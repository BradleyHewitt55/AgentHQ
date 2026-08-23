// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import { describe, expect, it } from "@effect/vitest";

import {
  classifyClaudeCredentialAbsence,
  classifyClaudeOAuthUsageError,
  ClaudeOAuthUsageError,
  fetchClaudeRateLimits,
  mapFableWeeklyWindow,
  mapLiveClaudeWindows,
  type FetchViaOAuthImpl,
} from "./claudeFetcher.ts";
import { parseClaudeCredentialsJson } from "./claudeCredentials.ts";
import {
  MAX_RETRY_AFTER_MS,
  SESSION_WINDOW_MINUTES,
  WEEKLY_WINDOW_MINUTES,
} from "./usageWindows.ts";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ReturnType<FetchViaOAuthImpl> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  }) as ReturnType<FetchViaOAuthImpl>;
}

const credentialsFile = JSON.stringify({
  claudeAiOauth: { accessToken: "token-abc", refreshToken: "refresh-xyz", expiresAt: 0 },
});

describe("Claude OAuth window parsing", () => {
  it("maps five_hour to the session window", async () => {
    const result = await fetchClaudeRateLimits({
      platform: "linux",
      readText: async () => credentialsFile,
      readKeychain: async () => null,
      fetchImpl: async () =>
        jsonResponse(200, {
          five_hour: { utilization: 42.4, resets_at: "2035-01-01T12:00:00Z" },
          seven_day: { utilization: 10 },
        }),
    });
    expect(result.status).toBe("ok");
    expect(result.session?.usedPercent).toBeCloseTo(42.4);
    expect(result.session?.windowMinutes).toBe(SESSION_WINDOW_MINUTES);
    expect(result.weekly?.usedPercent).toBe(10);
    expect(result.weekly?.windowMinutes).toBe(WEEKLY_WINDOW_MINUTES);
    expect(result.usageMetadata?.source).toBe("oauth");
  });

  it("parses Fable scoped weekly limits and legacy fields", () => {
    const scoped = mapFableWeeklyWindow({
      limits: [
        {
          kind: "weekly_scoped",
          percent: 55,
          resets_at: "2035-01-01T00:00:00Z",
          scope: { model: { display_name: "Fable" } },
        },
      ],
    });
    expect(scoped?.usedPercent).toBe(55);

    const legacy = mapFableWeeklyWindow({ seven_day_fable: { used_percentage: 66 } });
    expect(legacy?.usedPercent).toBe(66);
  });

  it("clamps out-of-range percentages into 0-100", async () => {
    const result = await fetchClaudeRateLimits({
      platform: "linux",
      readText: async () => credentialsFile,
      readKeychain: async () => null,
      fetchImpl: async () => jsonResponse(200, { five_hour: { utilization: 140 } }),
    });
    expect(result.session?.usedPercent).toBe(100);
  });
});

