/**
 * GitHubProjectsApi - Projects v2 GraphQL operations backing project tasks.
 *
 * All GitHub access goes through the existing `gh` CLI wrapper, so this
 * inherits the CLI's auth and host configuration rather than adding a second
 * credential path. Parsing is defensive: Projects v2 unions grow over time and
 * items can be redacted, so unrecognized content is skipped instead of failing
 * the whole board read.
 *
 * @module GitHubProjectsApi
 */
import { GitHubCli, type GitHubCliError } from "../sourceControl/GitHubCli.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { type TaskFailure, type TaskState, type TaskStatus } from "@t3tools/contracts";

import { resolveBoardOptionForStatus, type BoardSingleSelectOption } from "./taskBoardStatus.ts";

/** Everything the Projects v2 adapter can fail with. */
export type GitHubProjectsApiError = GitHubCliError | GitHubGraphQlError;

/** Hard cap so a runaway cursor cannot loop forever. */
const ITEM_PAGE_LIMIT = 50;
const ITEM_PAGE_SIZE = 100;
/** Upper bound on candidate boards, each costing a field-list lookup. */
const PROJECT_CANDIDATE_LIMIT = 25;

export interface GitHubRepositoryContext {
  readonly nameWithOwner: string;
  readonly ownerLogin: string;
  /** GraphQL node id, needed by conversions that file into this repository. */
  readonly repositoryNodeId: string;
}

export interface GitHubProjectContext {
  readonly projectNodeId: string;
  readonly projectNumber: number;
  readonly ownerLogin: string;
  readonly title: string;
  /** Present when the board exposes a usable "Status" single-select field. */
  readonly statusFieldId: string | null;
  readonly statusOptions: ReadonlyArray<BoardSingleSelectOption>;
}

export type GitHubItemType = "draft" | "issue" | "pull_request";

