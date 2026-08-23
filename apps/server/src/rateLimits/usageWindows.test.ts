// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import { describe, expect, it } from "@effect/vitest";

import {
  clampPercent,
  hasUsageData,
  parseRetryAfterMs,
  toUnixMs,
  usageWindow,
  usedFromRemaining,
} from "./usageWindows.ts";

describe("usage window normalization", () => {
  it("clamps usedPercent into 0-100", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(42.456)).toBeCloseTo(42.46);
    expect(clampPercent(Number.NaN)).toBe(0);
  });

  it("converts remaining percentages to consumed ones", () => {
    expect(usedFromRemaining(70)).toBeCloseTo(30);
  });

  it("normalizes Unix seconds to milliseconds", () => {
    expect(toUnixMs(1_900_000_000)).toBe(1_900_000_000_000);
    expect(toUnixMs("1900000000")).toBe(1_900_000_000_000);
    expect(toUnixMs(1_900_000_000_000)).toBe(1_900_000_000_000);
  });

  it("parses ISO timestamps and rejects garbage", () => {
    expect(toUnixMs("2035-01-01T00:00:00Z")).toBe(Date.parse("2035-01-01T00:00:00Z"));
    expect(toUnixMs("not a date")).toBeNull();
    expect(toUnixMs(null)).toBeNull();
  });

  it("builds canonical windows", () => {
    const window = usageWindow({
      usedPercent: 33,
      windowMinutes: 300,
      resetsAt: "2035-01-01T00:00:00Z",
    });
    expect(window.usedPercent).toBeCloseTo(33);
    expect(window.windowMinutes).toBe(300);
    expect(window.resetsAt).toBe(Date.parse("2035-01-01T00:00:00Z"));
    expect(window.resetDescription).not.toBeNull();
  });
});

describe("stale-policy helpers", () => {
  it("detects any visible usage data", () => {
    const empty = { session: null, weekly: null };
    const withBuckets = { ...empty, buckets: [{ name: "Pro" }] };
    expect(hasUsageData(empty)).toBe(false);
    expect(hasUsageData(withBuckets)).toBe(true);
  });
});

describe("Retry-After parsing", () => {
  it("accepts delay-seconds and HTTP-date forms", () => {
    const now = Date.now();
    expect(parseRetryAfterMs("120")).toBe(120_000);
    expect(parseRetryAfterMs(new Date(now + 60_000).toUTCString())).toBeGreaterThan(50_000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("junk")).toBeNull();
    expect(parseRetryAfterMs("-5")).toBeNull();
  });

  it("caps values at 24 hours", () => {
    expect(parseRetryAfterMs("999999")).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});
