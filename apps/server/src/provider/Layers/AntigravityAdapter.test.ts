// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ProviderInstanceId,
  ThreadId,
  type AntigravitySettings,
  type ProviderRuntimeEvent,
  type RuntimeMode,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ServerConfig } from "../../config.ts";
import { makeAntigravityAdapter } from "./AntigravityAdapter.ts";

const SETTINGS = {
  enabled: true,
  binaryPath: "agy",
  customModels: [],
} as unknown as AntigravitySettings;

const THREAD_ID = ThreadId.make("thread-antigravity");
const INSTANCE_ID = ProviderInstanceId.make("instance-antigravity");

interface FakeProcess {
  readonly stdout?: string | ReadonlyArray<string>;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly gate?: Deferred.Deferred<void>;
}

interface SpawnRecord {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean | string | undefined;
}

const makeRecordingSpawner = (process: FakeProcess) => {
  const commands: SpawnRecord[] = [];
  const state = { killed: 0 };
  const spawner = ChildProcessSpawner.make((command) => {
    if ("args" in command)
      commands.push({
        command: command.command,
        args: command.args,
        shell: command.options.shell,
      });
    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(process.exitCode ?? 0)),
      isRunning: Effect.succeed(false),
      kill: () =>
        Effect.sync(() => {
          state.killed += 1;
        }),
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.encodeText(
        Array.isArray(process.stdout)
          ? Stream.fromIterable(process.stdout)
          : Stream.make(process.stdout ?? ""),
      ),
      stderr: Stream.encodeText(Stream.make(process.stderr ?? "")),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
    return process.gate
      ? Deferred.await(process.gate).pipe(Effect.as(handle))
      : Effect.succeed(handle);
  });
  return { commands, state, spawner };
};

const drainTurn = <A, E, R>(stream: Stream.Stream<ProviderRuntimeEvent, E, R>) =>
  stream.pipe(
    Stream.takeUntil((event) => event.type === "turn.completed"),
    Stream.runCollect,
    Effect.timeout(5_000),
    Effect.map((events) => Array.from(events)),
  );

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-antigravity-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const runTurnScenario = (input: {
  readonly process: FakeProcess;
  readonly runtimeMode?: RuntimeMode;
  readonly interruptBeforeSpawn?: boolean;
}) =>
  Effect.gen(function* () {
    const recorder = makeRecordingSpawner(input.process);
    const adapter = yield* makeAntigravityAdapter(SETTINGS, { instanceId: INSTANCE_ID }).pipe(
      Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, recorder.spawner)),
    );
    yield* adapter.startSession({
      threadId: THREAD_ID,
      runtimeMode: input.runtimeMode ?? "full-access",
      cwd: "/workspace",
    });
    yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });
    if (input.interruptBeforeSpawn) yield* adapter.interruptTurn(THREAD_ID);
    if (input.process.gate) yield* Deferred.succeed(input.process.gate, undefined);
    const events = yield* drainTurn(adapter.streamEvents);
    return { adapter, recorder, events };
  }).pipe(Effect.provideService(HostProcessPlatform, "linux"), Effect.provide(serverConfigLayer));

const turnCompleted = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.find((event) => event.type === "turn.completed");

