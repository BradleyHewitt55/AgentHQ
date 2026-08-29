// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics runEffectInsideEffect:off
import type {
  ProviderRuntimeEvent,
  UsageLimitProviderId,
  UsageLimitsRefreshInput,
  UsageLimitsSnapshot,
} from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";

import type { UsageLimitProviderContext } from "./usageAdapters.ts";
import { UsageLimitCoordinator } from "./usageLimitCoordinator.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as grokAuth from "./grokAuth.ts";

/**
 * Managed usage-limit service.
 *
 * Owns one {@link UsageLimitCoordinator} per environment and adapts it to this
 * app's infrastructure:
 * - activity gating comes from `BackgroundPolicy` foreground leases (the
 *   equivalent of Orca's visible/focused/minimized main-window checks),
 * - focus/show/restore equivalents are `shouldRunOpportunisticWork`
 *   false→true edges in the policy's change stream,
 * - credential identities (Claude config dir, Codex home) are cached from
 *   server settings and re-resolved on every change; changing them invalidates
 *   in-flight results and forces a provider-specific refresh,
 * - live-session usage arrives through the provider runtime event bus
 *   (`account.rate-limits.updated`) instead of a separate statusline channel.
 */

export class UsageLimitsService extends Context.Service<
  UsageLimitsService,
  {
    readonly getState: Effect.Effect<UsageLimitsSnapshot>;
    readonly refresh: (input?: UsageLimitsRefreshInput) => Effect.Effect<UsageLimitsSnapshot>;
    readonly refreshIfStale: Effect.Effect<UsageLimitsSnapshot>;
    /**
     * Starts consuming the provider runtime event bus for live-session usage
     * (`account.rate-limits.updated`). Idempotent; the first call wins.
     */
    readonly attachEventStream: (
      events: Stream.Stream<ProviderRuntimeEvent>,
    ) => Effect.Effect<void>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: UsageLimitsSnapshot;
        readonly changes: Stream.Stream<UsageLimitsSnapshot>;
      },
      never,
      Scope.Scope
    >;
  }
>()("t3/rateLimits/UsageLimitsService") {}

class UsageLimitsRefreshError extends Data.TaggedError("UsageLimitsRefreshError")<{
  readonly cause: unknown;
}> {}

interface ProviderIdentities {
  claudeConfigDir: string | null;
  codexHomePath: string;
  codexBinaryPath: string;
  geminiCliOauthEnabled: boolean;
}

const INITIAL_IDENTITIES: ProviderIdentities = {
  claudeConfigDir: null,
  codexHomePath: "",
  codexBinaryPath: "",
  geminiCliOauthEnabled: false,
};

function provenanceFor(provider: string, identities: ProviderIdentities): string | null {
  switch (provider) {
    case "claude":
      // `host:<configDir>` distinguishes explicit homes from the default store.
      return identities.claudeConfigDir ? `host:${identities.claudeConfigDir}` : "host:system";
    case "codex":
      return identities.codexHomePath ? `host:${identities.codexHomePath}` : "host:system";
    case "grok":
      return "host:grok-auth-file";
    default:
      return null;
  }
}

function liveWindowsFromRateLimitsUpdate(payload: {
  fiveHour?: { usedPercent: number; resetsAt: string | null } | undefined;
  weekly?:
    | ReadonlyArray<{ usedPercent: number; resetsAt: string | null; label?: string | undefined }>
    | undefined;
}): {
  session: import("@t3tools/contracts").ProviderUsageLimits["session"];
  weekly: import("@t3tools/contracts").ProviderUsageLimits["weekly"];
} {
  const toMs = (iso: string | null): number | null => {
    if (!iso) return null;
    const parsed = Date.parse(iso);
    return Number.isNaN(parsed) ? null : parsed;
  };
  const session =
    payload.fiveHour && Number.isFinite(payload.fiveHour.usedPercent)
      ? {
          usedPercent: payload.fiveHour.usedPercent,
          windowMinutes: 300,
          resetsAt: toMs(payload.fiveHour.resetsAt),
          resetDescription: null,
        }
      : null;
  // Labeled windows are model-scoped extras; the account-wide one carries no label.
  const weeklyEntry = payload.weekly?.find((window) => !window.label) ?? payload.weekly?.[0];
  const weekly =
    weeklyEntry && Number.isFinite(weeklyEntry.usedPercent)
      ? {
          usedPercent: weeklyEntry.usedPercent,
          windowMinutes: 10_080,
          resetsAt: toMs(weeklyEntry.resetsAt),
          resetDescription: null,
        }
      : null;
  return { session, weekly };
}

