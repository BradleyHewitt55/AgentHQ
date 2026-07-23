import { assert, it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layer as GitHubCliLayer } from "../sourceControl/GitHubCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { GitHubTaskSync, layer as GitHubTaskSyncLayer } from "./GitHubTaskSync.ts";

const calls: Array<ReadonlyArray<string>> = [];

const output = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const TestLayer = GitHubTaskSyncLayer.pipe(
  Layer.provide(
    GitHubCliLayer.pipe(
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: ({ args }) => {
            calls.push(args);
            if (args[0] === "api" && args[1] === "graphql") {
              return Effect.succeed(
                output(
                  JSON.stringify({
                    data: {
                      repository: {
                        projectsV2: {
                          nodes: [
                            {
                              id: "PVT_linked",
                              number: 7,
                              owner: { login: "acme" },
                            },
                          ],
                        },
                      },
                    },
                  }),
                ),
              );
            }
            if (args[0] === "project" && args[1] === "field-list") {
              return Effect.succeed(
                output(
                  JSON.stringify({
                    fields: [
                      {
                        id: "PVTF_status",
                        name: "Status",
                        options: [
                          { id: "todo", name: "Todo" },
                          { id: "doing", name: "In Progress" },
                        ],
                      },
                    ],
                  }),
                ),
              );
            }
            return Effect.succeed(output(""));
          },
        }),
      ),
    ),
  ),
);

it.layer(TestLayer)("GitHubTaskSync", (it) => {
  it.effect("resolves only projects linked to the repository", () =>
    Effect.gen(function* () {
      calls.length = 0;
      const github = yield* GitHubTaskSync;
      const board = yield* github.resolveBoard({
        cwd: "/tmp/widgets",
        repository: { nameWithOwner: "acme/widgets", ownerLogin: "acme" },
      });

      assert.strictEqual(board?.projectNodeId, "PVT_linked");
      assert.strictEqual(board?.projectNumber, 7);
      assert.strictEqual(calls[0]?.[0], "api");
      assert.isFalse(calls.some((args) => args[0] === "project" && args[1] === "list"));
    }),
  );

  it.effect("reports an unmapped board status instead of silently succeeding", () =>
    Effect.gen(function* () {
      calls.length = 0;
      const github = yield* GitHubTaskSync;
      const applied = yield* github.setBoardItemStatus({
        cwd: "/tmp/widgets",
        board: {
          projectNodeId: "PVT_linked",
          projectNumber: 7,
          ownerLogin: "acme",
          statusFieldId: "PVTF_status",
          statusOptions: [{ id: "todo", name: "Todo" }],
        },
        itemId: "PVTI_item",
        status: "in_review",
      });

      assert.isFalse(applied);
      assert.isFalse(calls.some((args) => args[0] === "project" && args[1] === "item-edit"));
    }),
  );
});
