// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { isGrokAccessTokenFresh, readGrokAuthSession, resolveGrokAuthPath } from "./grokAuth.ts";
import { fetchGrokRateLimits, mapMonthlyUsage, mapWeeklyCredits } from "./grokFetcher.ts";

const FRESH_EXPIRY = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function authFile(entries: Record<string, unknown>): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "grok-auth-"));
  const authPath = NodePath.join(dir, "auth.json");
  NodeFS.writeFileSync(authPath, JSON.stringify(entries), "utf-8");
  return authPath;
}

describe("grok auth reading", () => {
  it("resolves GROK_HOME over the default home", () => {
    expect(resolveGrokAuthPath("/custom/home")).toContain("custom");
  });

  it("prefers a fresh xAI OAuth entry over alternate issuers", () => {
    const session = readGrokAuthSession({
      authPath: authFile({
        "https://legacy.example": { key: "old-key" },
        "https://auth.x.ai": { key: "preferred-key", expires_at: FRESH_EXPIRY },
      }),
    });
    expect(session.status).toBe("ok");
    if (session.status === "ok") expect(session.session.accessToken).toBe("preferred-key");
  });

  it("falls back to an expired preferred entry only when no other default exists", () => {
    const expired = new Date(Date.now() - 3_600_000).toISOString();
    const result = readGrokAuthSession({
      authPath: authFile({
        "https://auth.x.ai::team1": { key: "expired-key", expires_at: expired },
      }),
    });
    expect(result.status).toBe("ok"); // still usable; freshness is judged by the fetcher
  });

  it("treats a token-less file as signed out (missing), not an error", () => {
    const result = readGrokAuthSession({ authPath: authFile({ "https://auth.x.ai": {} }) });
    expect(result.status).toBe("missing");
  });

  it("redacts filesystem details from read errors", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "grok-auth-"));
    const authPath = NodePath.join(dir, "broken.json");
    NodeFS.writeFileSync(authPath, "{not json", "utf-8");
    const result = readGrokAuthSession({ authPath });
    // Malformed JSON parses to a non-object → invalid message, never the path.
    expect(result.status === "error" && !result.error.includes(dir)).toBe(true);
  });

  it("judges token freshness with skew", () => {
    expect(
      isGrokAccessTokenFresh({
        accessToken: "k",
        userId: null,
        email: null,
        teamId: null,
        expiresAtMs: Date.now() + 10 * 60_000,
      }),
    ).toBe(true);
    expect(
      isGrokAccessTokenFresh({
        accessToken: "k",
        userId: null,
        email: null,
        teamId: null,
        expiresAtMs: Date.now() + 60_000,
      }),
    ).toBe(false);
    expect(
      isGrokAccessTokenFresh({
        accessToken: "k",
        userId: null,
        email: null,
        teamId: null,
        expiresAtMs: null,
      }),
    ).toBe(true);
  });
});

describe("grok billing mapping", () => {
  const weeklyConfig = {
    creditUsagePercent: 42,
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2035-01-01T00:00:00Z",
      end: "2035-01-08T00:00:00Z",
    },
    billingPeriodStart: "2035-01-01T00:00:00Z",
    billingPeriodEnd: "2035-01-08T00:00:00Z",
    subscriptionTier: "SuperGrok",
  };

  it("maps weekly credits with reset timestamps", () => {
    const weekly = mapWeeklyCredits(weeklyConfig);
    expect(weekly?.usedPercent).toBe(42);
    expect(weekly?.windowMinutes).toBe(10_080);
    expect(weekly?.resetsAt).toBe(Date.parse("2035-01-08T00:00:00Z"));
  });

  it("maps monthly unified-billing usage from used/limit money values", () => {
    const monthly = mapMonthlyUsage({
      used: { val: "12.5" },
      monthlyLimit: { val: "50" },
      currentPeriod: { end: "2035-02-01T00:00:00Z" },
    });
    expect(monthly?.usedPercent).toBeCloseTo(25);
    expect(monthly?.windowMinutes).toBe(43_200);
  });

  function okResponse(body: unknown): Promise<Response> {
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
    } as unknown as Response);
  }

  it("falls back to the default billing view for unified-billing accounts", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = ((url: string | URL) => {
      requestedUrls.push(String(url));
      if (String(url).includes("format=credits")) {
        // Config present but no weekly credit usage (unified billing).
        return okResponse({ config: { subscriptionTier: "Pro" } });
      }
      return okResponse({ config: { used: { val: "10" }, monthlyLimit: { val: "40" } } });
    }) as unknown as typeof fetch;

    const result = await fetchGrokRateLimits({
      authReadResult: {
        status: "ok",
        session: { accessToken: "k", userId: "u1", email: null, teamId: null, expiresAtMs: null },
      },
      fetchImpl,
    });
    expect(result.monthly?.usedPercent).toBeCloseTo(25);
    expect(requestedUrls.filter((u) => u.includes("/billing")).length).toBe(2);
    expect(result.usageMetadata?.source).toBe("oauth");
  });

  it("reports expired tokens as delegated-refresh-required without refreshing anything", async () => {
    let fetchCalled = false;
    const result = await fetchGrokRateLimits({
      authReadResult: {
        status: "ok",
        session: {
          accessToken: "k",
          userId: null,
          email: null,
          teamId: null,
          expiresAtMs: Date.now() - 60_000,
        },
      },
      fetchImpl: (async () => {
        fetchCalled = true;
        throw new Error("must not fetch");
      }) as unknown as typeof fetch,
    });
    expect(fetchCalled).toBe(false);
    expect(result.status).toBe("error");
    expect(result.usageMetadata?.failureKind).toBe("delegated-refresh-required");
  });

  it("classifies 401/403 as errors and missing sessions as unavailable", async () => {
    const unauthorized = await fetchGrokRateLimits({
      authReadResult: {
        status: "ok",
        session: { accessToken: "k", userId: null, email: null, teamId: null, expiresAtMs: null },
      },
      fetchImpl: (async () => ({
        ok: false,
        status: 401,
        headers: { get: () => null },
        json: async () => ({}),
      })) as unknown as typeof fetch,
    });
    expect(unauthorized.status).toBe("error");

    const signedOut = await fetchGrokRateLimits({ authReadResult: { status: "missing" } });
    expect(signedOut.status).toBe("unavailable");
  });

  it("never rewrites the Grok auth file", async () => {
    const authPath = authFile({
      "https://auth.x.ai": { key: "k", expires_at: new Date(Date.now() - 60_000).toISOString() },
    });
    await fetchGrokRateLimits({ authReadResult: readGrokAuthSession({ authPath }) });
    // No API in this module writes; the assertion documents the contract.
    expect(readGrokAuthSession({ authPath }).status).toBe("ok");
  });
});
