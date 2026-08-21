import { vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";
import { rollbackTurns } from "./PiAdapter.ts";

type FakeListener = (event: unknown) => void;

interface FakeSession {
  readonly model: { readonly provider: string; readonly id: string } | undefined;
  readonly sessionFile: string;
  readonly calls: Array<{ text: string | undefined; options?: unknown }>;
  readonly prompts: Array<Promise<void>>;
  subscribe: (listener: FakeListener) => () => void;
  prompt: (text: string, options?: unknown) => Promise<void>;
  steer: () => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
  getSessionStats: () => { tokens: Record<string, never>; cost: number };
  emit: (event: unknown) => void;
}

const piSdkState = vi.hoisted(() => ({ sessions: [] as FakeSession[] }));

const makeSession = (): FakeSession => {
  const listeners = new Set<FakeListener>();
  const calls: Array<{ text: string | undefined; options?: unknown }> = [];
  const prompts: Array<Promise<void>> = [];
  const session: FakeSession = {
    model: { provider: "fake", id: "model-1" },
    sessionFile: "/fake/session.json",
    calls,
    prompts,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: async (text, options) => {
      // The real SDK calls `text.startsWith("/")` before anything else, so a
      // non-string prompt is a TypeError there, not a silently accepted call.
      if (typeof text !== "string") {
        throw new TypeError("Cannot read properties of undefined (reading 'startsWith')");
      }
      calls.push({ text, options });
      prompts.push(Promise.resolve());
    },
    steer: async () => undefined,
    abort: async () => undefined,
    dispose: () => undefined,
    getSessionStats: () => ({ tokens: {}, cost: 0 }),
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
  return session;
};

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: {
    create: async () => ({
      getModel: () => undefined,
      getModels: () => [],
    }),
  },
  SessionManager: {
    create: async () => ({ sessionFile: "/fake/session.json" }),
    open: async () => ({ sessionFile: "/fake/session.json" }),
  },
  createAgentSession: async () => {
    const session = makeSession();
    piSdkState.sessions.push(session);
    return { session };
  },
}));

const THREAD_ID = ThreadId.make("thread-pi-images");
const INSTANCE_ID = ProviderInstanceId.make("instance-pi-images");

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-pi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const drainTurn = <A extends { type: string }, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(
    Stream.takeUntil((event: { type: string }) => event.type === "turn.completed"),
    Stream.runCollect,
    Effect.timeout(5_000),
    Effect.map((events) => Array.from(events)),
  );

const drainUntil = <A extends { type: string }, E, R>(
  stream: Stream.Stream<A, E, R>,
  predicate: (event: A) => boolean,
) =>
  stream.pipe(
    Stream.takeUntil(predicate),
    Stream.runCollect,
    Effect.timeout(5_000),
    Effect.map((events) => Array.from(events)),
  );

const makeTestFixture = () =>
  Effect.gen(function* () {
    piSdkState.sessions.length = 0;
    const adapter = yield* makePiAdapter(
      { enabled: true, agentDir: "", customModels: [] },
      { instanceId: INSTANCE_ID },
    );
    yield* adapter.startSession({ threadId: THREAD_ID, cwd: "/workspace" });
    return adapter;
  }).pipe(Effect.provide(serverConfigLayer));

const lastSession = () => piSdkState.sessions.at(-1);

const waitForPromptCalls = (session: FakeSession | undefined, count: number) =>
  Effect.gen(function* () {
    let attempts = 0;
    while ((session?.calls.length ?? 0) < count) {
      attempts += 1;
      if (attempts > 10_000)
        return yield* Effect.fail(new Error(`prompt call ${count} never landed`));
      yield* Effect.yieldNow;
    }
  });

describe("PiAdapter thread snapshots", () => {
  it("keeps the remaining turns when rolling back", () => {
    const turns = [
      { id: "one", items: ["assistant"] },
      { id: "two", items: ["tool"] },
      { id: "three", items: ["assistant"] },
    ];
    expect(rollbackTurns(turns, 2)).toEqual([{ id: "one", items: ["assistant"] }]);
    expect(turns).toHaveLength(1);
  });

  it("rejects invalid rollback counts", () => {
    const turns = [{ id: "one", items: [] }];
    expect(rollbackTurns(turns, 0)).toBeUndefined();
    expect(rollbackTurns(turns, 1.5)).toBeUndefined();
    expect(turns).toHaveLength(1);
  });
});