export const layer = Layer.effect(
  UsageLimitsService,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    const platform = yield* HostProcessPlatform;

    const snapshots = yield* PubSub.sliding<UsageLimitsSnapshot>(1);
    let identities: ProviderIdentities = INITIAL_IDENTITIES;
    let isActiveNow = false;

    const readIdentities = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (!settings) return INITIAL_IDENTITIES;
      return {
        claudeConfigDir: resolveClaudeConfigDir(settings.providers.claudeAgent.homePath),
        codexHomePath: resolveCodexEffectiveHome(
          settings.providers.codex.homePath,
          settings.providers.codex.shadowHomePath,
        ),
        codexBinaryPath: settings.providers.codex.binaryPath.trim(),
        geminiCliOauthEnabled: settings.usageLimits.geminiCliOauthEnabled,
      } satisfies ProviderIdentities;
    });

    const coordinator = new UsageLimitCoordinator({
      isActive: () => isActiveNow,
      buildContext: async (
        provider: UsageLimitProviderId,
        signal,
      ): Promise<UsageLimitProviderContext> => {
        switch (provider) {
          case "claude":
            return {
              platform,
              claude: identities.claudeConfigDir ? { configDir: identities.claudeConfigDir } : {},
              signal,
            };
          case "codex":
            return {
              platform,
              codex: {
                ...(identities.codexHomePath ? { codexHomePath: identities.codexHomePath } : {}),
                ...(identities.codexBinaryPath
                  ? { codexBinaryPath: identities.codexBinaryPath }
                  : {}),
              },
              signal,
            };
          case "antigravity":
            return {
              platform,
              antigravity: { geminiCliOauthEnabled: identities.geminiCliOauthEnabled },
              signal,
            };
          case "grok":
            // Sync auth-file probe kept off getState(); once per fetch cycle.
            return { platform, grok: { authReadResult: grokAuth.readGrokAuthSession() }, signal };
          default:
            return { platform, signal };
        }
      },
      resolveProvenance: (provider) => provenanceFor(provider, identities),
    });

    coordinator.onStateChange(() => {
      Effect.runFork(PubSub.publish(snapshots, coordinator.getState()));
    });

    // ---- Activity gating + activation edges --------------------------------
    isActiveNow = (yield* backgroundPolicy.snapshot).shouldRunOpportunisticWork;
    yield* Stream.runForEach(backgroundPolicy.streamChanges, (policy) =>
      Effect.gen(function* () {
        const wasActive = isActiveNow;
        isActiveNow = policy.shouldRunOpportunisticWork;
        if (!wasActive && isActiveNow) {
          // Focus/show/restore equivalent: freshness evaluation, never a blind refetch.
          yield* Effect.tryPromise({
            try: () => coordinator.notifyActivated().then(() => undefined),
            catch: (cause) => new UsageLimitsRefreshError({ cause }),
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Usage-limits activation refresh failed", { cause }),
            ),
          );
        }
      }),
    ).pipe(Effect.forkScoped);

    // ---- Live-session ingestion (attached once, post-wiring) ----------------
    let eventStreamAttached = false;
    const attachEventStream = (events: Stream.Stream<ProviderRuntimeEvent>): Effect.Effect<void> =>
      Effect.sync(() => {
        if (eventStreamAttached) return;
        eventStreamAttached = true;
        const ingestion = Stream.runForEach(
          Stream.filter(events, (event) => event.type === "account.rate-limits.updated"),
          (event) =>
            event.type === "account.rate-limits.updated"
              ? Effect.sync(() => {
                  const provider = event.payload.rateLimits.provider;
                  if (provider !== "claude" && provider !== "codex") return;
                  const live = liveWindowsFromRateLimitsUpdate(event.payload.rateLimits);
                  if (live.session || live.weekly) {
                    coordinator.ingestLiveUpdate(provider, live);
                  }
                })
              : Effect.void,
        );
        Effect.runFork(ingestion);
      });

    // ---- Settings-driven credential changes --------------------------------
    identities = yield* readIdentities;
    let previousClaude = identities.claudeConfigDir;
    let previousCodex = identities.codexHomePath;
    let previousGemini = identities.geminiCliOauthEnabled;
    yield* Stream.runForEach(serverSettings.streamChanges, () =>
      Effect.gen(function* () {
        const next = yield* readIdentities;
        identities = next;
        for (const entry of [
          { provider: "claude", changed: previousClaude !== next.claudeConfigDir },
          { provider: "codex", changed: previousCodex !== next.codexHomePath },
          {
            provider: "antigravity",
            changed: previousGemini !== next.geminiCliOauthEnabled,
          },
        ] as const) {
          if (!entry.changed) continue;
          if (entry.provider === "antigravity") {
            // Antigravity is aggregated via geminiCliOauth, refresh via direct coordinator refresh
            yield* Effect.tryPromise({
              try: () => coordinator.refresh(entry.provider).then(() => undefined),
              catch: (cause) => new UsageLimitsRefreshError({ cause }),
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Usage-limits credential-change refresh failed", { cause }),
              ),
            );
            continue;
          }
          yield* Effect.tryPromise({
            try: () =>
              coordinator
                .refreshForCredentialChange(entry.provider as "claude" | "codex")
                .then(() => undefined),
            catch: (cause) => new UsageLimitsRefreshError({ cause }),
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Usage-limits credential-change refresh failed", { cause }),
            ),
          );
        }
        previousClaude = next.claudeConfigDir;
        previousCodex = next.codexHomePath;
        previousGemini = next.geminiCliOauthEnabled;
      }),
    ).pipe(Effect.forkScoped);

    // ---- Startup ------------------------------------------------------------
    coordinator.start({ fetchImmediately: true });
    yield* Effect.addFinalizer(() => Effect.sync(() => coordinator.stop()));

    return UsageLimitsService.of({
      getState: Effect.sync(() => coordinator.getState()),
      attachEventStream,
      refresh: (input) =>
        Effect.tryPromise({
          try: () => coordinator.refresh(input?.provider),
          catch: (cause) => new UsageLimitsRefreshError({ cause }),
        }).pipe(Effect.orElseSucceed(() => coordinator.getState())),
      refreshIfStale: Effect.tryPromise({
        try: () => coordinator.refreshIfStale(),
        catch: (cause) => new UsageLimitsRefreshError({ cause }),
      }).pipe(Effect.orElseSucceed(() => coordinator.getState())),
      subscribe: Effect.map(
        Effect.zip(
          PubSub.subscribe(snapshots),
          Effect.sync(() => coordinator.getState()),
        ),
        ([subscription, latest]) =>
          ({
            latest,
            changes: Stream.fromSubscription(subscription),
          }) as const,
      ),
    });
  }),
);

