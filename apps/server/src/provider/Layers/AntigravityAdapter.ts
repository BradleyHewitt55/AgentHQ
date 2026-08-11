// @effect-diagnostics globalDate:off runEffectInsideEffect:off
import * as NodeCrypto from "node:crypto";
import {
  type AntigravitySettings,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import {
  buildRuntimeEvent,
  message,
  now,
  rollbackTurns,
  type ProviderRuntimeEventDraft,
} from "./adapterShared.ts";
import {
  ANTIGRAVITY_MAX_PROMPT_CHARS,
  AntigravityOutputSanitizer,
  buildAntigravityArgs,
  buildAntigravityPrompt,
  DEFAULT_ANTIGRAVITY_MODEL,
  isAntigravityCommandWithinBudget,
  sanitizeCliOutput,
} from "./antigravityLaunch.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");

type AntigravityContext = {
  providerSession: ProviderSession;
  activeTurnId: TurnId | undefined;
  activeHandle: ChildProcessHandle | undefined;
  turns: Array<{ id: TurnId; items: unknown[] }>;
  conversation: Array<{ turnId: TurnId; user: string; assistant: string }>;
  pendingFollowUps: Array<{ turnId: TurnId; prompt: string; model: string }>;
  interrupted: boolean;
  stopped: boolean;
};

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
  ChildProcessSpawner.ChildProcessSpawner | ServerConfig
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, AntigravityContext>();
    const binaryPath = settings.binaryPath.trim() || "agy";

    /**
     * The print-mode prompt is argv text only, so images travel as markdown
     * references the CLI resolves before handing the prompt to the model. The
     * path is the attachment store's absolute path with forward slashes; the
     * CLI process reads it itself, outside the agent sandbox.
     */
    const buildImageRefs = (input: ProviderSendTurnInput) =>
      Effect.gen(function* () {
        const { attachmentsDir } = yield* ServerConfig;
        const refs: string[] = [];
        for (const attachment of input.attachments ?? []) {
          const attachmentPath = resolveAttachmentPath({ attachmentsDir, attachment });
          if (!attachmentPath)
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Invalid attachment id '${attachment.id}'.`,
            });
          const name = attachment.name.replace(/[[\]()]/g, "");
          const pathUrl = attachmentPath.replace(/\\/g, "/");
          refs.push(`![${name}](${pathUrl})`);
        }
        return refs;
      });

    const emit = (context: AntigravityContext, draft: ProviderRuntimeEventDraft) => {
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

    const addItem = (context: AntigravityContext, turnId: TurnId, item: unknown) => {
      context.turns.find((turn) => turn.id === turnId)?.items.push(item);
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
      const model = input.modelSelection?.model ?? DEFAULT_ANTIGRAVITY_MODEL;
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
        conversation: [],
        pendingFollowUps: [],
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
      userPrompt: string,
      args: ReadonlyArray<string>,
    ): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const environment = options.environment;
        const spawnCommand = yield* resolveSpawnCommand(
          binaryPath,
          args,
          environment ? { env: environment } : {},
        );
        const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: context.providerSession.cwd ?? process.cwd(),
          shell: spawnCommand.shell,
          ...(environment ? { env: environment, extendEnv: false } : {}),
        });
        const handle = yield* spawner.spawn(command);
        context.activeHandle = handle;
        // An interrupt can land between `sendTurn` forking this fiber and the
        // spawn resolving. Without this the turn reports itself interrupted
        // while the CLI keeps running unsupervised.
        if (context.interrupted) {
          yield* Effect.orElseSucceed(handle.kill(), () => undefined);
        }
        let assistantItemId: RuntimeItemId | undefined;
        let assistantText = "";
        const outputSanitizer = new AntigravityOutputSanitizer();
        const emitDelta = (delta: string) => {
          if (context.interrupted || !delta) return;
          if (assistantItemId === undefined) {
            assistantItemId = RuntimeItemId.make(NodeCrypto.randomUUID());
            emit(context, {
              type: "item.started",
              turnId,
              itemId: assistantItemId,
              payload: {
                itemType: "assistant_message",
                status: "inProgress",
                title: "Assistant",
              },
            });
          }
          assistantText += delta;
          emit(context, {
            type: "content.delta",
            turnId,
            itemId: assistantItemId,
            payload: { streamKind: "assistant_text", delta },
          });
        };
        const [, stderrText, exitCode] = yield* Effect.all(
          [
            Effect.gen(function* () {
              yield* Stream.decodeText(handle.stdout).pipe(
                Stream.runForEach((chunk) =>
                  Effect.sync(() => emitDelta(outputSanitizer.push(chunk))),
                ),
              );
              emitDelta(outputSanitizer.finish());
            }),
            Stream.decodeText(handle.stderr).pipe(Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        const interrupted = context.interrupted;
        const failed = !interrupted && exitCode !== 0;
        const content = assistantText.trim();
        const stderr = sanitizeCliOutput(stderrText).trim();
        // stderr is the CLI's error channel, but it stays empty on some exit
        // paths — fall back to whatever it printed on stdout before giving up
        // and reporting the bare exit code.
        const errorMessage =
          stderr || content || `Antigravity CLI exited with code ${exitCode.toString()}.`;

        if (assistantItemId !== undefined) {
          const status = failed ? "failed" : "completed";
          emit(context, {
            type: "item.completed",
            turnId,
            itemId: assistantItemId,
            payload: { itemType: "assistant_message", status, title: "Assistant" },
          });
          addItem(context, turnId, {
            itemId: assistantItemId,
            itemType: "assistant_message",
            status,
            text: content,
          });
        }
        if (!failed && !interrupted && content) {
          context.conversation.push({ turnId, user: userPrompt, assistant: content });
        }
        if (failed) {
          emit(context, {
            type: "runtime.error",
            turnId,
            payload: { message: errorMessage, class: "provider_error" },
          });
        } else if (!interrupted) {
          if (stderr) {
            emit(context, { type: "runtime.warning", turnId, payload: { message: stderr } });
          }
          if (!content) {
            emit(context, {
              type: "runtime.warning",
              turnId,
              payload: { message: "Antigravity CLI produced no output for this turn." },
            });
          }
        }

        context.activeHandle = undefined;
        context.activeTurnId = undefined;
        context.providerSession = {
          ...context.providerSession,
          status: failed ? "error" : "ready",
          activeTurnId: undefined,
          updatedAt: now(),
          ...(failed ? { lastError: errorMessage } : {}),
        };
        emit(context, {
          type: "turn.completed",
          turnId,
          payload: interrupted
            ? { state: "interrupted" }
            : failed
              ? { state: "failed", errorMessage }
              : { state: "completed" },
        });
        yield* startNextQueuedTurn(context).pipe(Effect.orElseSucceed(() => undefined));
      }).pipe(
        Effect.scoped,
        Effect.catch((cause: unknown) =>
          Effect.gen(function* () {
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
            yield* startNextQueuedTurn(context).pipe(Effect.orElseSucceed(() => undefined));
          }),
        ),
      );

    const startNextQueuedTurn = (context: AntigravityContext): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        if (
          context.stopped ||
          context.activeTurnId !== undefined ||
          context.pendingFollowUps.length === 0
        )
          return;
        const item = context.pendingFollowUps.shift();
        if (item === undefined) return;
        const cliPrompt = buildAntigravityPrompt(context.conversation, item.prompt);
        const args = buildAntigravityArgs({
          runtimeMode: context.providerSession.runtimeMode,
          model: item.model,
          prompt: cliPrompt,
        });
        if (!isAntigravityCommandWithinBudget(binaryPath, args)) {
          const errorMessage =
            "The Antigravity command exceeds the safe Windows command-line budget.";
          emit(context, {
            type: "runtime.error",
            turnId: item.turnId,
            payload: { message: errorMessage, class: "provider_error" },
          });
          emit(context, {
            type: "turn.completed",
            turnId: item.turnId,
            payload: { state: "failed", errorMessage },
          });
          return;
        }
        context.activeTurnId = item.turnId;
        context.interrupted = false;
        context.turns.push({ id: item.turnId, items: [] });
        context.providerSession = {
          ...context.providerSession,
          status: "running",
          model: item.model,
          activeTurnId: item.turnId,
          updatedAt: now(),
        };
        emit(context, {
          type: "turn.started",
          turnId: item.turnId,
          payload: { model: item.model },
        });
        yield* Effect.forkDetach(runTurn(context, item.turnId, item.prompt, args));
      });

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
      const imageRefs = input.attachments?.length ? yield* buildImageRefs(input) : [];
      const prompt = [input.input?.trim(), ...imageRefs].filter(Boolean).join("\n\n");
      if (!prompt)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "A prompt is required.",
        });
      if (prompt.length > ANTIGRAVITY_MAX_PROMPT_CHARS)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Antigravity CLI prompts are limited to ${ANTIGRAVITY_MAX_PROMPT_CHARS.toString()} characters.`,
        });
      const model =
        input.modelSelection?.model ?? context.providerSession.model ?? DEFAULT_ANTIGRAVITY_MODEL;
      if (context.activeTurnId !== undefined) {
        // The CLI is one-shot print mode and cannot steer into a live process,
        // so a follow-up is queued and run as a new turn once the active turn
        // completes, mirroring the Codex adapter's queued follow-up.
        const queuedTurnId = TurnId.make(NodeCrypto.randomUUID());
        context.pendingFollowUps.push({ turnId: queuedTurnId, prompt, model });
        return { threadId: input.threadId, turnId: queuedTurnId };
      }
      const cliPrompt = buildAntigravityPrompt(context.conversation, prompt);
      if (cliPrompt.length > ANTIGRAVITY_MAX_PROMPT_CHARS)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Antigravity CLI prompts are limited to ${ANTIGRAVITY_MAX_PROMPT_CHARS.toString()} characters.`,
        });
      const args = buildAntigravityArgs({
        runtimeMode: context.providerSession.runtimeMode,
        model,
        prompt: cliPrompt,
      });
      if (!isAntigravityCommandWithinBudget(binaryPath, args))
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "The Antigravity command exceeds the safe Windows command-line budget.",
        });
      const turnId = TurnId.make(NodeCrypto.randomUUID());
      context.activeTurnId = turnId;
      context.interrupted = false;
      context.turns.push({ id: turnId, items: [] });
      context.providerSession = {
        ...context.providerSession,
        status: "running",
        model,
        activeTurnId: turnId,
        updatedAt: now(),
      };
      emit(context, { type: "turn.started", turnId, payload: { model } });
      yield* Effect.forkDetach(runTurn(context, turnId, prompt, args));
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
      // Every turn is a fresh process, so the model can change per turn for free.
      capabilities: { sessionModelSwitch: "in-session" },
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
          Effect.flatMap((context) => {
            if (rollbackTurns(context.turns, numTurns) === undefined)
              return Effect.fail(
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "rollbackThread",
                  issue: "Invalid turn count.",
                }),
              );
            const retainedTurnIds = new Set(context.turns.map((turn) => turn.id));
            context.conversation = context.conversation.filter((entry) =>
              retainedTurnIds.has(entry.turnId),
            );
            return Effect.succeed({ threadId, turns: context.turns });
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
