/**
 * Project task contracts.
 *
 * Tasks are project-scoped work items persisted locally in SQLite so they work
 * without any linked repository. A task optionally carries a GitHub link: an
 * issue (`issueNumber`/`issueUrl`) and a GitHub Projects v2 board item
 * (`projectItemId`). Local storage stays authoritative; GitHub is written on an
 * explicit promote/push and read back on an explicit sync.
 */
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const TASK_TITLE_MAX_LENGTH = 512;
const TASK_BODY_MAX_LENGTH = 32_000;

/**
 * Where a task lives. A `draft` exists only in the local store; an `issue` has
 * been promoted and is expected to have a GitHub counterpart once a repository
 * is linked.
 */
export const TaskKind = Schema.Literals(["draft", "issue"]);
export type TaskKind = typeof TaskKind.Type;

/**
 * Kanban column. Independent of {@link TaskKind} — a draft and an issue can
 * both sit in `todo`.
 */
export const TaskStatus = Schema.Literals(["todo", "in_progress", "in_review", "done"]);
export type TaskStatus = typeof TaskStatus.Type;

/** Ordered kanban columns, left to right. */
export const TASK_STATUSES = [
  "todo",
  "in_progress",
  "in_review",
  "done",
] as const satisfies ReadonlyArray<TaskStatus>;

export const TaskGitHubLink = Schema.Struct({
  /** `owner/repo` the issue belongs to. */
  nameWithOwner: TrimmedNonEmptyString,
  issueNumber: PositiveInt,
  issueUrl: TrimmedNonEmptyString,
  /** GraphQL node id of the issue, needed to add it to a Projects v2 board. */
  issueNodeId: Schema.NullOr(TrimmedNonEmptyString),
  /** Projects v2 item id, present once the issue is on a board. */
  projectItemId: Schema.NullOr(TrimmedNonEmptyString),
  /** Projects v2 project node id owning `projectItemId`. */
  projectNodeId: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * Title and body as last written to the issue. Local text is only pushed
   * when it differs from these, so moving a task between columns does not
   * rewrite the issue. Absent on links written before this was tracked, which
   * makes the next push write the text once.
   */
  pushedTitle: Schema.optional(Schema.String),
  pushedBody: Schema.optional(Schema.String),
  lastSyncedAt: Schema.NullOr(IsoDateTime),
});
export type TaskGitHubLink = typeof TaskGitHubLink.Type;

export const Task = Schema.Struct({
  taskId: TaskId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(TASK_TITLE_MAX_LENGTH)),
  body: Schema.String.check(Schema.isMaxLength(TASK_BODY_MAX_LENGTH)),
  kind: TaskKind,
  status: TaskStatus,
  /** Manual ordering within a kanban column. */
  position: NonNegativeInt,
  /** Thread the task was handed to, set when passed to an agent. */
  threadId: Schema.NullOr(ThreadId),
  github: Schema.NullOr(TaskGitHubLink),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Task = typeof Task.Type;

export const TaskListInput = Schema.Struct({
  projectId: ProjectId,
});
export type TaskListInput = typeof TaskListInput.Type;

export const TaskListResult = Schema.Struct({
  tasks: Schema.Array(Task),
});
export type TaskListResult = typeof TaskListResult.Type;

export const TaskCreateInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(TASK_TITLE_MAX_LENGTH)),
  body: Schema.optional(Schema.String.check(Schema.isMaxLength(TASK_BODY_MAX_LENGTH))),
  kind: TaskKind,
  status: Schema.optional(TaskStatus),
  /**
   * Workspace root of the project. Required when `kind` is `issue` so the
   * server can create the GitHub issue through `gh` in that repository; an
   * `issue` requested without one is stored as a draft that can be promoted.
   */
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type TaskCreateInput = typeof TaskCreateInput.Type;

export const TaskUpdateInput = Schema.Struct({
  taskId: TaskId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(TASK_TITLE_MAX_LENGTH))),
  body: Schema.optional(Schema.String.check(Schema.isMaxLength(TASK_BODY_MAX_LENGTH))),
  status: Schema.optional(TaskStatus),
  position: Schema.optional(NonNegativeInt),
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  /**
   * When set, mirror the resulting status/closed state to GitHub. Requires
   * `cwd`; ignored for tasks without a GitHub link.
   */
  pushToGitHub: Schema.optional(Schema.Boolean),
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type TaskUpdateInput = typeof TaskUpdateInput.Type;

export const TaskDeleteInput = Schema.Struct({
  taskId: TaskId,
  projectId: ProjectId,
});
export type TaskDeleteInput = typeof TaskDeleteInput.Type;

/**
 * Promote a local draft into a real GitHub issue and, when the repository has
 * a Projects v2 board, add it to that board.
 */
export const TaskPromoteInput = Schema.Struct({
  taskId: TaskId,
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
});
export type TaskPromoteInput = typeof TaskPromoteInput.Type;

export const TaskMutationResult = Schema.Struct({
  task: Task,
  /**
   * Set when the mutation reached GitHub but the issue could not be placed on
   * (or moved within) a Projects v2 board. The issue itself is still linked.
   */
  boardUnavailable: Schema.Boolean,
});
export type TaskMutationResult = typeof TaskMutationResult.Type;

/** Pull issue and board state for a project's linked tasks. */
export const TaskSyncInput = Schema.Struct({
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
});
export type TaskSyncInput = typeof TaskSyncInput.Type;

export const TaskSyncResult = Schema.Struct({
  tasks: Schema.Array(Task),
  /** Tasks whose local state was updated from GitHub. */
  updatedCount: NonNegativeInt,
  /** Set when the repository has no Projects v2 board; issues still sync. */
  boardUnavailable: Schema.Boolean,
});
export type TaskSyncResult = typeof TaskSyncResult.Type;

export const TaskFailure = Schema.Literals([
  "task_not_found",
  "project_not_found",
  "invalid_transition",
  "repository_not_linked",
  "github_unavailable",
  "github_unauthenticated",
  "github_command_failed",
  "storage_failed",
]);
export type TaskFailure = typeof TaskFailure.Type;

export class TaskStoreError extends Schema.TaggedErrorClass<TaskStoreError>()("TaskStoreError", {
  projectId: Schema.optional(TrimmedNonEmptyString),
  taskId: Schema.optional(TrimmedNonEmptyString),
  operation: TrimmedNonEmptyString,
  failure: TaskFailure,
  detail: Schema.optional(TrimmedNonEmptyString),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Task operation ${this.operation} failed (${this.failure})${this.detail ? `: ${this.detail}` : ""}`;
  }
}

export class TaskSyncError extends Schema.TaggedErrorClass<TaskSyncError>()("TaskSyncError", {
  projectId: Schema.optional(TrimmedNonEmptyString),
  taskId: Schema.optional(TrimmedNonEmptyString),
  operation: TrimmedNonEmptyString,
  failure: TaskFailure,
  detail: Schema.optional(TrimmedNonEmptyString),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Task sync ${this.operation} failed (${this.failure})${this.detail ? `: ${this.detail}` : ""}`;
  }
}