describe("AntigravityAdapter argv", () => {
  it.effect("never bypasses permissions outside full access", () =>
    Effect.gen(function* () {
      const { recorder } = yield* runTurnScenario({
        process: { stdout: "ok" },
        runtimeMode: "approval-required",
      });
      const args = recorder.commands[0]?.args ?? [];
      expect(args).not.toContain("--dangerously-skip-permissions");
      expect(args).toContain("--mode");
      expect(args).toContain("plan");
      expect(args.some((arg) => arg.startsWith("--print="))).toBe(true);
    }),
  );

  it.effect("replays the conversation in an isolated project on the second turn", () =>
    Effect.gen(function* () {
      const { adapter, recorder } = yield* runTurnScenario({ process: { stdout: "one" } });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "again" });
      yield* drainTurn(adapter.streamEvents);
      expect(recorder.commands[0]?.args[0]).toBe("--new-project");
      expect(recorder.commands[1]?.args[0]).toBe("--new-project");
      expect(recorder.commands[1]?.args.find((arg) => arg.startsWith("--print="))).toContain(
        "User:\nhello\n\nAssistant:\none\n\nCurrent user message:\nagain",
      );
    }),
  );

  it.effect("escapes adversarial prompts when Windows resolves a cmd shim", () =>
    Effect.gen(function* () {
      const recorder = makeRecordingSpawner({ stdout: "ok" });
      const adapter = yield* makeAntigravityAdapter(SETTINGS, { instanceId: INSTANCE_ID }).pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, recorder.spawner)),
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        runtimeMode: "approval-required",
        cwd: "C:\\workspace",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "& whoami" });
      yield* drainTurn(adapter.streamEvents);
      const call = recorder.commands[0];
      expect(call?.command).toContain("agy.cmd");
      expect(call?.shell).toBe(true);
      expect(call?.args.find((arg) => arg.includes("whoami"))).not.toBe("--print=& whoami");
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(HostProcessEnvironment, {
        PATH: "C:\\fake",
        PATHEXT: ".EXE;.CMD",
      }),
      Effect.provideService(SpawnExecutableResolution, () => "C:\\fake\\agy.cmd"),
      Effect.provide(serverConfigLayer),
    ),
  );

  it.effect("queues a follow-up turn while one is running and runs it after", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const recorder = makeRecordingSpawner({ stdout: "one", gate });
      const adapter = yield* makeAntigravityAdapter(SETTINGS, { instanceId: INSTANCE_ID }).pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, recorder.spawner)),
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        runtimeMode: "full-access",
        cwd: "/workspace",
      });
      const first = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "first" });
      const second = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "second" });
      expect(second.turnId).not.toBe(first.turnId);
      yield* Deferred.succeed(gate, undefined);
      let completedTurns = 0;
      const events = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => {
          if (event.type === "turn.completed") completedTurns += 1;
          return completedTurns >= 2;
        }),
        Stream.runCollect,
        Effect.timeout(5_000),
        Effect.map((collected) => Array.from(collected)),
      );
      const started = events.filter((event) => event.type === "turn.started");
      const completed = events.filter((event) => event.type === "turn.completed");
      expect(started).toHaveLength(2);
      expect(completed).toHaveLength(2);
      expect(new Set(started.map((event) => event.turnId)).size).toBe(2);
      expect(new Set(completed.map((event) => event.turnId)).size).toBe(2);
      const firstCompletedIndex = events.findIndex(
        (event) => event.type === "turn.completed" && event.turnId === first.turnId,
      );
      const secondStartedIndex = events.findIndex(
        (event) => event.type === "turn.started" && event.turnId === second.turnId,
      );
      expect(firstCompletedIndex).toBeGreaterThan(-1);
      expect(secondStartedIndex).toBeGreaterThan(-1);
      expect(firstCompletedIndex).toBeLessThan(secondStartedIndex);
      expect(recorder.commands).toHaveLength(2);
      const secondPrintArg = recorder.commands[1]?.args.find((arg) => arg.startsWith("--print="));
      expect(secondPrintArg).toContain("second");
    }).pipe(Effect.provideService(HostProcessPlatform, "linux"), Effect.provide(serverConfigLayer)),
  );

  it.effect("delivers image attachments as markdown references in the print prompt", () =>
    Effect.gen(function* () {
      const { attachmentsDir } = yield* ServerConfig;
      const attachmentId = "screenshot-12345678-1234-1234-1234-123456789abc";
      const attachmentPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      yield* Effect.tryPromise(() =>
        NodeFSP.mkdir(NodePath.dirname(attachmentPath), { recursive: true }),
      );
      yield* Effect.tryPromise(() => NodeFSP.writeFile(attachmentPath, Uint8Array.from([1, 2, 3])));
      const recorder = makeRecordingSpawner({ stdout: "ok" });
      const adapter = yield* makeAntigravityAdapter(SETTINGS, { instanceId: INSTANCE_ID }).pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, recorder.spawner)),
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        runtimeMode: "full-access",
        cwd: "/workspace",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "What color?",
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
      yield* drainTurn(adapter.streamEvents);
      const printArg = recorder.commands[0]?.args.find((arg) => arg.startsWith("--print="));
      expect(printArg).toContain("What color?");
      expect(printArg).toContain(
        `![screenshot.png](${NodePath.resolve(attachmentPath).replace(/\\/g, "/")})`,
      );
    }).pipe(Effect.provideService(HostProcessPlatform, "linux"), Effect.provide(serverConfigLayer)),
  );

  it.effect("rejects an invalid image attachment id", () =>
    Effect.gen(function* () {
      const recorder = makeRecordingSpawner({ stdout: "ok" });
      const adapter = yield* makeAntigravityAdapter(SETTINGS, { instanceId: INSTANCE_ID }).pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, recorder.spawner)),
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        runtimeMode: "full-access",
        cwd: "/workspace",
      });
      const error = yield* adapter
        .sendTurn({
          threadId: THREAD_ID,
          input: "What color?",
          attachments: [
            { id: "../evil", name: "x.png", mimeType: "image/png", type: "image", sizeBytes: 3 },
          ],
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterValidationError");
      expect(recorder.commands).toHaveLength(0);
    }).pipe(Effect.provideService(HostProcessPlatform, "linux"), Effect.provide(serverConfigLayer)),
  );
});

