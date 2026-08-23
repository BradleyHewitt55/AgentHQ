// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import type {
  ProviderUsageLimits,
  UsageLimitProviderId,
  UsageLimitsSnapshot,
  UsageLimitWindow,
} from "@t3tools/contracts";

import { getUsageLimitAdapter, type UsageLimitProviderContext } from "./usageAdapters.ts";
import { hasUsageData } from "./usageWindows.ts";

/**
 * Central usage-limit orchestration (the equivalent of Orca's RateLimitService,
 * adapted to this app's architecture):
 *
 * - One owner of usage state; UI components never poll providers directly.
 * - Background polling every 15 minutes, only while the application reports an
 *   active foreground client (`isActive`).
 * - Focus/resume activation evaluates a refresh plan: fresh healthy data is not
 *   re-fetched within 5 minutes; failing providers get exponential fast-retry
 *   (30s doubling, capped at 15m) when they support isolated refreshes.
 * - Manual `refresh()` bypasses all throttling, queues exactly one follow-up
 *   behind any in-flight cycle, and waits for it to finish.
 * - Transient failures keep recent data visible for 30 minutes (24h when the
 *   failure is itself rate-limiting); explicit unavailability discards it.
 * - HTTP Retry-After windows gate *automated* refreshes only.
 * - Generation + provenance guards discard in-flight results whose credential
 *   identity changed mid-fetch (settings-driven home/account switches).
 *
 * The class is deliberately plain TypeScript so orchestration behavior is unit
 * testable without Effect machinery; `UsageLimitsService.ts` wraps it as a
 * managed Layer.
 */

export const DEFAULT_POLL_MS = 15 * 60 * 1000;
export const MIN_POLL_MS = 30 * 1000;
export const MAX_POLL_MS = 2_147_483_647;
export const MIN_REFETCH_MS = 5 * 60 * 1000;
export const ACTIVE_FAILURE_REFETCH_MS = MIN_POLL_MS;
export const MAX_ACTIVE_FAILURE_REFETCH_MS = DEFAULT_POLL_MS;
const MAX_ACTIVE_FAILURE_STREAK = 8;
export const STALE_THRESHOLD_MS = 30 * 60 * 1000;
export const RATE_LIMITED_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const LIVE_INGEST_DEDUPE_MS = 30 * 1000;
const DEFERRED_STARTUP_ACTIVE_REFRESH_MS = 1000;

/** Providers whose fetch cycle is cheap enough to retry in isolation. */
const INDIVIDUALLY_REFRESHABLE_PROVIDERS: ReadonlySet<UsageLimitProviderId> = new Set([
  "claude",
  "codex",
  "grok",
]);

export const USAGE_LIMIT_PROVIDER_IDS: ReadonlyArray<UsageLimitProviderId> = [
  "claude",
  "codex",
  "antigravity",
  "grok",
  "cursor",
  "opencode",
  "pi",
];

export type UsageLimitCoordinatorOptions = {
  readonly providerIds?: ReadonlyArray<UsageLimitProviderId>;
  /** True while a foreground, visible, focused client exists. */
  readonly isActive: () => boolean;
  readonly buildContext: (
    provider: UsageLimitProviderId,
    signal: AbortSignal,
  ) => UsageLimitProviderContext | Promise<UsageLimitProviderContext>;
  /** Resolved credential identity for a provider; changes invalidate results. */
  readonly resolveProvenance?: (provider: UsageLimitProviderId) => string | null;
  readonly now?: () => number;
  /** Injectable timers so tests can drive polling deterministically. */
  readonly scheduleInterval?: (fn: () => void, ms: number) => () => void;
  readonly scheduleTimeout?: (fn: () => void, ms: number) => () => void;
  /**
   * Injectable adapter dispatch. Defaults to the real registry; tests replace
   * it to observe and stub per-provider fetches.
   */
  readonly dispatch?: (
    provider: UsageLimitProviderId,
    signal: AbortSignal,
  ) => Promise<ProviderUsageLimits>;
};

