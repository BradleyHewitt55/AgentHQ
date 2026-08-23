// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics no-global-process-runtime:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalFetch:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { ProviderUsageLimits, UsageLimitBucket, UsageLimitWindow } from "@t3tools/contracts";

/**
 * Google Code Assist (Gemini) quota.
 *
 * Unlike the CLIs, Gemini CLI does not own a long-lived token refresher, so
 * this is the one provider whose OAuth token the application refreshes. The
 * refreshed credential is persisted atomically: write to a temp file in the
 * same directory, then rename over the original — the active credentials file
 * is never truncated before its replacement exists.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const RETRIEVE_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
export const GEMINI_API_TIMEOUT_MS = 10_000;

export function resolveGeminiOAuthCredsPath(homeDir = NodeOS.homedir()): string {
  return (
    process.env.GEMINI_OAUTH_CREDS_PATH?.trim() ||
    NodePath.join(homeDir, ".gemini", "oauth_creds.json")
  );
}

export type GeminiCredentials = {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
};

export type FetchImpl = typeof fetch;

export async function readGeminiCredentials(
  readText: (p: string) => Promise<string> = (p) => NodeFSP.readFile(p, "utf-8"),
  homeDir?: string,
): Promise<GeminiCredentials | null> {
  try {
    const parsed = JSON.parse(
      await readText(resolveGeminiOAuthCredsPath(homeDir)),
    ) as Partial<GeminiCredentials>;
    if (
      typeof parsed.access_token === "string" &&
      typeof parsed.refresh_token === "string" &&
      typeof parsed.expiry_date === "number"
    ) {
      return parsed as GeminiCredentials;
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw error;
  }
}

/** Atomic replace: temp write + rename, never truncate-then-write. */
export async function saveGeminiCredentials(
  creds: GeminiCredentials,
  writeText: (p: string, data: string) => Promise<void> = (p, d) =>
    NodeFSP.writeFile(p, d, "utf-8"),
  renameFile: (from: string, to: string) => Promise<void> = (f, t) => NodeFSP.rename(f, t),
  homeDir?: string,
): Promise<void> {
  const target = resolveGeminiOAuthCredsPath(homeDir);
  const tmpPath = `${target}.${process.pid}.tmp`;
  await writeText(tmpPath, JSON.stringify(creds, null, 2));
  await renameFile(tmpPath, target);
}

export type OAuthClientCredentials = { clientId: string; clientSecret: string };

/**
 * Extracts the OAuth client identity used by the installed Gemini CLI by
 * scanning its package for the embedded constants (same approach as Orca's
 * extractor). Returns null when no local install can be found.
 */
export async function extractGeminiOAuthClientCredentials(
  platform: NodeJS.Platform = "linux",
): Promise<OAuthClientCredentials | null> {
  const candidates =
    process.env.GEMINI_CLI_OAUTH_CLIENT_ID && process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET
      ? [
          {
            clientId: process.env.GEMINI_CLI_OAUTH_CLIENT_ID,
            clientSecret: process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET,
          },
        ]
      : [];
  // The bundled CLI layout differs per install method; without a resolved
  // install there is no safe client identity to reuse.
  return candidates[0] ?? scanGeminiCliInstall(platform);
}

async function scanGeminiCliInstall(
  platform: NodeJS.Platform,
): Promise<OAuthClientCredentials | null> {
  const lookup = platform === "win32" ? "where.exe" : "which";
  let binaryPath: string | null = null;
  try {
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(lookup, ["gemini"], {
      encoding: "utf-8",
      windowsHide: true,
    });
    binaryPath = stdout.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
  if (!binaryPath) return null;
  try {
    const realPath = await NodeFSP.realpath(binaryPath);
    let current = NodePath.dirname(realPath);
    for (let depth = 0; depth < 8; depth += 1) {
      const oauth2Path = NodePath.join(current, "dist", "src", "code_assist", "oauth2.js");
      const content = await NodeFSP.readFile(oauth2Path, "utf-8").catch(() => null);
      if (content) {
        const idMatch = content.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/)?.[1];
        const secretMatch = content.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/)?.[1];
        if (idMatch && secretMatch) return { clientId: idMatch, clientSecret: secretMatch };
      }
      const parent = NodePath.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch {
    return null;
  }
  return null;
}

export type TokenRefreshResult = { accessToken: string | null; expiresIn?: number };

export async function refreshGeminiAccessToken(
  refreshToken: string,
  client: OAuthClientCredentials,
  fetchImpl: FetchImpl = fetch,
): Promise<TokenRefreshResult> {
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    signal: AbortSignal.timeout(GEMINI_API_TIMEOUT_MS),
  });
  if (!res.ok) return { accessToken: null };
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  return {
    accessToken: typeof data.access_token === "string" ? data.access_token : null,
    ...(typeof data.expires_in === "number" ? { expiresIn: data.expires_in } : {}),
  };
}

