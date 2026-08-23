// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  classifyCodexRateLimitWindows,
  CODEX_SESSION_WINDOW_MINUTES,
  CODEX_WEEKLY_WINDOW_MINUTES,
} from "./codexWindowClassification.ts";
import { mapResetCredits, parsePtyStatusOutput, stripPtyControlSequences } from "./codexFetcher.ts";
import { probeCodexAuthPresence } from "./codexAuthPresence.ts";
import {
  withCodexHomeProcessLock,
  resolveCodexHomeProcessLockKey,
} from "./codexHomeProcessLock.ts";

describe("Codex window classification", () => {
  it("classifies by reported duration, not field order", () => {
    const classified = classifyCodexRateLimitWindows({
      primary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: 1_900_000_000 },
      secondary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_900_000_100 },
    });
    expect(classified.session?.usedPercent).toBe(20);
    expect(classified.weekly?.usedPercent).toBe(10);
  });

  it("tolerates the one-minute drift of older builds", () => {
    const classified = classifyCodexRateLimitWindows({
      primary: { usedPercent: 5, windowDurationMins: 299 },
      secondary: { usedPercent: 6, windowDurationMins: 10_081 },
    });
    expect(classified.session?.usedPercent).toBe(5);
    expect(classified.weekly?.usedPercent).toBe(6);
  });

  it("keeps the legacy mapping for unknown durations", () => {
    const classified = classifyCodexRateLimitWindows({
      primary: { usedPercent: 1 },
      secondary: { usedPercent: 2 },
    });
    expect(classified.session?.usedPercent).toBe(1);
    expect(classified.weekly?.usedPercent).toBe(2);
  });
});

describe("reset credit normalization", () => {
  it("normalizes seconds and milliseconds timestamps", () => {
    const credits = mapResetCredits({
      availableCount: 2,
      totalEarnedCount: 3,
      nextExpiresAt: 1_900_000_000,
      credits: [
        { status: "Available", expiresAt: 1_900_000_000, grantedAt: "2030-01-01T00:00:00Z" },
      ],
    });
    expect(credits?.availableCount).toBe(2);
    expect(credits?.credits?.[0]?.status).toBe("available");
    expect(credits?.credits?.[0]?.expiresAt).toBe(1_900_000_000_000);
    expect(credits?.nextExpiresAt).toBe(1_900_000_000_000);
  });

  it("derives next expiry from available credits when absent", () => {
    const credits = mapResetCredits({
      credits: [
        { status: "available", expiresAt: 1_900_000_001_000 },
        { status: "redeemed", expiresAt: 1_800_000_000_000 },
      ],
    });
    expect(credits?.nextExpiresAt).toBe(1_900_000_001_000);
  });

  it("returns null for unusable payloads", () => {
    expect(mapResetCredits({})).toBeNull();
    expect(mapResetCredits(null)).toBeNull();
    expect(mapResetCredits(undefined)).toBeUndefined();
  });
});

describe("PTY /status parsing", () => {
  it("parses '% used' rows", () => {
    const parsed = parsePtyStatusOutput(
      `${stripPtyControlSequences("\x1b[1m> Status\x1b[0m")}\n5h limit: 42% used\nWeekly limit: [██░] 7% left`,
    );
    expect(parsed.session?.usedPercent).toBe(42);
    expect(parsed.session?.windowMinutes).toBe(CODEX_SESSION_WINDOW_MINUTES);
    expect(parsed.weekly?.usedPercent).toBe(93); // 7% left → 93% used
    expect(parsed.weekly?.windowMinutes).toBe(CODEX_WEEKLY_WINDOW_MINUTES);
  });

  it("ignores model-scoped limit rows as account-wide limits", () => {
    const parsed = parsePtyStatusOutput("GPT-5-Spark Weekly limit 90% used\n5h limit: 12% used");
    // The lookbehind rejects model-scoped weekly rows.
    expect(parsed.session?.usedPercent).toBe(12);
    expect(parsed.weekly).toBeNull();
  });
});

describe("auth presence gating", () => {
  it("reports absent when no auth file exists", async () => {
    const presence = await probeCodexAuthPresence(
      NodePath.join(NodeOS.tmpdir(), "t3-nonexistent-codex-home"),
    );
    expect(presence).toBe("absent");
  });

  it("reports present when auth.json exists", async () => {
    const dir = NodeOS.tmpdir();
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(NodePath.join(dir, "auth.json"), "{}", "utf-8");
    const presence = await probeCodexAuthPresence(dir);
    expect(presence).toBe("present");
  });

  it("honors an explicit signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const presence = await probeCodexAuthPresence(undefined, { signal: controller.signal });
    expect(["timeout", "unavailable"]).toContain(presence);
  });
});

describe("per-home process lock", () => {
  it("serializes operations for the same home but not across homes", async () => {
    const order: string[] = [];
    const keyA = resolveCodexHomeProcessLockKey("/home/a/.codex");
    const keyB = resolveCodexHomeProcessLockKey("/home/b/.codex");
    const release = new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    const first = withCodexHomeProcessLock(keyA, async () => {
      await release;
      order.push("a-done");
    });
    void withCodexHomeProcessLock(keyA, async () => {
      order.push("a-second");
    });
    void withCodexHomeProcessLock(keyB, async () => {
      order.push("b-immediate");
    });
    await first;
    expect(order[0]).toBe("b-immediate");
    expect(order).toContain("a-second");
    expect(order.indexOf("a-second")).toBeGreaterThan(order.indexOf("a-done"));
  });

  it("keys different casings of the same Windows home identically", () => {
    expect(resolveCodexHomeProcessLockKey("C:\\Users\\X\\.codex")).toBe(
      resolveCodexHomeProcessLockKey("c:\\users\\x\\.codex"),
    );
  });
});
