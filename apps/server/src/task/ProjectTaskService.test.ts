import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectId, TaskId } from "@t3tools/contracts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import type { GitHubProjectItemSnapshot, GitHubRepositoryContext } from "./GitHubProjectsApi.ts";
import * as GitHubProjectsApiModule from "./GitHubProjectsApi.ts";
import * as ProjectTaskServiceModule from "./ProjectTaskService.ts";

const ProjectTaskService = ProjectTaskServiceModule.ProjectTaskService;

const projectId = ProjectId.make("proj-1");

function draftSnapshot(
  overrides: Partial<GitHubProjectItemSnapshot> = {},
): GitHubProjectItemSnapshot {
  return {
    itemId: "PVTI_draft_1",
    itemType: "draft",
    contentNodeId: "DI_1",
    title: "Draft task",
    body: "",
    number: null,
    url: null,
    state: null,
    repositoryNameWithOwner: null,
    statusName: "Todo",
    createdAt: "2026-08-01T10:00:00Z",
    updatedAt: "2026-08-01T10:00:00Z",
    ...overrides,
  };
}

function issueSnapshot(
  overrides: Partial<GitHubProjectItemSnapshot> = {},
): GitHubProjectItemSnapshot {
  return {
    itemId: "PVTI_issue_1",
    itemType: "issue",
    contentNodeId: "I_1",
    title: "Issue task",
    body: "",
    number: 12,
    url: "https://github.com/acme/widgets/issues/12",
    state: "open",
    repositoryNameWithOwner: "acme/widgets",
    statusName: "Done",
    createdAt: "2026-08-02T10:00:00Z",
    updatedAt: "2026-08-02T10:00:00Z",
    ...overrides,
  };
}

const REPOSITORY: GitHubRepositoryContext = {
  nameWithOwner: "acme/widgets",
  ownerLogin: "acme",
  repositoryNodeId: "R_1",
};

const BOARD = {
  projectNodeId: "PROJ_1",
  projectNumber: 3,
  ownerLogin: "acme",
  title: "Widgets Board",
  statusFieldId: "SF_status",
  statusOptions: [
    { id: "OPT_todo", name: "Todo" },
    { id: "OPT_done", name: "Done" },
  ],
};

type GitHubProjectsApiShape = GitHubProjectsApiModule.GitHubProjectsApi["Service"];

function apiMocks(overrides: Partial<GitHubProjectsApiShape> = {}) {
  return {
    resolveRepository: vi.fn(() => Effect.succeed(REPOSITORY)),
    resolveProjects: vi.fn(() => Effect.succeed([BOARD])),
    fetchStatusField: vi.fn(() =>
      Effect.succeed({ statusFieldId: BOARD.statusFieldId, options: BOARD.statusOptions }),
    ),
    listItems: vi.fn(() => Effect.succeed([])),
    fetchItem: vi.fn(() => Effect.succeed(null)),
    addDraftIssue: vi.fn(() => Effect.succeed(null)),
    addIssueToProject: vi.fn(() => Effect.succeed(null)),
    convertDraftToIssue: vi.fn(() => Effect.succeed(null)),
    deleteItem: vi.fn(() => Effect.void),
    setItemStatus: vi.fn(() => Effect.succeed(true)),
    createIssue: vi.fn(() =>
      Effect.succeed({
        nodeId: "I_new",
        number: 13,
        url: "https://github.com/acme/widgets/issues/13",
      }),
    ),
    ...overrides,
  } satisfies GitHubProjectsApiShape;
}

/** Build the real service over mocked GitHub access; no persistence anywhere. */
const serviceWith = (mocks: GitHubProjectsApiShape) =>
  Layer.effect(ProjectTaskServiceModule.ProjectTaskService, ProjectTaskServiceModule.make).pipe(
    Layer.provide(Layer.mock(GitHubProjectsApiModule.GitHubProjectsApi)(mocks)),
  );

