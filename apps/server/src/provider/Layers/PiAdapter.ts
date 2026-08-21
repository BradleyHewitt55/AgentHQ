// @effect-diagnostics globalDate:off runEffectInsideEffect:off
import * as NodeCrypto from "node:crypto";
import type {
  AgentSession,
  AgentSessionEvent,
  PromptOptions,
} from "@earendil-works/pi-coding-agent";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type PiSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import {
  buildRuntimeEvent,
  joinPath,
  message,
  now,
  rollbackTurns,
  type ProviderRuntimeEventDraft,
} from "./adapterShared.ts";
import { loadPiSdk } from "./piSdk.ts";

export { rollbackTurns } from "./adapterShared.ts";

const PROVIDER = ProviderDriverKind.make("pi");

type PiModelRuntime = AgentSession["modelRuntime"];

type PiContext = {
  providerSession: ProviderSession;
  agent: AgentSession;
  unsubscribe: () => void;
  activeTurnId: TurnId | undefined;
  assistantItemId: RuntimeItemId | undefined;
  reasoningItemId: RuntimeItemId | undefined;
  toolItems: Map<string, RuntimeItemId>;
  piSubagentIds: Set<string>;
  turns: Array<{ id: TurnId; items: unknown[] }>;
  abortInFlight: boolean;
  turnError: string | undefined;
  stopped: boolean;
};

const itemId = () => RuntimeItemId.make(NodeCrypto.randomUUID());

const asRecord = (value: unknown) =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const asNonEmptyString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

// T3's Pi subagent extension reports its durable child IDs in tool results
// and sends a custom result message when background work settles.
const piSubagentStatus = (value: unknown) => {
  switch (value) {
    case "running":
      return "running" as const;
    case "done":
      return "completed" as const;
    case "error":
      return "failed" as const;
    default:
      return undefined;
  }
};

const piSubagentPaths = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return value.reduce<string[]>((paths, entry) => {
    const path = asNonEmptyString(entry);
    return path && !paths.includes(path) ? [...paths, path] : paths;
  }, []);
};

const piSubagentDetails = (value: unknown) => {
  const record = asRecord(value);
  const id = asNonEmptyString(record?.id);
  if (!id) return undefined;
  return {
    id,
    title: asNonEmptyString(record?.title) ?? id,
    harness: asNonEmptyString(record?.harness),
    model: asNonEmptyString(record?.model),
    status: piSubagentStatus(record?.status),
    // Pi's base SDK does not stream child tool calls to the parent. Only
    // show paths explicitly provided by a subagent extension snapshot.
    activeFiles: piSubagentPaths(record?.activeFiles ?? record?.workingFiles),
    changedFiles: piSubagentPaths(record?.changedFiles),
  };
};

const piSubagentDetailsFromResult = (result: unknown) =>
  piSubagentDetails(asRecord(result)?.details);

const piSubagentResultsFromResult = (result: unknown) => {
  const details = asRecord(asRecord(result)?.details);
  const entries = [
    ...(Array.isArray(details?.subagents) ? details.subagents : []),
    ...(Array.isArray(details?.results) ? details.results : []),
  ];
  return entries.flatMap((entry) => {
    const parsed = piSubagentDetails(entry);
    return parsed ? [parsed] : [];
  });
};

const piSubagentResultText = (value: unknown) => {
  if (typeof value === "string") return asNonEmptyString(value);
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => asNonEmptyString(asRecord(entry)?.text))
    .find((text) => text !== undefined);
};

// Some Pi providers return the complete assistant message without emitting
// text deltas. Preserve that response instead of leaving a submitted T3 turn
// visibly empty.
const piAssistantText = (value: unknown) => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      const value = asNonEmptyString(asRecord(entry)?.text);
      return value ? [value] : [];
    })
    .join("");
  return text.length > 0 ? text : undefined;
};

/** The Pi SDK addresses models as `provider/id`; one parser for every call site. */
const resolveModel = (runtime: PiModelRuntime, slug: string) => {
  const separator = slug.indexOf("/");
  return separator > 0
    ? runtime.getModel(slug.slice(0, separator), slug.slice(separator + 1))
    : runtime.getModels().find((entry) => entry.id === slug);
};

const toolItemType = (toolName: string) =>
  toolName === "bash"
    ? ("command_execution" as const)
    : toolName === "edit" || toolName === "write"
      ? ("file_change" as const)
      : ("dynamic_tool_call" as const);

export interface PiAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}

export type PiAdapterEnv = FileSystem.FileSystem | ServerConfig;

