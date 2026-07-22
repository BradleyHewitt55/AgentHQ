// @effect-diagnostics globalDate:off
import crypto from "node:crypto";
import {
  type AntigravitySettings,
  EventId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";

import {
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");
const DEFAULT_MODEL = "Gemini 3.5 Flash";

// The `agy` CLI only accepts `--model` values with an explicit reasoning
// effort suffix (e.g. "Gemini 3.5 Flash (Medium)") — a bare model name is
// rejected with "invalid --model". Base model names are kept as the
// UI-facing slug; the effort suffix is appended right before invoking the
// CLI so settings/UI never need to know about efforts.
const DEFAULT_EFFORT_BY_MODEL: Readonly<Record<string, string>> = {
  "Gemini 3.6 Flash": "Medium",
  "Gemini 3.5 Flash": "Medium",
  "Gemini 3.1 Pro": "Low",
  "Claude Sonnet 4.6": "High",
  "Claude Opus 4.6": "High",
  "GPT-OSS 120B": "Medium",
};

function resolveCliModel(model: string): string {
  if (/\([^()]+\)\s*$/u.test(model)) return model;
  const effort = DEFAULT_EFFORT_BY_MODEL[model] ?? "Medium";
  return `${model} (${effort})`;
}

type AntigravityContext = {
  providerSession: ProviderSession;
  activeTurnId: TurnId | undefined;
  activeHandle: ChildProcessHandle | undefined;
  turns: Array<{ id: TurnId; items: unknown[] }>;
  interrupted: boolean;
  stopped: boolean;
};

const message = (cause: unknown) =>
  cause instanceof Error && cause.message.trim() ? cause.message : String(cause);

const now = () => new globalThis.Date().toISOString();

export interface AntigravityAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeAntigravityAdapter = (
  settings: AntigravitySettings,
  options: AntigravityAdapterOptions,
): Effect.Effect<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, AntigravityContext>();
    const binaryPath = settings.binaryPath.trim() || "agy";

    const emit = (context: AntigravityContext, event: Record<string, unknown>) => {
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

    const getContext = (
      threadId: ThreadId,
    ): Effect.Effect<AntigravityContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return context !== undefined
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = Effect.fn(
      "AntigravityAdapter.startSession",
    )(function* (input) {
      const existing = sessions.get(input.threadId);
      if (existing) return existing.providerSession;
      const cwd = input.cwd ?? process.cwd();
      const model = input.modelSelection?.model ?? DEFAULT_MODEL;
      const providerSession: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        model,
        threadId: input.threadId,
        createdAt: now(),
        updatedAt: now(),
      };
      const context: AntigravityContext = {
        providerSession,
        activeTurnId: undefined,
        activeHandle: undefined,
        turns: [],
        interrupted: false,
        stopped: false,
      };
      sessions.set(input.threadId, context);
      emit(context, {
        type: "session.started",
        payload: { message: "Antigravity CLI session started" },
      });
      emit(context, { type: "thread.started", payload: {} });
      return providerSession;
    });

    const runTurn = (
      context: AntigravityContext,
      turnId: TurnId,
      threadId: ThreadId,
      prompt: string,
      model: string,
    ) =>
      Effect.gen(function* () {
        const assistantItemId = RuntimeItemId.make(crypto.randomUUID());
        const command = ChildProcess.make(
          binaryPath,
          [
            "--new-project",
            "--dangerously-skip-permissions",
            "--model",
            resolveCliModel(model),
            "-p",
            prompt,
          ],
          {
            cwd: context.providerSession.cwd ?? process.cwd(),
            ...(options.environment ? { env: options.environment, extendEnv: false } : {}),
          },
        );
        const handle = yield* spawner.spawn(command);
        context.activeHandle = handle;
        const [stdoutText, stderrText, exitCode] = yield* Effect.all(
          [
            Stream.decodeText(handle.stdout).pipe(Stream.mkString),
            Stream.decodeText(handle.stderr).pipe(Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        const interrupted = context.interrupted;
        const failed = !interrupted && exitCode !== 0;
        const content = stdoutText.trim();
        if (content && !failed && !interrupted) {
          emit(context, {
            type: "item.started",
            turnId,
            itemId: assistantItemId,
            payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" },
          });
          emit(context, {
            type: "content.delta",
            turnId,
            itemId: assistantItemId,
            payload: { streamKind: "assistant_text", delta: content },
          });
          emit(context, {
            type: "item.completed",
            turnId,
            itemId: assistantItemId,
            payload: { itemType: "assistant_message", status: "completed", title: "Assistant" },
          });
        }
        if (failed && stderrText.trim()) {
          emit(context, {
            type: "runtime.error",
            turnId,
            payload: { message: stderrText.trim(), class: "provider_error" },
          });
        }
        context.activeHandle = undefined;
        context.activeTurnId = undefined;
        context.providerSession = {
          ...context.providerSession,
          status: failed ? "error" : "ready",
          activeTurnId: undefined,
          updatedAt: now(),
          ...(failed
            ? {
                lastError:
                  stderrText.trim() || `Antigravity CLI exited with code ${exitCode.toString()}.`,
              }
            : {}),
        };
        emit(context, {
          type: "turn.completed",
          turnId,
          payload: interrupted
            ? { state: "interrupted" }
            : failed
              ? {
                  state: "failed",
                  errorMessage:
                    stderrText.trim() || `Antigravity CLI exited with code ${exitCode.toString()}.`,
                }
              : { state: "completed" },
        });
      }).pipe(
        Effect.scoped,
        Effect.catch((cause: unknown) =>
          Effect.sync(() => {
            context.activeHandle = undefined;
            context.activeTurnId = undefined;
            emit(context, {
              type: "runtime.error",
              turnId,
              payload: { message: message(cause), class: "transport_error" },
            });
            emit(context, {
              type: "turn.completed",
              turnId,
              payload: { state: "failed", errorMessage: message(cause) },
            });
          }),
        ),
      );

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = Effect.fn(
      "AntigravityAdapter.sendTurn",
    )(function* (input: ProviderSendTurnInput) {
      const context = yield* getContext(input.threadId);
      if (context.stopped)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Antigravity session is stopped.",
        });
      const prompt = input.input?.trim();
      if (!prompt)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "A prompt is required.",
        });
      const turnId = TurnId.make(crypto.randomUUID());
      context.activeTurnId = turnId;
      context.interrupted = false;
      context.turns.push({ id: turnId, items: [] });
      const model = input.modelSelection?.model ?? context.providerSession.model ?? DEFAULT_MODEL;
      context.providerSession = {
        ...context.providerSession,
        status: "running",
        model,
        activeTurnId: turnId,
        updatedAt: now(),
      };
      emit(context, { type: "turn.started", turnId, payload: { model } });
      yield* Effect.forkDetach(runTurn(context, turnId, input.threadId, prompt, model));
      return { threadId: input.threadId, turnId };
    });

    const stop = (context: AntigravityContext) =>
      Effect.gen(function* () {
        context.stopped = true;
        context.interrupted = true;
        if (context.activeHandle)
          yield* Effect.orElseSucceed(context.activeHandle.kill(), () => undefined);
        sessions.delete(context.providerSession.threadId);
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn: (threadId) =>
        getContext(threadId).pipe(
          Effect.flatMap((context) => {
            context.interrupted = true;
            return context.activeHandle
              ? Effect.orElseSucceed(context.activeHandle.kill(), () => undefined)
              : Effect.void;
          }),
        ),
      respondToRequest: (threadId) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToRequest",
            issue: `Antigravity CLI print mode does not support approvals (${threadId}).`,
          }),
        ),
      respondToUserInput: (threadId) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: `Antigravity CLI print mode does not support user input requests (${threadId}).`,
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
          Effect.map((context) => {
            context.turns.splice(Math.max(0, context.turns.length - Math.max(0, numTurns)));
            return { threadId, turns: context.turns };
          }),
        ),
      stopAll: () =>
        Effect.forEach(Array.from(sessions.values()), stop, {
          concurrency: "unbounded",
          discard: true,
        }),
      streamEvents: Stream.fromQueue(events),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