describe("ProjectTaskService.list", () => {
  it.effect("maps mixed DraftIssue and Issue items onto one board", () =>
    Effect.gen(function* () {
      const service = yield* ProjectTaskService;
      const result = yield* service.list({ projectId, cwd: "/repo" });

      // The resolved board and every candidate come back so clients can offer a picker.
      expect(result.project).toMatchObject({ projectNodeId: "PROJ_1", title: "Widgets Board" });
      expect(result.projects).toHaveLength(1);
      expect(result.tasks.map((task) => [task.kind, task.status])).toEqual([
        ["draft", "todo"],
        ["draft", "todo"],
        ["issue", "done"],
      ]);
      const issue = result.tasks[2]!;
      expect(issue.taskId).toBe(TaskId.make("PVTI_issue_1"));
      expect(issue.repository).toBe("acme/widgets");
      expect(issue.number).toBe(12);
      expect(issue.url).toContain("/issues/12");
      const draft = result.tasks[0]!;
      expect(draft.number).toBeNull();
      expect(draft.url).toBeNull();
    }).pipe(
      Effect.provide(
        serviceWith(
          apiMocks({
            listItems: vi.fn(() =>
              Effect.succeed([
                issueSnapshot(),
                draftSnapshot(),
                draftSnapshot({ itemId: "PVTI_draft_2" }),
              ]),
            ),
          }),
        ),
      ),
    ),
  );

  it.effect("honors an explicit board selection", () =>
    Effect.gen(function* () {
      const service = yield* ProjectTaskService;
      const result = yield* service.list({
        projectId,
        cwd: "/repo",
        projectNodeId: "PROJ_2",
      });

      expect(result.project?.projectNodeId).toBe("PROJ_2");
      expect(result.tasks[0]!.projectNodeId).toBe("PROJ_2");
    }).pipe(
      Effect.provide(
        serviceWith(
          apiMocks({
            resolveProjects: vi.fn(() =>
              Effect.succeed([
                BOARD,
                {
                  ...BOARD,
                  projectNodeId: "PROJ_2",
                  title: "Roadmap",
                  statusFieldId: null,
                  statusOptions: [],
                },
              ]),
            ),
            listItems: vi.fn(() => Effect.succeed([draftSnapshot()])),
          }),
        ),
      ),
    ),
  );

  it.effect("returns an empty board when the workspace exposes no candidates", () =>
    Effect.gen(function* () {
      const service = yield* ProjectTaskService;
      const result = yield* service.list({ projectId, cwd: "/repo" });

      expect(result.project).toBeNull();
      expect(result.tasks).toEqual([]);
    }).pipe(
      Effect.provide(serviceWith(apiMocks({ resolveProjects: vi.fn(() => Effect.succeed([])) }))),
    ),
  );

  // Regression: the board must be the one linked to *this* project's
  // workspace repository. A board resolved without the repository context (or
  // the first candidate regardless of its columns) silently detaches every
  // task from the project's configured GitHub Projects connection.
  it.effect("scopes the default board to the workspace repository's linked candidates", () => {
    const mocks = apiMocks({
      resolveProjects: vi.fn(() =>
        Effect.succeed([
          {
            ...BOARD,
            projectNodeId: "PROJ_NO_STATUS",
            title: "Notes",
            statusFieldId: null,
            statusOptions: [],
          },
          BOARD,
        ]),
      ),
      listItems: vi.fn(() => Effect.succeed([draftSnapshot()])),
    });
    return Effect.gen(function* () {
      const service = yield* ProjectTaskService;
      const result = yield* service.list({ projectId, cwd: "/repo" });

      expect(mocks.resolveRepository).toHaveBeenCalledWith({ cwd: "/repo" });
      expect(mocks.resolveProjects).toHaveBeenCalledWith({ cwd: "/repo", repository: REPOSITORY });
      // The candidate with a writable Status column wins the default pick, and
      // the items are read from that board rather than the first candidate.
      expect(result.project?.projectNodeId).toBe("PROJ_1");
      expect(mocks.listItems).toHaveBeenCalledWith({ cwd: "/repo", projectNodeId: "PROJ_1" });
      expect(result.projects.map((project) => project.projectNodeId)).toEqual([
        "PROJ_NO_STATUS",
        "PROJ_1",
      ]);
      expect(result.tasks[0]!.projectNodeId).toBe("PROJ_1");
    }).pipe(Effect.provide(serviceWith(mocks)));
  });

  it.effect("fails when the workspace has no linked GitHub repository", () =>
    Effect.gen(function* () {
      const service = yield* ProjectTaskService;
      const error = yield* Effect.flip(service.list({ projectId, cwd: "/nope" }));

      expect(error.failure).toBe("repository_not_linked");
    }).pipe(
      Effect.provide(
        serviceWith(apiMocks({ resolveRepository: vi.fn(() => Effect.succeed(null)) })),
      ),
    ),
  );
});