export async function loadGeminiProjectId(
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string> {
  const res = await fetchImpl(LOAD_CODE_ASSIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" } }),
    signal: AbortSignal.timeout(GEMINI_API_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Failed to load Gemini project ID (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { cloudaicompanionProject?: unknown };
  if (typeof data.cloudaicompanionProject !== "string" || !data.cloudaicompanionProject) {
    throw new Error("Gemini project ID not found in API response");
  }
  return data.cloudaicompanionProject;
}

// ---------------------------------------------------------------------------
// Quota buckets
// ---------------------------------------------------------------------------

const MODEL_ID_TO_BUCKET_NAME: Record<string, string> = {
  "gemini-3.1-pro": "3.1 Pro",
  "gemini-3.1-flash": "3.1 Flash",
  "gemini-3.1-flash-lite": "3.1 Flash Lite",
  "gemini-3.0-pro": "3.0 Pro",
  "gemini-3.0-flash": "3.0 Flash",
  "gemini-2.5-pro": "Pro",
  "gemini-2.5-flash": "Flash",
  "gemini-2.5-flash-lite": "Flash Lite",
  "gemini-exp": "Exp",
  "gemini-experimental": "Exp",
};

function humanizeModelId(modelId: string): string {
  return modelId
    .replace(/^gemini-/i, "")
    .split("-")
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

type QuotaBucketInput = { remainingFraction: number; resetTime: string; modelId: string };

function isQuotaBucket(value: unknown): value is QuotaBucketInput {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as QuotaBucketInput).remainingFraction === "number" &&
    Number.isFinite((value as QuotaBucketInput).remainingFraction) &&
    typeof (value as QuotaBucketInput).resetTime === "string" &&
    typeof (value as QuotaBucketInput).modelId === "string"
  );
}

export function buildQuotaBucket(b: QuotaBucketInput): UsageLimitBucket & { modelId: string } {
  // remainingFraction → consumed percent.
  const usedPercent = Math.min(100, Math.max(0, Math.round((1 - b.remainingFraction) * 100)));
  const resetsAtMs = new Date(b.resetTime).getTime();
  return {
    name: MODEL_ID_TO_BUCKET_NAME[b.modelId] ?? humanizeModelId(b.modelId),
    modelId: b.modelId,
    usedPercent,
    windowMinutes: 60,
    resetsAt: Number.isNaN(resetsAtMs) ? null : resetsAtMs,
    resetDescription: null,
  };
}

/** Collapses equivalent per-model buckets, preferring known model names. */
export function deduplicateBuckets(
  buckets: (UsageLimitBucket & { modelId: string })[],
): UsageLimitBucket[] {
  const result: (UsageLimitBucket & { modelId: string })[] = [];
  const seenKeys = new Map<string, number>();
  for (const bucket of buckets) {
    const key = `${bucket.usedPercent}-${bucket.resetsAt}`;
    const existingIndex = seenKeys.get(key);
    if (existingIndex === undefined) {
      seenKeys.set(key, result.length);
      result.push(bucket);
      continue;
    }
    const existing = result[existingIndex];
    if (!existing) continue;
    const existingKnown = existing.modelId in MODEL_ID_TO_BUCKET_NAME;
    const currentKnown = bucket.modelId in MODEL_ID_TO_BUCKET_NAME;
    if (
      (currentKnown && !existingKnown) ||
      (currentKnown === existingKnown && bucket.name.length < existing.name.length)
    ) {
      result[existingIndex] = bucket;
    }
  }
  return result.map(({ modelId: _modelId, ...rest }) => rest);
}

/** The session summary is the most-consumed bucket. */
export function deriveSessionSummary(buckets: UsageLimitBucket[]): UsageLimitWindow | null {
  if (buckets.length === 0) return null;
  const worst = buckets.reduce((acc, bucket) =>
    bucket.usedPercent > acc.usedPercent ? bucket : acc,
  );
  const { name: _name, ...window } = worst;
  return window;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type FetchGeminiRateLimitsOptions = {
  geminiCliOauthEnabled: boolean;
  /** Injected host platform (HostProcessPlatform); never read globally. */
  platform: NodeJS.Platform;
  signal?: AbortSignal;
  fetchImpl?: FetchImpl;
  readText?: (p: string) => Promise<string>;
  writeText?: (p: string, data: string) => Promise<void>;
  renameFile?: (from: string, to: string) => Promise<void>;
  homeDir?: string;
  extractClientCredentials?: () => Promise<OAuthClientCredentials | null>;
};

function errorResult(
  error: string,
  status: ProviderUsageLimits["status"] = "error",
): ProviderUsageLimits {
  return {
    provider: "antigravity",
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
  };
}

function parseQuotaResponse(data: unknown): QuotaBucketInput[] {
  const raw: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { buckets?: unknown[] }).buckets)
      ? (data as { buckets: unknown[] }).buckets
      : [];
  return raw.filter(isQuotaBucket);
}

async function fetchQuota(
  accessToken: string,
  projectId: string,
  options: FetchGeminiRateLimitsOptions,
): Promise<ProviderUsageLimits> {
  const res = await (options.fetchImpl ?? fetch)(RETRIEVE_QUOTA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ project: projectId }),
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(GEMINI_API_TIMEOUT_MS)])
      : AbortSignal.timeout(GEMINI_API_TIMEOUT_MS),
  });
  if (!res.ok) {
    return errorResult(`Quota fetch failed (${res.status})`);
  }
  const data = (await res.json()) as unknown;
  const buckets = deduplicateBuckets(parseQuotaResponse(data).map(buildQuotaBucket));
  if (buckets.length === 0) {
    return errorResult("Quota response contained no usable buckets", "error");
  }
  return {
    provider: "antigravity",
    session: deriveSessionSummary(buckets),
    weekly: null,
    buckets,
    updatedAt: Date.now(),
    error: null,
    status: "ok",
    usageMetadata: { source: "oauth", credentialSource: "gemini-oauth-creds-file" },
  };
}

