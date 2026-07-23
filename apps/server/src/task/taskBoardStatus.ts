/**
 * Mapping between local kanban statuses and GitHub Projects v2 "Status"
 * single-select options.
 *
 * Board option names are user-configurable, so matching is normalized
 * (case/punctuation insensitive) and falls back to a per-status alias list
 * before giving up. Nothing here performs IO, so it is unit testable.
 */
import type { TaskStatus } from "@t3tools/contracts";

export interface BoardSingleSelectOption {
  readonly id: string;
  readonly name: string;
}

/**
 * Aliases per status, most preferred first. GitHub's default board template
 * uses "Todo"/"In Progress"/"In Review"/"Done".
 */
const STATUS_ALIASES: Record<TaskStatus, ReadonlyArray<string>> = {
  todo: ["todo", "to do", "backlog", "open", "new", "ready"],
  in_progress: ["in progress", "inprogress", "doing", "started", "active"],
  in_review: ["in review", "inreview", "review", "needs review", "awaiting review"],
  done: ["done", "closed", "complete", "completed", "shipped"],
};

/** Lowercase and collapse separators so "In-Progress" matches "in progress". */
export function normalizeOptionName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[_\-/]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve the board option that represents `status`, or `null` when the board
 * has no comparable column.
 */
export function resolveBoardOptionForStatus(
  status: TaskStatus,
  options: ReadonlyArray<BoardSingleSelectOption>,
): BoardSingleSelectOption | null {
  const normalized = options.map((option) => ({
    option,
    normalizedName: normalizeOptionName(option.name),
  }));

  for (const alias of STATUS_ALIASES[status]) {
    const match = normalized.find((entry) => entry.normalizedName === alias);
    if (match) return match.option;
  }

  // Prefix match catches boards using names like "In Progress (dev)".
  for (const alias of STATUS_ALIASES[status]) {
    const match = normalized.find((entry) => entry.normalizedName.startsWith(alias));
    if (match) return match.option;
  }

  return null;
}

/**
 * Resolve the local status a board option represents, or `null` when the
 * option does not correspond to any local column.
 */
export function resolveStatusForBoardOption(optionName: string): TaskStatus | null {
  const normalized = normalizeOptionName(optionName);
  if (normalized === "") return null;

  for (const [status, aliases] of Object.entries(STATUS_ALIASES) as ReadonlyArray<
    readonly [TaskStatus, ReadonlyArray<string>]
  >) {
    if (aliases.includes(normalized)) return status;
  }

  for (const [status, aliases] of Object.entries(STATUS_ALIASES) as ReadonlyArray<
    readonly [TaskStatus, ReadonlyArray<string>]
  >) {
    if (aliases.some((alias) => normalized.startsWith(alias))) return status;
  }

  return null;
}

/**
 * Status implied by an issue's open/closed state, used when the repository has
 * no Projects v2 board to read a column from.
 *
 * A closed issue is always `done`. An open issue keeps its local status unless
 * that status was `done`, which would otherwise strand a reopened issue in the
 * done column.
 */
export function statusFromIssueState(
  issueState: "open" | "closed",
  localStatus: TaskStatus,
): TaskStatus {
  if (issueState === "closed") return "done";
  return localStatus === "done" ? "todo" : localStatus;
}
