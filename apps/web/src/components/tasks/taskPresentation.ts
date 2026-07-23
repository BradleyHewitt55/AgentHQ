/**
 * Pure presentation helpers for project tasks.
 *
 * Kept free of React and RPC so the board's labelling, filtering, and
 * hand-off prompt construction can be unit tested directly.
 */
import { TASK_STATUSES, type Task, type TaskStatus } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};

export const TASK_BOARD_COLUMNS: ReadonlyArray<{
  readonly status: TaskStatus;
  readonly label: string;
}> = TASK_STATUSES.map((status) => ({ status, label: TASK_STATUS_LABELS[status] }));

/** Narrow a menu selection, which arrives untyped, to a board column. */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as ReadonlyArray<string>).includes(value);
}

/**
 * Tasks the top-bar quick action surfaces as "running" — work an agent has
 * picked up but not finished.
 */
export function selectRunningTasks(tasks: ReadonlyArray<Task>): ReadonlyArray<Task> {
  return tasks.filter((task) => task.status === "in_progress");
}

/** Counts shown on the quick action badge and column headers. */
export function countTasksByStatus(tasks: ReadonlyArray<Task>): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    todo: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
  };
  for (const task of tasks) {
    counts[task.status] += 1;
  }
  return counts;
}

/** Short GitHub reference for a task, or `null` for a local-only draft. */
export function taskIssueLabel(task: Task): string | null {
  return task.github === null ? null : `#${task.github.issueNumber}`;
}

/**
 * A draft can be promoted only when it is not already linked to an issue.
 * Promotion additionally requires a linked repository, which the caller knows.
 */
export function canPromoteTask(task: Task): boolean {
  return task.kind === "draft" && task.github === null;
}

/**
 * Task mutations settle into a result instead of throwing, so a caller that
 * only clears its input on success has to inspect the result. `null` is the
 * "never ran" case (no project or environment selected).
 */
export function taskCommandSucceeded(
  result: AsyncResult.AsyncResult<unknown, unknown> | null,
): boolean {
  return result !== null && AsyncResult.isSuccess(result);
}

/**
 * Handing a task to an agent moves it into `in_progress`. A task already there
 * or further along keeps its column so re-sending context does not regress it.
 */
export function statusAfterHandoff(task: Task): TaskStatus {
  return task.status === "todo" ? "in_progress" : task.status;
}

/**
 * Prompt seeded into the composer when a task is passed to an agent. The issue
 * reference is included when present so the agent can look it up.
 */
export function buildTaskHandoffPrompt(task: Task): string {
  const reference = taskIssueLabel(task);
  const heading = reference === null ? task.title : `${task.title} (${reference})`;
  const lines = [`Work on this task: ${heading}`];

  const body = task.body.trim();
  if (body !== "") {
    lines.push("", body);
  }
  if (task.github !== null) {
    lines.push("", `GitHub issue: ${task.github.issueUrl}`);
  }
  return lines.join("\n");
}
