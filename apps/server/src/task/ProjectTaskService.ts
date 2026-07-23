/**
 * ProjectTaskService - Project task CRUD with optional GitHub mirroring.
 *
 * The local SQLite store is authoritative and always writable, so tasks work in
 * projects with no linked repository. Every mutation is persisted locally
 * before GitHub is touched, so a `gh` failure never loses typed work.
 *
 * Ownership of a field decides the sync direction:
 *
 * - Title and body are local. They are pushed to the issue on an explicit
 *   push and are never read back, so an edit made here cannot be reverted by
 *   a later sync.
 * - Status is GitHub's when a link exists: sync takes the board column, or the
 *   issue's open/closed state when the repository has no board.
 *
 * GitHub is written only on explicit actions (creating an `issue`, promoting a
 * draft, or an update that opts in with `pushToGitHub`) and read only on an
 * explicit sync.
 *
 * @module ProjectTaskService
 */
import {
  TaskId,
  TaskStoreError,
  TaskSyncError,
  type ProjectId,
  type Task,
  type TaskCreateInput,
  type TaskDeleteInput,
  type TaskGitHubLink,
  type TaskListInput,
  type TaskListResult,
  type TaskMutationResult,
  type TaskPromoteInput,
  type TaskStatus,
  type TaskSyncInput,
  type TaskSyncResult,
  type TaskUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { ProjectTaskRepository } from "../persistence/Services/ProjectTasks.ts";
import { GitHubTaskSync, type GitHubBoardContext } from "./GitHubTaskSync.ts";
import { statusFromIssueState } from "./taskBoardStatus.ts";

/** GitHub CLI failures are advisory here: they never lose a local write. */
function toTaskSyncError(operation: string, projectId: ProjectId, taskId?: TaskId) {
  return (cause: unknown): TaskSyncError =>
    new TaskSyncError({
      projectId,
      taskId,
      operation,
      failure: "github_command_failed",
      detail: cause instanceof Error ? cause.message : undefined,
      cause,
    });
}

function toTaskStoreError(operation: string, projectId: ProjectId, taskId?: TaskId) {
  return (cause: ProjectionRepositoryError): TaskStoreError =>
    new TaskStoreError({
      projectId,
      taskId,
      operation,
      failure: "storage_failed",
      detail: cause.message,
      cause,
    });
}

export class ProjectTaskService extends Context.Service<
  ProjectTaskService,
  {
    readonly list: (input: TaskListInput) => Effect.Effect<TaskListResult, TaskStoreError>;
    readonly changes: (input: TaskListInput) => Stream.Stream<TaskListResult, TaskStoreError>;
    readonly create: (
      input: TaskCreateInput,
    ) => Effect.Effect<TaskMutationResult, TaskStoreError | TaskSyncError>;
    readonly update: (
      input: TaskUpdateInput,
    ) => Effect.Effect<TaskMutationResult, TaskStoreError | TaskSyncError>;
    readonly remove: (input: TaskDeleteInput) => Effect.Effect<void, TaskStoreError>;
    readonly promote: (
      input: TaskPromoteInput,
    ) => Effect.Effect<TaskMutationResult, TaskStoreError | TaskSyncError>;
    readonly sync: (
      input: TaskSyncInput,
    ) => Effect.Effect<TaskSyncResult, TaskStoreError | TaskSyncError>;
  }
>()("t3/task/ProjectTaskService") {}

export const make = Effect.gen(function* () {
  const repository = yield* ProjectTaskRepository;
  const github = yield* GitHubTaskSync;
  const crypto = yield* Crypto.Crypto;
  const changesPubSub = yield* PubSub.unbounded<{
    readonly projectId: ProjectId;
    readonly result: TaskListResult;
  }>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(changesPubSub));

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const newTaskId = (projectId: ProjectId) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((id) => TaskId.make(`task-${id}`)),
      Effect.mapError(
        (cause) =>
          new TaskStoreError({
            projectId,
            operation: "generateTaskId",
            failure: "storage_failed",
            detail: cause.message,
            cause,
          }),
      ),
    );

  // Reads are project-scoped, so a task id from another project resolves to
  // nothing rather than leaking or mutating that project's row.
  const requireTask = (projectId: ProjectId, taskId: TaskId, operation: string) =>
    repository.getById({ taskId, projectId }).pipe(
      Effect.mapError(toTaskStoreError(operation, projectId, taskId)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TaskStoreError({
                projectId,
                taskId,
                operation,
                failure: "task_not_found",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  /**
   * Push a task onto GitHub: create the issue when missing, mirror the local
   * text onto an existing one, then place it on the board. Board work is
   * best-effort so a missing board or `project` scope still yields a linked
   * issue, but the caller is told through `boardUnavailable`.
   */
  const pushToGitHub = Effect.fn("ProjectTaskService.pushToGitHub")(function* (
    task: Task,
    cwd: string,
  ) {
    const fail = toTaskSyncError("pushToGitHub", task.projectId, task.taskId);

    const repositoryContext = yield* github.resolveRepository({ cwd }).pipe(Effect.mapError(fail));
    if (repositoryContext === null) {
      return yield* new TaskSyncError({
        projectId: task.projectId,
        taskId: task.taskId,
        operation: "pushToGitHub",
        failure: "repository_not_linked",
        detail: `No GitHub repository is linked to '${cwd}'.`,
      });
    }

    const link = task.github;
    if (link !== null && link.nameWithOwner !== repositoryContext.nameWithOwner) {
      return yield* new TaskSyncError({
        projectId: task.projectId,
        taskId: task.taskId,
        operation: "pushToGitHub",
        failure: "repository_not_linked",
        detail: `Task is linked to '${link.nameWithOwner}', but the project workspace points to '${repositoryContext.nameWithOwner}'.`,
      });
    }

    // Push fields independently. If somebody changed the body on github.com,
    // a local title-only edit must not replace that body with the stale local copy.
    const titleChanged = link !== null && link.pushedTitle !== task.title;
    const bodyChanged = link !== null && link.pushedBody !== task.body;
    const issue =
      link === null
        ? yield* github
            .createIssue({ cwd, title: task.title, body: task.body })
            .pipe(Effect.mapError(fail))
        : yield* (
            titleChanged || bodyChanged
              ? github
                  .updateIssue({
                    cwd,
                    issueNumber: link.issueNumber,
                    ...(titleChanged ? { title: task.title } : {}),
                    ...(bodyChanged ? { body: task.body } : {}),
                  })
                  .pipe(Effect.mapError(fail))
              : Effect.void
          ).pipe(
            Effect.map(() => ({
              number: link.issueNumber,
              url: link.issueUrl,
              nodeId: link.issueNodeId,
            })),
          );

    const board = yield* github
      .resolveBoard({
        cwd,
        repository: repositoryContext,
        ...(link?.projectNodeId !== undefined
          ? { preferredProjectNodeId: link.projectNodeId }
          : {}),
      })
      .pipe(Effect.orElseSucceed(() => null));

    // A stored item id belongs to exactly one board and cannot be reused when
    // the repository's linked board changes.
    let projectItemId =
      board !== null && link?.projectNodeId === board.projectNodeId
        ? (link.projectItemId ?? null)
        : null;
    let boardUnavailable = board === null;
    if (board !== null) {
      if (projectItemId === null) {
        projectItemId = yield* github
          .addIssueToBoard({ cwd, board, issueUrl: issue.url })
          .pipe(Effect.orElseSucceed(() => null));
      }
      if (projectItemId === null) {
        boardUnavailable = true;
      } else {
        boardUnavailable = !(yield* github
          .setBoardItemStatus({ cwd, board, itemId: projectItemId, status: task.status })
          .pipe(Effect.orElseSucceed(() => false)));
      }
    }

    const syncedAt = yield* nowIso;
    const pushedLink: TaskGitHubLink = {
      nameWithOwner: repositoryContext.nameWithOwner,
      issueNumber: issue.number,
      issueUrl: issue.url,
      issueNodeId: issue.nodeId,
      projectItemId,
      projectNodeId: board?.projectNodeId ?? null,
      pushedTitle: task.title,
      pushedBody: task.body,
      lastSyncedAt: syncedAt,
    };
    return { link: pushedLink, boardUnavailable, updatedAt: syncedAt };
  });

  const list: ProjectTaskService["Service"]["list"] = ({ projectId }) =>
    repository.listByProject({ projectId }).pipe(
      Effect.mapError(toTaskStoreError("list", projectId)),
      Effect.map((tasks) => ({ tasks })),
    );

  const notifyProject = (projectId: ProjectId) =>
    repository.listByProject({ projectId }).pipe(
      Effect.flatMap((tasks) => PubSub.publish(changesPubSub, { projectId, result: { tasks } })),
      Effect.ignore,
    );

  const changes: ProjectTaskService["Service"]["changes"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Acquire the subscription before reading the snapshot so a mutation
        // committed between those steps is queued instead of being lost.
        const subscription = yield* PubSub.subscribe(changesPubSub);
        return Stream.concat(
          Stream.fromEffect(list(input)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.projectId === input.projectId),
            Stream.map((event) => event.result),
          ),
        );
      }),
    );

  const create: ProjectTaskService["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      const status: TaskStatus = input.status ?? "todo";
      const position = yield* repository
        .nextPosition({ projectId: input.projectId, status })
        .pipe(Effect.mapError(toTaskStoreError("create", input.projectId)));
      const createdAt = yield* nowIso;
      const taskId = yield* newTaskId(input.projectId);

      // The row starts as a draft whatever was asked for: `issue` only becomes
      // true once GitHub has actually accepted it, so a failed or impossible
      // push leaves a promotable task instead of a phantom.
      const draft: Task = {
        taskId,
        projectId: input.projectId,
        title: input.title,
        body: input.body ?? "",
        kind: "draft",
        status,
        position,
        threadId: null,
        github: null,
        createdAt,
        updatedAt: createdAt,
      };

      const store = toTaskStoreError("create", input.projectId, taskId);
      yield* repository.upsert(draft).pipe(Effect.mapError(store));
      yield* notifyProject(input.projectId);

      if (input.kind !== "issue" || input.cwd === undefined) {
        return { task: draft, boardUnavailable: false };
      }

      const pushed = yield* pushToGitHub(draft, input.cwd);
      if (draft.status === "done") {
        yield* github
          .setIssueState({
            cwd: input.cwd,
            issueNumber: pushed.link.issueNumber,
            closed: true,
          })
          .pipe(Effect.mapError(toTaskSyncError("create", input.projectId, taskId)));
      }
      const task: Task = {
        ...draft,
        kind: "issue",
        github: pushed.link,
        updatedAt: pushed.updatedAt,
      };
      yield* repository.upsert(task).pipe(Effect.mapError(store));
      yield* notifyProject(input.projectId);
      return { task, boardUnavailable: pushed.boardUnavailable };
    });

  const update: ProjectTaskService["Service"]["update"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* requireTask(input.projectId, input.taskId, "update");
      const updatedAt = yield* nowIso;

      const status = input.status ?? existing.status;
      // Moving between columns appends to the destination unless the caller
      // supplied an explicit position (a drag within the board does).
      const movedColumn = input.status !== undefined && input.status !== existing.status;
      const appendPosition = movedColumn
        ? yield* repository
            .nextPosition({ projectId: input.projectId, status })
            .pipe(Effect.mapError(toTaskStoreError("update", input.projectId, input.taskId)))
        : existing.position;
      const reposition = input.position ?? appendPosition;

      const local: Task = {
        ...existing,
        title: input.title ?? existing.title,
        body: input.body ?? existing.body,
        status,
        position: reposition,
        threadId: input.threadId === undefined ? existing.threadId : input.threadId,
        updatedAt,
      };

      const store = toTaskStoreError("update", input.projectId, input.taskId);
      yield* repository.upsert(local).pipe(Effect.mapError(store));
      yield* notifyProject(input.projectId);

      if (input.pushToGitHub !== true || input.cwd === undefined) {
        return { task: local, boardUnavailable: false };
      }

      const pushed = yield* pushToGitHub(local, input.cwd);
      // Only crossing the done boundary changes issue open/closed state.
      // Reopening every already-open issue creates needless GitHub events.
      if ((existing.status === "done") !== (local.status === "done")) {
        yield* github
          .setIssueState({
            cwd: input.cwd,
            issueNumber: pushed.link.issueNumber,
            closed: local.status === "done",
          })
          .pipe(Effect.mapError(toTaskSyncError("update", input.projectId, input.taskId)));
      }

      const task: Task = {
        ...local,
        kind: "issue",
        github: pushed.link,
        updatedAt: pushed.updatedAt,
      };
      yield* repository.upsert(task).pipe(Effect.mapError(store));
      yield* notifyProject(input.projectId);
      return { task, boardUnavailable: pushed.boardUnavailable };
    });

  const remove: ProjectTaskService["Service"]["remove"] = ({ projectId, taskId }) =>
    repository.deleteById({ taskId, projectId }).pipe(
      Effect.mapError(toTaskStoreError("remove", projectId, taskId)),
      Effect.tap(() => notifyProject(projectId)),
    );

  const promote: ProjectTaskService["Service"]["promote"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* requireTask(input.projectId, input.taskId, "promote");
      if (existing.kind === "issue" && existing.github !== null) {
        return { task: existing, boardUnavailable: false };
      }

      // Promotion carries no local edit of its own: the stored row is already
      // the local truth, so the push is a follow-on and only its result — the
      // GitHub link — is written back.
      const store = toTaskStoreError("promote", input.projectId, input.taskId);
      const pushed = yield* pushToGitHub(existing, input.cwd);
      if (existing.status === "done") {
        yield* github
          .setIssueState({
            cwd: input.cwd,
            issueNumber: pushed.link.issueNumber,
            closed: true,
          })
          .pipe(Effect.mapError(toTaskSyncError("promote", input.projectId, input.taskId)));
      }
      const task: Task = {
        ...existing,
        kind: "issue",
        github: pushed.link,
        updatedAt: pushed.updatedAt,
      };
      yield* repository.upsert(task).pipe(Effect.mapError(store));
      yield* notifyProject(input.projectId);
      return { task, boardUnavailable: pushed.boardUnavailable };
    });

  const sync: ProjectTaskService["Service"]["sync"] = (input) =>
    Effect.gen(function* () {
      const fail = toTaskSyncError("sync", input.projectId);
      const existing = yield* repository
        .listByProject({ projectId: input.projectId })
        .pipe(Effect.mapError(toTaskStoreError("sync", input.projectId)));

      const repositoryContext = yield* github
        .resolveRepository({ cwd: input.cwd })
        .pipe(Effect.mapError(fail));
      if (repositoryContext === null) {
        return { tasks: existing, updatedCount: 0, boardUnavailable: true };
      }

      const mismatchedLink = existing.find(
        (task) =>
          task.github !== null && task.github.nameWithOwner !== repositoryContext.nameWithOwner,
      );
      if (mismatchedLink?.github !== undefined && mismatchedLink.github !== null) {
        return yield* new TaskSyncError({
          projectId: input.projectId,
          taskId: mismatchedLink.taskId,
          operation: "sync",
          failure: "repository_not_linked",
          detail: `Task is linked to '${mismatchedLink.github.nameWithOwner}', but the project workspace points to '${repositoryContext.nameWithOwner}'.`,
        });
      }

      const linkedIssueNumbers = existing.flatMap((task) =>
        task.github === null ? [] : [task.github.issueNumber],
      );
      const issues = yield* github
        .fetchIssues({ cwd: input.cwd, issueNumbers: linkedIssueNumbers })
        .pipe(Effect.mapError(fail));
      const issuesByNumber = new Map(issues.map((issue) => [issue.number, issue]));

      const preferredProjectNodeId = existing.find(
        (task) => task.github?.projectNodeId !== null && task.github?.projectNodeId !== undefined,
      )?.github?.projectNodeId;
      const board: GitHubBoardContext | null = yield* github
        .resolveBoard({
          cwd: input.cwd,
          repository: repositoryContext,
          ...(preferredProjectNodeId !== undefined ? { preferredProjectNodeId } : {}),
        })
        .pipe(Effect.orElseSucceed(() => null));

      const boardRead =
        board === null
          ? { available: true as const, items: [] as ReadonlyArray<never> }
          : yield* github.listBoardItems({ cwd: input.cwd, board }).pipe(
              Effect.map((items) => ({ available: true as const, items })),
              Effect.orElseSucceed(() => ({
                available: false as const,
                items: [] as ReadonlyArray<never>,
              })),
            );
      const boardByIssueNumber = new Map(boardRead.items.map((item) => [item.issueNumber, item]));

      const syncedAt = yield* nowIso;
      const reconciled: Task[] = [];
      let updatedCount = 0;

      for (const task of existing) {
        if (task.github === null) {
          reconciled.push(task);
          continue;
        }
        const issue = issuesByNumber.get(task.github.issueNumber);
        if (issue === undefined) {
          reconciled.push(task);
          continue;
        }
        const boardItem = boardByIssueNumber.get(task.github.issueNumber);
        // Preserve the local column when a linked board could not be read. A
        // failed board request is not evidence that the item has no status.
        const status =
          board !== null && !boardRead.available
            ? task.status
            : (boardItem?.status ?? statusFromIssueState(issue.state, task.status));

        // Title and body are deliberately not read back: local text is
        // authoritative and is pushed by `update`/`promote` instead.
        const next: Task = {
          ...task,
          status,
          github: {
            ...task.github,
            issueUrl: issue.url,
            issueNodeId: issue.nodeId ?? task.github.issueNodeId,
            projectItemId: boardItem?.itemId ?? task.github.projectItemId,
            projectNodeId: board?.projectNodeId ?? task.github.projectNodeId,
            lastSyncedAt: syncedAt,
          },
          updatedAt: syncedAt,
        };

        if (next.status !== task.status) {
          updatedCount += 1;
        }
        yield* repository
          .upsert(next)
          .pipe(Effect.mapError(toTaskStoreError("sync", input.projectId, task.taskId)));
        reconciled.push(next);
      }

      const result = {
        tasks: reconciled,
        updatedCount,
        boardUnavailable: board === null || !boardRead.available,
      };
      yield* PubSub.publish(changesPubSub, {
        projectId: input.projectId,
        result: { tasks: reconciled },
      });
      return result;
    });

  return ProjectTaskService.of({ list, changes, create, update, remove, promote, sync });
});

export const layer = Layer.effect(ProjectTaskService, make);