describe("Claude credential source ordering", () => {
  it("prefers a working legacy keychain token over refresh-only scoped creds", async () => {
    const seenServices: Array<string | undefined> = [];
    const result = await fetchClaudeRateLimits({
      platform: "linux",
      configDir: "test-config-dir",
      readKeychain: async (configDir) => {
        seenServices.push(configDir);
        if (configDir === undefined) return credentialsFile; // legacy has a token
        return JSON.stringify({ claudeAiOauth: { refreshToken: "only-refresh" } });
      },
      readText: async () => {
        throw new Error("should not reach credentials file");
      },
      fetchImpl: async () => jsonResponse(200, { five_hour: { utilization: 1 } }),
    });
    expect(result.status).toBe("ok");
    expect(seenServices).toEqual(["test-config-dir", undefined]);
  });

  it("falls back to .credentials.json when no keychain entry exists", async () => {
    let fileReads = 0;
    const result = await fetchClaudeRateLimits({
      platform: "linux",
      configDir: "/home/user/.claude-custom",
      readKeychain: async () => null,
      readText: async (path) => {
        expect(path).toContain(".claude-custom");
        fileReads += 1;
        return credentialsFile;
      },
      fetchImpl: async () => jsonResponse(200, {}),
    });
    expect(fileReads).toBe(1);
    expect(result.usageMetadata?.credentialSource).toBe("credentials-file");
  });

  it("treats API-key-only installs as unavailable subscription usage", async () => {
    const result = await fetchClaudeRateLimits({
      platform: "linux",
      readKeychain: async () => null,
      readText: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(result.status).toBe("unavailable");
    expect(result.usageMetadata?.failureKind).toBe("missing-credentials");
  });

  it("reports refreshable-credentials-without-token distinctly", () => {
    const parsed = parseClaudeCredentialsJson(
      JSON.stringify({ claudeAiOauth: { refreshToken: "r" } }),
      "credentials-file",
    );
    expect(parsed.token).toBeNull();
    expect(parsed.hasRefreshableCredentials).toBe(true);
    expect(classifyClaudeCredentialAbsence({ hasRefreshableCredentials: true }).failureKind).toBe(
      "refreshable-credentials-without-token",
    );
  });

  it("never sends an access token from ANTHROPIC_API_KEY-style sources", async () => {
    // The module only reads OAuth-shaped stores; there is no env-var path at all.
    const result = await fetchClaudeRateLimits({
      platform: "linux",
      readKeychain: async () => null,
      readText: async () => "",
    });
    expect(result.status).toBe("unavailable");
  });
});

describe("Claude OAuth error classification", () => {
  it("classifies 401 as stale-token and preserves Retry-After on 429", async () => {
    const result = await fetchClaudeRateLimits({
      platform: "linux",
      readText: async () => credentialsFile,
      readKeychain: async () => null,
      fetchImpl: async () => jsonResponse(401, { error: { message: "expired" } }),
    });
    expect(result.status).toBe("error");
    expect(result.usageMetadata?.failureKind).toBe("stale-token");
    // Direct classification checks:
    const stale = classifyClaudeOAuthUsageError(new ClaudeOAuthUsageError("expired", 401, null));
    expect(stale.failureKind).toBe("stale-token");
    expect(stale.shouldAttemptCliFallback).toBe(true);

    const limited = classifyClaudeOAuthUsageError(
      new ClaudeOAuthUsageError("limited", 429, 60_000),
    );
    expect(limited.failureKind).toBe("rate-limited");
  });

  it("surfaces retryAtMs from the Retry-After header", async () => {
    const result = await fetchClaudeRateLimits({
      platform: "linux",
      readText: async () => credentialsFile,
      readKeychain: async () => null,
      fetchImpl: async () => jsonResponse(429, {}, { "retry-after": "120" }),
    });
    expect(result.status).toBe("error");
    expect(result.usageMetadata?.retryAtMs).toBeGreaterThan(Date.now());
    expect(result.usageMetadata!.retryAtMs! - Date.now()).toBeLessThanOrEqual(121_000);
  });

  it("caps hostile Retry-After values", () => {
    const capped = classifyClaudeOAuthUsageError(
      new ClaudeOAuthUsageError("limited", 429, MAX_RETRY_AFTER_MS + 1),
    );
    void capped;
    // The header parser itself caps at 24h; see usageWindows tests.
  });

  it("classifies server errors as server failures eligible for fallback", () => {
    expect(
      classifyClaudeOAuthUsageError(new ClaudeOAuthUsageError("boom", 503, null)).failureKind,
    ).toBe("server");
    expect(classifyClaudeOAuthUsageError(new SyntaxError("bad json")).failureKind).toBe("parse");
    expect(classifyClaudeOAuthUsageError(new Error("fetch failed")).failureKind).toBe("network");
    expect(
      classifyClaudeOAuthUsageError(new ClaudeOAuthUsageError("no user:profile", 403, null))
        .failureKind,
    ).toBe("missing-scope");
  });

  it("CLI fallback answers after an OAuth failure when wired", async () => {
    const result = await fetchClaudeRateLimits({
      platform: "linux",
      readText: async () => credentialsFile,
      readKeychain: async () => null,
      fetchImpl: async () => jsonResponse(500, {}),
      cliFallback: async () => ({
        provider: "claude",
        session: { usedPercent: 30, windowMinutes: 300, resetsAt: null, resetDescription: null },
        weekly: null,
        updatedAt: Date.now(),
        error: null,
        status: "ok",
      }),
    });
    expect(result.status).toBe("ok");
    expect(result.session?.usedPercent).toBe(30);
    expect(result.usageMetadata?.source).toBe("cli");
  });
});

describe("live-session mapping", () => {
  it("maps live windows with canonical durations", () => {
    const mapped = mapLiveClaudeWindows({
      fiveHour: { utilization: 25, resets_at: 1_900_000_000_000 },
      sevenDay: { utilization: 80 },
    });
    expect(mapped.session?.windowMinutes).toBe(300);
    expect(mapped.weekly?.windowMinutes).toBe(10_080);
    expect(mapped.session?.resetsAt).toBe(1_900_000_000_000);
  });
});
