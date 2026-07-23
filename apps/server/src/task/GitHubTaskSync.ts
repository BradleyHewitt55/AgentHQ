/**
 * GitHubTaskSync - GitHub issue and Projects v2 operations for project tasks.
 *
 * All GitHub access goes through the existing `gh` CLI wrapper, so this
 * inherits the CLI's auth and host configuration rather than adding a second
 * credential path.
 *
 * Projects v2 is treated as best-effort: a repository with no board, or a token
 * without the `project` scope, still gets full issue sync. Board failures are
 * reported as `boardUnavailable` instead of failing the whole operation.
 *
 * @module GitHubTaskSync
 */
import { VcsProcessExitError, type TaskStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { GitHubCli, type GitHubCliError } from "../sourceControl/GitHubCli.ts";
import {
  resolveBoardOptionForStatus,
  resolveStatusForBoardOption,
  type BoardSingleSelectOption,
} from "./taskBoardStatus.ts";

const PROJECT_ITEM_LIST_LIMIT = 500;
const ISSUE_FETCH_CONCURRENCY = 4;

/**
 * `gh issue create` succeeded but printed something other than an issue URL.
 * The issue exists on GitHub at that point, so this is reported rather than
 * papered over: retrying blindly would file a duplicate.
 */
export class GitHubIssueUrlDecodeError extends Schema.TaggedErrorClass<GitHubIssueUrlDecodeError>()(
  "GitHubIssueUrlDecodeError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    stdout: Schema.String,
  },
) {
  get detail(): string {
    return "GitHub CLI created an issue but did not print its URL, so it could not be linked.";
  }

  override get message(): string {
    return `GitHub CLI failed in createIssue: ${this.detail} Output: ${this.stdout}`;
  }
}

export interface GitHubRepositoryContext {
  readonly nameWithOwner: string;
  readonly ownerLogin: string;
}

export interface GitHubIssueSnapshot {
  readonly number: number;
  readonly url: string;
  readonly nodeId: string | null;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
}

export interface GitHubBoardContext {
  readonly projectNodeId: string;
  readonly projectNumber: number;
  readonly ownerLogin: string;
  readonly statusFieldId: string;
  readonly statusOptions: ReadonlyArray<BoardSingleSelectOption>;
}

export interface GitHubBoardItem {
  readonly itemId: string;
  readonly issueNumber: number;
  readonly status: TaskStatus | null;
}

const isVcsProcessExitError = Schema.is(VcsProcessExitError);

function isMissingIssueError(error: GitHubCliError): boolean {
  if (error._tag !== "GitHubCliCommandError" && error._tag !== "GitHubPullRequestNotFoundError") {
    return false;
  }
  const cause = error.cause;
  if (!isVcsProcessExitError(cause)) return false;
  const detail = cause.detail.toLowerCase();
  return (
    detail.includes("could not resolve to an issue") ||
    detail.includes("issue not found") ||
    detail.includes("no issue found")
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
}

function parseIssue(value: unknown): GitHubIssueSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const number = asNumber(record.number);
  const url = asString(record.url);
  if (number === null || url === null) return null;
  const rawState = asString(record.state)?.toLowerCase();
  return {
    number,
    url,
    nodeId: asString(record.id),
    title: asString(record.title) ?? "",
    body: typeof record.body === "string" ? record.body : "",
    state: rawState === "closed" ? "closed" : "open",
  };
}

/**
 * `gh project item-list --format json` flattens single-select field values onto
 * the item keyed by field name, so the status column is found case-insensitively
 * rather than by a fixed key.
 */
function readStatusFieldValue(item: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(item)) {
    if (key.toLowerCase() !== "status") continue;
    const direct = asString(value);
    if (direct) return direct;
    const nested = asRecord(value);
    if (nested) return asString(nested.name);
  }
  return null;
}

