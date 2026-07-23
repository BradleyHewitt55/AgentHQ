import { ProjectId, TaskId, VcsProcessExitError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectTaskRepositoryLive } from "../persistence/Layers/ProjectTasks.ts";
import { GitHubCliCommandError, layer as GitHubCliLayer } from "../sourceControl/GitHubCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  GitHubIssueUrlDecodeError,
  GitHubTaskSync,
  layer as GitHubTaskSyncLayer,
} from "./GitHubTaskSync.ts";
import { ProjectTaskService, layer as ProjectTaskServiceLayer } from "./ProjectTaskService.ts";

/**
 * The in-memory database is built once per suite, so each test scopes itself to
 * a fresh project rather than sharing rows with its neighbours.
 */
let projectCounter = 0;
const nextProjectId = () => ProjectId.make(`project-tasks-${(projectCounter += 1)}`);

/**
 * Stub GitHub with no linked repository, exercising the local-only path a
 * project without a remote takes.
 */
const UnlinkedGitHubLayer = Layer.mock(GitHubTaskSync)({
  resolveRepository: () => Effect.succeed(null),
});

/** Issue numbers each sync asked GitHub for, so lookups can be asserted. */
const requestedIssueNumbers: Array<ReadonlyArray<number>> = [];

/** Issue edits GitHub was asked to make, so no-op pushes can be asserted. */
const issueEdits: Array<{
  readonly issueNumber: number;
  readonly title?: string;
  readonly body?: string;
}> = [];

/** Stub a linked repository whose owner has no usable Projects v2 board. */
const IssuesOnlyGitHubLayer = Layer.mock(GitHubTaskSync)({
  resolveRepository: ({ cwd }) =>
    Effect.succeed({
      nameWithOwner: cwd === "/tmp/other" ? "acme/other" : "acme/widgets",
      ownerLogin: "acme",
    }),
  createIssue: ({ title, body }) =>
    Effect.succeed({
      number: 42,
      url: "https://github.com/acme/widgets/issues/42",
      nodeId: "I_node42",
      title,
      body,
      state: "open" as const,
    }),
  updateIssue: ({ issueNumber, title, body }) => {
    issueEdits.push({
      issueNumber,
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
    });
    return Effect.void;
  },
  setIssueState: () => Effect.void,
  resolveBoard: () => Effect.succeed(null),
  fetchIssues: ({ issueNumbers }) => {
    requestedIssueNumbers.push([...issueNumbers]);
    return Effect.succeed(
      issueNumbers.includes(42)
        ? [
            {
              number: 42,
              url: "https://github.com/acme/widgets/issues/42",
              nodeId: "I_node42",
              title: "Renamed on GitHub",
              body: "Rewritten on GitHub",
              state: "closed" as const,
            },
          ]
        : [],
    );
  },
});

/**
 * `gh issue create` succeeded but printed no issue URL: the issue exists, so
 * the failure must reach the caller instead of being papered over.
 */
const UnparseableIssueGitHubLayer = Layer.mock(GitHubTaskSync)({
  resolveRepository: () => Effect.succeed({ nameWithOwner: "acme/widgets", ownerLogin: "acme" }),
  createIssue: ({ cwd }) =>
    Effect.fail(
      new GitHubIssueUrlDecodeError({
        command: "gh",
        cwd,
        stdout: "Creating issue in acme/widgets",
      }),
    ),
});

const UnreadableBoardGitHubLayer = Layer.mock(GitHubTaskSync)({
  resolveRepository: () => Effect.succeed({ nameWithOwner: "acme/widgets", ownerLogin: "acme" }),
  createIssue: ({ title, body }) =>
    Effect.succeed({
      number: 51,
      url: "https://github.com/acme/widgets/issues/51",
      nodeId: "I_node51",
      title,
      body,
      state: "open" as const,
    }),
  updateIssue: () => Effect.void,
  setIssueState: () => Effect.void,
  resolveBoard: () =>
    Effect.succeed({
      projectNodeId: "PVT_board",
      projectNumber: 7,
      ownerLogin: "acme",
      statusFieldId: "PVTF_status",
      statusOptions: [{ id: "todo", name: "Todo" }],
    }),
  addIssueToBoard: () => Effect.succeed("PVTI_item"),
  setBoardItemStatus: () => Effect.succeed(true),
  fetchIssues: () =>
    Effect.succeed([
      {
        number: 51,
        url: "https://github.com/acme/widgets/issues/51",
        nodeId: "I_node51",
        title: "Task",
        body: "",
        state: "closed" as const,
      },
    ]),
  listBoardItems: ({ cwd }) =>
    Effect.fail(
      new GitHubCliCommandError({
        command: "gh",
        cwd,
        cause: new Error("Projects API unavailable"),
      }),
    ),
});