type InternalState = Record<UsageLimitProviderId, ProviderUsageLimits | null>;

function emptyState(providers: ReadonlyArray<UsageLimitProviderId>): InternalState {
  return Object.fromEntries(providers.map((id) => [id, null])) as InternalState;
}

function normalizePollInterval(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_POLL_MS;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, ms));
}

function errorMessage(error: unknown): string {
  // Redact anything that looks like a bearer token or key fragment.
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\b(?:Bearer\s+|sk-|xai-)[A-Za-z0-9._~+/=-]{8,}/gi, "[redacted]");
}

function isSameWindow(a: UsageLimitWindow | null, b: UsageLimitWindow | null): boolean {
  if (!a || !b) return a === b;
  return a.usedPercent === b.usedPercent && a.resetsAt === b.resetsAt;
}

export class UsageLimitCoordinator {
  private state: InternalState;
  private readonly providers: ReadonlyArray<UsageLimitProviderId>;
  private readonly isActiveFn: () => boolean;
  private readonly buildContext: UsageLimitCoordinatorOptions["buildContext"];
  private readonly resolveProvenance: (provider: UsageLimitProviderId) => string | null;
  private readonly now: () => number;
  private readonly scheduleInterval: (fn: () => void, ms: number) => () => void;
  private readonly scheduleTimeout: (fn: () => void, ms: number) => () => void;
  private readonly dispatchFn:
    | ((provider: UsageLimitProviderId, signal: AbortSignal) => Promise<ProviderUsageLimits>)
    | undefined;

  private pollTimerCancel: (() => void) | null = null;
  private deferredStartupCancel: (() => void) | null = null;

  private isFetching = false;
  private fullFetchQueued = false;
  private providerFetchQueued = new Set<UsageLimitProviderId>();
  private activeAbortControllers = new Set<AbortController>();
  private fetchIdleResolvers: (() => void)[] = [];

  private generations: Partial<Record<UsageLimitProviderId, number>> = {};
  private lastProvenances: Partial<Record<UsageLimitProviderId, string | null>> = {};
  private failureStreaks: Partial<Record<UsageLimitProviderId, number>> = {};
  private lastFailureRetryAt: Partial<Record<UsageLimitProviderId, number>> = {};

  private stateListeners = new Set<(snapshot: UsageLimitsSnapshot) => void>();

  private pollIntervalMs = DEFAULT_POLL_MS;