export class GitHubTaskSync extends Context.Service<
  GitHubTaskSync,
  {
    /** Repository backing `cwd`, or `null` when the directory has no GitHub remote. */
    readonly resolveRepository: (input: {
      readonly cwd: string;
    }) => Effect.Effect<GitHubRepositoryContext | null, GitHubCliError>;

    readonly createIssue: (input: {
      readonly cwd: string;
      readonly title: string;
      readonly body: string;
    }) => Effect.Effect<GitHubIssueSnapshot, GitHubCliError | GitHubIssueUrlDecodeError>;

    /**
     * Snapshots of specific issues. Issues are fetched by number rather than
     * listed so a task linked to an old issue keeps syncing; numbers that no
     * longer resolve are omitted.
     */
    readonly fetchIssues: (input: {
      readonly cwd: string;
      readonly issueNumbers: ReadonlyArray<number>;
    }) => Effect.Effect<ReadonlyArray<GitHubIssueSnapshot>, GitHubCliError>;

    readonly setIssueState: (input: {
      readonly cwd: string;
      readonly issueNumber: number;
      readonly closed: boolean;
    }) => Effect.Effect<void, GitHubCliError>;

    readonly updateIssue: (input: {
      readonly cwd: string;
      readonly issueNumber: number;
      readonly title?: string;
      readonly body?: string;
    }) => Effect.Effect<void, GitHubCliError>;

    /**
     * First Projects v2 board owned by the repository owner that exposes a
     * single-select "Status" field. `null` when no usable board exists.
     */
    readonly resolveBoard: (input: {
      readonly cwd: string;
      readonly repository: GitHubRepositoryContext;
      readonly preferredProjectNodeId?: string | null;
    }) => Effect.Effect<GitHubBoardContext | null, GitHubCliError>;

    /** Add an issue to the board, returning the created item id. */
    readonly addIssueToBoard: (input: {
      readonly cwd: string;
      readonly board: GitHubBoardContext;
      readonly issueUrl: string;
    }) => Effect.Effect<string | null, GitHubCliError>;

    readonly setBoardItemStatus: (input: {
      readonly cwd: string;
      readonly board: GitHubBoardContext;
      readonly itemId: string;
      readonly status: TaskStatus;
    }) => Effect.Effect<boolean, GitHubCliError>;

    readonly listBoardItems: (input: {
      readonly cwd: string;
      readonly board: GitHubBoardContext;
    }) => Effect.Effect<ReadonlyArray<GitHubBoardItem>, GitHubCliError>;
  }
>()("t3/task/GitHubTaskSync") {}

