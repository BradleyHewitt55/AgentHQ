import { assert, describe, it } from "@effect/vitest";

import {
  normalizeOptionName,
  resolveBoardOptionForStatus,
  resolveStatusForBoardOption,
  statusFromIssueState,
} from "./taskBoardStatus.ts";

const DEFAULT_BOARD_OPTIONS = [
  { id: "opt-todo", name: "Todo" },
  { id: "opt-progress", name: "In Progress" },
  { id: "opt-done", name: "Done" },
];

describe("normalizeOptionName", () => {
  it("collapses separators and casing so board names compare equal", () => {
    assert.strictEqual(normalizeOptionName("In-Progress"), "in progress");
    assert.strictEqual(normalizeOptionName("IN_PROGRESS"), "in progress");
    assert.strictEqual(normalizeOptionName("  In   Progress  "), "in progress");
    assert.strictEqual(normalizeOptionName("🚧 In Progress!"), "in progress");
  });
});

describe("resolveBoardOptionForStatus", () => {
  it("maps local statuses onto GitHub's default board columns", () => {
    assert.strictEqual(resolveBoardOptionForStatus("todo", DEFAULT_BOARD_OPTIONS)?.id, "opt-todo");
    assert.strictEqual(
      resolveBoardOptionForStatus("in_progress", DEFAULT_BOARD_OPTIONS)?.id,
      "opt-progress",
    );
    assert.strictEqual(resolveBoardOptionForStatus("done", DEFAULT_BOARD_OPTIONS)?.id, "opt-done");
  });

  it("matches renamed columns through aliases", () => {
    const options = [
      { id: "opt-backlog", name: "Backlog" },
      { id: "opt-doing", name: "Doing" },
      { id: "opt-shipped", name: "Shipped" },
    ];

    assert.strictEqual(resolveBoardOptionForStatus("todo", options)?.id, "opt-backlog");
    assert.strictEqual(resolveBoardOptionForStatus("in_progress", options)?.id, "opt-doing");
    assert.strictEqual(resolveBoardOptionForStatus("done", options)?.id, "opt-shipped");
  });

  it("falls back to a prefix match for suffixed column names", () => {
    const options = [{ id: "opt-progress", name: "In Progress (dev)" }];

    assert.strictEqual(resolveBoardOptionForStatus("in_progress", options)?.id, "opt-progress");
  });

  it("returns null when the board has no comparable column", () => {
    // `in_review` is absent from GitHub's default template.
    assert.strictEqual(resolveBoardOptionForStatus("in_review", DEFAULT_BOARD_OPTIONS), null);
  });
});

describe("resolveStatusForBoardOption", () => {
  it("maps board column names back to local statuses", () => {
    assert.strictEqual(resolveStatusForBoardOption("Todo"), "todo");
    assert.strictEqual(resolveStatusForBoardOption("In Progress"), "in_progress");
    assert.strictEqual(resolveStatusForBoardOption("In Review"), "in_review");
    assert.strictEqual(resolveStatusForBoardOption("Done"), "done");
  });

  it("returns null for columns with no local equivalent", () => {
    assert.strictEqual(resolveStatusForBoardOption("Icebox"), null);
    assert.strictEqual(resolveStatusForBoardOption(""), null);
  });
});

describe("statusFromIssueState", () => {
  it("treats a closed issue as done regardless of local status", () => {
    assert.strictEqual(statusFromIssueState("closed", "in_progress"), "done");
  });

  it("preserves local status for open issues", () => {
    assert.strictEqual(statusFromIssueState("open", "in_progress"), "in_progress");
    assert.strictEqual(statusFromIssueState("open", "in_review"), "in_review");
  });

  it("pulls a reopened issue out of the done column", () => {
    assert.strictEqual(statusFromIssueState("open", "done"), "todo");
  });
});