/** Structure the Pi SDK requires for image input (`ImageContent`). */
interface PiImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export const makePiAdapter = (
  settings: PiSettings,
  options: PiAdapterOptions,
): Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, never, PiAdapterEnv> =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, PiContext>();
    const agentDir = settings.agentDir.trim() || undefined;

    const buildImages = (input: ProviderSendTurnInput) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { attachmentsDir } = yield* ServerConfig;
        const images: PiImageContent[] = [];
        for (const attachment of input.attachments ?? []) {
          const attachmentPath = resolveAttachmentPath({ attachmentsDir, attachment });
          if (!attachmentPath)
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Invalid attachment id '${attachment.id}'.`,
            });
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "sendTurn",
                  detail: `Failed to read attachment '${attachment.id}': ${message(cause)}.`,
                  cause,
                }),
            ),
          );
          images.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
        return images;
      });

    const emit = (context: PiContext, draft: ProviderRuntimeEventDraft) => {
      // Offering to an unbounded queue always completes synchronously, so this
      // never escapes fiber supervision the way a floating promise would.
      Effect.runSync(
        Queue.offer(
          events,
          buildRuntimeEvent(
            {
              provider: PROVIDER,
              providerInstanceId: options.instanceId,
              threadId: context.providerSession.threadId,
            },
            draft,
          ),
        ),
      );
    };

    const currentTurn = (context: PiContext) =>
      context.turns.find((turn) => turn.id === context.activeTurnId);

    const addItem = (context: PiContext, item: unknown) => currentTurn(context)?.items.push(item);

    const startTurn = (context: PiContext) => {
      const turnId = TurnId.make(NodeCrypto.randomUUID());
      context.activeTurnId = turnId;
      context.turnError = undefined;
      context.turns.push({ id: turnId, items: [] });
      context.providerSession = {
        ...context.providerSession,
        status: "running",
        activeTurnId: turnId,
        updatedAt: now(),
      };
      emit(context, {
        type: "turn.started",
        turnId,
        payload: {
          model: context.agent.model
            ? `${context.agent.model.provider}/${context.agent.model.id}`
            : undefined,
        },
        raw: { source: "pi.sdk.event", method: "prompt", payload: {} },
      });
      return turnId;
    };

    const emitPiSubagent = (
      context: PiContext,
      details: NonNullable<ReturnType<typeof piSubagentDetails>>,
      summary?: string,
    ) => {
      const taskId = RuntimeTaskId.make(details.id);
      if (!context.piSubagentIds.has(details.id)) {
        context.piSubagentIds.add(details.id);
        emit(context, {
          type: "task.started",
          turnId: context.activeTurnId,
          payload: {
            taskId,
            description: details.title,
            taskType: "subagent",
            title: details.title,
            ...(details.harness ? { role: `${details.harness} subagent` } : {}),
            ...(details.model ? { model: details.model } : {}),
            activeFiles: details.activeFiles,
            ...(details.changedFiles.length > 0 ? { changedFiles: details.changedFiles } : {}),
          },
          raw: { source: "pi.sdk.event", method: "subagent", payload: details },
        });
      }
      if (details.status === "completed" || details.status === "failed") {
        emit(context, {
          type: "task.completed",
          turnId: context.activeTurnId,
          payload: {
            taskId,
            status: details.status,
            ...(summary ? { summary } : {}),
            taskType: "subagent",
            title: details.title,
            ...(details.harness ? { role: `${details.harness} subagent` } : {}),
            ...(details.model ? { model: details.model } : {}),
            activeFiles: [],
            ...(details.changedFiles.length > 0 ? { changedFiles: details.changedFiles } : {}),
          },
          raw: { source: "pi.sdk.event", method: "subagent", payload: details },
        });
        return;
      }
      emit(context, {
        type: "task.progress",
        turnId: context.activeTurnId,
        payload: {
          taskId,
          description: details.title,
          status: "running",
          summary: summary ?? "Running in background",
          taskType: "subagent",
          title: details.title,
          ...(details.harness ? { role: `${details.harness} subagent` } : {}),
          ...(details.model ? { model: details.model } : {}),
          activeFiles: details.activeFiles,
          ...(details.changedFiles.length > 0 ? { changedFiles: details.changedFiles } : {}),
        },
        raw: { source: "pi.sdk.event", method: "subagent", payload: details },
      });
    };

    const handleEvent = (context: PiContext, event: AgentSessionEvent) => {
      const raw = { source: "pi.sdk.event" as const, method: event.type, payload: event };
      // Extension messages with triggerTurn restart the Pi agent after its
      // foreground turn settled. Give that continuation its own lifecycle so
      // its result and sibling task state stay visible together.
      if (event.type === "agent_start" && !context.activeTurnId) {
        startTurn(context);
        return;
      }
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          context.assistantItemId ??= itemId();
          emit(context, {
            type: "content.delta",
            turnId: context.activeTurnId,
            itemId: context.assistantItemId,
            payload: { streamKind: "assistant_text", delta: update.delta },
            raw,
          });
        } else if (update.type === "thinking_delta") {
          context.reasoningItemId ??= itemId();
          emit(context, {
            type: "content.delta",
            turnId: context.activeTurnId,
            itemId: context.reasoningItemId,
            payload: { streamKind: "reasoning_text", delta: update.delta },
            raw,
          });
        }
        return;
      }
      if (event.type === "tool_execution_start") {
        const id = itemId();
        context.toolItems.set(event.toolCallId, id);
        emit(context, {
          type: "item.started",
          turnId: context.activeTurnId,
          itemId: id,
          payload: {
            itemType: toolItemType(event.toolName),
            status: "inProgress",
            title: event.toolName,
            data: { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
          },
          raw,
        });
        addItem(context, {
          itemId: id,
          itemType: toolItemType(event.toolName),
          status: "inProgress",
          title: event.toolName,
          data: { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        if (!event.isError && event.toolName === "subagent_spawn") {
          const details = piSubagentDetailsFromResult(event.result);
          if (details) emitPiSubagent(context, details);
        }
        if (
          !event.isError &&
          ["subagent_list", "subagent_wait", "subagent_cancel"].includes(event.toolName)
        ) {
          for (const details of piSubagentResultsFromResult(event.result)) {
            emitPiSubagent(context, details);
          }
        }
        if (!event.isError && event.toolName === "subagent_check") {
          const details = piSubagentDetailsFromResult(event.result);
          if (details) emitPiSubagent(context, details);
        }
        const id = context.toolItems.get(event.toolCallId) ?? itemId();
        emit(context, {
          type: "item.completed",
          turnId: context.activeTurnId,
          itemId: id,
          payload: {
            itemType: toolItemType(event.toolName),
            status: event.isError ? "failed" : "completed",
            title: event.toolName,
            data: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              result: event.result,
              isError: event.isError,
            },
          },
          raw,
        });
        addItem(context, {
          itemId: id,
          itemType: toolItemType(event.toolName),
          status: event.isError ? "failed" : "completed",
          title: event.toolName,
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
          },
        });
        context.toolItems.delete(event.toolCallId);
        return;
      }
      if (event.type === "message_end") {
        if (event.message.role === "assistant") {
          // A failed Pi run does not reject `prompt()`: the agent loop catches
          // the error and hands back an assistant message carrying
          // `stopReason: "error"` and an empty body. Without reading it here an
          // auth or transport failure settles as an empty *completed* turn and
          // the thread renders nothing at all.
          if (event.message.stopReason === "error") {
            context.turnError = asNonEmptyString(event.message.errorMessage) ?? "Pi turn failed.";
            emit(context, {
              type: "runtime.error",
              turnId: context.activeTurnId,
              payload: { message: context.turnError, class: "provider_error" },
              raw,
            });
          } else if (event.message.stopReason === "aborted") {
            context.abortInFlight = true;
          }
          if (!context.assistantItemId) {
            const text = piAssistantText(event.message.content);
            if (text) {
              context.assistantItemId = itemId();
              emit(context, {
                type: "content.delta",
                turnId: context.activeTurnId,
                itemId: context.assistantItemId,
                payload: { streamKind: "assistant_text", delta: text },
                raw,
              });
            }
          }
        }
        if (event.message.role === "custom" && event.message.customType === "subagent-result") {
          const details = piSubagentDetails(event.message.details);
          if (details) {
            emitPiSubagent(context, details, piSubagentResultText(event.message.content));
          }
        }
        return;
      }
      if (event.type === "agent_settled" && context.activeTurnId) {
        if (context.assistantItemId) {
          addItem(context, {
            itemId: context.assistantItemId,
            itemType: "assistant_message",
            status: "completed",
          });
          emit(context, {
            type: "item.completed",
            turnId: context.activeTurnId,
            itemId: context.assistantItemId,
            payload: { itemType: "assistant_message", status: "completed" },
            raw,
          });
        }
        if (context.reasoningItemId) {
          addItem(context, {
            itemId: context.reasoningItemId,
            itemType: "reasoning",
            status: "completed",
          });
          emit(context, {
            type: "item.completed",
            turnId: context.activeTurnId,
            itemId: context.reasoningItemId,
            payload: { itemType: "reasoning", status: "completed" },
            raw,
          });
        }
        const stats = context.agent.getSessionStats();
        const turnError = context.turnError;
        emit(context, {
          type: "turn.completed",
          turnId: context.activeTurnId,
          payload: {
            // A run that errored must not settle as "completed": that is what
            // left failed Pi turns invisible in the thread.
            ...(turnError !== undefined
              ? { state: "failed" as const, errorMessage: turnError }
              : { state: context.abortInFlight ? ("cancelled" as const) : ("completed" as const) }),
            usage: stats.tokens,
            totalCostUsd: stats.cost,
          },
          raw,
        });
        context.activeTurnId = undefined;
        context.assistantItemId = undefined;
        context.reasoningItemId = undefined;
        context.abortInFlight = false;
        context.turnError = undefined;
        context.providerSession = {
          ...context.providerSession,
          status: turnError !== undefined ? "error" : "ready",
          activeTurnId: undefined,
          updatedAt: now(),
          resumeCursor: context.agent.sessionFile,
          ...(turnError !== undefined ? { lastError: turnError } : {}),
        };
      }
    };

    const getContext = (
      threadId: ThreadId,
    ): Effect.Effect<PiContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return context !== undefined
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = Effect.fn(
      "PiAdapter.startSession",
    )(function* (input) {
      if (sessions.has(input.threadId)) return sessions.get(input.threadId)!.providerSession;
      const cwd = input.cwd ?? process.cwd();
      const { ModelRuntime, SessionManager, createAgentSession } = yield* Effect.tryPromise({
        try: () => loadPiSdk(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "startSession",
            detail: message(cause),
            cause,
          }),
      });
      const modelRuntime = yield* Effect.tryPromise({
        try: () =>
          ModelRuntime.create({
            ...(agentDir
              ? {
                  authPath: joinPath(agentDir, "auth.json"),
                  modelsPath: joinPath(agentDir, "models.json"),
                }
              : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "startSession",
            detail: message(cause),
            cause,
          }),
      });
      const selected = input.modelSelection?.model;
      // `getModel` throws for an unknown provider/id pair, and `SessionManager.open`
      // throws for an unreadable resume path — both are synchronous SDK calls that
      // would otherwise surface as fiber defects rather than typed failures.
      const model = selected
        ? yield* Effect.try({
            try: () => resolveModel(modelRuntime, selected),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "getModel",
                detail: message(cause),
                cause,
              }),
          })
        : undefined;
      const resumeFile = typeof input.resumeCursor === "string" ? input.resumeCursor : undefined;
      const manager = yield* Effect.try({
        try: () => (resumeFile ? SessionManager.open(resumeFile) : SessionManager.create(cwd)),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: resumeFile ? "SessionManager.open" : "SessionManager.create",
            detail: message(cause),
            cause,
          }),
      });
      const result = yield* Effect.tryPromise({
        try: () =>
          createAgentSession({
            cwd,
            ...(agentDir ? { agentDir } : {}),
            modelRuntime,
            ...(model ? { model } : {}),
            sessionManager: manager,
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "startSession",
            detail: message(cause),
            cause,
          }),
      });
      const providerSession: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        ...(model ? { model: `${model.provider}/${model.id}` } : {}),
        threadId: input.threadId,
        resumeCursor: result.session.sessionFile,
        createdAt: now(),
        updatedAt: now(),
      };
      const context: PiContext = {
        providerSession,
        agent: result.session,
        unsubscribe: () => undefined,
        activeTurnId: undefined,
        assistantItemId: undefined,
        reasoningItemId: undefined,
        toolItems: new Map(),
        piSubagentIds: new Set(),
        turns: [],
        abortInFlight: false,
        turnError: undefined,
        stopped: false,
      };
      context.unsubscribe = result.session.subscribe((event) => handleEvent(context, event));
      sessions.set(input.threadId, context);
      emit(context, {
        type: "session.started",
        payload: { resume: result.session.sessionFile },
        raw: { source: "pi.sdk.event", method: "session.started", payload: {} },
      });
      emit(context, {
        type: "thread.started",
        payload: { providerThreadId: result.session.sessionId },
        raw: { source: "pi.sdk.event", method: "thread.started", payload: {} },
      });
      return providerSession;
    });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = Effect.fn(
      "PiAdapter.sendTurn",
    )(function* (input: ProviderSendTurnInput) {
      const context = yield* getContext(input.threadId);
      if (context.stopped)
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: input.threadId,
        });
      if (!input.input?.trim() && !input.attachments?.length)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "A prompt or attachment is required.",
        });
      if (input.modelSelection?.model) {
        const selected = input.modelSelection.model;
        const model = yield* Effect.try({
          try: () => resolveModel(context.agent.modelRuntime, selected),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "getModel",
              detail: message(cause),
              cause,
            }),
        });
        // Skipping the switch would silently run the turn on the previous model.
        if (!model)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Unknown Pi model: ${selected}.`,
          });
        yield* Effect.tryPromise({
          try: () => context.agent.setModel(model),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "setModel",
              detail: message(cause),
              cause,
            }),
        });
      }
      const activeTurnId = context.activeTurnId;
      const streaming = activeTurnId !== undefined;
      const turnId = activeTurnId ?? startTurn(context);
      const images = yield* buildImages(input);
      // An attachment-only turn is valid here, but the Pi SDK calls
      // `text.startsWith("/")` before anything else — passing `undefined`
      // throws a bare TypeError instead of sending the image.
      const prompt = input.input?.trim() ?? "";
      // The Pi SDK requires an explicit delivery mode mid-stream. Queue a
      // follow-up so it runs after the active response instead of replacing it.
      const promptOptions: PromptOptions = {
        ...(images.length > 0 ? { images } : {}),
        // Keep the active response intact; Pi will run this as the next turn
        // once it settles. This is what users expect from a follow-up.
        ...(streaming ? { streamingBehavior: "followUp" as const } : {}),
      };
      yield* Effect.forkDetach(
        Effect.tryPromise({
          try: () => context.agent.prompt(prompt, promptOptions),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "prompt",
              detail: message(cause),
              cause,
            }),
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              emit(context, {
                type: "runtime.error",
                turnId,
                payload: { message: error.message, class: "provider_error" },
                raw: { source: "pi.sdk.event", method: "prompt.error", payload: error },
              });
              emit(context, {
                type: "turn.completed",
                turnId,
                payload: { state: "failed", errorMessage: error.message },
                raw: { source: "pi.sdk.event", method: "prompt.error", payload: error },
              });
              context.activeTurnId = undefined;
            }),
          ),
        ),
      );
      return {
        threadId: input.threadId,
        turnId,
        ...(context.agent.sessionFile ? { resumeCursor: context.agent.sessionFile } : {}),
      };
    });

    const stop = (context: PiContext) =>
      Effect.tryPromise({
        // A rejected `abort()` must not strand the agent or its `sessions`
        // entry: dispose and deregistration run either way.
        try: async () => {
          context.stopped = true;
          context.unsubscribe();
          try {
            await context.agent.abort();
          } finally {
            context.agent.dispose();
            sessions.delete(context.providerSession.threadId);
          }
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "stopSession",
            detail: message(cause),
            cause,
          }),
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn: (threadId) =>
        getContext(threadId).pipe(
          Effect.flatMap((context) =>
            Effect.sync(() => {
              context.abortInFlight = true;
            }).pipe(
              Effect.flatMap(() =>
                Effect.tryPromise({
                  try: () => context.agent.abort(),
                  catch: (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "interruptTurn",
                      detail: message(cause),
                      cause,
                    }),
                }),
              ),
            ),
          ),
        ),
      respondToRequest: (threadId) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToRequest",
            issue: `Pi does not request T3 approval decisions (${threadId}).`,
          }),
        ),
      respondToUserInput: (threadId) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: `Pi extension UI input is not supported yet (${threadId}).`,
          }),
        ),
      stopSession: (threadId) => getContext(threadId).pipe(Effect.flatMap(stop)),
      listSessions: () =>
        Effect.succeed(Array.from(sessions.values(), (context) => context.providerSession)),
      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
      readThread: (threadId) =>
        getContext(threadId).pipe(
          Effect.map((context): ProviderThreadSnapshot => ({ threadId, turns: context.turns })),
        ),
      rollbackThread: (threadId, numTurns) =>
        getContext(threadId).pipe(
          Effect.flatMap((context) =>
            rollbackTurns(context.turns, numTurns) !== undefined
              ? Effect.succeed({ threadId, turns: context.turns })
              : Effect.fail(
                  new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "rollbackThread",
                    issue: "Invalid turn count.",
                  }),
                ),
          ),
        ),
      stopAll: () =>
        // One failing session must not abandon the rest of the shutdown.
        Effect.forEach(Array.from(sessions.values()), (context) => Effect.ignore(stop(context)), {
          concurrency: "unbounded",
          discard: true,
        }),
      streamEvents: Stream.fromQueue(events),
    };
  });
