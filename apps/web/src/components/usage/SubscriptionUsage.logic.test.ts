import { describe, expect, it } from "@effect/vitest";

import {
  formatSubscriptionPercent,
  formatSubscriptionReset,
  formatSubscriptionUpdatedAt,
  subscriptionWindowLabel,
} from "./SubscriptionUsage.logic";

describe("subscription usage formatting", () => {
  it("formats provider-reported usage as a compact percentage", () => {
    expect(formatSubscriptionPercent(37.5)).toBe("38%");
  });

  it("handles absent and malformed reset times", () => {
    expect(formatSubscriptionReset(null)).toBeNull();
    expect(formatSubscriptionReset("not-a-date")).toBeNull();
  });

  it("names Claude's model-specific weekly window", () => {
    expect(subscriptionWindowLabel("fiveHour")).toBe("5-hour");
    expect(
      subscriptionWindowLabel("weekly", { label: "Opus", usedPercent: 10, resetsAt: null }),
    ).toBe("Weekly · Opus");
  });

  it("labels a snapshot as stale once it stops tracking the account", () => {
    const now = Date.parse("2026-08-16T12:00:00.000Z");
    expect(formatSubscriptionUpdatedAt(null, now)).toBeNull();
    expect(formatSubscriptionUpdatedAt("not-a-date", now)).toBeNull();
    expect(formatSubscriptionUpdatedAt("2026-08-16T11:59:40.000Z", now)).toEqual({
      text: "Updated just now",
      isStale: false,
    });
    expect(formatSubscriptionUpdatedAt("2026-08-16T11:31:00.000Z", now)).toEqual({
      text: "Updated 29m ago",
      isStale: false,
    });
    expect(formatSubscriptionUpdatedAt("2026-08-16T09:00:00.000Z", now)).toEqual({
      text: "Updated 3h ago",
      isStale: true,
    });
    expect(formatSubscriptionUpdatedAt("2026-08-14T09:00:00.000Z", now)).toEqual({
      text: "Updated 2d ago",
      isStale: true,
    });
  });
});
