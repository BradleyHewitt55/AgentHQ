import { describe, expect, it } from "@effect/vitest";

import {
  applySubscriptionRateLimitsUpdate,
  normalizeClaudeUsageSnapshot,
  normalizeCodexSubscriptionRateLimits,
  unavailableSubscriptionUsage,
} from "./SubscriptionRateLimits.ts";

describe("subscription rate-limit normalization", () => {
  it("maps Codex's five-hour and weekly snapshot windows", () => {
    expect(
      normalizeCodexSubscriptionRateLimits({
        primary: { usedPercent: 24, resetsAt: 1_700_000_000, windowDurationMins: 300 },
        secondary: { usedPercent: 62, resetsAt: 1_700_604_800, windowDurationMins: 10_080 },
      }),
    ).toEqual({
      provider: "codex",
      fiveHour: {
        usedPercent: 24,
        resetsAt: "2023-11-14T22:13:20.000Z",
      },
      weekly: [
        {
          usedPercent: 62,
          resetsAt: "2023-11-21T22:13:20.000Z",
        },
      ],
    });
  });

  it("classifies Codex's single reported window by duration, not by slot", () => {
    // Real Plus-plan payload: the only window Codex sends lands in `primary`
    // even though it is the seven-day one, and `secondary` is always null.
    expect(
      normalizeCodexSubscriptionRateLimits({
        primary: { usedPercent: 48, resetsAt: 1_787_245_913, windowDurationMins: 10_080 },
        secondary: null,
      }),
    ).toEqual({
      provider: "codex",
      weekly: [{ usedPercent: 48, resetsAt: "2026-08-20T17:11:53.000Z" }],
    });
  });

  it("maps every Claude usage window, including model-specific weekly limits", () => {
    expect(
      normalizeClaudeUsageSnapshot({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 12.5, resets_at: "2026-08-16T23:30:00.000Z" },
          seven_day: { utilization: 41, resets_at: "2026-08-20T17:11:53.000Z" },
          seven_day_opus: { utilization: 3, resets_at: "2026-08-20T17:11:53.000Z" },
        },
      }),
    ).toEqual({
      provider: "claude",
      fiveHour: { usedPercent: 12.5, resetsAt: "2026-08-16T23:30:00.000Z" },
      weekly: [
        { usedPercent: 41, resetsAt: "2026-08-20T17:11:53.000Z" },
        { usedPercent: 3, resetsAt: "2026-08-20T17:11:53.000Z", label: "Opus" },
      ],
    });
  });

  it("reads Claude utilization as a 0-100 percentage, not a fraction", () => {
    expect(
      normalizeClaudeUsageSnapshot({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 0.8, resets_at: null } },
      }),
    ).toEqual({
      provider: "claude",
      fiveHour: { usedPercent: 0.8, resetsAt: null },
    });
  });

  it("ignores Claude sessions where plan limits do not apply", () => {
    expect(
      normalizeClaudeUsageSnapshot({ rate_limits_available: false, rate_limits: null }),
    ).toBeUndefined();
    expect(normalizeClaudeUsageSnapshot({ rate_limits_available: true })).toBeUndefined();
    expect(
      normalizeClaudeUsageSnapshot({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: null, resets_at: null } },
      }),
    ).toBeUndefined();
  });

  it("ignores malformed provider telemetry", () => {
    expect(
      normalizeCodexSubscriptionRateLimits({
        primary: { usedPercent: Number.NaN },
      }),
    ).toBeUndefined();
  });

  it("merges sparse updates without losing another weekly window", () => {
    const initial = unavailableSubscriptionUsage("claude");
    const opus = applySubscriptionRateLimitsUpdate(
      initial,
      {
        provider: "claude",
        weekly: [{ label: "Opus", usedPercent: 20, resetsAt: null }],
      },
      "2026-02-24T12:00:00.000Z",
    );
    const sonnet = applySubscriptionRateLimitsUpdate(
      opus,
      {
        provider: "claude",
        weekly: [{ label: "Sonnet", usedPercent: 30, resetsAt: null }],
      },
      "2026-02-24T12:01:00.000Z",
    );

    expect(sonnet).toMatchObject({
      status: "available",
      weekly: [
        { label: "Opus", usedPercent: 20 },
        { label: "Sonnet", usedPercent: 30 },
      ],
    });
  });
});