// ---- Pure home/config-dir resolution (no Effect Path dependency) ------------

function expandTilde(path: string): string {
  if (path === "~") return NodeOS.homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return `${NodeOS.homedir()}${path.slice(1)}`;
  }
  return path;
}

function normalizeDir(path: string): string {
  const trimmed = path.trim();
  return trimmed.length > 0 ? trimmed.replace(/[\\/]+$/, "") : "";
}

/** Mirrors ClaudeSkills' config-dir precedence: explicit setting → env → none. */
function resolveClaudeConfigDir(homePathSetting: string): string | null {
  const explicit = normalizeDir(homePathSetting);
  if (explicit.length > 0) return normalizeDir(NodePath.resolve(expandTilde(explicit)));
  const envDir = (process.env.CLAUDE_CONFIG_DIR ?? "").trim();
  return envDir.length > 0 ? normalizeDir(envDir) : null;
}

/**
 * The home that contains auth.json for sessions: an explicit shadow home wins
 * (it keeps auth.json private), then an explicit shared home, else "" meaning
 * the CLI default (~/.codex or CODEX_HOME).
 */
function resolveCodexEffectiveHome(homePathSetting: string, shadowHomePathSetting: string): string {
  const shadow = normalizeDir(shadowHomePathSetting);
  if (shadow.length > 0) return NodePath.resolve(expandTilde(shadow));
  const shared = normalizeDir(homePathSetting);
  if (shared.length > 0) return NodePath.resolve(expandTilde(shared));
  return "";
}