describe("AntigravityAdapter turn results", () => {
  it.effect("streams sanitized stdout and records the assistant item", () =>
    Effect.gen(function* () {
      const escape = String.fromCharCode(0x1b);
      const { adapter, events } = yield* runTurnScenario({
        process: { stdout: [`thinking\rdo${escape}[3`, "2mne\nnext"] },
      });
      const text = events
        .filter((event) => event.type === "content.delta")
        .map((event) => event.payload.delta)
        .join("");
      expect(text).toBe("done\nnext");
      expect(turnCompleted(events)?.payload).toMatchObject({ state: "completed" });
      const snapshot = yield* adapter.readThread(THREAD_ID);
      expect(snapshot.turns[0]?.items).toHaveLength(1);
    }),
  );

  it.effect("warns when a successful run produces no output", () =>
    Effect.gen(function* () {
      const { events } = yield* runTurnScenario({ process: { stdout: "" } });
      expect(events.some((event) => event.type === "runtime.warning")).toBe(true);
      expect(turnCompleted(events)?.payload).toMatchObject({ state: "completed" });
    }),
  );

  it.effect("surfaces stderr as a warning on a successful run", () =>
    Effect.gen(function* () {
      const { events } = yield* runTurnScenario({
        process: { stdout: "fine", stderr: "deprecated flag" },
      });
      const warning = events.find((event) => event.type === "runtime.warning");
      expect(warning?.payload).toMatchObject({ message: "deprecated flag" });
    }),
  );

  it.effect("falls back to stdout when a failing run writes no stderr", () =>
    Effect.gen(function* () {
      const { events } = yield* runTurnScenario({
        process: { stdout: "model not found", exitCode: 2 },
      });
      const error = events.find((event) => event.type === "runtime.error");
      expect(error?.payload).toMatchObject({ message: "model not found" });
      expect(turnCompleted(events)?.payload).toMatchObject({
        state: "failed",
        errorMessage: "model not found",
      });
    }),
  );

  it.effect("prefers stderr for the failure message", () =>
    Effect.gen(function* () {
      const { events } = yield* runTurnScenario({
        process: { stdout: "partial", stderr: "boom", exitCode: 1 },
      });
      expect(turnCompleted(events)?.payload).toMatchObject({
        state: "failed",
        errorMessage: "boom",
      });
    }),
  );
});

describe("AntigravityAdapter interrupts", () => {
  it.effect("kills a child that spawns after the interrupt", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const { recorder, events } = yield* runTurnScenario({
        process: { stdout: "late", gate },
        interruptBeforeSpawn: true,
      });
      expect(recorder.state.killed).toBeGreaterThan(0);
      expect(turnCompleted(events)?.payload).toMatchObject({ state: "interrupted" });
    }),
  );
});

describe("AntigravityAdapter thread rollback", () => {
  it.effect("rejects an invalid turn count instead of clamping it", () =>
    Effect.gen(function* () {
      const { adapter } = yield* runTurnScenario({ process: { stdout: "ok" } });
      const error = yield* adapter.rollbackThread(THREAD_ID, 0).pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterValidationError");
      const rolled = yield* adapter.rollbackThread(THREAD_ID, 1);
      expect(rolled.turns).toHaveLength(0);
    }),
  );
});
