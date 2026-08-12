import { describe, expect, it } from "@effect/vitest";

import {
  applySubscriptionRateLimitsUpdate,
  normalizeClaudeSubscriptionRateLimits,
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

  it("maps Claude fractional utilization and retains model-specific weekly labels", () => {
    expect(
      normalizeClaudeSubscriptionRateLimits({
        rateLimitType: "seven_day_opus",
        utilization: 0.375,
        resetsAt: 1_700_000_000_000,
      }),
    ).toEqual({
      provider: "claude",
      weekly: [
        {
          usedPercent: 37.5,
          resetsAt: "2023-11-14T22:13:20.000Z",
          label: "Opus",
        },
      ],
    });
  });

  it("ignores overage and malformed provider telemetry", () => {
    expect(
      normalizeClaudeSubscriptionRateLimits({
        rateLimitType: "overage",
        utilization: 0.5,
      }),
    ).toBeUndefined();
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
