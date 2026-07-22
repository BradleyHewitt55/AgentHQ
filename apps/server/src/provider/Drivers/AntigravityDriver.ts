// @effect-diagnostics globalDate:off globalDateInEffect:off
import { AntigravitySettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeAntigravityAdapter } from "../Layers/AntigravityAdapter.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { TextGenerationError } from "@t3tools/contracts";

const DRIVER_KIND = ProviderDriverKind.make("antigravity");
const decodeSettings = Schema.decodeSync(AntigravitySettings);
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

const ANTIGRAVITY_MODELS = [
  "Gemini 3.6 Flash",
  "Gemini 3.5 Flash",
  "Gemini 3.1 Pro",
  "Claude Sonnet 4.6",
  "Claude Opus 4.6",
  "GPT-OSS 120B",
];

const unsupportedTextGeneration = (): TextGeneration.TextGeneration["Service"] => {
  const fail = (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle",
  ) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Antigravity is not configured for background text generation.",
      }),
    );
  return {
    generateCommitMessage: () => fail("generateCommitMessage"),
    generatePrContent: () => fail("generatePrContent"),
    generateBranchName: () => fail("generateBranchName"),
    generateThreadTitle: () => fail("generateThreadTitle"),
  };
};

export type AntigravityDriverEnv = ChildProcessSpawner.ChildProcessSpawner;

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
      const models = [...ANTIGRAVITY_MODELS, ...effectiveConfig.customModels];
      const buildSnapshot = (checkedAt: string): ServerProvider => ({
        instanceId,
        driver: DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: `antigravity:${instanceId}` },
        showInteractionModeToggle: false,
        enabled,
        installed: true,
        version: null,
        status: !enabled ? "disabled" : "ready",
        auth: { status: "authenticated" },
        checkedAt,
        models: models.map((model) => ({
          slug: model,
          name: model,
          isCustom: false,
          capabilities: createModelCapabilities({ optionDescriptors: [] }),
        })),
        slashCommands: [],
        skills: [],
      });
      const currentSnapshot = Effect.sync(() => buildSnapshot(new globalThis.Date().toISOString()));
      const providerSnapshot = {
        maintenanceCapabilities: MAINTENANCE_CAPABILITIES,
        getSnapshot: currentSnapshot,
        refresh: currentSnapshot,
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
        textGeneration: unsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
