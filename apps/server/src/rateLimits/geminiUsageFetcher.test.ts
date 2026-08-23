// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import { describe, expect, it } from "@effect/vitest";

import {
  buildQuotaBucket,
  deduplicateBuckets,
  deriveSessionSummary,
  fetchAntigravityRateLimits,
  loadGeminiProjectId,
  readGeminiCredentials,
  refreshGeminiAccessToken,
  saveGeminiCredentials,
} from "./geminiUsageFetcher.ts";
import { deriveAntigravityRateLimits } from "./antigravityUsageMirror.ts";

const VALID_CREDS = JSON.stringify({
  access_token: "at-old",
  refresh_token: "rt",
  expiry_date: Date.parse("2020-01-01T00:00:00Z"), // long expired
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function okFetch(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let call = 0;
  return (async () => {
    const response = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    return jsonResponse(response.status, response.body);
  }) as unknown as typeof fetch;
}

describe("quota bucket formatting", () => {
  it("converts remainingFraction into consumed percent", () => {
    const bucket = buildQuotaBucket({
      remainingFraction: 0.25,
      resetTime: "2035-01-01T00:00:00Z",
      modelId: "gemini-2.5-pro",
    });
    expect(bucket.usedPercent).toBe(75);
    expect(bucket.name).toBe("Pro");
    expect(bucket.resetsAt).not.toBeNull();
  });

  it("deduplicates equivalent buckets preferring known model names", () => {
    const deduped = deduplicateBuckets([
      buildQuotaBucket({
        remainingFraction: 0.5,
        resetTime: "2035-01-01T00:00:00Z",
        modelId: "unknown-model",
      }),
      buildQuotaBucket({
        remainingFraction: 0.5,
        resetTime: "2035-01-01T00:00:00Z",
        modelId: "gemini-2.5-flash",
      }),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.name).toBe("Flash");
  });

  it("derives the session summary from the most-consumed bucket", () => {
    const summary = deriveSessionSummary([
      { name: "Flash", usedPercent: 10, windowMinutes: 60, resetsAt: null, resetDescription: null },
      { name: "Pro", usedPercent: 80, windowMinutes: 60, resetsAt: null, resetDescription: null },
    ]);
    expect(summary?.usedPercent).toBe(80);
  });
});

describe("credential persistence", () => {
  it("persists refreshed credentials atomically (temp write + rename)", async () => {
    const writes: string[] = [];
    let renamedTo: string | null = null;
    await saveGeminiCredentials(
      { access_token: "a", refresh_token: "r", expiry_date: 1 },
      async (p, data) => {
        writes.push(p);
        expect(data).toContain('"access_token": "a"');
      },
      async (from, to) => {
        expect(writes).toContain(from); // temp file written BEFORE rename
        renamedTo = to;
      },
      "/home/tester",
    );
    expect(writes[0]).toContain(".tmp");
    expect(renamedTo).toContain("oauth_creds.json");
  });

  it("returns null when the credentials file is missing and throws otherwise", async () => {
    const missing = await readGeminiCredentials(async () => {
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    });
    expect(missing).toBeNull();
    await expect(
      readGeminiCredentials(async () => {
        throw new Error("EACCES");
      }),
    ).rejects.toThrow("EACCES");
  });
});

describe("antigravity quota fetch", () => {
  it("is unavailable while the opt-in is disabled", async () => {
    const result = await fetchAntigravityRateLimits({
      platform: "linux",
      geminiCliOauthEnabled: false,
    });
    expect(result.status).toBe("unavailable");
    expect(result.error).toContain("disabled");
  });

  it("reports missing credentials as unavailable without touching the network", async () => {
    let fetchCalled = false;
    const result = await fetchAntigravityRateLimits({
      platform: "linux",
      geminiCliOauthEnabled: true,
      readText: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      fetchImpl: (async () => {
        fetchCalled = true;
        throw new Error("should not be called");
      }) as unknown as typeof fetch,
    });
    expect(fetchCalled).toBe(false);
    expect(result.status).toBe("unavailable");
  });

  it("refreshes expired tokens via the Google token endpoint and persists them", async () => {
    const urls: string[] = [];
    const fetchImpl = ((url: string | URL) => {
      urls.push(String(url));
      if (String(url) === "https://oauth2.googleapis.com/token") {
        return jsonResponse(200, { access_token: "at-new", expires_in: 3600 });
      }
      if (String(url).includes("loadCodeAssist")) {
        return jsonResponse(200, { cloudaicompanionProject: "proj-1" });
      }
      return jsonResponse(200, {
        buckets: [
          { remainingFraction: 0.9, resetTime: "2035-01-01T00:00:00Z", modelId: "gemini-2.5-pro" },
        ],
      });
    }) as unknown as typeof fetch;

    const saved: string[] = [];
    const result = await fetchAntigravityRateLimits({
      platform: "linux",
      geminiCliOauthEnabled: true,
      readText: async () => VALID_CREDS,
      writeText: async (_path, data) => {
        saved.push(data);
      },
      renameFile: async () => {},
      extractClientCredentials: async () => ({ clientId: "id", clientSecret: "secret" }),
      fetchImpl,
    });
    expect(urls.some((u) => u.includes("oauth2.googleapis.com/token"))).toBe(true);
    expect(saved.join("\n")).toContain("at-new");
    expect(result.status).toBe("ok");
    expect(result.session?.usedPercent).toBe(10);
    expect(result.provider).toBe("antigravity");
    void loadGeminiProjectId;
    void refreshGeminiAccessToken;
  });

  it("performs exactly one refresh-and-retry on a 401 quota response", async () => {
    let quotaCalls = 0;
    const fetchImpl = ((url: string | URL) => {
      const urlText = String(url);
      if (urlText.includes("retrieveUserQuota")) {
        quotaCalls += 1;
        // First attempt 401; after refresh, still 401 → no infinite loop.
        return jsonResponse(401, {});
      }
      if (urlText === "https://oauth2.googleapis.com/token") {
        return jsonResponse(200, { access_token: "at-new" });
      }
      return jsonResponse(200, { cloudaicompanionProject: "proj-1" });
    }) as unknown as typeof fetch;

    const result = await fetchAntigravityRateLimits({
      platform: "linux",
      geminiCliOauthEnabled: true,
      readText: async () => VALID_CREDS,
      writeText: async () => {},
      renameFile: async () => {},
      extractClientCredentials: async () => ({ clientId: "id", clientSecret: "secret" }),
      fetchImpl,
    });
    expect(quotaCalls).toBe(2);
    expect(result.status).toBe("error");
  });

  it("surfaces malformed quota payloads as errors", async () => {
    const result = await fetchAntigravityRateLimits({
      platform: "linux",
      geminiCliOauthEnabled: true,
      readText: async () =>
        JSON.stringify({
          access_token: "a",
          refresh_token: "r",
          expiry_date: Date.now() + 3_600_000,
        }),
      extractClientCredentials: async () => null,
      fetchImpl: okFetch([
        { status: 200, body: { cloudaicompanionProject: "proj" } },
        { status: 200, body: { buckets: [{ nonsense: true }] } },
      ]),
    });
    expect(result.status).toBe("error");
    expect(result.error).toContain("no usable buckets");
  });
});

describe("antigravity mirror", () => {
  it("mirrors successful quota reads unchanged", () => {
    const geminiOk = {
      provider: "antigravity" as const,
      session: { usedPercent: 12, windowMinutes: 60, resetsAt: 1, resetDescription: null },
      weekly: null,
      updatedAt: 1234,
      error: null,
      status: "ok" as const,
    };
    const mirrored = deriveAntigravityRateLimits(geminiOk);
    expect(mirrored).toBe(geminiOk);
  });

  it("never claims an Antigravity request failed when the shared quota was unreadable", () => {
    const failed = deriveAntigravityRateLimits({
      provider: "antigravity",
      session: null,
      weekly: null,
      updatedAt: 1234,
      error: "Quota fetch failed (500)",
      status: "error",
    });
    expect(failed.status).toBe("unavailable");
    expect(failed.error).toContain("could not be read");
    expect(failed.updatedAt).toBe(1234); // inherited so freshness loops stay aligned
  });

  it("maps disabled/absent sources to an explanatory unavailability", () => {
    const off = deriveAntigravityRateLimits({
      provider: "antigravity",
      session: null,
      weekly: null,
      updatedAt: 1234,
      error: "disabled in settings",
      status: "unavailable",
    });
    expect(off.status).toBe("unavailable");
    expect(off.error).toContain("Gemini CLI sign-in");
  });
});