export const make = Effect.gen(function* () {
  const gh = yield* GitHubCli;

  const resolveRepository: GitHubTaskSync["Service"]["resolveRepository"] = ({ cwd }) =>
    gh.execute({ cwd, args: ["repo", "view", "--json", "nameWithOwner,owner"] }).pipe(
      Effect.map(({ stdout }) => {
        const record = asRecord(parseJson(stdout));
        if (!record) return null;
        const nameWithOwner = asString(record.nameWithOwner);
        const ownerLogin = asString(asRecord(record.owner)?.login);
        if (nameWithOwner === null || ownerLogin === null) return null;
        return { nameWithOwner, ownerLogin };
      }),
    );

  const createIssue: GitHubTaskSync["Service"]["createIssue"] = ({ cwd, title, body }) =>
    Effect.gen(function* () {
      // `gh issue create` prints only the issue URL, so the number is read back
      // from it and the node id fetched separately for Projects v2.
      const created = yield* gh.execute({
        cwd,
        args: ["issue", "create", "--title", title, "--body", body],
      });
      const url = created.stdout.match(/https?:\/\/\S+\/issues\/(\d+)/);
      if (!url) {
        return yield* new GitHubIssueUrlDecodeError({
          command: "gh",
          cwd,
          stdout: created.stdout.trim(),
        });
      }
      const issueNumber = Number.parseInt(url[1] ?? "", 10);
      const viewed = yield* gh.execute({
        cwd,
        args: ["issue", "view", String(issueNumber), "--json", "id,number,url,title,body,state"],
      });
      return (
        parseIssue(parseJson(viewed.stdout)) ?? {
          number: issueNumber,
          url: url[0],
          nodeId: null,
          title,
          body,
          state: "open" as const,
        }
      );
    });

  const fetchIssues: GitHubTaskSync["Service"]["fetchIssues"] = ({ cwd, issueNumbers }) =>
    Effect.forEach(
      [...new Set(issueNumbers)],
      (issueNumber) =>
        gh
          .execute({
            cwd,
            args: [
              "issue",
              "view",
              String(issueNumber),
              "--json",
              "id,number,url,title,body,state",
            ],
          })
          .pipe(
            Effect.map(({ stdout }) => parseIssue(parseJson(stdout))),
            Effect.catch((error) =>
              isMissingIssueError(error) ? Effect.succeed(null) : Effect.fail(error),
            ),
          ),
      { concurrency: ISSUE_FETCH_CONCURRENCY },
    ).pipe(Effect.map((issues) => issues.filter((issue) => issue !== null)));

  const setIssueState: GitHubTaskSync["Service"]["setIssueState"] = ({
    cwd,
    issueNumber,
    closed,
  }) =>
    gh
      .execute({ cwd, args: ["issue", closed ? "close" : "reopen", String(issueNumber)] })
      .pipe(Effect.asVoid);

  const updateIssue: GitHubTaskSync["Service"]["updateIssue"] = ({
    cwd,
    issueNumber,
    title,
    body,
  }) => {
    const args = ["issue", "edit", String(issueNumber)];
    if (title !== undefined) args.push("--title", title);
    if (body !== undefined) args.push("--body", body);
    return args.length === 3 ? Effect.void : gh.execute({ cwd, args }).pipe(Effect.asVoid);
  };

  const resolveBoard: GitHubTaskSync["Service"]["resolveBoard"] = ({
    cwd,
    repository,
    preferredProjectNodeId,
  }) =>
    Effect.gen(function* () {
      const [owner, name] = repository.nameWithOwner.split("/", 2);
      if (!owner || !name) return null;

      // Repository.projectsV2 contains only boards explicitly linked to this
      // repository. Listing every board owned by `owner` could put an issue on
      // an unrelated project.
      const listed = yield* gh.execute({
        cwd,
        args: [
          "api",
          "graphql",
          "-f",
          "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){projectsV2(first:100){nodes{id number owner{... on User{login} ... on Organization{login}}}}}}",
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
        ],
      });
      const data = asRecord(parseJson(listed.stdout))?.data;
      const repositoryRecord = asRecord(asRecord(data)?.repository);
      const projectsConnection = asRecord(repositoryRecord?.projectsV2);
      const rawProjects = projectsConnection?.nodes;
      if (!Array.isArray(rawProjects) || rawProjects.length === 0) return null;

      const projects = [...rawProjects].sort((left, right) => {
        const leftPreferred = asString(asRecord(left)?.id) === preferredProjectNodeId;
        const rightPreferred = asString(asRecord(right)?.id) === preferredProjectNodeId;
        return Number(rightPreferred) - Number(leftPreferred);
      });

      // Boards without a single-select Status field cannot represent columns,
      // so the first usable linked board wins, preferring the task's prior board.
      for (const entry of projects) {
        const record = asRecord(entry);
        const projectNodeId = asString(record?.id);
        const projectNumber = asNumber(record?.number);
        const ownerLogin = asString(asRecord(record?.owner)?.login);
        if (projectNodeId === null || projectNumber === null || ownerLogin === null) continue;

        const fields = yield* gh.execute({
          cwd,
          args: [
            "project",
            "field-list",
            String(projectNumber),
            "--owner",
            ownerLogin,
            "--format",
            "json",
          ],
        });
        const fieldList = asRecord(parseJson(fields.stdout))?.fields;
        if (!Array.isArray(fieldList)) continue;

        for (const fieldEntry of fieldList) {
          const field = asRecord(fieldEntry);
          if (field === null) continue;
          if (asString(field.name)?.toLowerCase() !== "status") continue;
          const statusFieldId = asString(field.id);
          const rawOptions = field.options;
          if (statusFieldId === null || !Array.isArray(rawOptions)) continue;

          const statusOptions = rawOptions.flatMap((optionEntry) => {
            const option = asRecord(optionEntry);
            const id = asString(option?.id);
            const name = asString(option?.name);
            return id !== null && name !== null ? [{ id, name }] : [];
          });
          if (statusOptions.length === 0) continue;

          return { projectNodeId, projectNumber, ownerLogin, statusFieldId, statusOptions };
        }
      }
      return null;
    });

  const addIssueToBoard: GitHubTaskSync["Service"]["addIssueToBoard"] = ({
    cwd,
    board,
    issueUrl,
  }) =>
    gh
      .execute({
        cwd,
        args: [
          "project",
          "item-add",
          String(board.projectNumber),
          "--owner",
          board.ownerLogin,
          "--url",
          issueUrl,
          "--format",
          "json",
        ],
      })
      .pipe(Effect.map(({ stdout }) => asString(asRecord(parseJson(stdout))?.id)));

  const setBoardItemStatus: GitHubTaskSync["Service"]["setBoardItemStatus"] = ({
    cwd,
    board,
    itemId,
    status,
  }) => {
    const option = resolveBoardOptionForStatus(status, board.statusOptions);
    if (option === null) return Effect.succeed(false);
    return gh
      .execute({
        cwd,
        args: [
          "project",
          "item-edit",
          "--id",
          itemId,
          "--project-id",
          board.projectNodeId,
          "--field-id",
          board.statusFieldId,
          "--single-select-option-id",
          option.id,
        ],
      })
      .pipe(Effect.as(true));
  };

  const listBoardItems: GitHubTaskSync["Service"]["listBoardItems"] = ({ cwd, board }) =>
    gh
      .execute({
        cwd,
        args: [
          "project",
          "item-list",
          String(board.projectNumber),
          "--owner",
          board.ownerLogin,
          "--limit",
          String(PROJECT_ITEM_LIST_LIMIT),
          "--format",
          "json",
        ],
      })
      .pipe(
        Effect.map(({ stdout }) => {
          const items = asRecord(parseJson(stdout))?.items;
          if (!Array.isArray(items)) return [];
          return items.flatMap((entry) => {
            const item = asRecord(entry);
            const itemId = asString(item?.id);
            const issueNumber = asNumber(asRecord(item?.content)?.number);
            if (item === null || itemId === null || issueNumber === null) return [];
            const statusName = readStatusFieldValue(item);
            return [
              {
                itemId,
                issueNumber,
                status: statusName === null ? null : resolveStatusForBoardOption(statusName),
              },
            ];
          });
        }),
      );

  return GitHubTaskSync.of({
    resolveRepository,
    createIssue,
    fetchIssues,
    setIssueState,
    updateIssue,
    resolveBoard,
    addIssueToBoard,
    setBoardItemStatus,
    listBoardItems,
  });
});

export const layer = Layer.effect(GitHubTaskSync, make);
