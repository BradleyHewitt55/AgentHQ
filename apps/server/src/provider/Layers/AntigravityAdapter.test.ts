import { describe, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ThreadId,
  type AntigravitySettings,
  type ProviderRuntimeEvent,
  type RuntimeMode,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeAntigravityAdapter } from "./AntigravityAdapter.ts";

const SETTINGS = {
  enabled: true,
  binaryPath: "agy",
  customModels: [],
} as unknown as AntigravitySettings;

const THREAD_ID = ThreadId.make("thread-antigravity");
const INSTANCE_ID = ProviderInstanceId.make("instance-antigravity");

interface FakeProcess {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly gate?: Deferred.Deferred<void>;
}

interface SpawnRecord {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const makeRecordingSpawner = (process: FakeProcess) => {
  const commands: SpawnRecord[] = [];
  const state = { killed: 0 };
  const spawner = ChildProcessSpawner.make((command) => {
    if ("args" in command) commands.push({ command: command.command, args: command.args });
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
      stdout: Stream.encodeText(Stream.make(process.stdout ?? "")),
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
  }).pipe(Effect.provideService(HostProcessPlatform, "linux"));

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

  it.effect("resumes the conversation on the second turn", () =>
    Effect.gen(function* () {
      const { adapter, recorder } = yield* runTurnScenario({ process: { stdout: "one" } });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "again" });
      yield* drainTurn(adapter.streamEvents);
      expect(recorder.commands[0]?.args[0]).toBe("--new-project");
      expect(recorder.commands[1]?.args[0]).toBe("--continue");
    }),
  );
});

describe("AntigravityAdapter turn results", () => {
  it.effect("streams stdout and records the assistant item", () =>
    Effect.gen(function* () {
      const { adapter, events } = yield* runTurnScenario({ process: { stdout: "hello world" } });
      const delta = events.find((event) => event.type === "content.delta");
      expect(delta?.payload).toMatchObject({ delta: "hello world" });
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
