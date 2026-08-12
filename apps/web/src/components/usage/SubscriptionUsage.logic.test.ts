import { describe, expect, it } from "@effect/vitest";

import {
  formatSubscriptionPercent,
  formatSubscriptionReset,
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
});
