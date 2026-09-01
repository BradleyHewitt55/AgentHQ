import { TaskId, type Task } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTaskHandoffPrompt,
  buildTaskHandoffPromptBatch,
  canPromoteTask,
  countTasksByStatus,
  selectRunningTasks,
  statusAfterHandoff,
  taskCommandSucceeded,
  taskIssueLabel,
} from "./taskPresentation";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: TaskId.make("PVTI_1"),
    projectNodeId: "PVTPROJ_1",
    title: "Fix the login redirect",
    body: "",
    kind: "draft",
    status: "todo",
    repository: null,
    number: null,
    url: null,
    state: null,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    ...overrides,
  };
}

function makeLinkedTask(overrides: Partial<Task> = {}): Task {
  return makeTask({
    kind: "issue",
    repository: "acme/widgets",
    number: 42,
    url: "https://github.com/acme/widgets/issues/42",
    state: "open",
    ...overrides,
  });
}

describe("selectRunningTasks", () => {
  it("returns only tasks an agent is working on", () => {
    const tasks = [
      makeTask({ taskId: TaskId.make("task-todo"), status: "todo" }),
      makeTask({ taskId: TaskId.make("task-running"), status: "in_progress" }),
      makeTask({ taskId: TaskId.make("task-done"), status: "done" }),
    ];

    expect(selectRunningTasks(tasks).map((task) => task.taskId)).toEqual(["task-running"]);
  });
});

describe("countTasksByStatus", () => {
  it("counts every column, including empty ones", () => {
    const tasks = [
      makeTask({ taskId: TaskId.make("a"), status: "todo" }),
      makeTask({ taskId: TaskId.make("b"), status: "todo" }),
      makeTask({ taskId: TaskId.make("c"), status: "in_progress" }),
    ];

    expect(countTasksByStatus(tasks)).toEqual({
      todo: 2,
      in_progress: 1,
      in_review: 0,
      done: 0,
    });
  });
});

describe("taskIssueLabel", () => {
  it("labels repository-backed tasks with their issue number", () => {
    expect(taskIssueLabel(makeLinkedTask())).toBe("#42");
  });

  it("returns null for a Project draft", () => {
    expect(taskIssueLabel(makeTask())).toBeNull();
  });
});

describe("canPromoteTask", () => {
  it("allows converting a draft", () => {
    expect(canPromoteTask(makeTask())).toBe(true);
  });

  it("refuses a task that is already an issue", () => {
    expect(canPromoteTask(makeLinkedTask())).toBe(false);
  });
});

describe("taskCommandSucceeded", () => {
  it("accepts a settled success", () => {
    expect(taskCommandSucceeded(AsyncResult.success({ task: makeTask() }))).toBe(true);
  });

  it("rejects a failure, which a command settles into instead of throwing", () => {
    expect(taskCommandSucceeded(AsyncResult.failure(Cause.fail("repository_not_linked")))).toBe(
      false,
    );
  });

  it("rejects a command that never ran", () => {
    expect(taskCommandSucceeded(null)).toBe(false);
  });
});

describe("statusAfterHandoff", () => {
  it("moves a todo task into in_progress", () => {
    expect(statusAfterHandoff(makeTask({ status: "todo" }))).toBe("in_progress");
  });

  it("does not regress a task that is already further along", () => {
    expect(statusAfterHandoff(makeTask({ status: "in_review" }))).toBe("in_review");
    expect(statusAfterHandoff(makeTask({ status: "in_progress" }))).toBe("in_progress");
  });
});

describe("buildTaskHandoffPrompt", () => {
  it("includes the title and body for a local draft", () => {
    const prompt = buildTaskHandoffPrompt(
      makeTask({ body: "The redirect drops the query string." }),
    );

    expect(prompt).toBe(
      "Work on this task: Fix the login redirect\n\nThe redirect drops the query string.",
    );
  });

  it("includes the issue reference and url when linked", () => {
    const prompt = buildTaskHandoffPrompt(makeLinkedTask());

    expect(prompt).toBe(
      "Work on this task: Fix the login redirect (#42)\n\nGitHub issue: https://github.com/acme/widgets/issues/42",
    );
  });

  it("omits an empty body", () => {
    expect(buildTaskHandoffPrompt(makeTask({ body: "   " }))).toBe(
      "Work on this task: Fix the login redirect",
    );
  });
});

describe("buildTaskHandoffPromptBatch", () => {
  it("returns an empty prompt for no tasks", () => {
    expect(buildTaskHandoffPromptBatch([])).toBe("");
  });

  it("falls back to the single-task prompt for one task", () => {
    const task = makeTask({ body: "The redirect drops the query string." });
    expect(buildTaskHandoffPromptBatch([task])).toBe(buildTaskHandoffPrompt(task));
  });

  it("numbers each task and keeps bodies and issue references", () => {
    const prompt = buildTaskHandoffPromptBatch([
      makeTask({ taskId: TaskId.make("PVTI_1"), title: "Fix the redirect", body: "Loses query." }),
      makeTask({
        taskId: TaskId.make("PVTI_2"),
        title: "Ship the banner",
        kind: "issue",
        repository: "acme/widgets",
        number: 42,
        url: "https://github.com/acme/widgets/issues/42",
        state: "open",
      }),
    ]);

    expect(prompt).toBe(
      [
        "Work on these tasks:",
        "",
        "1. Fix the redirect",
        "",
        "Loses query.",
        "",
        "2. Ship the banner (#42)",
        "",
        "GitHub issue: https://github.com/acme/widgets/issues/42",
      ].join("\n"),
    );
  });
});
