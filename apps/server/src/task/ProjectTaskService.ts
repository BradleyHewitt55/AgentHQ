/**
 * ProjectTaskService - Project task orchestration over GitHub Projects v2.
 *
 * GitHub is the source of truth: nothing here persists task state locally.
 * Reads go straight to the board's items, and every mutation is a Projects v2
 * write whose result is mapped back into the Tasks model. The only local
 * concept is which workspace (cwd) anchors the `gh` CLI and repository
 * lookups, plus an optional explicit board selection per request.
 *
 * @module ProjectTaskService
 */
import {
  TASK_STATUSES,
  TaskId,
  TasksError,
  type ProjectId,
  type Task,
  type TaskCreateInput,
  type TaskDeleteInput,
  type TaskListInput,
  type TaskListResult,
  type TaskMutationResult,
  type TaskPromoteInput,
  type TaskProjectRef,
  type TaskStatus,
  type TaskUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { layer as gitHubCliLayer } from "../sourceControl/GitHubCli.ts";
import * as GitHubProjectsApi from "./GitHubProjectsApi.ts";
import type { GitHubProjectContext, GitHubProjectItemSnapshot } from "./GitHubProjectsApi.ts";
import { resolveStatusForBoardOption } from "./taskBoardStatus.ts";

interface TaskScope {
  readonly projectId: ProjectId;
  readonly taskId?: TaskId;
}

const isTasksError = Schema.is(TasksError);

function toTasksError(operation: string, scope: TaskScope) {
  return (cause: unknown): TasksError => {
    if (isTasksError(cause)) return cause;
    // GitHubGraphQlError exposes the precise API message via its detail getter;
    // plain process failures only carry a generic exit description.
    const rawDetail =
      (typeof cause === "object" &&
      cause !== null &&
      typeof (cause as { detail?: unknown }).detail === "string"
        ? (cause as { detail: string }).detail
        : undefined) ?? (cause instanceof Error ? cause.message : undefined);
    const detail = rawDetail === undefined || rawDetail.trim() === "" ? undefined : rawDetail;
    const failure = GitHubProjectsApi.toTasksFailure(cause);
    return new TasksError({
      ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
      ...(scope.taskId !== undefined ? { taskId: scope.taskId } : {}),
      operation,
      failure,
      ...(detail !== undefined ? { detail } : {}),
      ...(cause instanceof Error ? { cause } : {}),
    });
  };
}

/**
 * Kanban column for a Project item. The board's own Status option wins when it
 * maps to a known column; otherwise drafts sit in `todo` and closed issues and
 * pull requests in `done`.
 */
export function statusForSnapshot(snapshot: GitHubProjectItemSnapshot): TaskStatus {
  if (snapshot.statusName !== null) {
    const mapped = resolveStatusForBoardOption(snapshot.statusName);
    if (mapped !== null) return mapped;
  }
  if (snapshot.itemType === "draft") return "todo";
  return snapshot.state === "closed" ? "done" : "todo";
}

/** Map a Project item onto the Tasks model. */
export function taskFromSnapshot(
  snapshot: GitHubProjectItemSnapshot,
  projectId: ProjectId,
  projectNodeId: string,
): Task {
  return {
    taskId: TaskId.make(snapshot.itemId),
    projectNodeId,
    title: snapshot.title,
    body: snapshot.body,
    kind: snapshot.itemType,
    status: statusForSnapshot(snapshot),
    repository: snapshot.repositoryNameWithOwner,
    number: snapshot.number,
    url: snapshot.url,
    state: snapshot.state,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
}

function compareTasks(left: Task, right: Task): number {
  const column = TASK_STATUSES.indexOf(left.status) - TASK_STATUSES.indexOf(right.status);
  if (column !== 0) return column;
  const created = left.createdAt.localeCompare(right.createdAt);
  if (created !== 0) return created;
  return left.taskId.localeCompare(right.taskId);
}

export class ProjectTaskService extends Context.Service<
  ProjectTaskService,
  {
    readonly list: (input: TaskListInput) => Effect.Effect<TaskListResult, TasksError>;
    readonly create: (input: TaskCreateInput) => Effect.Effect<TaskMutationResult, TasksError>;
    readonly update: (input: TaskUpdateInput) => Effect.Effect<TaskMutationResult, TasksError>;
    readonly remove: (input: TaskDeleteInput) => Effect.Effect<void, TasksError>;
    readonly promote: (input: TaskPromoteInput) => Effect.Effect<TaskMutationResult, TasksError>;
  }
>()("t3/task/ProjectTaskService") {}

export const make = Effect.gen(function* () {
  const github = yield* GitHubProjectsApi.GitHubProjectsApi;

  /**
   * Resolve the boards usable for a workspace. An explicit selection wins when
   * given; otherwise the first candidate with a writable Status column is the
   * default, falling back to the first candidate at all.
   */
  const resolveBoards = (
    input: TaskListInput | TaskCreateInput | TaskUpdateInput | TaskDeleteInput | TaskPromoteInput,
  ) =>
    Effect.gen(function* () {
      const repository = yield* github
        .resolveRepository({ cwd: input.cwd })
        .pipe(Effect.mapError(toTasksError("resolveRepository", { projectId: input.projectId })));
      if (repository === null) {
        return yield* new TasksError({
          projectId: input.projectId,
          operation: "resolveRepository",
          failure: "repository_not_linked",
          detail: `No GitHub repository is linked to '${input.cwd}'.`,
        });
      }

      const candidates = yield* github
        .resolveProjects({ cwd: input.cwd, repository })
        .pipe(Effect.mapError(toTasksError("resolveProjects", { projectId: input.projectId })));

      const explicit = input.projectNodeId;
      const active =
        explicit !== undefined
          ? candidates.find((project) => project.projectNodeId === explicit)
          : (candidates.find((project) => project.statusFieldId !== null) ?? candidates[0]);
      return { repository, candidates, active };
    });

  const boardOr = (
    boards: { readonly active: GitHubProjectContext | undefined },
    projectId: ProjectId,
  ) =>
    boards.active !== undefined
      ? Effect.succeed(boards.active)
      : Effect.fail(
          new TasksError({
            projectId,
            operation: "resolveProjects",
            failure: "project_not_found",
            detail: "No GitHub Projects v2 board is available for this workspace.",
          }),
        );

  const list: ProjectTaskService["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const fail = toTasksError("list", { projectId: input.projectId });
      const boards = yield* resolveBoards(input).pipe(Effect.mapError(fail));
      const board = boards.active;
      const projectRefs: TaskProjectRef[] = boards.candidates.map((project) => ({
        projectNodeId: project.projectNodeId,
        ownerLogin: project.ownerLogin,
        projectNumber: project.projectNumber,
        title: project.title,
      }));
      if (board === undefined) {
        return { project: null, projects: projectRefs, tasks: [] };
      }

      const snapshots = yield* github
        .listItems({ cwd: input.cwd, projectNodeId: board.projectNodeId })
        .pipe(Effect.mapError(fail));
      const tasks = snapshots
        .map((snapshot) => taskFromSnapshot(snapshot, input.projectId, board.projectNodeId))
        .sort(compareTasks);

      return {
        project: {
          projectNodeId: board.projectNodeId,
          ownerLogin: board.ownerLogin,
          projectNumber: board.projectNumber,
          title: board.title,
        },
        projects: projectRefs,
        tasks,
      };
    });

  const create: ProjectTaskService["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      const fail = toTasksError("create", { projectId: input.projectId });
      const boards = yield* resolveBoards(input).pipe(Effect.mapError(fail));
      const board = yield* boardOr(boards, input.projectId);
      const body = input.body ?? "";

      let snapshot: GitHubProjectItemSnapshot | null;
      if (input.kind === "draft") {
        snapshot = yield* github
          .addDraftIssue({
            cwd: input.cwd,
            projectNodeId: board.projectNodeId,
            title: input.title,
            body,
          })
          .pipe(Effect.mapError(fail));
      } else {
        // File the issue first, then attach it. If the attach fails the issue
        // exists on GitHub; the error surfaces and a retry of the whole flow
        // would file a duplicate, so attachment failures are reported as-is.
        const issue = yield* github
          .createIssue({ cwd: input.cwd, title: input.title, body })
          .pipe(Effect.mapError(fail));
        snapshot = yield* github
          .addIssueToProject({
            cwd: input.cwd,
            projectNodeId: board.projectNodeId,
            issueNodeId: issue.nodeId,
          })
          .pipe(Effect.mapError(fail));
      }
      if (snapshot === null) {
        return yield* new TasksError({
          projectId: input.projectId,
          operation: "create",
          failure: "github_command_failed",
          detail: "GitHub accepted the mutation but returned no item.",
        });
      }
      return { task: taskFromSnapshot(snapshot, input.projectId, board.projectNodeId) };
    });

  const update: ProjectTaskService["Service"]["update"] = (input) =>
    Effect.gen(function* () {
      const fail = toTasksError("update", { projectId: input.projectId, taskId: input.taskId });
      const boards = yield* resolveBoards(input).pipe(Effect.mapError(fail));
      const board = yield* boardOr(boards, input.projectId);

      if (board.statusFieldId === null) {
        return yield* new TasksError({
          projectId: input.projectId,
          taskId: input.taskId,
          operation: "update",
          failure: "github_command_failed",
          detail: "The selected board has no Status field, so columns cannot be changed.",
        });
      }
      const moved = yield* github
        .setItemStatus({
          cwd: input.cwd,
          projectNodeId: board.projectNodeId,
          itemId: input.taskId,
          status: input.status,
          field: { statusFieldId: board.statusFieldId, options: board.statusOptions },
        })
        .pipe(Effect.mapError(fail));
      if (!moved) {
        return yield* new TasksError({
          projectId: input.projectId,
          taskId: input.taskId,
          operation: "update",
          failure: "github_command_failed",
          detail: `The board has no Status option matching '${input.status}'.`,
        });
      }

      const snapshot = yield* github
        .fetchItem({ cwd: input.cwd, itemId: input.taskId })
        .pipe(Effect.mapError(fail));
      if (snapshot === null) {
        return yield* new TasksError({
          projectId: input.projectId,
          taskId: input.taskId,
          operation: "update",
          failure: "task_not_found",
        });
      }
      return { task: taskFromSnapshot(snapshot, input.projectId, board.projectNodeId) };
    });

  const remove: ProjectTaskService["Service"]["remove"] = (input) =>
    Effect.gen(function* () {
      const fail = toTasksError("remove", { projectId: input.projectId, taskId: input.taskId });
      const boards = yield* resolveBoards(input).pipe(Effect.mapError(fail));
      const board = yield* boardOr(boards, input.projectId);
      yield* github
        .deleteItem({
          cwd: input.cwd,
          projectNodeId: board.projectNodeId,
          itemId: input.taskId,
        })
        .pipe(Effect.mapError(fail));
    });

  const promote: ProjectTaskService["Service"]["promote"] = (input) =>
    Effect.gen(function* () {
      const fail = toTasksError("promote", { projectId: input.projectId, taskId: input.taskId });
      const boards = yield* resolveBoards(input).pipe(Effect.mapError(fail));
      const board = yield* boardOr(boards, input.projectId);
      const snapshot = yield* github
        .convertDraftToIssue({
          cwd: input.cwd,
          itemId: input.taskId,
          repositoryNodeId: boards.repository.repositoryNodeId,
        })
        .pipe(Effect.mapError(fail));
      if (snapshot === null) {
        return yield* new TasksError({
          projectId: input.projectId,
          taskId: input.taskId,
          operation: "promote",
          failure: "github_command_failed",
          detail: "Conversion succeeded but GitHub returned no item.",
        });
      }
      return { task: taskFromSnapshot(snapshot, input.projectId, board.projectNodeId) };
    });

  return ProjectTaskService.of({ list, create, update, remove, promote });
});

export const layer = Layer.effect(ProjectTaskService, make).pipe(
  Layer.provide(GitHubProjectsApi.layer.pipe(Layer.provide(gitHubCliLayer))),
);