  constructor(options: UsageLimitCoordinatorOptions) {
    this.providers = options.providerIds ?? USAGE_LIMIT_PROVIDER_IDS;
    this.isActiveFn = options.isActive;
    this.buildContext = options.buildContext;
    this.resolveProvenance = options.resolveProvenance ?? (() => null);
    this.now = options.now ?? Date.now;
    this.scheduleInterval =
      options.scheduleInterval ??
      ((fn, ms) => {
        const timer = setInterval(fn, ms);
        return () => clearInterval(timer);
      });
    this.scheduleTimeout =
      options.scheduleTimeout ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      });
    this.dispatchFn = options.dispatch;
    this.state = emptyState(this.providers);
  }

  /** Runs one provider fetch through the injected or real adapter registry. */
  private fetchProvider(
    provider: UsageLimitProviderId,
    signal: AbortSignal,
  ): Promise<ProviderUsageLimits> {
    if (this.dispatchFn) return this.dispatchFn(provider, signal);
    const run = async (): Promise<ProviderUsageLimits> => {
      const context = await this.buildContext(provider, signal);
      return getUsageLimitAdapter(provider).fetchUsage(context);
    };
    return run();
  }

  /** Test seam: drive a full automatic fetch cycle deterministically. */
  fetchAllForTest(): Promise<void> {
    return this.fetchAll();
  }

  // ---------------------------------------------------------------------------
  // Subscriptions & state
  // ---------------------------------------------------------------------------

  onStateChange(listener: (snapshot: UsageLimitsSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  getState(): UsageLimitsSnapshot {
    return {
      readAt: new Date(this.now()).toISOString(),
      providers: this.providers.map(
        (provider) =>
          this.state[provider] ?? {
            provider,
            session: null,
            weekly: null,
            updatedAt: 0,
            error: null,
            status: "idle" as const,
          },
      ),
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(options?: { fetchImmediately?: boolean }): void {
    if (options?.fetchImmediately === false) {
      this.scheduleDeferredStartupRefresh();
    } else {
      void this.fetchAll();
    }
    this.startPollTimer();
  }

  stop(): void {
    this.stopPollTimer();
    this.clearDeferredStartupRefresh();
    this.abortActiveCycles();
    this.fullFetchQueued = false;
    this.providerFetchQueued.clear();
    this.resolveAndClearIdleWaiters();
  }

  setPollingInterval(ms: number): void {
    this.pollIntervalMs = normalizePollInterval(ms);
    if (this.pollTimerCancel) {
      this.stopPollTimer();
      this.startPollTimer();
    }
  }

  getPollingInterval(): number {
    return this.pollIntervalMs;
  }

  private startPollTimer(): void {
    this.stopPollTimer();
    this.pollTimerCancel = this.scheduleInterval(() => {
      if (!this.isActiveFn()) return;
      void this.fetchAll();
    }, this.pollIntervalMs);
  }

  private stopPollTimer(): void {
    if (this.pollTimerCancel) {
      this.pollTimerCancel();
      this.pollTimerCancel = null;
    }
  }

  private scheduleDeferredStartupRefresh(): void {
    this.clearDeferredStartupRefresh();
    this.deferredStartupCancel = this.scheduleTimeout(() => {
      this.deferredStartupCancel = null;
      void this.refreshIfActive();
    }, DEFERRED_STARTUP_ACTIVE_REFRESH_MS);
  }

  private clearDeferredStartupRefresh(): void {
    if (this.deferredStartupCancel) {
      this.deferredStartupCancel();
      this.deferredStartupCancel = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Activation / focus-resume refresh planning
  // ---------------------------------------------------------------------------

  /**
   * Called when the app becomes active again (focus/show/restore equivalents).
   * Never immediately refetches healthy data younger than MIN_REFETCH_MS.
   */
  async notifyActivated(): Promise<void> {
    await this.refreshIfActive();
  }

  private async refreshIfActive(): Promise<void> {
    if (!this.isActiveFn()) return;
    const plan = this.getActiveRefreshPlan();
    await this.runActiveRefreshPlan(plan);
  }

  private getActiveRefreshPlan():
    | { kind: "none" }
    | { kind: "full" }
    | { kind: "providers"; providers: UsageLimitProviderId[] } {
    const now = this.now();
    const retryable: UsageLimitProviderId[] = [];
    for (const provider of this.providers) {
      const limits = this.state[provider];
      if (!limits || limits.status === "idle") return { kind: "full" };
      if (limits.status === "fetching") continue;
      if (limits.status === "ok" || limits.status === "unavailable") {
        if (now - limits.updatedAt >= MIN_REFETCH_MS) return { kind: "full" };
        continue;
      }
      // status === 'error': a failed startup read stays eligible for
      // activation recovery, throttled per provider.
      if (this.isRetryAfterActive(limits)) continue;
      const throttleMs = INDIVIDUALLY_REFRESHABLE_PROVIDERS.has(provider)
        ? Math.min(
            ACTIVE_FAILURE_REFETCH_MS * 2 ** Math.max(0, (this.failureStreaks[provider] ?? 0) - 1),
            MAX_ACTIVE_FAILURE_REFETCH_MS,
          )
        : MIN_REFETCH_MS;
      if (now - (this.lastFailureRetryAt[provider] ?? 0) >= throttleMs) {
        retryable.push(provider);
      }
    }
    if (retryable.length === 0) return { kind: "none" };
    return { kind: "providers", providers: retryable };
  }

  private async runActiveRefreshPlan(
    plan:
      | { kind: "none" }
      | { kind: "full" }
      | { kind: "providers"; providers: UsageLimitProviderId[] },
  ): Promise<void> {
    if (plan.kind === "none") return;
    if (plan.kind === "full") {
      if (!this.isFetching) {
        // Restart retry clocks so the individual lane doesn't fire ahead of backoff.
        const now = this.now();
        for (const provider of this.providers) {
          if (this.state[provider]?.status === "error") {
            this.lastFailureRetryAt[provider] = now;
          }
        }
      }
      await this.fetchAll();
      return;
    }
    if (this.isFetching) return;
    const now = this.now();
    for (const provider of plan.providers) this.lastFailureRetryAt[provider] = now;
    const canRefreshIndividually = plan.providers.every((p) =>
      INDIVIDUALLY_REFRESHABLE_PROVIDERS.has(p),
    );
    if (!canRefreshIndividually) {
      await this.fetchAll();
      return;
    }
    for (const provider of plan.providers) {
      await this.fetchProvidersOnly([provider]);
    }
  }

  // ---------------------------------------------------------------------------
  // Manual refresh
  // ---------------------------------------------------------------------------

  async refresh(provider?: UsageLimitProviderId): Promise<UsageLimitsSnapshot> {
    // User-directed refresh must bypass poll/freshness throttling entirely.
    if (provider && INDIVIDUALLY_REFRESHABLE_PROVIDERS.has(provider)) {
      await this.fetchProvidersOnly([provider], { force: true });
      return this.getState();
    }
    await this.fetchAll({ force: true });
    return this.getState();
  }

  /** Reconnect-safe variant: replays a subscription without forcing a fetch. */
  async refreshIfStale(): Promise<UsageLimitsSnapshot> {
    await this.refreshIfActive();
    return this.getState();
  }

  // ---------------------------------------------------------------------------
  // Account / credential-target switching
  // ---------------------------------------------------------------------------

  /**
   * Invalidates a provider's visible state because its credential identity
   * changed (settings-driven home/config-dir switch). Old in-flight results
   * can no longer be applied (generation + provenance), and a forced
   * provider-specific refresh starts immediately.
   */
  async refreshForCredentialChange(provider: UsageLimitProviderId): Promise<void> {
    this.bumpGeneration(provider);
    this.failureStreaks[provider] = 0;
    this.updateState({
      ...this.state,
      [provider]: this.withFetchingStatus(null, provider),
    });
    if (INDIVIDUALLY_REFRESHABLE_PROVIDERS.has(provider)) {
      await this.fetchProvidersOnly([provider], { force: true });
      return;
    }
    await this.fetchAll({ force: true });
  }

  // ---------------------------------------------------------------------------
  // Live-session ingestion
  // ---------------------------------------------------------------------------

  /**
   * Merges a live runtime update (Claude SDK `/usage`, Codex rate-limit
   * notifications) into state. Partial payloads preserve the other window.
   */
  ingestLiveUpdate(
    provider: "claude" | "codex",
    windows: { session?: UsageLimitWindow | null; weekly?: UsageLimitWindow | null },
    metadata?: { authProvenance?: string },
  ): void {
    const previous = this.state[provider];
    // A partial payload means "no update" for the missing window, not cleared.
    const session = windows.session ?? previous?.session ?? null;
    const weekly = windows.weekly ?? previous?.weekly ?? null;
    if (!session && !weekly) return;
    if (
      previous?.status === "ok" &&
      previous.usageMetadata?.source === "live-session" &&
      this.now() - previous.updatedAt < LIVE_INGEST_DEDUPE_MS &&
      isSameWindow(previous.session, session) &&
      isSameWindow(previous.weekly, weekly)
    ) {
      return;
    }
    this.failureStreaks[provider] = 0;
    this.updateState({
      ...this.state,
      [provider]: {
        provider,
        session,
        weekly,
        // The live payload carries no Fable scoped window; keep the last
        // OAuth-provided one visible until the next OAuth cycle refreshes it.
        ...(previous?.fableWeekly ? { fableWeekly: previous.fableWeekly } : {}),
        updatedAt: this.now(),
        error: null,
        status: "ok",
        usageMetadata: {
          source: "live-session",
          lastSuccessfulSource: "live-session",
          credentialSource: previous?.usageMetadata?.credentialSource,
          authProvenance: metadata?.authProvenance ?? previous?.usageMetadata?.authProvenance,
        },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Fetch cycles
  // ---------------------------------------------------------------------------

  private async fetchAll(options?: { force?: boolean }): Promise<void> {
    if (this.isFetching) {
      if (options?.force) {
        this.fullFetchQueued = true;
        return this.waitForFetchIdle();
      }
      return;
    }
    this.isFetching = true;
    try {
      let shouldContinue = true;
      let cycleForce = options?.force ?? false;
      while (shouldContinue) {
        const aborted = await this.runCycle((signal) =>
          this.runFullFetchCycle(signal, { force: cycleForce }),
        );
        shouldContinue = false;
        cycleForce = true;
        if (aborted) break;
        if (this.fullFetchQueued) {
          this.fullFetchQueued = false;
          shouldContinue = true;
          continue;
        }
        const queued = [...this.providerFetchQueued];
        this.providerFetchQueued.clear();
        // Queued reruns only exist because a forced request asked for them,
        // so they inherit force and bypass Retry-After gates.
        for (const provider of queued) {
          const queueAborted = await this.runCycle((signal) =>
            this.runProviderFetchCycle(signal, provider, { force: true }),
          );
          if (queueAborted) break;
        }
      }
    } finally {
      this.isFetching = false;
      this.resolveFetchIdleWaiters();
    }
  }

  private async fetchProvidersOnly(
    providers: ReadonlyArray<UsageLimitProviderId>,
    options?: { force?: boolean },
  ): Promise<void> {
    if (this.isFetching) {
      if (options?.force) {
        for (const provider of providers) {
          if (!this.providerFetchQueued.has(provider)) this.providerFetchQueued.add(provider);
        }
        return this.waitForFetchIdle();
      }
      return;
    }
    this.isFetching = true;
    try {
      let shouldContinue = true;
      while (shouldContinue) {
        shouldContinue = false;
        const primary = providers[0];
        if (!primary) break;
        const aborted = await this.runCycle((signal) =>
          this.runProviderFetchCycle(signal, primary, { force: options?.force === true }),
        );
        if (aborted) break;
        if (this.fullFetchQueued) {
          this.fullFetchQueued = false;
          await this.runCycle((signal) => this.runFullFetchCycle(signal, { force: true }));
        }
        for (const provider of providers.slice(1)) {
          await this.runCycle((signal) => this.runProviderFetchCycle(signal, provider));
        }
        const queued = [...this.providerFetchQueued];
        this.providerFetchQueued.clear();
        for (const provider of queued) {
          await this.runCycle((signal) => this.runProviderFetchCycle(signal, provider));
        }
      }
    } finally {
      this.isFetching = false;
      this.resolveFetchIdleWaiters();
    }
  }

  private waitForFetchIdle(): Promise<void> {
    if (!this.isFetching && !this.fullFetchQueued && this.providerFetchQueued.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.fetchIdleResolvers.push(resolve);
    });
  }

  private resolveFetchIdleWaiters(): void {
    if (this.isFetching || this.fullFetchQueued || this.providerFetchQueued.size > 0) return;
    const resolvers = this.fetchIdleResolvers;
    this.fetchIdleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  private resolveAndClearIdleWaiters(): void {
    const resolvers = this.fetchIdleResolvers;
    this.fetchIdleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  private async runCycle(fn: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    const controller = new AbortController();
    this.activeAbortControllers.add(controller);
    try {
      await fn(controller.signal);
      return controller.signal.aborted;
    } finally {
      this.activeAbortControllers.delete(controller);
    }
  }

  private abortActiveCycles(): void {
    for (const controller of this.activeAbortControllers) controller.abort();
    this.activeAbortControllers.clear();
  }

  // ---------------------------------------------------------------------------
  // Full fetch cycle
  // ---------------------------------------------------------------------------

  private detectProvenanceChanges(): Set<UsageLimitProviderId> {
    const changed = new Set<UsageLimitProviderId>();
    for (const provider of this.providers) {
      const next = this.resolveProvenance(provider);
      const previous = this.lastProvenances[provider];
      if (previous !== undefined && previous !== next) {
        changed.add(provider);
      }
      this.lastProvenances[provider] = next;
    }
    return changed;
  }

  private async runFullFetchCycle(
    signal: AbortSignal,
    options?: { force?: boolean },
  ): Promise<void> {
    if (signal.aborted) return;

    // Capture identities before awaiting anything so a mid-cycle switch
    // invalidates both the attribution snapshot and the state apply.
    const snapshots = new Map<
      UsageLimitProviderId,
      { generation: number; provenance: string | null }
    >();
    for (const provider of this.providers) {
      snapshots.set(provider, {
        generation: this.generations[provider] ?? 0,
        provenance: this.resolveProvenance(provider),
      });
      this.lastProvenances[provider] = snapshots.get(provider)!.provenance;
    }

    const previousState = this.state;
    const configChanged = this.detectProvenanceChanges();

    const skipAutomated = new Map<UsageLimitProviderId, boolean>();
    for (const provider of this.providers) {
      const limits = previousState[provider];
      const gatedByRetryAfter = !options?.force && this.isRetryAfterActive(limits);
      const gatedByLiveFreshness =
        !options?.force &&
        provider === "claude" &&
        Boolean(
          limits?.status === "ok" &&
          limits.usageMetadata?.source === "live-session" &&
          this.now() - limits.updatedAt < MIN_REFETCH_MS,
        );
      skipAutomated.set(provider, gatedByRetryAfter || gatedByLiveFreshness);
    }

    // Mark fetching while keeping settled snapshots visible; explicitly
    // reconfigured providers drop their old-identity data right away.
    const nextState: InternalState = { ...previousState };
    for (const provider of this.providers) {
      nextState[provider] = configChanged.has(provider)
        ? this.withFetchingStatus(null, provider)
        : skipAutomated.get(provider)
          ? previousState[provider]
          : this.withFetchingStatus(previousState[provider], provider);
    }
    this.updateState(nextState);

    const settled = await Promise.allSettled(
      this.providers.map(async (provider) => {
        if (skipAutomated.get(provider) && previousState[provider]) {
          return previousState[provider]!;
        }
        return this.fetchProvider(provider, signal);
      }),
    );

    if (signal.aborted) return;

    const applied: InternalState = { ...this.state };
    settled.forEach((outcome, index) => {
      const provider = this.providers[index];
      if (!provider) return;
      const snapshot = snapshots.get(provider)!;
      const provenanceStillCurrent = this.resolveProvenance(provider) === snapshot.provenance;
      const shouldApply =
        snapshot.generation === (this.generations[provider] ?? 0) && provenanceStillCurrent;
      if (!shouldApply) return;
      let fresh: ProviderUsageLimits;
      if (outcome.status === "fulfilled") {
        fresh = outcome.value;
      } else {
        fresh = {
          provider,
          session: null,
          weekly: null,
          updatedAt: this.now(),
          error: errorMessage(outcome.reason),
          status: "error",
        };
      }
      this.trackFailureStreak(provider, fresh);
      applied[provider] = configChanged.has(provider)
        ? fresh
        : this.applyStalePolicy(fresh, previousState[provider]);
    });
    this.updateState(applied);
  }

  // ---------------------------------------------------------------------------
  // Single-provider fetch cycle
  // ---------------------------------------------------------------------------

  private async runProviderFetchCycle(
    signal: AbortSignal,
    provider: UsageLimitProviderId,
    options?: { force?: boolean },
  ): Promise<void> {
    if (signal.aborted) return;
    const limits = this.state[provider];
    if (!options?.force && this.isRetryAfterActive(limits)) return;
    if (
      !options?.force &&
      provider === "claude" &&
      Boolean(
        limits?.status === "ok" &&
        limits.usageMetadata?.source === "live-session" &&
        this.now() - limits.updatedAt < MIN_REFETCH_MS,
      )
    ) {
      return;
    }

    const generation = this.generations[provider] ?? 0;
    const provenance = this.resolveProvenance(provider);

    const previousState = this.state;
    this.updateState({
      ...previousState,
      [provider]: this.withFetchingStatus(previousState[provider], provider),
    });

    let fresh: ProviderUsageLimits;
    try {
      fresh = await this.fetchProvider(provider, signal);
    } catch (err) {
      fresh = {
        provider,
        session: null,
        weekly: null,
        updatedAt: this.now(),
        error: errorMessage(err),
        status: "error",
      };
    }
    if (signal.aborted) return;

    const shouldApply =
      generation === (this.generations[provider] ?? 0) &&
      this.resolveProvenance(provider) === provenance;
    if (shouldApply) {
      this.trackFailureStreak(provider, fresh);
      this.updateState({
        ...this.state,
        [provider]: this.applyStalePolicy(fresh, previousState[provider]),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Policies
  // ---------------------------------------------------------------------------

  private isRetryAfterActive(limits: ProviderUsageLimits | null): boolean {
    return Boolean(
      limits?.status === "error" &&
      limits.usageMetadata?.retryAtMs &&
      limits.usageMetadata.retryAtMs > this.now(),
    );
  }

  private trackFailureStreak(provider: UsageLimitProviderId, fresh: ProviderUsageLimits): void {
    if (fresh.status === "error") {
      this.failureStreaks[provider] = Math.min(
        (this.failureStreaks[provider] ?? 0) + 1,
        MAX_ACTIVE_FAILURE_STREAK,
      );
      return;
    }
    if (fresh.status === "ok" || fresh.status === "unavailable") {
      this.failureStreaks[provider] = 0;
    }
  }

  /**
   * Keeps settled state meaningful across transient failures: fresh ok wins,
   * explicit unavailability clears, errors temporarily preserve recent usage.
   */
  applyStalePolicy(
    fresh: ProviderUsageLimits,
    previous: ProviderUsageLimits | null,
  ): ProviderUsageLimits {
    if (fresh.status === "ok") {
      return {
        ...fresh,
        usageMetadata: {
          ...fresh.usageMetadata,
          lastSuccessfulSource:
            fresh.usageMetadata?.source ?? fresh.usageMetadata?.lastSuccessfulSource,
        },
      };
    }
    if (fresh.status === "unavailable") {
      return fresh;
    }
    if (!previous || !hasUsageData(previous)) return fresh;
    const staleThresholdMs =
      fresh.usageMetadata?.failureKind === "rate-limited"
        ? RATE_LIMITED_STALE_THRESHOLD_MS
        : STALE_THRESHOLD_MS;
    if (this.now() - previous.updatedAt > staleThresholdMs) return fresh;
    return {
      ...previous,
      error: fresh.error,
      status: "error",
      usageMetadata: {
        ...previous.usageMetadata,
        ...fresh.usageMetadata,
        lastSuccessfulSource:
          previous.usageMetadata?.lastSuccessfulSource ?? previous.usageMetadata?.source,
      },
    };
  }

  private withFetchingStatus(
    current: ProviderUsageLimits | null,
    provider: UsageLimitProviderId,
  ): ProviderUsageLimits {
    if (!current) {
      return {
        provider,
        session: null,
        weekly: null,
        updatedAt: 0,
        error: null,
        status: "fetching",
      };
    }
    // Keep settled chips visible during background refetches.
    if (current.status === "ok" || current.status === "error" || current.status === "unavailable") {
      return current;
    }
    return { ...current, status: "fetching" };
  }

  private bumpGeneration(provider: UsageLimitProviderId): void {
    this.generations[provider] = (this.generations[provider] ?? 0) + 1;
  }

  private updateState(next: InternalState): void {
    this.state = next;
    const snapshot = this.getState();
    for (const listener of this.stateListeners) {
      try {
        listener(snapshot);
      } catch {
        // One bad listener must not break the others.
      }
    }
  }
}