export async function fetchAntigravityRateLimits(
  options: FetchGeminiRateLimitsOptions,
): Promise<ProviderUsageLimits> {
  if (!options.geminiCliOauthEnabled) {
    return errorResult("Google Code Assist quota reads are disabled in settings", "unavailable");
  }
  let creds: GeminiCredentials | null;
  try {
    creds = await readGeminiCredentials(options.readText, options.homeDir);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : "Unknown error");
  }
  if (!creds || !creds.access_token) {
    return errorResult("Gemini CLI credentials not found", "unavailable");
  }
  const stored: GeminiCredentials = creds;

  const getAccessToken = async (
    forceRefresh = false,
  ): Promise<{ token: string; creds: GeminiCredentials } | null> => {
    if (!forceRefresh && stored.expiry_date > Date.now() && stored.access_token) {
      return { token: stored.access_token, creds: stored };
    }
    const client = await (
      options.extractClientCredentials ??
      (() => extractGeminiOAuthClientCredentials(options.platform))
    )();
    if (!client) return null;
    const refreshed = await refreshGeminiAccessToken(
      stored.refresh_token,
      client,
      options.fetchImpl,
    );
    if (!refreshed.accessToken) return null;
    const updated: GeminiCredentials = {
      ...stored,
      access_token: refreshed.accessToken,
      expiry_date: refreshed.expiresIn
        ? Date.now() + refreshed.expiresIn * 1000
        : stored.expiry_date,
    };
    await saveGeminiCredentials(updated, options.writeText, options.renameFile, options.homeDir);
    return { token: updated.access_token, creds: updated };
  };

  try {
    const initial = await getAccessToken();
    if (!initial) return errorResult("Token refresh failed");
    let projectId: string;
    try {
      projectId = await loadGeminiProjectId(initial.token, options.fetchImpl);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : "Gemini project ID not found");
    }
    const result = await fetchQuota(initial.token, projectId, options);
    // Exactly one forced refresh-and-retry on 401 — never an auth retry loop.
    if (result.status === "error" && result.error?.includes("(401")) {
      const retried = await getAccessToken(true);
      if (retried) {
        const retryProjectId = await loadGeminiProjectId(retried.token, options.fetchImpl).catch(
          () => projectId,
        );
        return fetchQuota(retried.token, retryProjectId, options);
      }
    }
    return result;
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : "Unknown error");
  }
}
