import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubProjectsApiModule from "./GitHubProjectsApi.ts";

const mockedExecute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>();

const TestLayer = GitHubProjectsApiModule.layer.pipe(
  Layer.provide(Layer.mock(GitHubCli.GitHubCli)({ execute: mockedExecute })),
);

function ghOk(stdout: string) {
  return Effect.succeed({
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
}

/** The GraphQL request body the adapter pipes to `gh` through stdin. */
function graphqlRequestBody(input: {
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
}): { readonly query: string; readonly variables: Record<string, unknown> } {
  if (!input.args.includes("--input") || input.stdin === undefined) {
    throw new Error(`gh was not invoked with a stdin GraphQL body: ${input.args.join(" ")}`);
  }
  return JSON.parse(input.stdin) as {
    query: string;
    variables: Record<string, unknown>;
  };
}

function draftItemNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "PVTI_draft_1",
    type: "DRAFT_ISSUE",
    createdAt: "2026-08-01T10:00:00Z",
    updatedAt: "2026-08-02T10:00:00Z",
    fieldValues: { nodes: [] },
    content: {
      __typename: "DraftIssue",
      id: "DI_1",
      title: "Ship the thing",
      body: "Body text.",
      createdAt: "2026-08-01T10:00:00Z",
    },
    ...overrides,
  };
}

function issueItemNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "PVTI_issue_1",
    type: "ISSUE",
    createdAt: "2026-08-01T09:00:00Z",
    updatedAt: "2026-08-03T09:00:00Z",
    fieldValues: {
      nodes: [
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          name: "In Progress",
          field: { __typename: "ProjectV2SingleSelectField", id: "SF_status", name: "Status" },
        },
      ],
    },
    content: {
      __typename: "Issue",
      id: "I_1",
      number: 12,
      title: "Broken login",
      body: "Steps to reproduce.",
      url: "https://github.com/acme/widgets/issues/12",
      state: "OPEN",
      repository: { nameWithOwner: "acme/widgets" },
    },
    ...overrides,
  };
}

describe("GitHubProjectsApiModule.parseProjectItem", () => {
  it("maps a DraftIssue item without repository coordinates", () => {
    const snapshot = GitHubProjectsApiModule.parseProjectItem(draftItemNode());

    expect(snapshot).toMatchObject({
      itemId: "PVTI_draft_1",
      itemType: "draft",
      contentNodeId: "DI_1",
      title: "Ship the thing",
      body: "Body text.",
      number: null,
      url: null,
      state: null,
      repositoryNameWithOwner: null,
      statusName: null,
    });
  });

  it("maps an Issue item with repository, number, url, and state", () => {
    const snapshot = GitHubProjectsApiModule.parseProjectItem(issueItemNode());

    expect(snapshot).toMatchObject({
      itemId: "PVTI_issue_1",
      itemType: "issue",
      title: "Broken login",
      number: 12,
      url: "https://github.com/acme/widgets/issues/12",
      state: "open",
      repositoryNameWithOwner: "acme/widgets",
      statusName: "In Progress",
    });
  });

  it("maps a PullRequest item", () => {
    const snapshot = GitHubProjectsApiModule.parseProjectItem(
      issueItemNode({
        id: "PVTI_pr_1",
        type: "PR",
        fieldValues: { nodes: [] },
        content: {
          __typename: "PullRequest",
          id: "PR_1",
          number: 9,
          title: "Fix login",
          body: "",
          url: "https://github.com/acme/widgets/pull/9",
          state: "CLOSED",
          repository: { nameWithOwner: "acme/widgets" },
        },
      }),
    );

    expect(snapshot).toMatchObject({
      itemType: "pull_request",
      number: 9,
      state: "closed",
      repositoryNameWithOwner: "acme/widgets",
    });
  });

  it("returns null for redacted or unrecognizable items instead of failing the board", () => {
    expect(
      GitHubProjectsApiModule.parseProjectItem({
        id: "PVTI_x",
        content: { __typename: "Redacted" },
      }),
    ).toBeNull();
    expect(GitHubProjectsApiModule.parseProjectItem(null)).toBeNull();
    expect(
      GitHubProjectsApiModule.parseProjectItem(issueItemNode({ content: { __typename: "Issue" } })),
    ).toBeNull();
  });
});

