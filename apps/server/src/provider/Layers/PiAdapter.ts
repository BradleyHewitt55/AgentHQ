// @effect-diagnostics globalDate:off
import crypto from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  EventId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type PiSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { loadPiSdk } from "./piSdk.ts";

const PROVIDER = ProviderDriverKind.make("pi");

type PiContext = {
  providerSession: ProviderSession;
  agent: AgentSession;
  unsubscribe: () => void;
  activeTurnId: TurnId | undefined;
  assistantItemId: RuntimeItemId | undefined;
  reasoningItemId: RuntimeItemId | undefined;
  toolItems: Map<string, RuntimeItemId>;
  turns: Array<{ id: TurnId; items: unknown[] }>;
  abortInFlight: boolean;
  stopped: boolean;
};

const message = (cause: unknown) =>
  cause instanceof Error && cause.message.trim() ? cause.message : String(cause);

const itemId = () => RuntimeItemId.make(crypto.randomUUID());
const now = () => new globalThis.Date().toISOString();
const joinPath = (directory: string, filename: string) =>
  `${directory.replace(/[\\/]$/u, "")}/${filename}`;

export const rollbackTurns = <T>(turns: T[], numTurns: number): T[] | undefined => {
  if (!Number.isInteger(numTurns) || numTurns < 1 || numTurns > turns.length) return undefined;
  turns.splice(turns.length - numTurns, numTurns);
  return turns;
};

export interface PiAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makePiAdapter = (
  settings: PiSettings,
  options: PiAdapterOptions,
): Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, never> =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, PiContext>();
    const agentDir = settings.agentDir.trim() || undefined;

    const emit = (context: PiContext, event: Record<string, unknown>) => {
      void Effect.runPromise(
        Queue.offer(events, {
          eventId: EventId.make(crypto.randomUUID()),
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          threadId: context.providerSession.threadId,
          createdAt: now(),
          ...event,
        } as ProviderRuntimeEvent),
      );
    };

    const currentTurn = (context: PiContext) =>
      context.turns.find((turn) => turn.id === context.activeTurnId);

    const addItem = (context: PiContext, item: unknown) => currentTurn(context)?.items.push(item);

    const handleEvent = (context: PiContext, event: AgentSessionEvent) => {
      const raw = { source: "pi.sdk.event" as const, method: event.type, payload: event };
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
            itemType:
              event.toolName === "bash"
                ? "command_execution"
                : event.toolName === "edit" || event.toolName === "write"
                  ? "file_change"
                  : "dynamic_tool_call",
            status: "inProgress",
            title: event.toolName,
            data: { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
          },
          raw,
        });
        addItem(context, {
          itemId: id,
          itemType:
            event.toolName === "bash"
              ? "command_execution"
              : event.toolName === "edit" || event.toolName === "write"
                ? "file_change"
                : "dynamic_tool_call",
          status: "inProgress",
          title: event.toolName,
          data: { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        const id = context.toolItems.get(event.toolCallId) ?? itemId();
        emit(context, {
          type: "item.completed",
          turnId: context.activeTurnId,
          itemId: id,
          payload: {
            itemType:
              event.toolName === "bash"
                ? "command_execution"
                : event.toolName === "edit" || event.toolName === "write"
                  ? "file_change"
                  : "dynamic_tool_call",
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
          itemType:
            event.toolName === "bash"
              ? "command_execution"
              : event.toolName === "edit" || event.toolName === "write"
                ? "file_change"
                : "dynamic_tool_call",
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
      if (event.type === "agent_end" && context.activeTurnId && !event.willRetry) {
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
        emit(context, {
          type: "turn.completed",
          turnId: context.activeTurnId,
          payload: {
            state: context.abortInFlight ? "cancelled" : "completed",
            usage: stats.tokens,
            cumulativeCostUsd: stats.cost,
          },
          raw,
        });
        context.activeTurnId = undefined;
        context.assistantItemId = undefined;
        context.reasoningItemId = undefined;
        context.abortInFlight = false;
        context.providerSession = {
          ...context.providerSession,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: now(),
          resumeCursor: context.agent.sessionFile,
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
      const [modelProvider, ...modelParts] = selected?.includes("/") ? selected.split("/") : [];
      const model = modelProvider
        ? modelRuntime.getModel(modelProvider, modelParts.join("/"))
        : selected
          ? modelRuntime.getModels().find((entry) => entry.id === selected)
          : undefined;
      const resumeFile = typeof input.resumeCursor === "string" ? input.resumeCursor : undefined;
      const manager = resumeFile ? SessionManager.open(resumeFile) : SessionManager.create(cwd);
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
        turns: [],
        abortInFlight: false,
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
        const slash = selected.indexOf("/");
        const runtime = context.agent.modelRuntime;
        const model =
          slash > 0
            ? runtime.getModel(selected.slice(0, slash), selected.slice(slash + 1))
            : runtime.getModels().find((entry) => entry.id === selected);
        if (model)
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
      const turnId = TurnId.make(crypto.randomUUID());
      context.activeTurnId = turnId;
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
      const attachmentLines = (input.attachments ?? []).map(
        (attachment) => `[Attached image: ${attachment.name}]`,
      );
      const prompt = [input.input?.trim(), ...attachmentLines].filter(Boolean).join("\n\n");
      Effect.runPromise(
        Effect.tryPromise({
          try: () => context.agent.prompt(prompt),
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
      ).catch(() => undefined);
      return {
        threadId: input.threadId,
        turnId,
        ...(context.agent.sessionFile ? { resumeCursor: context.agent.sessionFile } : {}),
      };
    });

    const stop = (context: PiContext) =>
      Effect.tryPromise({
        try: async () => {
          context.stopped = true;
          context.unsubscribe();
          await context.agent.abort();
          context.agent.dispose();
          sessions.delete(context.providerSession.threadId);
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
        Effect.forEach(Array.from(sessions.values()), stop, {
          concurrency: "unbounded",
          discard: true,
        }),
      streamEvents: Stream.fromQueue(events),
    };
  });