describe("PiAdapter turns", () => {
  it.effect("sends prompts and closes the turn on agent_settled", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestFixture();
      const result = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });
      const session = lastSession();
      yield* waitForPromptCalls(session, 1);
      expect(session?.calls).toHaveLength(1);
      expect(session?.calls[0]?.text).toBe("hello");
      expect(session?.calls[0]?.options).toEqual({});
      yield* Effect.sync(() => session!.emit({ type: "agent_settled" }));
      const events = yield* drainTurn(adapter.streamEvents);
      expect(events.some((event) => event.type === "turn.started")).toBe(true);
      expect(events.some((event) => event.type === "turn.completed")).toBe(true);
      expect(result.turnId).toBeDefined();
    }).pipe(Effect.provide(serverConfigLayer)),
  );

  it.effect("renders a completed Pi assistant message when no text delta was emitted", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestFixture();
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });
      const session = lastSession();
      yield* waitForPromptCalls(session, 1);
      yield* Effect.sync(() =>
        session!.emit({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Hello from Pi." }] },
        }),
      );
      yield* Effect.sync(() => session!.emit({ type: "agent_settled" }));

      const events = yield* drainTurn(adapter.streamEvents);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: "Hello from Pi." },
        }),
      );
    }).pipe(Effect.provide(serverConfigLayer)),
  );

  it.effect("surfaces a failed Pi run instead of settling it as an empty completed turn", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestFixture();
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "testing the pi agent" });
      const session = lastSession();
      yield* waitForPromptCalls(session, 1);
      // Pi's agent loop swallows a run failure and reports it as an assistant
      // message with an empty body — `prompt()` itself resolves cleanly.
      yield* Effect.sync(() =>
        session!.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "OAuth auth derivation failed for openai-codex",
          },
        }),
      );
      yield* Effect.sync(() => session!.emit({ type: "agent_settled" }));

      const events = yield* drainTurn(adapter.streamEvents);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "runtime.error",
          payload: {
            message: "OAuth auth derivation failed for openai-codex",
            class: "provider_error",
          },
        }),
      );
      const completed = events.find((event) => event.type === "turn.completed");
      expect(completed?.payload).toMatchObject({
        state: "failed",
        errorMessage: "OAuth auth derivation failed for openai-codex",
      });
    }).pipe(Effect.provide(serverConfigLayer)),
  );

  it.effect("reports an aborted Pi run as a cancelled turn", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestFixture();
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });
      const session = lastSession();
      yield* waitForPromptCalls(session, 1);
      yield* Effect.sync(() =>
        session!.emit({
          type: "message_end",
          message: { role: "assistant", content: [], stopReason: "aborted" },
        }),
      );
      yield* Effect.sync(() => session!.emit({ type: "agent_settled" }));

      const events = yield* drainTurn(adapter.streamEvents);
      expect(events.some((event) => event.type === "runtime.error")).toBe(false);
      expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
        state: "cancelled",
      });
    }).pipe(Effect.provide(serverConfigLayer)),
  );

  it.effect("projects Pi subagents into the shared running and completed task lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestFixture();
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "delegate this" });
      const session = lastSession();
      yield* waitForPromptCalls(session, 1);
      yield* Effect.sync(() =>
        session!.emit({
          type: "tool_execution_start",
          toolCallId: "spawn-1",
          toolName: "subagent_spawn",
          args: { name: "Inspect runtime", harness: "pi" },
        }),
      );
      yield* Effect.sync(() =>
        session!.emit({
          type: "tool_execution_end",
          toolCallId: "spawn-1",
          toolName: "subagent_spawn",
          isError: false,
          result: {
            details: {
              id: "sa-pi-1",
              title: "Inspect runtime",
              harness: "pi",
              model: "anthropic/claude-sonnet",
            },
          },
        }),
      );
      yield* Effect.sync(() =>
        session!.emit({
          type: "message_end",
          message: {
            role: "custom",
            customType: "subagent-result",
            content: "Runtime inspection finished.",
            display: true,
            details: {
              id: "sa-pi-1",
              title: "Inspect runtime",
              status: "done",
              activeFiles: ["src/stale.ts"],
              changedFiles: ["src/runtime.ts"],
            },
            timestamp: Date.now(),
          },
        }),
      );
      yield* Effect.sync(() => session!.emit({ type: "agent_settled" }));

      const events = yield* drainTurn(adapter.streamEvents);
      const started = events.find((event) => event.type === "task.started");
      const running = events.find(
        (event) => event.type === "task.progress" && event.payload.taskId === "sa-pi-1",
      );
      const completed = events.find((event) => event.type === "task.completed");

      expect(started).toMatchObject({
        payload: {
          taskId: "sa-pi-1",
          taskType: "subagent",
          title: "Inspect runtime",
          role: "pi subagent",
          model: "anthropic/claude-sonnet",
        },
      });
      expect(running).toMatchObject({
        payload: { status: "running", summary: "Running in background" },
      });
      expect(completed).toMatchObject({
        payload: {
          taskId: "sa-pi-1",
          status: "completed",
          summary: "Runtime inspection finished.",
          activeFiles: [],
          changedFiles: ["src/runtime.ts"],
        },
      });
    }).pipe(Effect.provide(serverConfigLayer)),
  );

  it.effect("continues after one background Pi subagent settles while siblings run", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestFixture();
      const initialTurn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "delegate" });
      const session = lastSession();
      yield* waitForPromptCalls(session, 1);

      for (const details of [
        { id: "sa-pi-done", title: "Review", harness: "pi" },
        { id: "sa-pi-running", title: "Search", harness: "pi" },
      ]) {
        yield* Effect.sync(() =>
          session!.emit({
            type: "tool_execution_end",
            toolCallId: `spawn-${details.id}`,
            toolName: "subagent_spawn",
            isError: false,
            result: { details },
          }),
        );
      }
      // The foreground turn settles while the extension-owned children stay
      // alive; its completion message restarts the parent agent.
      yield* Effect.sync(() => session!.emit({ type: "agent_settled" }));
      yield* Effect.sync(() => session!.emit({ type: "agent_start" }));
      yield* Effect.sync(() =>
        session!.emit({
          type: "message_end",
          message: {
            role: "custom",
            customType: "subagent-result",
            content: "Review found no issues.",
            display: true,
            details: { id: "sa-pi-done", title: "Review", status: "done" },
            timestamp: 0,
          },
        }),
      );
      yield* Effect.sync(() =>
        session!.emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Continuing with search." },
        }),
      );
      yield* Effect.sync(() => session!.emit({ type: "agent_settled" }));

      const events = yield* drainUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.completed" && event.turnId !== initialTurn.turnId,
      );
      const resumedTurn = events.find(
        (event) => event.type === "turn.started" && event.turnId !== initialTurn.turnId,
      )?.turnId;

      expect(resumedTurn).toBeDefined();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "task.completed",
          turnId: resumedTurn,
          payload: expect.objectContaining({
            taskId: "sa-pi-done",
            status: "completed",
            summary: "Review found no issues.",
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "task.progress",
          payload: expect.objectContaining({ taskId: "sa-pi-running", status: "running" }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "content.delta",
          turnId: resumedTurn,
          payload: { streamKind: "assistant_text", delta: "Continuing with search." },
        }),
      );
    }).pipe(Effect.provide(serverConfigLayer)),
  );

  it.effect("reconciles Pi subagent list snapshots into running and completed tasks", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestFixture();
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "check agents" });
      const session = lastSession();
      yield* waitForPromptCalls(session, 1);
      yield* Effect.sync(() =>
        session!.emit({
          type: "tool_execution_end",
          toolCallId: "list-1",
          toolName: "subagent_list",
          isError: false,
          result: {
            details: {
              subagents: [
                { id: "sa-pi-running", title: "Search", harness: "pi", status: "running" },
                { id: "sa-pi-done", title: "Review", harness: "pi", status: "done" },
              ],
            },
          },
        }),
      );
      yield* Effect.sync(() => session!.emit({ type: "agent_settled" }));

      const events = yield* drainTurn(adapter.streamEvents);
      expect(events.filter((event) => event.type === "task.started")).toHaveLength(2);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "task.progress",
          payload: expect.objectContaining({ taskId: "sa-pi-running", status: "running" }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "task.completed",
          payload: expect.objectContaining({ taskId: "sa-pi-done", status: "completed" }),
        }),
      );
    }).pipe(Effect.provide(serverConfigLayer)),
  );

  it.effect("queues a follow-up message into the live turn instead of failing", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestFixture();
      const first = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "first" });
      const session = lastSession();
      yield* waitForPromptCalls(session, 1);
      const followUp = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "second" });
      yield* waitForPromptCalls(session, 2);
      expect(followUp.turnId).toBe(first.turnId);
      expect(session?.calls.map((call) => call.text)).toEqual(["first", "second"]);
      expect(session?.calls[1]?.options).toMatchObject({ streamingBehavior: "followUp" });
      yield* Effect.sync(() => session!.emit({ type: "agent_settled" }));
      const events = yield* drainTurn(adapter.streamEvents);
      expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    }).pipe(Effect.provide(serverConfigLayer)),
  );

  it.effect("delivers image attachments to the prompt call", () =>
    Effect.gen(function* () {
      const { attachmentsDir } = yield* ServerConfig;
      const attachmentId = "screenshot-12345678-1234-1234-1234-123456789abc";
      const attachmentPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      yield* Effect.tryPromise(() =>
        NodeFSP.mkdir(NodePath.dirname(attachmentPath), { recursive: true }),
      );
      yield* Effect.tryPromise(() => NodeFSP.writeFile(attachmentPath, Uint8Array.from([1, 2, 3])));
      const adapter = yield* makeTestFixture();
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "What is this?",
        attachments: [
          {
            id: attachmentId,
            name: "screenshot.png",
            mimeType: "image/png",
            type: "image",
            sizeBytes: 3,
          },
        ],
      });
      const session = lastSession();
      yield* waitForPromptCalls(session, 1);
      expect(session?.calls).toHaveLength(1);
      expect(session?.calls[0]?.options).toMatchObject({
        images: [
          {
            type: "image",
            data: Buffer.from([1, 2, 3]).toString("base64"),
            mimeType: "image/png",
          },
        ],
      });
    }).pipe(Effect.provide(serverConfigLayer)),
  );

  it.effect("sends an attachment-only turn without a text prompt", () =>
    Effect.gen(function* () {
      const { attachmentsDir } = yield* ServerConfig;
      const attachmentId = "pasted-22345678-1234-1234-1234-123456789abc";
      const attachmentPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      yield* Effect.tryPromise(() =>
        NodeFSP.mkdir(NodePath.dirname(attachmentPath), { recursive: true }),
      );
      yield* Effect.tryPromise(() => NodeFSP.writeFile(attachmentPath, Uint8Array.from([9, 8, 7])));
      const adapter = yield* makeTestFixture();
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        attachments: [
          {
            id: attachmentId,
            name: "pasted.png",
            mimeType: "image/png",
            type: "image",
            sizeBytes: 3,
          },
        ],
      });
      const session = lastSession();
      // The SDK rejects a non-string prompt, so the fake never records the
      // call and this wait is what fails if the adapter regresses.
      yield* waitForPromptCalls(session, 1);
      expect(typeof session?.calls[0]?.text).toBe("string");
      expect(session?.calls[0]?.options).toMatchObject({
        images: [
          {
            type: "image",
            data: Buffer.from([9, 8, 7]).toString("base64"),
            mimeType: "image/png",
          },
        ],
      });
    }).pipe(Effect.provide(serverConfigLayer)),
  );

  it.effect("fails a turn for an invalid attachment id", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestFixture();
      const error = yield* adapter
        .sendTurn({
          threadId: THREAD_ID,
          input: "What is this?",
          attachments: [
            { id: "../evil", name: "x.png", mimeType: "image/png", type: "image", sizeBytes: 3 },
          ],
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterValidationError");
      expect(lastSession()?.calls).toHaveLength(0);
    }).pipe(Effect.provide(serverConfigLayer)),
  );
});