export interface GitHubProjectItemSnapshot {
  /** Projects v2 item node id. */
  readonly itemId: string;
  readonly itemType: GitHubItemType;
  /** Node id of the underlying DraftIssue/Issue/PullRequest, when present. */
  readonly contentNodeId: string | null;
  readonly title: string;
  readonly body: string;
  readonly number: number | null;
  readonly url: string | null;
  readonly state: TaskState | null;
  readonly repositoryNameWithOwner: string | null;
  /** Raw "Status" single-select option name, before any alias mapping. */
  readonly statusName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A GraphQL response that carried an `errors` array. `gh` exits non-zero for
 * these but prints the structured body on stdout, and the process layer
 * deliberately drops stderr, so this body is the only precise error signal.
 */
export class GitHubGraphQlError extends Schema.TaggedErrorClass<GitHubGraphQlError>()(
  "GitHubGraphQlError",
  {
    messages: Schema.Array(Schema.String),
  },
) {
  /** First messages joined for error surfaces; GraphQL lists one error per problem. */
  get detail(): string {
    return this.messages.join("; ");
  }

  override get message(): string {
    return `GitHub GraphQL failed: ${this.detail}`;
  }
}

const isGraphQlError = Schema.is(GitHubGraphQlError);

/**
 * Map a `gh` failure onto the task error taxonomy. Missing Projects v2 scopes
 * are common enough (the CLI token often predates the feature) that they get
 * their own failure instead of a generic command error.
 */
export function toTasksFailure(cause: unknown): TaskFailure {
  if (isGraphQlError(cause)) {
    const detail = cause.detail.toLowerCase();
    if (
      detail.includes("insufficient_scopes") ||
      detail.includes("has not been granted the required scopes") ||
      detail.includes("requires one of the following scopes")
    ) {
      return "github_scopes_missing";
    }
    if (detail.includes("could not resolve to a node")) {
      return "task_not_found";
    }
    return "github_command_failed";
  }
  const tag = (cause as { _tag?: string } | null)?._tag;
  if (tag === "GitHubCliUnavailableError") return "github_unavailable";
  if (tag === "GitHubCliAuthenticationError") return "github_unauthenticated";
  return "github_command_failed";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
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

function parseIssueState(value: unknown): TaskState | null {
  const raw = asString(value)?.toLowerCase();
  return raw === "closed" ? "closed" : raw === "open" ? "open" : null;
}

/**
 * `fieldValues(first:)` mixes typed field values in one union, so the status
 * column is found by matching the field's name case-insensitively.
 */
function readStatusFieldValue(item: Record<string, unknown>): {
  statusName: string | null;
} {
  const values = asRecord(item.fieldValues)?.nodes;
  if (!Array.isArray(values)) return { statusName: null };
  for (const entry of values) {
    const record = asRecord(entry);
    if (record === null) continue;
    const field = asRecord(record.field);
    if (asString(field?.name)?.toLowerCase() !== "status") continue;
    const statusName = asString(record.name);
    if (statusName !== null) return { statusName };
  }
  return { statusName: null };
}

/** Parse one ProjectV2Item node. Returns null for redacted/unusable items. */
export function parseProjectItem(value: unknown): GitHubProjectItemSnapshot | null {
  const item = asRecord(value);
  if (item === null) return null;
  const itemId = asString(item.id);
  if (itemId === null) return null;

  const content = asRecord(item.content);
  const typename = asString(content?.__typename);
  const base = {
    itemId,
    body: typeof content?.body === "string" ? content.body : "",
    createdAt: asString(item.createdAt) ?? asString(content?.createdAt) ?? "",
    updatedAt: asString(item.updatedAt) ?? asString(content?.updatedAt) ?? "",
    ...readStatusFieldValue(item),
  };

  if (typename === "DraftIssue") {
    const title = asString(content?.title);
    if (title === null) return null;
    return {
      ...base,
      itemType: "draft",
      contentNodeId: asString(content?.id),
      title,
      number: null,
      url: null,
      state: null,
      repositoryNameWithOwner: null,
    };
  }

  const repositoryNameWithOwner = asString(asRecord(content?.repository)?.nameWithOwner);
  if (typename === "Issue") {
    const number = asNumber(content?.number);
    const url = asString(content?.url);
    const title = asString(content?.title);
    if (number === null || url === null || title === null) return null;
    return {
      ...base,
      itemType: "issue",
      contentNodeId: asString(content?.id),
      title,
      number,
      url,
      state: parseIssueState(content?.state),
      repositoryNameWithOwner,
    };
  }
  if (typename === "PullRequest") {
    const number = asNumber(content?.number);
    const url = asString(content?.url);
    const title = asString(content?.title);
    if (number === null || url === null || title === null) return null;
    return {
      ...base,
      itemType: "pull_request",
      contentNodeId: asString(content?.id),
      title,
      number,
      url,
      state: parseIssueState(content?.state),
      repositoryNameWithOwner,
    };
  }
  return null;
}

/** Shared selection set for mutation payloads returning a full item. */
const PROJECT_ITEM_FRAGMENT_FIELDS = `id
      type
      createdAt
      updatedAt
      fieldValues(first:20){
        nodes{
          ... on ProjectV2ItemFieldSingleSelectValue{
            name
            field{ ... on ProjectV2SingleSelectField{ id name } }
          }
        }
      }
      content{
        __typename
        ... on DraftIssue{ id title body createdAt }
        ... on Issue{ id number title body url state repository{nameWithOwner} }
        ... on PullRequest{ id number title body url state repository{nameWithOwner} }
      }`;

const PROJECT_ITEMS_QUERY = `query($id:ID!,$cursor:String){
  node(id:$id){
    ... on ProjectV2 {
      items(first:${ITEM_PAGE_SIZE}, after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id
          type
          createdAt
          updatedAt
          fieldValues(first:20){
            nodes{
              ... on ProjectV2ItemFieldSingleSelectValue{
                name
                field{ ... on ProjectV2SingleSelectField{ id name } }
              }
            }
          }
          content{
            __typename
            ... on DraftIssue{ id title body createdAt }
            ... on Issue{ id number title body url state repository{nameWithOwner} }
            ... on PullRequest{ id number title body url state repository{nameWithOwner} }
          }
        }
      }
    }
  }
}`;

const REPOSITORY_PROJECTS_QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    id
    nameWithOwner
    owner{ ... on User{ login } ... on Organization{ login } }
    projectsV2(first:100){
      nodes{ id number title owner{ ... on User{ login } ... on Organization{ login } } }
    }
  }
}`;

const STATUS_FIELD_QUERY = `query($id:ID!){
  node(id:$id){
    ... on ProjectV2 {
      fields(first:100){
        nodes{
          ... on ProjectV2SingleSelectField{
            id
            name
            options{ id name }
          }
        }
      }
    }
  }
}`;

const SINGLE_ITEM_QUERY = `query($id:ID!){
  node(id:$id){
    ... on ProjectV2Item {
      ${PROJECT_ITEM_FRAGMENT_FIELDS}
    }
  }
}`;

const ADD_DRAFT_ISSUE_MUTATION = `mutation($input:AddProjectV2DraftIssueInput!){
  addProjectV2DraftIssue(input:$input){
    projectItem{
      ${PROJECT_ITEM_FRAGMENT_FIELDS}
    }
  }
}`;

const ADD_ISSUE_BY_ID_MUTATION = `mutation($input:AddProjectV2ItemByIdInput!){
  addProjectV2ItemById(input:$input){
    item{
      ${PROJECT_ITEM_FRAGMENT_FIELDS}
    }
  }
}`;

const CONVERT_DRAFT_TO_ISSUE_MUTATION = `mutation($input:ConvertProjectV2DraftIssueItemToIssueInput!){
  convertProjectV2DraftIssueItemToIssue(input:$input){
    item{
      ${PROJECT_ITEM_FRAGMENT_FIELDS}
    }
  }
}`;

const DELETE_ITEM_MUTATION = `mutation($input:DeleteProjectV2ItemInput!){
  deleteProjectV2Item(input:$input){ clientMutationId }
}`;

const SET_ITEM_FIELD_VALUE_MUTATION = `mutation($input:UpdateProjectV2ItemFieldValueInput!){
  updateProjectV2ItemFieldValue(input:$input){ clientMutationId }
}`;

/**
 * `gh issue create` succeeded but printed something other than an issue URL.
 * The issue exists on GitHub at that point, so this is reported rather than
 * papered over: retrying blindly would file a duplicate.
 */
export class GitHubIssueUrlDecodeError extends Schema.TaggedErrorClass<GitHubIssueUrlDecodeError>()(
  "GitHubIssueUrlDecodeError",
  {
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

export class GitHubProjectsApi extends Context.Service<
  GitHubProjectsApi,
  {
    /** Repository backing `cwd`, or `null` when the directory has none. */
    readonly resolveRepository: (input: {
      readonly cwd: string;
    }) => Effect.Effect<GitHubRepositoryContext | null, GitHubProjectsApiError>;

    /**
     * Boards usable as the workspace's Tasks source: only Projects v2 boards
     * explicitly linked to the repository. Each carries its Status field context
     * when it has one. If the repository has no linked board the workspace has
     * no task source and the UI shows "No project located".
     */
    readonly resolveProjects: (input: {
      readonly cwd: string;
      readonly repository: GitHubRepositoryContext;
    }) => Effect.Effect<ReadonlyArray<GitHubProjectContext>, GitHubProjectsApiError>;

    /**
     * Fetch the Status single-select field of a board, or `null` when it has
     * none. Needed before writing a column value.
     */
    readonly fetchStatusField: (input: {
      readonly cwd: string;
      readonly projectNodeId: string;
    }) => Effect.Effect<
      { statusFieldId: string; options: ReadonlyArray<BoardSingleSelectOption> } | null,
      GitHubProjectsApiError
    >;

    /** Every item on the board, following cursors until exhausted. */
    readonly listItems: (input: {
      readonly cwd: string;
      readonly projectNodeId: string;
    }) => Effect.Effect<ReadonlyArray<GitHubProjectItemSnapshot>, GitHubProjectsApiError>;

    /** One item by node id, used to read back state after a field write. */
    readonly fetchItem: (input: {
      readonly cwd: string;
      readonly itemId: string;
    }) => Effect.Effect<GitHubProjectItemSnapshot | null, GitHubProjectsApiError>;

    /** Create a Project-native draft, returning the fresh item. */
    readonly addDraftIssue: (input: {
      readonly cwd: string;
      readonly projectNodeId: string;
      readonly title: string;
      readonly body: string;
    }) => Effect.Effect<GitHubProjectItemSnapshot | null, GitHubProjectsApiError>;

    /** Add an existing issue to the board, returning the fresh item. */
    readonly addIssueToProject: (input: {
      readonly cwd: string;
      readonly projectNodeId: string;
      readonly issueNodeId: string;
    }) => Effect.Effect<GitHubProjectItemSnapshot | null, GitHubProjectsApiError>;

    /**
     * Convert a draft item into an issue in the given repository through the
     * Project's own conversion, keeping the same Project item.
     */
    readonly convertDraftToIssue: (input: {
      readonly cwd: string;
      readonly itemId: string;
      readonly repositoryNodeId: string;
    }) => Effect.Effect<GitHubProjectItemSnapshot | null, GitHubProjectsApiError>;

    /** Remove an item from the board. The underlying issue is untouched. */
    readonly deleteItem: (input: {
      readonly cwd: string;
      readonly projectNodeId: string;
      readonly itemId: string;
    }) => Effect.Effect<void, GitHubProjectsApiError>;

    /** Write the board column for an item. */
    readonly setItemStatus: (input: {
      readonly cwd: string;
      readonly projectNodeId: string;
      readonly itemId: string;
      readonly status: TaskStatus;
      readonly field: { statusFieldId: string; options: ReadonlyArray<BoardSingleSelectOption> };
    }) => Effect.Effect<boolean, GitHubProjectsApiError>;

    /** Create a repository issue, returning its node id and coordinates. */
    readonly createIssue: (input: {
      readonly cwd: string;
      readonly title: string;
      readonly body: string;
    }) => Effect.Effect<
      { nodeId: string; number: number; url: string },
      GitHubProjectsApiError | GitHubIssueUrlDecodeError
    >;
  }
>()("t3/task/GitHubProjectsApi") {}

interface GraphQlVariables {
  readonly [name: string]: unknown;
}

export const make = Effect.gen(function* () {
  const gh = yield* GitHubCli;

  const graphql = (cwd: string, query: string, variables: GraphQlVariables = {}) => {
    const body = JSON.stringify({ query, variables });
    return gh
      .execute({
        cwd,
        // The full request goes through stdin: `-f`/`-F` cannot express
        // object-typed variables like `AddProjectV2DraftIssueInput!`, and
        // stdin also keeps user text out of argv.
        args: ["api", "graphql", "--input", "-"],
        stdin: body,
        // GraphQL failures arrive as a structured body with a non-zero exit;
        // the body carries the precise error, the generic exit error does not.
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map(({ stdout }) => parseJson(stdout)),
        Effect.flatMap((body) => {
          const record = asRecord(body);
          const errors = record?.errors;
          if (Array.isArray(errors) && errors.length > 0) {
            const messages = errors.flatMap((entry) => {
              const message = asString(asRecord(entry)?.message);
              return message === null ? [] : [message];
            });
            return Effect.fail(new GitHubGraphQlError({ messages }));
          }
          return Effect.succeed(asRecord(record?.data));
        }),
      );
  };

  const resolveRepository: GitHubProjectsApi["Service"]["resolveRepository"] = ({ cwd }) =>
    gh
      .execute({
        cwd,
        args: ["repo", "view", "--json", "id,nameWithOwner,owner"],
      })
      .pipe(
        Effect.map(({ stdout }) => {
          const record = asRecord(parseJson(stdout));
          const nameWithOwner = asString(record?.nameWithOwner);
          const ownerLogin = asString(asRecord(record?.owner)?.login);
          const repositoryNodeId = asString(record?.id);
          if (nameWithOwner === null || ownerLogin === null || repositoryNodeId === null) {
            return null;
          }
          return { nameWithOwner, ownerLogin, repositoryNodeId };
        }),
      );

  const parseProjectListNodes = (data: Record<string, unknown>): Array<Record<string, unknown>> => {
    const connection = asRecord(data.projectsV2);
    const list = connection?.nodes;
    if (!Array.isArray(list)) return [];
    return list.flatMap((entry) => {
      const record = asRecord(entry);
      return record !== null && asString(record.id) !== null ? [record] : [];
    });
  };

  const toProjectContext = (
    record: Record<string, unknown>,
    fallbackOwnerLogin: string,
  ): Omit<GitHubProjectContext, "statusFieldId" | "statusOptions"> | null => {
    const projectNodeId = asString(record.id);
    const projectNumber = asNumber(record.number);
    const title = asString(record.title) ?? "";
    const ownerLogin = asString(asRecord(record.owner)?.login) ?? fallbackOwnerLogin;
    if (projectNodeId === null || projectNumber === null) return null;
    return { projectNodeId, projectNumber, ownerLogin, title };
  };

  const attachStatusField = (
    cwd: string,
    project: Omit<GitHubProjectContext, "statusFieldId" | "statusOptions">,
  ): Effect.Effect<GitHubProjectContext, GitHubProjectsApiError> =>
    graphql(cwd, STATUS_FIELD_QUERY, { id: project.projectNodeId }).pipe(
      Effect.map((data) => {
        const fields = asRecord(asRecord(asRecord(data)?.node)?.fields)?.nodes;
        const list = Array.isArray(fields) ? fields : [];
        for (const entry of list) {
          const field = asRecord(entry);
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
          return { ...project, statusFieldId, statusOptions };
        }
        return { ...project, statusFieldId: null, statusOptions: [] };
      }),
    );

  const resolveProjects: GitHubProjectsApi["Service"]["resolveProjects"] = ({ cwd, repository }) =>
    Effect.gen(function* () {
      const [owner] = repository.nameWithOwner.split("/", 2);
      if (!owner) return [];

      const repositoryData = yield* graphql(cwd, REPOSITORY_PROJECTS_QUERY, {
        owner,
        name: repository.nameWithOwner.slice(owner.length + 1),
      }).pipe(Effect.orElseSucceed(() => null));
      const repositoryRecord = asRecord(asRecord(repositoryData)?.repository);
      // Only repository-linked Projects v2 boards are considered; owner-owned
      // boards are intentionally not returned. A workspace whose repository has
      // no linked board must surface "No project located" rather than inherit an
      // unrelated board that merely shares the repository's owner.
      if (repositoryRecord === null || repositoryRecord === undefined) return [];
      const linked: Array<Omit<GitHubProjectContext, "statusFieldId" | "statusOptions">> = [];
      for (const record of parseProjectListNodes(repositoryRecord)) {
        const context = toProjectContext(record, repository.ownerLogin);
        if (context !== null) linked.push(context);
      }

      const candidates = linked.slice(0, PROJECT_CANDIDATE_LIMIT);
      return yield* Effect.forEach(candidates, (candidate) => attachStatusField(cwd, candidate), {
        concurrency: 4,
      });
    });

  const fetchStatusField: GitHubProjectsApi["Service"]["fetchStatusField"] = ({
    cwd,
    projectNodeId,
  }) =>
    graphql(cwd, STATUS_FIELD_QUERY, { id: projectNodeId }).pipe(
      Effect.map((data) => {
        const fields = asRecord(asRecord(asRecord(data)?.node)?.fields)?.nodes;
        const list = Array.isArray(fields) ? fields : [];
        for (const entry of list) {
          const field = asRecord(entry);
          if (field === null) continue;
          if (asString(field.name)?.toLowerCase() !== "status") continue;
          const statusFieldId = asString(field.id);
          const rawOptions = field.options;
          if (statusFieldId === null || !Array.isArray(rawOptions)) continue;
          const options = rawOptions.flatMap((optionEntry) => {
            const option = asRecord(optionEntry);
            const id = asString(option?.id);
            const name = asString(option?.name);
            return id !== null && name !== null ? [{ id, name }] : [];
          });
          if (options.length > 0) return { statusFieldId, options };
        }
        return null;
      }),
    );

  const listItems: GitHubProjectsApi["Service"]["listItems"] = ({ cwd, projectNodeId }) =>
    Effect.gen(function* () {
      const snapshots: GitHubProjectItemSnapshot[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < ITEM_PAGE_LIMIT; page += 1) {
        const data = yield* graphql(cwd, PROJECT_ITEMS_QUERY, {
          id: projectNodeId,
          ...(cursor !== null ? { cursor } : {}),
        });
        const connection = asRecord(asRecord(asRecord(data)?.node)?.items);
        const nodes = connection?.nodes;
        if (!Array.isArray(nodes)) break;
        for (const node of nodes) {
          const snapshot = parseProjectItem(node);
          if (snapshot !== null) snapshots.push(snapshot);
        }
        const pageInfo = asRecord(connection?.pageInfo);
        if (asString(pageInfo?.endCursor) === null || pageInfo?.hasNextPage !== true) break;
        cursor = asString(pageInfo?.endCursor) ?? null;
        if (cursor === null) break;
      }
      return snapshots;
    });

  const fetchItem: GitHubProjectsApi["Service"]["fetchItem"] = ({ cwd, itemId }) =>
    graphql(cwd, SINGLE_ITEM_QUERY, { id: itemId }).pipe(
      Effect.map((data) => parseProjectItem(asRecord(data)?.node)),
    );

  const itemFromMutationPayload = (
    data: unknown,
    payloadKey: string,
  ): GitHubProjectItemSnapshot | null => {
    const payload = asRecord(asRecord(data)?.[payloadKey]);
    return parseProjectItem(payload?.item ?? payload?.projectItem);
  };

  const addDraftIssue: GitHubProjectsApi["Service"]["addDraftIssue"] = ({
    cwd,
    projectNodeId,
    title,
    body,
  }) =>
    graphql(cwd, ADD_DRAFT_ISSUE_MUTATION, {
      input: { projectId: projectNodeId, title, body },
    }).pipe(Effect.map((data) => itemFromMutationPayload(data, "addProjectV2DraftIssue")));

  const addIssueToProject: GitHubProjectsApi["Service"]["addIssueToProject"] = ({
    cwd,
    projectNodeId,
    issueNodeId,
  }) =>
    graphql(cwd, ADD_ISSUE_BY_ID_MUTATION, {
      input: { projectId: projectNodeId, contentId: issueNodeId },
    }).pipe(Effect.map((data) => itemFromMutationPayload(data, "addProjectV2ItemById")));

  const convertDraftToIssue: GitHubProjectsApi["Service"]["convertDraftToIssue"] = ({
    cwd,
    itemId,
    repositoryNodeId,
  }) =>
    graphql(cwd, CONVERT_DRAFT_TO_ISSUE_MUTATION, {
      input: { itemId, repositoryId: repositoryNodeId },
    }).pipe(
      Effect.map((data) => itemFromMutationPayload(data, "convertProjectV2DraftIssueItemToIssue")),
    );

  const deleteItem: GitHubProjectsApi["Service"]["deleteItem"] = ({ cwd, projectNodeId, itemId }) =>
    graphql(cwd, DELETE_ITEM_MUTATION, {
      input: { projectId: projectNodeId, itemId },
    }).pipe(Effect.asVoid);

  const setItemStatus: GitHubProjectsApi["Service"]["setItemStatus"] = ({
    cwd,
    projectNodeId,
    itemId,
    status,
    field,
  }) => {
    const option = resolveBoardOptionForStatus(status, field.options);
    if (option === null) return Effect.succeed(false);
    return graphql(cwd, SET_ITEM_FIELD_VALUE_MUTATION, {
      input: {
        projectId: projectNodeId,
        itemId,
        fieldId: field.statusFieldId,
        value: { singleSelectOptionId: option.id },
      },
    }).pipe(Effect.as(true));
  };

  const createIssue: GitHubProjectsApi["Service"]["createIssue"] = ({ cwd, title, body }) =>
    Effect.gen(function* () {
      // `gh issue create` prints only the issue URL, so the number is read
      // back from it and the node id fetched separately for Projects v2.
      const created = yield* gh.execute({
        cwd,
        args: ["issue", "create", "--title", title, "--body", body],
      });
      const match = created.stdout.match(/https?:\/\/\S+\/issues\/(\d+)/);
      if (!match) {
        return yield* new GitHubIssueUrlDecodeError({
          cwd,
          stdout: created.stdout.trim(),
        });
      }
      const number = Number.parseInt(match[1] ?? "", 10);
      const viewed = yield* gh.execute({
        cwd,
        args: ["issue", "view", String(number), "--json", "id,number,url"],
      });
      const record = asRecord(parseJson(viewed.stdout));
      return {
        nodeId: asString(record?.id) ?? `issue-${number}`,
        number,
        url: asString(record?.url) ?? match[0],
      };
    });

  return GitHubProjectsApi.of({
    resolveRepository,
    resolveProjects,
    fetchStatusField,
    listItems,
    fetchItem,
    addDraftIssue,
    addIssueToProject,
    convertDraftToIssue,
    deleteItem,
    setItemStatus,
    createIssue,
  });
});

export const layer = Layer.effect(GitHubProjectsApi, make);