/** Issue numbers whose `gh issue view` fails, as a deleted issue would. */
const brokenIssueLookups = new Set<number>();
/** Issue lookups that fail for a reason sync must not suppress. */
const failedIssueLookups = new Set<number>();
let issueNumberCounter = 0;

const ghOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const issueJson = (issueNumber: number, state: "open" | "closed") =>
  JSON.stringify({
    id: `I_node${issueNumber}`,
    number: issueNumber,
    url: `https://github.com/acme/widgets/issues/${issueNumber}`,
    title: `Issue ${issueNumber}`,
    body: "",
    state,
  });

/**
 * The real `GitHubTaskSync` over a stubbed `gh`, so issue lookups are
 * classified exactly as the CLI wrapper classifies them.
 */
const RealGitHubTaskSyncLayer = GitHubTaskSyncLayer.pipe(
  Layer.provide(
    GitHubCliLayer.pipe(
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: ({ args, cwd, operation }) => {
            const [group, action, target] = args;
            if (group === "repo" && action === "view") {
              return Effect.succeed(
                ghOutput(
                  JSON.stringify({ nameWithOwner: "acme/widgets", owner: { login: "acme" } }),
                ),
              );
            }
            if (group === "project" && action === "list") {
              return Effect.succeed(ghOutput(JSON.stringify({ projects: [] })));
            }
            if (group === "issue" && action === "create") {
              issueNumberCounter += 1;
              return Effect.succeed(
                ghOutput(`https://github.com/acme/widgets/issues/${issueNumberCounter}\n`),
              );
            }
            if (group === "issue" && action === "view") {
              const issueNumber = Number(target);
              if (brokenIssueLookups.has(issueNumber)) {
                // `gh` reports a missing issue as a plain command failure:
                // its not-found classification only matches pull requests.
                return Effect.fail(
                  new VcsProcessExitError({
                    operation,
                    command: "gh",
                    cwd,
                    exitCode: 1,
                    detail: `Could not resolve to an Issue with the number of ${issueNumber}.`,
                    failureKind: "command-failed",
                  }),
                );
              }
              if (failedIssueLookups.has(issueNumber)) {
                return Effect.fail(
                  new VcsProcessExitError({
                    operation,
                    command: "gh",
                    cwd,
                    exitCode: 1,
                    detail: "GitHub request timed out.",
                    failureKind: "command-failed",
                  }),
                );
              }
              // The second issue is closed so a successful sync is observable.
              return Effect.succeed(
                ghOutput(issueJson(issueNumber, issueNumber === 2 ? "closed" : "open")),
              );
            }
            return Effect.succeed(ghOutput(""));
          },
        }),
      ),
    ),
  ),
);

