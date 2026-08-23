// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import type { ProviderUsageLimits, UsageLimitProviderId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  DEFAULT_POLL_MS,
  MIN_POLL_MS,
  MIN_REFETCH_MS,
  MAX_ACTIVE_FAILURE_REFETCH_MS,
  ACTIVE_FAILURE_REFETCH_MS,
  STALE_THRESHOLD_MS,
  RATE_LIMITED_STALE_THRESHOLD_MS,
  UsageLimitCoordinator,
} from "./usageLimitCoordinator.ts";

const BASE_TIME = 1_700_000_000_000;

type HarnessOptions = {
  readonly providers?: readonly UsageLimitProviderId[];
};

function makeHarness(options: HarnessOptions = {}) {
  const providers = options.providers ?? (["claude", "codex", "grok"] as const);
  const nowRef = { value: BASE_TIME };
  let active = true;
  let dispatchCalls: Array<{ provider: UsageLimitProviderId; at: number }> = [];
  const dispatchQueue = new Map<UsageLimitProviderId, Array<ProviderUsageLimits | Error>>();
  const provenances: Partial<Record<UsageLimitProviderId, string | null>> = {};
  const intervals: Array<{ fn: () => void; ms: number }> = [];

  function limitsFor(provider: UsageLimitProviderId, usedPercent: number): ProviderUsageLimits {
    return {
      provider,
      session:
        usedPercent >= 0
          ? { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null }
          : null,
      weekly: null,
      updatedAt: nowRef.value,
      error: null,
      status: "ok",
    };
  }

  const coordinator = new UsageLimitCoordinator({
    providerIds: [...providers],
    isActive: () => active,
    buildContext: async () => ({ platform: "linux" }),
    resolveProvenance: (provider) => provenances[provider] ?? "host:test",
    now: () => nowRef.value,
    scheduleInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return () => {};
    },
    scheduleTimeout: () => () => {},
    dispatch: async (provider) => {
      dispatchCalls.push({ provider, at: nowRef.value });
      const queued = dispatchQueue.get(provider);
      if (!queued || queued.length === 0) return limitsFor(provider, 40);
      const next = queued.shift()!;
      if (next instanceof Error) throw next;
      return next;
    },
  });

  return {
    coordinator,
    providers,
    nowRef,
    intervals,
    ok: limitsFor,
    get dispatchCalls() {
      return dispatchCalls;
    },
    resetDispatchCalls() {
      dispatchCalls = [];
    },
    queueResult(provider: UsageLimitProviderId, result: ProviderUsageLimits | Error) {
      const list = dispatchQueue.get(provider) ?? [];
      list.push(result);
      dispatchQueue.set(provider, list);
    },
    setActive(value: boolean) {
      active = value;
    },
    setProvenance(provider: UsageLimitProviderId, value: string | null) {
      provenances[provider] = value;
    },
    async tickInterval(index = 0) {
      intervals[index]?.fn();
      await flush();
    },
    state(): Record<string, ProviderUsageLimits | null> {
      const snapshot = coordinator.getState();
      return Object.fromEntries(snapshot.providers.map((p) => [p.provider, p]));
    },
  };
}

const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

function unavailable(
  provider: UsageLimitProviderId,
  error: string,
  updatedAt: number,
): ProviderUsageLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt,
    error,
    status: "unavailable",
    usageMetadata: { failureKind: "missing-credentials" },
  };
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

