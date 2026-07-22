// @effect-diagnostics globalDateInEffect:off
import {
  PiSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makePiAdapter } from "../Layers/PiAdapter.ts";
import { loadPiSdk } from "../Layers/piSdk.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { ProviderDriverError } from "../Errors.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");

// Shape of the entries `ModelRuntime.getAvailable()` returns that we consume.
// Declared structurally so the SDK's types stay off the module's import graph.
interface PiAvailableModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly reasoning?: boolean;
}
const decodeSettings = Schema.decodeSync(PiSettings);
const joinPath = (directory: string, filename: string) =>
  `${directory.replace(/[\\/]$/u, "")}/${filename}`;

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
        detail: "Pi is not configured for background text generation.",
      }),
    );
  return {
    generateCommitMessage: () => fail("generateCommitMessage"),
    generatePrContent: () => fail("generatePrContent"),
    generateBranchName: () => fail("generateBranchName"),
    generateThreadTitle: () => fail("generateThreadTitle"),
  };
};

export const PiDriver: ProviderDriver<PiSettings> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Pi", supportsMultipleInstances: true },
  configSchema: PiSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const adapter = yield* makePiAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
      });
      const agentDir = effectiveConfig.agentDir.trim() || undefined;
      const discoverModels = Effect.tryPromise({
        try: async () => {
          const { ModelRuntime } = await loadPiSdk();
          const modelRuntime = await ModelRuntime.create({
            ...(agentDir
              ? {
                  authPath: joinPath(agentDir, "auth.json"),
                  modelsPath: joinPath(agentDir, "models.json"),
                }
              : {}),
          });
          return (await modelRuntime.getAvailable()) as ReadonlyArray<PiAvailableModel>;
        },
        catch: (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to discover authenticated Pi models.",
            cause,
          }),
      });
      const modelsRef = yield* Ref.make<ReadonlyArray<PiAvailableModel>>([]);
      // Warm the catalog off the critical path: loading the Pi SDK is a
      // multi-second-to-minute cold start, and provider creation runs before
      // the server binds its port. Snapshots read whatever is cached so far.
      yield* discoverModels.pipe(
        Effect.flatMap((models) => Ref.set(modelsRef, models)),
        Effect.catch(() =>
          Effect.logWarning("Pi model discovery failed; models load when a session starts."),
        ),
        Effect.forkDetach,
      );
      const buildSnapshot = (
        available: ReadonlyArray<PiAvailableModel>,
        checkedAt: string,
      ): ServerProvider => ({
        instanceId,
        driver: DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: `pi:${agentDir ?? "default"}` },
        showInteractionModeToggle: false,
        enabled,
        installed: true,
        version: null,
        status: !enabled ? "disabled" : available.length > 0 ? "ready" : "warning",
        auth: { status: available.length > 0 ? "authenticated" : "unauthenticated" },
        checkedAt,
        ...(available.length === 0
          ? { message: "Authenticate Pi with `pi /login` or configure an API key." }
          : {}),
        models: available.map((model) => ({
          slug: `${model.provider}/${model.id}`,
          name: model.name,
          subProvider: model.provider,
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: model.reasoning
              ? [
                  {
                    id: "thinking",
                    label: "Thinking",
                    type: "select",
                    options: ["off", "minimal", "low", "medium", "high", "xhigh"].map((id) => ({
                      id,
                      label:
                        id === "xhigh" ? "Extra High" : id.charAt(0).toUpperCase() + id.slice(1),
                      ...(id === "medium" ? { isDefault: true as const } : {}),
                    })),
                    currentValue: "medium",
                  },
                ]
              : [],
          }),
        })),
        slashCommands: [
          { name: "reload", description: "Reload Pi extensions, skills, prompts, and settings." },
        ],
        skills: [],
      });
      const currentSnapshot = Effect.gen(function* () {
        const models = yield* Ref.get(modelsRef);
        return buildSnapshot(models, new globalThis.Date().toISOString());
      });
      const providerSnapshot = {
        maintenanceCapabilities: {
          provider: DRIVER_KIND,
          packageName: "@earendil-works/pi-coding-agent",
          update: null,
        },
        getSnapshot: currentSnapshot,
        // Runs after startup, so it can wait for the SDK rather than fall back.
        refresh: Effect.gen(function* () {
          const models = yield* discoverModels.pipe(Effect.catch(() => Ref.get(modelsRef)));
          yield* Ref.set(modelsRef, models);
          return buildSnapshot(models, new globalThis.Date().toISOString());
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
        textGeneration: unsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
