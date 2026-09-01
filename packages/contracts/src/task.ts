/**
 * Project task contracts.
 *
 * Tasks are GitHub Projects v2 items; GitHub is the source of truth and
 * nothing about a task is stored locally. A `draft` is a Project-native
 * DraftIssue that belongs to no repository, while `issue` and `pull_request`
 * items carry their repository, number, url, and lifecycle state.
 */
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  TaskId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const TASK_TITLE_MAX_LENGTH = 512;
const TASK_BODY_MAX_LENGTH = 32_000;

/**
 * What a Project item contains. A `draft` exists only inside the Project;
 * `issue` and `pull_request` are backed by repository content that was added
 * to the Project.
 */
export const TaskKind = Schema.Literals(["draft", "issue", "pull_request"]);
export type TaskKind = typeof TaskKind.Type;

/** Kinds a caller can create. Issues are filed in the workspace repository. */
export const TaskCreatableKind = Schema.Literals(["draft", "issue"]);
export type TaskCreatableKind = typeof TaskCreatableKind.Type;

/**
 * Kanban column, derived from the Project's "Status" single-select field when
 * it has one, or from the content's open/closed state otherwise.
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

/** Lifecycle of repository-backed content; drafts have none. */
export const TaskState = Schema.Literals(["open", "closed"]);
export type TaskState = typeof TaskState.Type;

/** A Projects v2 board usable as a Tasks source. */
export const TaskProjectRef = Schema.Struct({
  /** GraphQL node id of the ProjectV2. */
  projectNodeId: TrimmedNonEmptyString,
  ownerLogin: TrimmedNonEmptyString,
  projectNumber: PositiveInt,
  title: TrimmedNonEmptyString,
});
export type TaskProjectRef = typeof TaskProjectRef.Type;

export const Task = Schema.Struct({
  /** Projects v2 item node id — the stable identity on GitHub. */
  taskId: TaskId,
  /** Node id of the ProjectV2 owning this item. */
  projectNodeId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(TASK_TITLE_MAX_LENGTH)),
  body: Schema.String.check(Schema.isMaxLength(TASK_BODY_MAX_LENGTH)),
  kind: TaskKind,
  status: TaskStatus,
  /** `owner/repo` for issue/pull_request items; null for drafts. */
  repository: Schema.NullOr(TrimmedNonEmptyString),
  /** Issue or pull request number; null for drafts. */
  number: Schema.NullOr(PositiveInt),
  /** HTML url for issue/pull_request items; null for drafts. */
  url: Schema.NullOr(TrimmedNonEmptyString),
  /** Open/closed lifecycle for issue/pull_request items; null for drafts. */
  state: Schema.NullOr(TaskState),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Task = typeof Task.Type;

export const TaskListInput = Schema.Struct({
  projectId: ProjectId,
  /** Workspace root of the local project; anchors `gh` auth and repo lookups. */
  cwd: TrimmedNonEmptyString,
  /**
   * Explicit Projects v2 selection. When absent the server resolves candidates
   * from the Projects v2 boards linked to the workspace's repository. If the
   * repository has no linked board the result is empty and the UI shows
   * "No project located".
   */
  projectNodeId: Schema.optional(TrimmedNonEmptyString),
});
export type TaskListInput = typeof TaskListInput.Type;

export const TaskListResult = Schema.Struct({
  /** The board backing these tasks: the explicit pick or the resolved default. */
  project: Schema.NullOr(TaskProjectRef),
  /** Every candidate board found for the workspace, for client-side pickers. */
  projects: Schema.Array(TaskProjectRef),
  tasks: Schema.Array(Task),
});
export type TaskListResult = typeof TaskListResult.Type;

export const TaskCreateInput = Schema.Struct({
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(TASK_TITLE_MAX_LENGTH)),
  body: Schema.optional(Schema.String.check(Schema.isMaxLength(TASK_BODY_MAX_LENGTH))),
  kind: TaskCreatableKind,
  projectNodeId: Schema.optional(TrimmedNonEmptyString),
});
export type TaskCreateInput = typeof TaskCreateInput.Type;

/**
 * Move an item between board columns. Text edits happen on GitHub; the app
 * only rewrites the Project's "Status" field.
 */
export const TaskUpdateInput = Schema.Struct({
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  /** Projects v2 item node id. */
  taskId: TaskId,
  projectNodeId: Schema.optional(TrimmedNonEmptyString),
  status: TaskStatus,
});
export type TaskUpdateInput = typeof TaskUpdateInput.Type;

export const TaskDeleteInput = Schema.Struct({
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  /** Projects v2 item node id. Removing an item never deletes its issue. */
  taskId: TaskId,
  projectNodeId: Schema.optional(TrimmedNonEmptyString),
});
export type TaskDeleteInput = typeof TaskDeleteInput.Type;

/**
 * Convert a draft item into a real repository issue through the Project's own
 * conversion mutation, which keeps the same Project item.
 */
export const TaskPromoteInput = Schema.Struct({
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  /** Projects v2 item node id of the draft. */
  taskId: TaskId,
  projectNodeId: Schema.optional(TrimmedNonEmptyString),
});
export type TaskPromoteInput = typeof TaskPromoteInput.Type;

export const TaskMutationResult = Schema.Struct({
  task: Task,
});
export type TaskMutationResult = typeof TaskMutationResult.Type;

export const TaskFailure = Schema.Literals([
  "task_not_found",
  "project_not_found",
  "draft_not_promotable",
  "repository_not_linked",
  "github_unavailable",
  "github_unauthenticated",
  "github_scopes_missing",
  "github_command_failed",
]);
export type TaskFailure = typeof TaskFailure.Type;

export class TasksError extends Schema.TaggedErrorClass<TasksError>()("TasksError", {
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