describe("ProjectTaskService.create", () => {
  it.effect("creates a Project-native draft directly on the board", () =>
    Effect.gen(function* () {
      const service = yield* ProjectTaskService;
      const result = yield* service.create({
        projectId,
        cwd: "/repo",
        title: "Fresh draft",
        body: "hello",
        kind: "draft",
      });

      expect(result.task).toMatchObject({ kind: "draft", title: "Fresh draft", number: null });
    }).pipe(
      Effect.provide(
        serviceWith(
          apiMocks({
            addDraftIssue: vi.fn(() => Effect.succeed(draftSnapshot({ title: "Fresh draft" }))),
          }),
        ),
      ),
    ),
  );

  it.effect("creates a repository issue and adds it to the board by node id", () =>
    Effect.gen(function* () {
      const service = yield* ProjectTaskService;
      const result = yield* service.create({
        projectId,
        cwd: "/repo",
        title: "Filed issue",
        kind: "issue",
      });

      expect(result.task).toMatchObject({ kind: "issue", repository: "acme/widgets" });
    }).pipe(
      Effect.provide(
        serviceWith(
          apiMocks({
            addIssueToProject: vi.fn(() =>
              Effect.succeed(issueSnapshot({ itemId: "PVTI_issue_new" })),
            ),
          }),
        ),
      ),
    ),
  );

  it.effect("never touches a local store while creating", () =>
    Effect.gen(function* () {
      // The service context contains only the GitHub adapter: there is no SQL
      // dependency left to invoke. Building the service here proves that by
      // construction; the wiring test below proves it for the live layer too.
      const service = yield* ProjectTaskService;
      yield* service.create({ projectId, cwd: "/repo", title: "Whatever", kind: "draft" });
    }).pipe(
      Effect.provide(
        serviceWith(
          apiMocks({
            addDraftIssue: vi.fn(() => Effect.succeed(draftSnapshot())),
          }),
        ),
      ),
    ),
  );
});