it.effect("listItems follows cursors until the board is exhausted", () =>
  Effect.gen(function* () {
    const api = yield* GitHubProjectsApiModule.GitHubProjectsApi;
    let call = 0;
    mockedExecute.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return ghOk(
          JSON.stringify({
            data: {
              node: {
                items: {
                  pageInfo: { hasNextPage: true, endCursor: "CURSOR_1" },
                  nodes: [draftItemNode()],
                },
              },
            },
          }),
        );
      }
      return ghOk(
        JSON.stringify({
          data: {
            node: {
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [issueItemNode()],
              },
            },
          },
        }),
      );
    });

    const items = yield* api.listItems({ cwd: "/repo", projectNodeId: "PROJ_1" });

    expect(items.map((item) => item.itemId)).toEqual(["PVTI_draft_1", "PVTI_issue_1"]);
    // The second call must carry the cursor so GitHub resumes where page one ended.
    const secondBody = graphqlRequestBody(mockedExecute.mock.calls[1]![0]);
    expect(secondBody.variables.cursor).toBe("CURSOR_1");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("listItems stops after the hard page cap even if GitHub keeps paging", () =>
  Effect.gen(function* () {
    mockedExecute.mockClear();
    const api = yield* GitHubProjectsApiModule.GitHubProjectsApi;
    mockedExecute.mockImplementation(() =>
      ghOk(
        JSON.stringify({
          data: {
            node: {
              items: {
                pageInfo: { hasNextPage: true, endCursor: "CURSOR_FOREVER" },
                nodes: [],
              },
            },
          },
        }),
      ),
    );

    yield* api.listItems({ cwd: "/repo", projectNodeId: "PROJ_1" });

    expect(mockedExecute).toHaveBeenCalledTimes(50);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("resolveProjects returns only repository-linked boards and ignores owner boards", () =>
  Effect.gen(function* () {
    const api = yield* GitHubProjectsApiModule.GitHubProjectsApi;
    mockedExecute.mockImplementation((input) => {
      const { query } = graphqlRequestBody(input);
      if (query.includes("node(id:$id)")) {
        return ghOk(
          JSON.stringify({
            data: {
              node: {
                fields: {
                  nodes: [
                    {
                      id: "SF_1",
                      name: "Status",
                      options: [
                        { id: "OPT_todo", name: "Todo" },
                        { id: "OPT_done", name: "Done" },
                      ],
                    },
                  ],
                },
              },
            },
          }),
        );
      }
      if (query.includes("repository(owner:$owner")) {
        return ghOk(
          JSON.stringify({
            data: {
              repository: {
                id: "R_1",
                nameWithOwner: "acme/widgets",
                owner: { login: "acme" },
                projectsV2: { nodes: [{ id: "PROJ_linked", number: 3, title: "Widgets Board" }] },
              },
            },
          }),
        );
      }
      // Owner lookups must not be issued: a repo with no linked board must not
      // inherit unrelated boards that merely share its owner.
      if (query.includes("user(login:$login)") || query.includes("organization(login:$login)")) {
        return Effect.die(
          new Error(`owner board lookup should not be issued: ${query.slice(0, 80)}`),
        );
      }
      return Effect.die(new Error(`unexpected gh invocation: ${input.args.join(" ")}`));
    });

    const projects = yield* api.resolveProjects({
      cwd: "/repo",
      repository: {
        nameWithOwner: "acme/widgets",
        ownerLogin: "acme",
        repositoryNodeId: "R_1",
      },
    });

    expect(projects.map((project) => project.projectNodeId)).toEqual(["PROJ_linked"]);
    expect(projects[0]).toMatchObject({
      statusFieldId: "SF_1",
      statusOptions: [
        { id: "OPT_todo", name: "Todo" },
        { id: "OPT_done", name: "Done" },
      ],
    });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "resolveProjects returns empty when the repository has no linked board and does not fall back to owner or organization boards",
  () =>
    Effect.gen(function* () {
      const api = yield* GitHubProjectsApiModule.GitHubProjectsApi;
      mockedExecute.mockImplementation((input) => {
        const { query } = graphqlRequestBody(input);
        if (query.includes("user(login:$login)") || query.includes("organization(login:$login)")) {
          return Effect.die(
            new Error(
              `owner/organization board lookup should not be issued: ${query.slice(0, 80)}`,
            ),
          );
        }
        if (query.includes("repository(owner:$owner")) {
          return ghOk(
            JSON.stringify({
              data: {
                repository: {
                  id: "R_1",
                  nameWithOwner: "acme/widgets",
                  owner: { login: "acme" },
                  projectsV2: { nodes: [] },
                },
              },
            }),
          );
        }
        // No linked boards, so no status-field lookups should be issued either.
        if (query.includes("node(id:$id)")) {
          return Effect.die(
            new Error("status field lookup should not be issued for empty board list"),
          );
        }
        return Effect.die(new Error(`unexpected gh invocation: ${input.args.join(" ")}`));
      });

      const projects = yield* api.resolveProjects({
        cwd: "/repo",
        repository: {
          nameWithOwner: "acme/widgets",
          ownerLogin: "acme",
          repositoryNodeId: "R_1",
        },
      });

      // A repo with no linked ProjectsV2 board must surface "No project located"
      // — it must not inherit unrelated boards owned by the same account.
      expect(projects).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("creates drafts through addProjectV2DraftIssue with the project id", () =>
  Effect.gen(function* () {
    const api = yield* GitHubProjectsApiModule.GitHubProjectsApi;
    let captured: Record<string, unknown> = {};
    mockedExecute.mockImplementation((input) => {
      captured = (graphqlRequestBody(input).variables.input ?? {}) as Record<string, unknown>;
      return ghOk(
        JSON.stringify({ data: { addProjectV2DraftIssue: { projectItem: draftItemNode() } } }),
      );
    });

    const snapshot = yield* api.addDraftIssue({
      cwd: "/repo",
      projectNodeId: "PROJ_1",
      title: "New draft",
      body: "With a body",
    });

    expect(captured).toEqual({
      projectId: "PROJ_1",
      title: "New draft",
      body: "With a body",
    });
    expect(snapshot).toMatchObject({ itemId: "PVTI_draft_1", itemType: "draft" });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("adds existing issues by node id", () =>
  Effect.gen(function* () {
    const api = yield* GitHubProjectsApiModule.GitHubProjectsApi;
    let captured: Record<string, unknown> = {};
    mockedExecute.mockImplementation((input) => {
      captured = (graphqlRequestBody(input).variables.input ?? {}) as Record<string, unknown>;
      return ghOk(JSON.stringify({ data: { addProjectV2ItemById: { item: issueItemNode() } } }));
    });

    const snapshot = yield* api.addIssueToProject({
      cwd: "/repo",
      projectNodeId: "PROJ_1",
      issueNodeId: "I_99",
    });

    expect(captured).toEqual({ projectId: "PROJ_1", contentId: "I_99" });
    expect(snapshot).toMatchObject({ itemType: "issue", number: 12 });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("writes column moves as single-select option ids", () =>
  Effect.gen(function* () {
    const api = yield* GitHubProjectsApiModule.GitHubProjectsApi;
    let captured: Record<string, unknown> = {};
    mockedExecute.mockImplementation((input) => {
      captured = (graphqlRequestBody(input).variables.input ?? {}) as Record<string, unknown>;
      return ghOk(JSON.stringify({ data: { updateProjectV2ItemFieldValue: {} } }));
    });

    const wrote = yield* api.setItemStatus({
      cwd: "/repo",
      projectNodeId: "PROJ_1",
      itemId: "PVTI_1",
      status: "done",
      field: { statusFieldId: "SF_1", options: [{ id: "OPT_done", name: "Done" }] },
    });

    expect(wrote).toBe(true);
    expect(captured).toEqual({
      projectId: "PROJ_1",
      itemId: "PVTI_1",
      fieldId: "SF_1",
      value: { singleSelectOptionId: "OPT_done" },
    });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("reports unmatched columns instead of writing a guess", () =>
  Effect.gen(function* () {
    mockedExecute.mockClear();
    const api = yield* GitHubProjectsApiModule.GitHubProjectsApi;

    const wrote = yield* api.setItemStatus({
      cwd: "/repo",
      projectNodeId: "PROJ_1",
      itemId: "PVTI_1",
      status: "in_review",
      field: { statusFieldId: "SF_1", options: [{ id: "OPT_done", name: "Done" }] },
    });

    expect(wrote).toBe(false);
    expect(mockedExecute).not.toHaveBeenCalled();
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("fails loudly when issue creation prints no url", () =>
  Effect.gen(function* () {
    const api = yield* GitHubProjectsApiModule.GitHubProjectsApi;
    mockedExecute.mockImplementation(() => ghOk("Created!\n"));

    const error = yield* Effect.flip(api.createIssue({ cwd: "/repo", title: "T", body: "" }));

    expect(error).toBeInstanceOf(GitHubProjectsApiModule.GitHubIssueUrlDecodeError);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("reads back the created issue for its node id", () =>
  Effect.gen(function* () {
    const api = yield* GitHubProjectsApiModule.GitHubProjectsApi;
    mockedExecute.mockImplementation((input) => {
      const args = input.args.join(" ");
      if (args.includes('"issue","create"')) {
        return ghOk("https://github.com/acme/widgets/issues/21\n");
      }
      return ghOk(
        JSON.stringify({
          id: "I_node21",
          number: 21,
          url: "https://github.com/acme/widgets/issues/21",
        }),
      );
    });

    const issue = yield* api.createIssue({ cwd: "/repo", title: "T", body: "" });

    expect(issue).toEqual({
      nodeId: "I_node21",
      number: 21,
      url: "https://github.com/acme/widgets/issues/21",
    });
  }).pipe(Effect.provide(TestLayer)),
);

describe("toTasksFailure", () => {
  it("classifies missing Projects scopes from the GraphQL error body", () => {
    expect(
      GitHubProjectsApiModule.toTasksFailure(
        new GitHubProjectsApiModule.GitHubGraphQlError({
          messages: [
            "Your token has not been granted the required scopes to execute this query. The 'projectsV2' field requires one of the following scopes: ['read:project']",
          ],
        }),
      ),
    ).toBe("github_scopes_missing");
  });

  it("classifies vanished nodes as task_not_found", () => {
    expect(
      GitHubProjectsApiModule.toTasksFailure(
        new GitHubProjectsApiModule.GitHubGraphQlError({
          messages: ["Could not resolve to a node with id PVTI_x"],
        }),
      ),
    ).toBe("task_not_found");
  });

  it("leaves ordinary GraphQL failures as github_command_failed", () => {
    expect(
      GitHubProjectsApiModule.toTasksFailure(
        new GitHubProjectsApiModule.GitHubGraphQlError({ messages: ["Something else went wrong"] }),
      ),
    ).toBe("github_command_failed");
  });

  it("maps CLI availability and authentication by tag", () => {
    expect(
      GitHubProjectsApiModule.toTasksFailure(
        new GitHubCli.GitHubCliUnavailableError({
          command: "gh",
          cwd: "/repo",
          cause: new Error("spawn"),
        }),
      ),
    ).toBe("github_unavailable");
    expect(
      GitHubProjectsApiModule.toTasksFailure(
        new GitHubCli.GitHubCliAuthenticationError({
          command: "gh",
          cwd: "/repo",
          cause: new Error("auth"),
        }),
      ),
    ).toBe("github_unauthenticated");
  });
});

it.effect("graphql failures carry the API error messages instead of a generic exit", () =>
  Effect.gen(function* () {
    const api = yield* GitHubProjectsApiModule.GitHubProjectsApi;
    mockedExecute.mockImplementation(() =>
      ghOk(
        JSON.stringify({
          errors: [
            {
              type: "INSUFFICIENT_SCOPES",
              message: "Your token has not been granted the required scopes to execute this query.",
            },
          ],
        }),
      ),
    );

    const error = yield* Effect.flip(api.listItems({ cwd: "/repo", projectNodeId: "PROJ_1" }));

    expect(error._tag).toBe("GitHubGraphQlError");
    if (error._tag === "GitHubGraphQlError") {
      expect(error.messages).toEqual([
        "Your token has not been granted the required scopes to execute this query.",
      ]);
    }
  }).pipe(Effect.provide(TestLayer)),
);
