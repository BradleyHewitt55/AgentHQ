import { describe, expect, it } from "@effect/vitest";
import type { ProviderUsageLimits } from "@t3tools/contracts";

import {
  formatUsagePercent,
  formatUsageReset,
  formatUsageUpdatedAt,
  primaryPillWindow,
  usageLimitProviderLabel,
} from "./usageLimitsProviders";

function limits(
  provider: ProviderUsageLimits["provider"],
  windows: Partial<ProviderUsageLimits>,
): ProviderUsageLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: "ok",
    ...windows,
  };
}

describe("usage limit presentation", () => {
  it("labels every provider without falling back to generic text", () => {
    for (const provider of [
      "claude",
      "codex",
      "antigravity",
      "grok",
      "cursor",
      "opencode",
      "pi",
    ] as const) {
      expect(usageLimitProviderLabel(provider).length).toBeGreaterThan(0);
    }
    expect(usageLimitProviderLabel("codex")).toBe("ChatGPT / Codex");
  });

  it("formats percent and reset timestamps", () => {
    expect(formatUsagePercent(41.6)).toBe("42%");
    expect(formatUsageReset(Date.parse("2035-01-05T14:30:00Z"))).toMatch(/^Resets/);
    expect(formatUsageReset(null)).toBeNull();
  });

  it("dates stale snapshots", () => {
    const now = Date.now();
    expect(formatUsageUpdatedAt(now - 10_000, now)?.text).toBe("Updated just now");
    const stale = formatUsageUpdatedAt(now - 45 * 60 * 1000, now);
    expect(stale?.isStale).toBe(true);
    expect(formatUsageUpdatedAt(0, now)).toBeNull();
  });

  it("picks the provider-preferred pill window", () => {
    const claude = limits("claude", {
      session: { usedPercent: 10, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: { usedPercent: 90, windowMinutes: 10_080, resetsAt: null, resetDescription: null },
    });
    expect(primaryPillWindow(claude)?.usedPercent).toBe(10);

    const codex = limits("codex", {
      session: { usedPercent: 10, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: { usedPercent: 90, windowMinutes: 10_080, resetsAt: null, resetDescription: null },
    });
    expect(primaryPillWindow(codex)?.usedPercent).toBe(90);

    const monthlyOnly = limits("grok", {
      monthly: { usedPercent: 25, windowMinutes: 43_200, resetsAt: null, resetDescription: null },
    });
    expect(primaryPillWindow(monthlyOnly)?.usedPercent).toBe(25);
  });
});