describe("ProjectTaskService.update", () => {
  const updateMocks = apiMocks({
    fetchItem: vi.fn(() => Effect.succeed(issueSnapshot({ statusName: "Done" }))),
  });

  it.effect("writes column moves to the board Status field and refetches the item", () =>
    Effect.gen(function* () {
      const service = yield* ProjectTaskService;
      const result = yield* service.update({
        projectId,
        cwd: "/repo",
        taskId: TaskId.make("PVTI_issue_1"),
        status: "done",
      });

      expect(updateMocks.setItemStatus).toHaveBeenCalledWith({
        cwd: "/repo",
        projectNodeId: "PROJ_1",
        itemId: "PVTI_issue_1",
        status: "done",
        field: { statusFieldId: "SF_status", options: BOARD.statusOptions },
      });
      expect(result.task.status).toBe("done");
    }).pipe(Effect.provide(serviceWith(updateMocks))),
  );

  // Regression: a column move with no explicit selection must land on the same
  // repository-linked board the list resolved, not on an unrelated candidate.
  it.effect("moves columns on the workspace's resolved board when no board is named", () => {
    const mocks = apiMocks({
      resolveProjects: vi.fn(() =>
        Effect.succeed([
          {
            ...BOARD,
            projectNodeId: "PROJ_NO_STATUS",
            title: "Notes",
            statusFieldId: null,
            statusOptions: [],
          },
          BOARD,
        ]),
      ),
      fetchItem: vi.fn(() => Effect.succeed(issueSnapshot({ statusName: "Done" }))),
    });
    return Effect.gen(function* () {
      const service = yield* ProjectTaskService;
      const result = yield* service.update({
        projectId,
        cwd: "/repo",
        taskId: TaskId.make("PVTI_issue_1"),
        status: "done",
      });

      expect(mocks.setItemStatus).toHaveBeenCalledWith({
        cwd: "/repo",
        projectNodeId: "PROJ_1",
        itemId: "PVTI_issue_1",
        status: "done",
        field: { statusFieldId: "SF_status", options: BOARD.statusOptions },
      });
      expect(result.task.projectNodeId).toBe("PROJ_1");
    }).pipe(Effect.provide(serviceWith(mocks)));
  });

  it.effect("fails clearly when the board has no Status field", () =>
    Effect.gen(function* () {
      const service = yield* ProjectTaskService;
      const error = yield* Effect.flip(
        service.update({
          projectId,
          cwd: "/repo",
          taskId: TaskId.make("PVTI_1"),
          status: "todo",
        }),
      );

      expect(error.failure).toBe("github_command_failed");
    }).pipe(
      Effect.provide(
        serviceWith(
          apiMocks({
            resolveProjects: vi.fn(() =>
              Effect.succeed([{ ...BOARD, statusFieldId: null, statusOptions: [] }]),
            ),
            setItemStatus: vi.fn(() => Effect.succeed(true)),
          }),
        ),
      ),
    ),
  );
});

describe("ProjectTaskService.remove and promote", () => {
  it.effect("removes only the Project item", () =>
    Effect.gen(function* () {
      const service = yield* ProjectTaskService;
      yield* service.remove({ projectId, cwd: "/repo", taskId: TaskId.make("PVTI_draft_1") });
    }).pipe(Effect.provide(serviceWith(apiMocks()))),
  );

  it.effect("converts drafts into issues through GitHub keeping the same item id", () =>
    Effect.gen(function* () {
      const service = yield* ProjectTaskService;
      const result = yield* service.promote({
        projectId,
        cwd: "/repo",
        taskId: TaskId.make("PVTI_draft_1"),
      });

      expect(result.task.taskId).toBe(TaskId.make("PVTI_draft_1"));
      expect(result.task.kind).toBe("issue");
      expect(result.task.number).toBe(44);
    }).pipe(
      Effect.provide(
        serviceWith(
          apiMocks({
            convertDraftToIssue: vi.fn((input: { readonly itemId: string }) =>
              Effect.succeed(
                issueSnapshot({
                  itemId: input.itemId,
                  title: "Promoted draft",
                  number: 44,
                  url: "https://github.com/acme/widgets/issues/44",
                }),
              ),
            ),
          }),
        ),
      ),
    ),
  );
});

describe("ProjectTaskService wiring", () => {
  it.effect("builds without any local SQL dependency and surfaces gh failures as task errors", () =>
    Effect.gen(function* () {
      const service = yield* ProjectTaskService;
      const error = yield* Effect.flip(service.list({ projectId, cwd: "/repo" }));

      expect(error.failure).toBe("github_unavailable");
    }).pipe(
      Effect.provide(
        // Real adapter, mocked `gh`: proves the live wiring needs nothing but
        // the GitHub CLI — no SqlClient in the dependency chain.
        Layer.effect(
          ProjectTaskServiceModule.ProjectTaskService,
          ProjectTaskServiceModule.make,
        ).pipe(
          Layer.provide(
            GitHubProjectsApiModule.layer.pipe(
              Layer.provide(
                Layer.mock(GitHubCli.GitHubCli)({
                  execute: () =>
                    Effect.fail(
                      new GitHubCli.GitHubCliUnavailableError({
                        command: "gh",
                        cwd: "/repo",
                        cause: new Error("spawn"),
                      }),
                    ),
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});