const makeLayer = (githubLayer: Layer.Layer<GitHubTaskSync>) =>
  it.layer(
    ProjectTaskServiceLayer.pipe(
      Layer.provide(githubLayer),
      Layer.provide(ProjectTaskRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
      // Task ids come from `Crypto.randomUUIDv4`, which the Node platform provides.
      Layer.provide(NodeServices.layer),
    ),
  );

makeLayer(UnlinkedGitHubLayer)("ProjectTaskService without a linked repository", (it) => {
  it.effect("stores drafts locally and lists them", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();

      const created = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Write the migration",
        kind: "draft",
      });

      assert.strictEqual(created.task.kind, "draft");
      assert.strictEqual(created.task.status, "todo");
      assert.strictEqual(created.task.github, null);

      const listed = yield* tasks.list({ projectId: PROJECT_ID });
      assert.strictEqual(listed.tasks.length, 1);
      assert.strictEqual(listed.tasks[0]?.title, "Write the migration");
    }),
  );

  it.effect("broadcasts task mutations to active project subscribers", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();
      const updatesFiber = yield* tasks
        .changes({ projectId: PROJECT_ID })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;

      yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Visible in another client",
        kind: "draft",
      });

      const updates = yield* Fiber.join(updatesFiber);
      assert.strictEqual(updates.length, 2);
      assert.strictEqual(updates[0]?.tasks.length, 0);
      assert.strictEqual(updates[1]?.tasks[0]?.title, "Visible in another client");
    }),
  );

  it.effect("appends each new task to the end of its column", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();

      const first = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "First",
        kind: "draft",
      });
      const second = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Second",
        kind: "draft",
      });

      assert.strictEqual(first.task.position, 0);
      assert.strictEqual(second.task.position, 1);
    }),
  );

  it.effect("moves a task to the end of the destination column on status change", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();

      const parked = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Already in progress",
        kind: "draft",
        status: "in_progress",
      });
      const created = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Hand to agent",
        kind: "draft",
      });

      const updated = yield* tasks.update({
        taskId: created.task.taskId,
        projectId: PROJECT_ID,
        status: "in_progress",
      });

      assert.strictEqual(updated.task.status, "in_progress");
      assert.strictEqual(parked.task.position, 0);
      assert.strictEqual(updated.task.position, 1);
    }),
  );

  it.effect("fails to promote when the workspace has no GitHub repository", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();

      const created = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Needs a remote",
        kind: "draft",
      });

      const error = yield* Effect.flip(
        tasks.promote({
          taskId: created.task.taskId,
          projectId: PROJECT_ID,
          cwd: "/tmp/no-remote",
        }),
      );

      assert.strictEqual(error.failure, "repository_not_linked");
    }),
  );

  it.effect("reports task_not_found for an unknown task", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();

      const error = yield* Effect.flip(
        tasks.update({ taskId: TaskId.make("task-missing"), projectId: PROJECT_ID, title: "x" }),
      );

      assert.strictEqual(error.failure, "task_not_found");
    }),
  );

  it.effect("refuses to update a task owned by another project", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const OWNER_PROJECT_ID = nextProjectId();
      const OTHER_PROJECT_ID = nextProjectId();

      const created = yield* tasks.create({
        projectId: OWNER_PROJECT_ID,
        title: "Owned elsewhere",
        kind: "draft",
      });

      const error = yield* Effect.flip(
        tasks.update({
          taskId: created.task.taskId,
          projectId: OTHER_PROJECT_ID,
          status: "done",
        }),
      );

      assert.strictEqual(error.failure, "task_not_found");
      const listed = yield* tasks.list({ projectId: OWNER_PROJECT_ID });
      assert.strictEqual(listed.tasks[0]?.status, "todo");
    }),
  );

  it.effect("refuses to delete a task owned by another project", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const OWNER_PROJECT_ID = nextProjectId();
      const OTHER_PROJECT_ID = nextProjectId();

      const created = yield* tasks.create({
        projectId: OWNER_PROJECT_ID,
        title: "Owned elsewhere",
        kind: "draft",
      });

      yield* tasks.remove({ taskId: created.task.taskId, projectId: OTHER_PROJECT_ID });

      const listed = yield* tasks.list({ projectId: OWNER_PROJECT_ID });
      assert.strictEqual(listed.tasks.length, 1);
    }),
  );

  it.effect("stores an issue requested without a workspace as a promotable draft", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();

      const created = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "No workspace to file in",
        kind: "issue",
      });

      assert.strictEqual(created.task.kind, "draft");
      assert.strictEqual(created.task.github, null);

      const listed = yield* tasks.list({ projectId: PROJECT_ID });
      assert.strictEqual(listed.tasks[0]?.kind, "draft");
    }),
  );
});

makeLayer(UnparseableIssueGitHubLayer)("ProjectTaskService when gh prints no issue url", (it) => {
  it.effect("fails the create and keeps the task as a promotable draft", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();

      const error = yield* Effect.flip(
        tasks.create({
          projectId: PROJECT_ID,
          title: "Files a duplicate on retry",
          kind: "issue",
          cwd: "/tmp/widgets",
        }),
      );

      assert.strictEqual(error.failure, "github_command_failed");
      assert.include(error.detail ?? "", "Creating issue in acme/widgets");

      // The typed title survives the failed push, so the user can retry with
      // promote instead of re-typing (and re-filing) the issue.
      const listed = yield* tasks.list({ projectId: PROJECT_ID });
      assert.strictEqual(listed.tasks.length, 1);
      assert.strictEqual(listed.tasks[0]?.title, "Files a duplicate on retry");
      assert.strictEqual(listed.tasks[0]?.kind, "draft");
    }),
  );

  it.effect("fails the promote rather than storing a sentinel issue number", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();

      const created = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Needs an issue",
        kind: "draft",
      });

      const error = yield* Effect.flip(
        tasks.promote({
          taskId: created.task.taskId,
          projectId: PROJECT_ID,
          cwd: "/tmp/widgets",
        }),
      );

      assert.strictEqual(error.failure, "github_command_failed");

      const listed = yield* tasks.list({ projectId: PROJECT_ID });
      assert.strictEqual(listed.tasks[0]?.github, null);
    }),
  );
});

