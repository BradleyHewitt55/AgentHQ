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

const drainTurn = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(
    Stream.takeUntil((event: { type: string }) => event.type === "turn.completed"),
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
      expect(session?.calls[1]?.options).toMatchObject({ streamingBehavior: "steer" });
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
          { id: attachmentId, name: "screenshot.png", mimeType: "image/png", type: "image" },
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

  it.effect("fails a turn for an invalid attachment id", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestFixture();
      const error = yield* adapter
        .sendTurn({
          threadId: THREAD_ID,
          input: "What is this?",
          attachments: [{ id: "../evil", name: "x.png", mimeType: "image/png", type: "image" }],
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterValidationError");
      expect(lastSession()?.calls).toHaveLength(0);
    }).pipe(Effect.provide(serverConfigLayer)),
  );
});