describe("polling", () => {
  it("registers a default 15-minute poll timer", () => {
    const h = makeHarness();
    h.coordinator.start({ fetchImmediately: false });
    expect(h.intervals).toHaveLength(1);
    expect(h.intervals[0]?.ms).toBe(DEFAULT_POLL_MS);
    h.coordinator.stop();
  });

  it("clamps polling intervals to the minimum", () => {
    const h = makeHarness();
    h.coordinator.setPollingInterval(100);
    h.coordinator.start({ fetchImmediately: false });
    expect(h.intervals[0]?.ms).toBe(MIN_POLL_MS);
    h.coordinator.stop();
  });

  it("does not poll while inactive and polls while active", async () => {
    const h = makeHarness();
    h.setActive(false);
    h.coordinator.start({ fetchImmediately: false });
    await h.tickInterval();
    expect(h.dispatchCalls).toHaveLength(0);

    h.setActive(true);
    await h.tickInterval();
    expect(h.dispatchCalls.length).toBe(h.providers.length);
    h.coordinator.stop();
  });

  it("skips polling when the app becomes unfocused between ticks", async () => {
    const h = makeHarness();
    h.coordinator.start({ fetchImmediately: false });
    await h.tickInterval(); // active first tick fetches
    h.resetDispatchCalls();
    h.setActive(false);
    await h.tickInterval();
    expect(h.dispatchCalls).toHaveLength(0);
    h.coordinator.stop();
  });
});

// ---------------------------------------------------------------------------
// Activation refresh
// ---------------------------------------------------------------------------

describe("activation refresh planning", () => {
  it("does not refetch healthy data younger than five minutes on activation", async () => {
    const h = makeHarness();
    await h.coordinator.refresh();
    h.resetDispatchCalls();
    await h.coordinator.notifyActivated();
    expect(h.dispatchCalls).toHaveLength(0);
  });

  it("refetches every provider on activation once data is older than five minutes", async () => {
    const h = makeHarness();
    await h.coordinator.refresh();
    h.resetDispatchCalls();
    h.nowRef.value += MIN_REFETCH_MS + 1;
    await h.coordinator.notifyActivated();
    expect(h.dispatchCalls.length).toBe(h.providers.length);
  });

  it("initial missing state triggers a full refresh on activation", async () => {
    const h = makeHarness();
    h.coordinator.start({ fetchImmediately: false });
    await h.coordinator.notifyActivated();
    expect(h.dispatchCalls.length).toBe(h.providers.length);
    h.coordinator.stop();
  });
});

// ---------------------------------------------------------------------------
// Manual refresh
// ---------------------------------------------------------------------------