makeLayer(IssuesOnlyGitHubLayer)("ProjectTaskService with issues but no board", (it) => {
  it.effect("promotes a draft into a linked issue", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();

      const created = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Ship the thing",
        kind: "draft",
      });
      const promoted = yield* tasks.promote({
        taskId: created.task.taskId,
        projectId: PROJECT_ID,
        cwd: "/tmp/widgets",
      });

      assert.strictEqual(promoted.task.kind, "issue");
      assert.strictEqual(promoted.task.github?.issueNumber, 42);
      assert.strictEqual(promoted.task.github?.nameWithOwner, "acme/widgets");
      // No board is available, so the item stays unplaced but the issue links.
      assert.strictEqual(promoted.task.github?.projectItemId, null);
    }),
  );

  it.effect("promoting an already-linked issue is a no-op", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();

      const created = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Ship the thing",
        kind: "draft",
      });
      const first = yield* tasks.promote({
        taskId: created.task.taskId,
        projectId: PROJECT_ID,
        cwd: "/tmp/widgets",
      });
      const second = yield* tasks.promote({
        taskId: created.task.taskId,
        projectId: PROJECT_ID,
        cwd: "/tmp/widgets",
      });

      assert.deepStrictEqual(second.task, first.task);
    }),
  );

  it.effect("sync moves a closed issue into the done column", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();

      const created = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Ship the thing",
        kind: "draft",
      });
      yield* tasks.promote({
        taskId: created.task.taskId,
        projectId: PROJECT_ID,
        cwd: "/tmp/widgets",
      });

      const synced = yield* tasks.sync({ projectId: PROJECT_ID, cwd: "/tmp/widgets" });

      assert.strictEqual(synced.boardUnavailable, true);
      assert.strictEqual(synced.updatedCount, 1);
      assert.strictEqual(synced.tasks[0]?.status, "done");
    }),
  );

  it.effect("looks issues up by number rather than scanning a bounded list", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();
      requestedIssueNumbers.length = 0;

      const created = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Ship the thing",
        kind: "draft",
      });
      yield* tasks.promote({
        taskId: created.task.taskId,
        projectId: PROJECT_ID,
        cwd: "/tmp/widgets",
      });

      yield* tasks.sync({ projectId: PROJECT_ID, cwd: "/tmp/widgets" });

      assert.deepStrictEqual(requestedIssueNumbers, [[42]]);
    }),
  );

  it.effect("keeps local title and body when GitHub text diverges", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();

      const created = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Ship the thing",
        body: "Local notes",
        kind: "draft",
      });
      yield* tasks.promote({
        taskId: created.task.taskId,
        projectId: PROJECT_ID,
        cwd: "/tmp/widgets",
      });

      const synced = yield* tasks.sync({ projectId: PROJECT_ID, cwd: "/tmp/widgets" });

      assert.strictEqual(synced.tasks[0]?.title, "Ship the thing");
      assert.strictEqual(synced.tasks[0]?.body, "Local notes");
    }),
  );

  it.effect("does not rewrite the issue when only the column moved", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();
      issueEdits.length = 0;

      const created = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Ship the thing",
        body: "Local notes",
        kind: "draft",
      });
      yield* tasks.promote({
        taskId: created.task.taskId,
        projectId: PROJECT_ID,
        cwd: "/tmp/widgets",
      });

      yield* tasks.update({
        taskId: created.task.taskId,
        projectId: PROJECT_ID,
        status: "in_progress",
        pushToGitHub: true,
        cwd: "/tmp/widgets",
      });

      assert.deepStrictEqual(issueEdits, []);

      const renamed = yield* tasks.update({
        taskId: created.task.taskId,
        projectId: PROJECT_ID,
        title: "Ship the other thing",
        pushToGitHub: true,
        cwd: "/tmp/widgets",
      });

      assert.deepStrictEqual(issueEdits, [{ issueNumber: 42, title: "Ship the other thing" }]);
      assert.strictEqual(renamed.task.github?.pushedTitle, "Ship the other thing");

      yield* tasks.update({
        taskId: created.task.taskId,
        projectId: PROJECT_ID,
        body: "Updated local notes",
        pushToGitHub: true,
        cwd: "/tmp/widgets",
      });
      assert.deepStrictEqual(issueEdits[1], {
        issueNumber: 42,
        body: "Updated local notes",
      });
    }),
  );

  it.effect("refuses to update an issue through a different repository", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();
      const created = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Repository-bound task",
        kind: "draft",
      });
      yield* tasks.promote({
        taskId: created.task.taskId,
        projectId: PROJECT_ID,
        cwd: "/tmp/widgets",
      });

      const error = yield* tasks
        .update({
          taskId: created.task.taskId,
          projectId: PROJECT_ID,
          title: "Must not edit another repository",
          pushToGitHub: true,
          cwd: "/tmp/other",
        })
        .pipe(Effect.flip);

      assert.strictEqual(error.failure, "repository_not_linked");
      assert.match(error.detail ?? "", /acme\/widgets.*acme\/other/);
    }),
  );

  it.effect("reports the board as unavailable when the repository has none", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();

      const created = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Ship the thing",
        kind: "draft",
      });
      const promoted = yield* tasks.promote({
        taskId: created.task.taskId,
        projectId: PROJECT_ID,
        cwd: "/tmp/widgets",
      });

      assert.strictEqual(promoted.boardUnavailable, true);
    }),
  );
});

