import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { AntigravityDriver } from "./AntigravityDriver.ts";

const noopSpawner = ChildProcessSpawner.make(() => Effect.die("spawn is not expected"));

const createInstance = (config: Parameters<typeof AntigravityDriver.create>[0]["config"]) =>
  AntigravityDriver.create({
    instanceId: ProviderInstanceId.make("instance-antigravity"),
    displayName: undefined,
    accentColor: undefined,
    environment: [],
    enabled: true,
    config,
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, noopSpawner),
        NodeServices.layer,
      ),
    ),
    Effect.scoped,
  );

describe("AntigravityDriver", () => {
  it("is registered as a built-in provider driver", () => {
    expect(AntigravityDriver.driverKind).toBe(ProviderDriverKind.make("antigravity"));
    expect(BUILT_IN_DRIVERS).toContain(AntigravityDriver);
  });

  it.effect("reports the provider as not installed when the binary is missing", () =>
    Effect.gen(function* () {
      const instance = yield* createInstance({
        ...AntigravityDriver.defaultConfig(),
        binaryPath: "definitely-not-a-real-antigravity-binary",
      });
      const snapshot = yield* instance.snapshot.getSnapshot;
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unknown");
    }),
  );

  it.effect("flags configured custom models as custom", () =>
    Effect.gen(function* () {
      const instance = yield* createInstance({
        ...AntigravityDriver.defaultConfig(),
        binaryPath: "definitely-not-a-real-antigravity-binary",
        customModels: ["My Fine Tune"],
      });
      const snapshot = yield* instance.snapshot.getSnapshot;
      const custom = snapshot.models.find((model) => model.slug === "My Fine Tune");
      expect(custom?.isCustom).toBe(true);
      expect(snapshot.models.every((model) => model.isCustom === (model.slug === "My Fine Tune")));
    }),
  );
});
