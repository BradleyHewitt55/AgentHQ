// @effect-diagnostics globalDateInEffect:off
import { AntigravitySettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeAntigravityAdapter } from "../Layers/AntigravityAdapter.ts";
import { ANTIGRAVITY_MODEL_NAMES } from "../Layers/antigravityLaunch.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { unsupportedTextGeneration } from "./unsupportedTextGeneration.ts";

const DRIVER_KIND = ProviderDriverKind.make("antigravity");
const decodeSettings = Schema.decodeSync(AntigravitySettings);
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type AntigravityDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path;

export const AntigravityDriver: ProviderDriver<AntigravitySettings, AntigravityDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  configSchema: AntigravitySettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const effectiveConfig = { ...config, enabled } satisfies AntigravitySettings;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const adapter = yield* makeAntigravityAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
      });
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binaryPath = effectiveConfig.binaryPath.trim() || "agy";
      // The CLI exposes no `--version` flag, so availability is a PATH/PATHEXT
      // lookup rather than a probe run. That is enough to stop the provider
      // reporting "ready" while every turn dies at spawn.
      const probeInstalled = isCommandAvailable(binaryPath, { env: processEnv }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const installedRef = yield* Ref.make(yield* probeInstalled);
      const models = [
        ...ANTIGRAVITY_MODEL_NAMES.map((model) => ({ slug: model, isCustom: false })),
        ...effectiveConfig.customModels.map((model) => ({ slug: model, isCustom: true })),
      ];
      const buildSnapshot = (installed: boolean, checkedAt: string): ServerProvider => ({
        instanceId,
        driver: DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: `antigravity:${instanceId}` },
        showInteractionModeToggle: false,
        enabled,
        installed,
        version: null,
        status: !enabled ? "disabled" : installed ? "ready" : "error",
        auth: { status: installed ? "authenticated" : "unknown" },
        checkedAt,
        ...(installed
          ? {}
          : { message: `Antigravity CLI (\`${binaryPath}\`) is not installed or not on PATH.` }),
        models: models.map((model) => ({
          slug: model.slug,
          name: model.slug,
          isCustom: model.isCustom,
          capabilities: createModelCapabilities({ optionDescriptors: [] }),
        })),
        slashCommands: [],
        skills: [],
      });
      const currentSnapshot = Effect.gen(function* () {
        const installed = yield* Ref.get(installedRef);
        return buildSnapshot(installed, new globalThis.Date().toISOString());
      });
      const providerSnapshot = {
        maintenanceCapabilities: MAINTENANCE_CAPABILITIES,
        getSnapshot: currentSnapshot,
        refresh: Effect.gen(function* () {
          const installed = yield* probeInstalled;
          yield* Ref.set(installedRef, installed);
          return buildSnapshot(installed, new globalThis.Date().toISOString());
        }),
        streamChanges: Stream.fromEffect(currentSnapshot),
      };
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: defaultProviderContinuationIdentity({
          driverKind: DRIVER_KIND,
          instanceId,
        }),
        displayName,
        accentColor,
        enabled,
        snapshot: providerSnapshot,
        adapter,
        textGeneration: unsupportedTextGeneration("Antigravity"),
      } satisfies ProviderInstance;
    }),
};