makeLayer(UnreadableBoardGitHubLayer)("ProjectTaskService with an unreadable board", (it) => {
  it.effect("preserves local status and reports the board read failure", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();
      const created = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Keep the local column",
        kind: "issue",
        cwd: "/tmp/widgets",
      });
      assert.strictEqual(created.task.status, "todo");

      const synced = yield* tasks.sync({ projectId: PROJECT_ID, cwd: "/tmp/widgets" });

      assert.isTrue(synced.boardUnavailable);
      assert.strictEqual(synced.updatedCount, 0);
      assert.strictEqual(synced.tasks[0]?.status, "todo");
    }),
  );
});

makeLayer(RealGitHubTaskSyncLayer)("ProjectTaskService against a stubbed gh", (it) => {
  it.effect("keeps syncing the other tasks when one issue lookup fails", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();
      issueNumberCounter = 0;
      brokenIssueLookups.clear();
      failedIssueLookups.clear();

      const deletedIssue = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Filed then deleted on GitHub",
        kind: "issue",
        cwd: "/tmp/widgets",
      });
      const survivingIssue = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Still on GitHub",
        kind: "issue",
        cwd: "/tmp/widgets",
      });

      assert.strictEqual(deletedIssue.task.github?.issueNumber, 1);
      assert.strictEqual(survivingIssue.task.github?.issueNumber, 2);

      brokenIssueLookups.add(1);
      const synced = yield* tasks.sync({ projectId: PROJECT_ID, cwd: "/tmp/widgets" });

      const byTaskId = new Map(synced.tasks.map((task) => [task.taskId, task]));
      assert.strictEqual(synced.updatedCount, 1);
      assert.strictEqual(byTaskId.get(deletedIssue.task.taskId)?.status, "todo");
      assert.strictEqual(byTaskId.get(survivingIssue.task.taskId)?.status, "done");
    }),
  );

  it.effect("fails sync when an issue lookup has a non-not-found command error", () =>
    Effect.gen(function* () {
      const tasks = yield* ProjectTaskService;
      const PROJECT_ID = nextProjectId();
      issueNumberCounter = 0;
      brokenIssueLookups.clear();
      failedIssueLookups.clear();

      const created = yield* tasks.create({
        projectId: PROJECT_ID,
        title: "Lookup times out",
        kind: "issue",
        cwd: "/tmp/widgets",
      });
      failedIssueLookups.add(created.task.github?.issueNumber ?? -1);

      const error = yield* tasks
        .sync({ projectId: PROJECT_ID, cwd: "/tmp/widgets" })
        .pipe(Effect.flip);
      assert.strictEqual(error.failure, "github_command_failed");
    }),
  );
});