describe("manual refresh", () => {
  it("bypasses the freshness throttle", async () => {
    const h = makeHarness();
    await h.coordinator.refresh();
    h.resetDispatchCalls();
    await h.coordinator.refresh();
    expect(h.dispatchCalls.length).toBe(h.providers.length);
  });

  it("queues exactly one follow-up behind an in-flight automatic cycle and waits for final state", async () => {
    let currentProvenance = "host:home-a";
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const coordinator = new UsageLimitCoordinator({
      providerIds: ["claude"],
      isActive: () => true,
      buildContext: async () => ({ platform: "linux" }),
      resolveProvenance: () => currentProvenance,
      now: () => BASE_TIME,
      scheduleTimeout: () => () => {},
      dispatch: async (provider) => {
        calls += 1;
        if (calls === 1) await gate; // hold the automatic cycle in flight
        return {
          provider,
          session: {
            usedPercent: calls === 1 ? 10 : 55,
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null,
          },
          weekly: null,
          updatedAt: BASE_TIME + calls,
          error: null,
          status: "ok",
        };
      },
    });

    const automatic = coordinator.fetchAllForTest();
    // Two rapid manual clicks while in flight → one queued follow-up total.
    const manualPromise = coordinator.refresh();
    releaseFirst?.();
    const state = await manualPromise;
    await automatic;

    expect(state.providers[0]?.session?.usedPercent).toBe(55);
    // The follow-up cycle ran after the gated first cycle.
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("concurrency coalescing", () => {
  it("never runs two full cycles simultaneously", async () => {
    let inFlight = false;
    let overlaps = 0;
    const coordinator = new UsageLimitCoordinator({
      providerIds: ["claude"],
      isActive: () => true,
      buildContext: async () => ({ platform: "linux" }),
      now: () => BASE_TIME,
      scheduleTimeout: () => () => {},
      dispatch: async (provider) => {
        if (inFlight) overlaps += 1;
        inFlight = true;
        await flush();
        inFlight = false;
        return {
          provider,
          session: null,
          weekly: null,
          updatedAt: BASE_TIME,
          error: null,
          status: "unavailable",
        };
      },
    });
    await Promise.all([coordinator.fetchAllForTest(), coordinator.fetchAllForTest()]);
    expect(overlaps).toBe(0);
  });

  it("one provider rejection does not abort other providers", async () => {
    const h = makeHarness({ providers: ["claude", "codex"] });
    h.queueResult("claude", new Error("boom"));
    const state = await h.coordinator.refresh();
    const claude = state.providers.find((p) => p.provider === "claude");
    const codex = state.providers.find((p) => p.provider === "codex");
    expect(claude?.status).toBe("error");
    expect(codex?.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Stale behavior
// ---------------------------------------------------------------------------

describe("stale policy", () => {
  it("preserves recent successful data through transient errors", async () => {
    const h = makeHarness({ providers: ["claude"] });
    await h.coordinator.refresh();
    h.nowRef.value += 60_000;
    h.queueResult("claude", new Error("network down"));
    const state = await h.coordinator.refresh();
    const claude = state.providers[0]!;
    expect(claude.status).toBe("error");
    expect(claude.session?.usedPercent).toBe(40);
    expect(claude.error).toContain("network down");
  });

  it("replaces stale data with a successful result", async () => {
    const h = makeHarness({ providers: ["claude"] });
    await h.coordinator.refresh();
    h.nowRef.value += 60_000;
    h.queueResult("claude", h.ok("claude", 90));
    const state = await h.coordinator.refresh();
    expect(state.providers[0]?.session?.usedPercent).toBe(90);
    expect(state.providers[0]?.status).toBe("ok");
  });

  it("unavailable clears previously visible usage", async () => {
    const h = makeHarness({ providers: ["claude"] });
    await h.coordinator.refresh();
    h.nowRef.value += 60_000;
    h.queueResult(
      "claude",
      unavailable(
        "claude",
        "No subscription plan — API key billing or not signed in",
        h.nowRef.value,
      ),
    );
    const state = await h.coordinator.refresh();
    expect(state.providers[0]?.status).toBe("unavailable");
    expect(state.providers[0]?.session).toBeNull();
  });

  it("discards stale data older than the normal threshold", async () => {
    const h = makeHarness({ providers: ["claude"] });
    await h.coordinator.refresh();
    h.nowRef.value += STALE_THRESHOLD_MS + 60_000;
    h.queueResult("claude", new Error("still failing"));
    const state = await h.coordinator.refresh();
    expect(state.providers[0]?.status).toBe("error");
    expect(state.providers[0]?.session).toBeNull();
  });

  it("rate-limited failures keep previous data up to 24 hours", async () => {
    const h = makeHarness({ providers: ["claude"] });
    await h.coordinator.refresh();
    h.nowRef.value += 2 * 60 * 60 * 1000; // beyond the 30-minute window
    h.queueResult("claude", {
      provider: "claude",
      session: null,
      weekly: null,
      updatedAt: h.nowRef.value,
      error: "Claude usage is rate limited right now.",
      status: "error",
      usageMetadata: { failureKind: "rate-limited" },
    });
    const state = await h.coordinator.refresh();
    expect(state.providers[0]?.session?.usedPercent).toBe(40);
    expect(state.providers[0]?.usageMetadata?.failureKind).toBe("rate-limited");

    // But past the rate-limited threshold even that goes away.
    h.nowRef.value += RATE_LIMITED_STALE_THRESHOLD_MS + 60_000;
    h.queueResult("claude", new Error("still limited"));
    const expired = await h.coordinator.refresh();
    expect(expired.providers[0]?.session).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Retry-After
// ---------------------------------------------------------------------------

describe("Retry-After gating", () => {
  function retryAfterLimits(retryAtMs: number): ProviderUsageLimits {
    return {
      provider: "grok",
      session: null,
      weekly: null,
      updatedAt: BASE_TIME,
      error: "Grok usage request failed (HTTP 429)",
      status: "error",
      usageMetadata: { failureKind: "rate-limited", retryAtMs },
    };
  }

  it("skips automated fetches before retryAtMs but allows manual force", async () => {
    const h = makeHarness({ providers: ["grok"] });
    h.queueResult("grok", retryAfterLimits(h.nowRef.value + 10 * 60 * 1000));
    await h.coordinator.refresh();
    h.resetDispatchCalls();

    await h.coordinator.notifyActivated();
    expect(h.dispatchCalls).toHaveLength(0); // automated lane respects the window

    await h.coordinator.refresh();
    expect(h.dispatchCalls).toHaveLength(1); // manual bypasses it
  });

  it("allows automated refreshes again once retryAtMs has passed", async () => {
    const h = makeHarness({ providers: ["grok"] });
    h.queueResult("grok", retryAfterLimits(h.nowRef.value + 60_000));
    await h.coordinator.refresh();
    h.resetDispatchCalls();

    h.nowRef.value += 61_000;
    await h.coordinator.notifyActivated();
    expect(h.dispatchCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Failure backoff
// ---------------------------------------------------------------------------

describe("failure backoff", () => {
  it("grows isolated-retry delay exponentially and resets after success", async () => {
    const h = makeHarness({ providers: ["grok"] });
    h.queueResult("grok", new Error("fail seed"));
    await h.coordinator.refresh(); // streak=1
    h.resetDispatchCalls();

    h.queueResult("grok", new Error("fail retry")); // activation retry fails again
    await h.coordinator.notifyActivated(); // immediate first retry allowed (lastRetryAt unset)
    expect(h.dispatchCalls.filter((c) => c.provider === "grok")).toHaveLength(1);

    // streak=2 → ~60s delay; an immediate re-activation must not retry.
    h.resetDispatchCalls();
    await h.coordinator.notifyActivated();
    expect(h.dispatchCalls).toHaveLength(0);

    h.nowRef.value += ACTIVE_FAILURE_REFETCH_MS * 2 ** 1 + 1;
    await h.coordinator.notifyActivated(); // retry succeeds → streak resets
    expect(h.dispatchCalls.filter((c) => c.provider === "grok")).toHaveLength(1);

    // Success resets the streak: after freshness lapses the poll resumes normally.
    h.resetDispatchCalls();
    h.nowRef.value += MIN_REFETCH_MS + 1;
    await h.coordinator.notifyActivated();
    expect(h.dispatchCalls.length).toBeGreaterThan(0);
  });

  it("caps the delay at the maximum", async () => {
    const h = makeHarness({ providers: ["grok"] });
    for (let i = 0; i < 8; i += 1) {
      h.queueResult("grok", new Error(`fail ${i}`));
      await h.coordinator.refresh();
    }
    h.resetDispatchCalls();

    h.queueResult("grok", new Error("fail at cap"));
    await h.coordinator.notifyActivated(); // pending retry slot fires immediately
    expect(h.dispatchCalls.filter((c) => c.provider === "grok")).toHaveLength(1);

    // At max streak the throttle must be capped at 15 minutes, not larger.
    h.resetDispatchCalls();
    await h.coordinator.notifyActivated();
    expect(h.dispatchCalls).toHaveLength(0);

    h.nowRef.value += MAX_ACTIVE_FAILURE_REFETCH_MS - 30_000;
    await h.coordinator.notifyActivated();
    expect(h.dispatchCalls).toHaveLength(0); // 14.5min < the 15-minute cap

    h.queueResult("grok", new Error("still failing past cap"));
    h.nowRef.value += 31_000;
    await h.coordinator.notifyActivated();
    expect(h.dispatchCalls.filter((c) => c.provider === "grok")).toHaveLength(1);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Account / credential switching
// ---------------------------------------------------------------------------

describe("credential-target switching", () => {
  it("an old in-flight result cannot overwrite the newly selected identity's state", async () => {
    let currentProvenance = "host:home-a";
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let callCount = 0;
    const coordinator = new UsageLimitCoordinator({
      providerIds: ["claude"],
      isActive: () => true,
      buildContext: async () => ({ platform: "linux" }),
      resolveProvenance: () => currentProvenance,
      now: () => BASE_TIME,
      scheduleTimeout: () => () => {},
      dispatch: async (provider) => {
        callCount += 1;
        const generationPercent = callCount === 1 ? 77 : 12; // 77 belongs to the OLD home
        await gate;
        return {
          provider,
          session: {
            usedPercent: generationPercent,
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null,
          },
          weekly: null,
          updatedAt: BASE_TIME + callCount,
          error: null,
          status: "ok",
        };
      },
    });

    const inFlight = coordinator.fetchAllForTest().then(() => undefined);
    // The switch happens while the old-home fetch is still in flight.
    currentProvenance = "host:home-b";
    const switched = coordinator.refreshForCredentialChange("claude").then(() => undefined);
    // The forced post-switch cycle also passes through the gate; release both.
    releaseFetch?.();
    await Promise.all([inFlight, switched]);

    const claude = coordinator.getState().providers[0]!;
    // The pre-switch generation's 77% never lands on the post-switch bar.
    expect(claude.session?.usedPercent).not.toBe(77);
  });

  it("refreshForCredentialChange clears visible usage immediately", async () => {
    const h = makeHarness({ providers: ["claude"] });
    await h.coordinator.refresh();
    h.setProvenance("claude", "host:new-home");
    const clearing = h.coordinator.refreshForCredentialChange("claude");
    const midState = h.state().claude!;
    expect(midState).not.toBeNull();
    await clearing;
    expect(h.state().claude?.session?.usedPercent).toBe(40);
  });

  it("provenance changes invalidate results captured under the old identity", async () => {
    const h = makeHarness({ providers: ["claude"] });
    h.setProvenance("claude", "host:home-a");
    await h.coordinator.refresh();

    h.setProvenance("claude", "host:home-b");
    h.nowRef.value += MIN_REFETCH_MS + 1;
    await h.coordinator.refreshIfStale();
    const claude = h.state().claude!;
    expect(claude.status === "ok" || claude.status === "fetching").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live-session ingestion
// ---------------------------------------------------------------------------

describe("live-session ingestion", () => {
  it("merges partial updates without clearing the other window", () => {
    const h = makeHarness({ providers: ["claude"] });
    h.coordinator.ingestLiveUpdate("claude", {
      session: { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: null },
    });
    h.coordinator.ingestLiveUpdate("claude", {
      weekly: { usedPercent: 60, windowMinutes: 10_080, resetsAt: null, resetDescription: null },
    });
    const claude = h.state().claude!;
    expect(claude.session?.usedPercent).toBe(20);
    expect(claude.weekly?.usedPercent).toBe(60);
    expect(claude.usageMetadata?.source).toBe("live-session");
  });

  it("deduplicates identical frequent updates", () => {
    const h = makeHarness({ providers: ["claude"] });
    h.coordinator.ingestLiveUpdate("claude", {
      session: { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: null },
    });
    const firstUpdatedAt = h.state().claude!.updatedAt;
    h.coordinator.ingestLiveUpdate("claude", {
      session: { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: null },
    });
    expect(h.state().claude!.updatedAt).toBe(firstUpdatedAt);
  });

  it("fresh live data suppresses redundant automated Claude OAuth polls", async () => {
    const h = makeHarness({ providers: ["claude"] });
    h.coordinator.ingestLiveUpdate("claude", {
      session: { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: null },
    });
    h.resetDispatchCalls();
    await h.coordinator.notifyActivated();
    expect(h.dispatchCalls.filter((c) => c.provider === "claude")).toHaveLength(0);
  });

  it("stale live data older than five minutes lets the poll resume", async () => {
    const h = makeHarness({ providers: ["claude"] });
    h.coordinator.ingestLiveUpdate("claude", {
      session: { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: null },
    });
    h.nowRef.value += MIN_REFETCH_MS + 1;
    await h.coordinator.notifyActivated();
    expect(h.dispatchCalls.filter((c) => c.provider === "claude")).toHaveLength(1);
  });
});
