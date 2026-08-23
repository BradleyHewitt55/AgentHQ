// @effect-diagnostics globalDate:off
// @effect-diagnostics globalFetch:off
import type {
  ProviderUsageLimits,
  UsageLimitFailureKind,
  UsageLimitMetadata,
  UsageLimitSource,
  UsageLimitWindow,
} from "@t3tools/contracts";

import { readClaudeOAuthCredentials, type ClaudeOAuthCredentials } from "./claudeCredentials.ts";
import {
  parseRetryAfterMs,
  SESSION_WINDOW_MINUTES,
  usageWindow,
  WEEKLY_WINDOW_MINUTES,
} from "./usageWindows.ts";

/**
 * Claude subscription usage via the OAuth usage endpoint, mirroring the Claude
 * Code CLI contract. Credential refresh is owned by the Claude CLI/SDK — this
 * module never repairs or rewrites credentials; on a stale token it reports
 * the failure and lets a live session (or the user's next CLI run) fix it.
 */

const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.0";
export const CLAUDE_USAGE_API_TIMEOUT_MS = 10_000;

export type FetchViaOAuthImpl = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json: () => Promise<unknown>;
}>;

type ClaudeUsageWindowInput = {
  utilization?: number | undefined;
  used_percentage?: number | undefined;
  resets_at?: string | number | undefined;
};

type ScopedLimit = {
  kind?: string;
  percent?: number;
  resets_at?: string | number;
  is_active?: boolean;
  scope?: { model?: { display_name?: string } | null } | null;
};

type ClaudeOAuthUsageResponse = {
  five_hour?: ClaudeUsageWindowInput;
  seven_day?: ClaudeUsageWindowInput;
  fable_weekly?: ClaudeUsageWindowInput;
  fable_seven_day?: ClaudeUsageWindowInput;
  seven_day_fable?: ClaudeUsageWindowInput;
  limits?: ScopedLimit[] | null;
};

/** Thrown for non-2xx usage responses; carries Retry-After when rate limited. */
export class ClaudeOAuthUsageError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(message: string, status: number, retryAfterMs: number | null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export async function createClaudeOAuthUsageError(
  res: Awaited<ReturnType<FetchViaOAuthImpl>>,
): Promise<ClaudeOAuthUsageError> {
  let detail: string | null = null;
  if (res.status !== 429) {
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (typeof body.error?.message === "string" && body.error.message.trim()) {
        detail = body.error.message;
      }
    } catch {
      // fall through to status text
    }
  }
  return new ClaudeOAuthUsageError(
    res.status === 429
      ? "Claude usage is rate limited right now."
      : (detail ?? `OAuth API returned ${res.status}`),
    res.status,
    res.status === 429 ? parseRetryAfterMs(res.headers.get("retry-after")) : null,
  );
}

function mapUsageWindow(
  raw: ClaudeUsageWindowInput | undefined,
  minutes: number,
): UsageLimitWindow | null {
  if (!raw) return null;
  const usedPercent =
    typeof raw.utilization === "number"
      ? raw.utilization
      : typeof raw.used_percentage === "number"
        ? raw.used_percentage
        : null;
  if (usedPercent === null) return null;
  return usageWindow({ usedPercent, windowMinutes: minutes, resetsAt: raw.resets_at ?? null });
}

/** Prefers structured scoped limits; falls back to legacy Fable fields. */
export function mapFableWeeklyWindow(data: ClaudeOAuthUsageResponse): UsageLimitWindow | null {
  const scoped = Array.isArray(data.limits)
    ? data.limits.find(
        (limit) =>
          limit?.kind === "weekly_scoped" &&
          typeof limit.percent === "number" &&
          Number.isFinite(limit.percent) &&
          limit.scope?.model?.display_name?.trim().toLowerCase() === "fable",
      )
    : undefined;
  const scopedPercent = scoped && typeof scoped.percent === "number" ? scoped.percent : undefined;
  return (
    mapUsageWindow(
      scopedPercent !== undefined
        ? { used_percentage: scopedPercent, resets_at: scoped?.resets_at }
        : undefined,
      WEEKLY_WINDOW_MINUTES,
    ) ??
    mapUsageWindow(data.fable_weekly, WEEKLY_WINDOW_MINUTES) ??
    mapUsageWindow(data.fable_seven_day, WEEKLY_WINDOW_MINUTES) ??
    mapUsageWindow(data.seven_day_fable, WEEKLY_WINDOW_MINUTES)
  );
}

export async function fetchClaudeUsageViaOAuth(
  token: string,
  options?: { signal?: AbortSignal; fetchImpl?: FetchViaOAuthImpl },
): Promise<Omit<ProviderUsageLimits, "usageMetadata">> {
  const opts = options ?? {};
  if (opts.signal?.aborted) throw new Error("Rate-limit fetch aborted");
  const timeoutSignal = AbortSignal.timeout(CLAUDE_USAGE_API_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
  const doFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const res = await doFetch(OAUTH_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA_HEADER,
      "User-Agent": CLAUDE_CODE_USER_AGENT,
    },
    signal,
  });
  if (!res.ok) {
    throw await createClaudeOAuthUsageError(res);
  }
  const data = (await res.json()) as ClaudeOAuthUsageResponse;
  if (options?.signal?.aborted) throw new Error("Rate-limit fetch aborted");
  const session = mapUsageWindow(data.five_hour, SESSION_WINDOW_MINUTES);
  const weekly = mapUsageWindow(data.seven_day, WEEKLY_WINDOW_MINUTES);
  const fableWeekly = mapFableWeeklyWindow(data);
  if (!session && !weekly && !fableWeekly) {
    throw new SyntaxError("Claude usage response contained no windows");
  }
  return {
    provider: "claude",
    session,
    weekly,
    ...(fableWeekly ? { fableWeekly } : {}),
    updatedAt: Date.now(),
    error: null,
    status: "ok",
  };
}

// ---------------------------------------------------------------------------
// Error classification (Orca's claude-usage-error-classification)
// ---------------------------------------------------------------------------

export type ClaudeUsageErrorClassification = {
  failureKind: UsageLimitFailureKind;
  /** A CLI fallback may still be able to answer after this failure. */
  shouldAttemptCliFallback: boolean;
  terminal: boolean;
};

export function classifyClaudeOAuthUsageError(error: unknown): ClaudeUsageErrorClassification {
  if (error instanceof ClaudeOAuthUsageError) {
    if (error.status === 429) return terminal("rate-limited");
    if (error.status === 401) return recoverableAuth("stale-token");
    if (error.status === 403) {
      return error.message.includes("user:profile")
        ? terminal("missing-scope")
        : recoverableAuth("stale-token");
    }
    if (error.status >= 500) return fallbackOnly("server");
    return terminal("usage-unavailable");
  }
  if (error instanceof SyntaxError) return fallbackOnly("parse");
  const message = error instanceof Error ? error.message : String(error);
  if (/\babort|network|econn|enotfound|etimedout|fetch failed|dns\b/i.test(message)) {
    return fallbackOnly("network");
  }
  return fallbackOnly("unknown");
}

export function classifyClaudeCredentialAbsence(input: {
  hasRefreshableCredentials: boolean;
  keychainUnavailable?: boolean | undefined;
}): ClaudeUsageErrorClassification {
  if (input.keychainUnavailable) return fallbackOnly("keychain-unavailable");
  if (input.hasRefreshableCredentials)
    return recoverableAuth("refreshable-credentials-without-token");
  return terminal("missing-credentials");
}

function recoverableAuth(failureKind: UsageLimitFailureKind): ClaudeUsageErrorClassification {
  return { failureKind, shouldAttemptCliFallback: true, terminal: false };
}
function fallbackOnly(failureKind: UsageLimitFailureKind): ClaudeUsageErrorClassification {
  return { failureKind, shouldAttemptCliFallback: true, terminal: false };
}
function terminal(failureKind: UsageLimitFailureKind): ClaudeUsageErrorClassification {
  return { failureKind, shouldAttemptCliFallback: false, terminal: false };
}

function classifyClaudeCliFailure(limits: ProviderUsageLimits): UsageLimitFailureKind | undefined {
  if (!limits.error) return undefined;
  if (/rate limited/i.test(limits.error)) return "rate-limited";
  if (/plan usage is unavailable|usage is unavailable/i.test(limits.error)) {
    return "usage-unavailable";
  }
  return "cli-unavailable";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type FetchClaudeRateLimitsOptions = {
  configDir?: string | undefined;
  /** Injected host platform (HostProcessPlatform); never read globally. */
  platform: NodeJS.Platform;
  signal?: AbortSignal;
  fetchImpl?: FetchViaOAuthImpl;
  readKeychain?: Parameters<typeof readClaudeOAuthCredentials>[0]["readKeychain"];
  readText?: (path: string) => Promise<string>;
  /**
   * T3 does not automate the interactive Claude CLI for background quota reads
   * (hidden-PTY automation is unreliable on Windows and heavy everywhere), so
   * this hook is only wired in tests. When absent, CLI steps report
   * `cli-unavailable` and the fetch degrades to the classified error result.
   */
  cliFallback?: (() => Promise<ProviderUsageLimits>) | undefined;
};

function makeClaudeResult(
  status: ProviderUsageLimits["status"],
  error: string | null,
  metadata: UsageLimitMetadata,
): ProviderUsageLimits {
  return {
    provider: "claude",
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: metadata,
  };
}

export async function fetchClaudeRateLimits(
  options: FetchClaudeRateLimitsOptions,
): Promise<ProviderUsageLimits> {
  if (options.signal?.aborted) {
    return makeClaudeResult("error", "Rate-limit fetch aborted", {});
  }
  const attemptedSources: UsageLimitSource[] = [];
  const recordAttempt = (source: UsageLimitSource): void => {
    if (!attemptedSources.includes(source)) attemptedSources.push(source);
  };
  const credentials: ClaudeOAuthCredentials = await readClaudeOAuthCredentials({
    ...(options.configDir !== undefined ? { configDir: options.configDir } : {}),
    platform: options.platform,
    ...(options.readKeychain ? { readKeychain: options.readKeychain } : {}),
    ...(options.readText ? { readText: options.readText } : {}),
  });

  const baseMetadata = (): UsageLimitMetadata => ({
    credentialSource: credentials.source,
    attemptedSources: [...attemptedSources],
  });

  const runCliFallback = async (): Promise<ProviderUsageLimits> => {
    recordAttempt("cli");
    if (!options.cliFallback) {
      return makeClaudeResult("error", "Claude usage is unavailable without OAuth credentials", {
        ...baseMetadata(),
        failureKind: "cli-unavailable",
      });
    }
    const limits = await options.cliFallback();
    return {
      ...limits,
      usageMetadata: {
        ...baseMetadata(),
        source: "cli",
        failureKind: classifyClaudeCliFailure(limits),
      },
    };
  };

  if (credentials.token) {
    recordAttempt("oauth");
    try {
      const oauthLimits = await fetchClaudeUsageViaOAuth(credentials.token, options);
      if (options.signal?.aborted) {
        return makeClaudeResult("error", "Rate-limit fetch aborted", baseMetadata());
      }
      return {
        ...oauthLimits,
        usageMetadata: { ...baseMetadata(), source: "oauth" },
      };
    } catch (err) {
      const classification = classifyClaudeOAuthUsageError(err);
      const retryAfterMs = err instanceof ClaudeOAuthUsageError ? err.retryAfterMs : null;
      if (classification.shouldAttemptCliFallback && options.cliFallback) {
        try {
          return await runCliFallback();
        } catch {
          // fall through to classified error result
        }
      }
      return makeClaudeResult("error", err instanceof Error ? err.message : "Unknown error", {
        ...baseMetadata(),
        failureKind: classification.failureKind,
        ...(retryAfterMs ? { retryAtMs: Date.now() + retryAfterMs } : {}),
      });
    }
  }

  const absence = classifyClaudeCredentialAbsence({
    hasRefreshableCredentials: credentials.hasRefreshableCredentials,
    keychainUnavailable: credentials.keychainUnavailable,
  });

  // Refreshable-but-tokenless means the CLI owns an in-progress rotation; the
  // user's next Claude session refreshes it. Never rewrite the store here.
  if (
    (credentials.token ||
      credentials.hasRefreshableCredentials ||
      credentials.keychainUnavailable) &&
    absence.shouldAttemptCliFallback &&
    options.cliFallback
  ) {
    try {
      return await runCliFallback();
    } catch (err) {
      return makeClaudeResult("error", err instanceof Error ? err.message : "Unknown error", {
        ...baseMetadata(),
        failureKind:
          absence.failureKind === "keychain-unavailable"
            ? "keychain-unavailable"
            : "cli-unavailable",
      });
    }
  }

  if (credentials.keychainUnavailable) {
    return makeClaudeResult("error", "Claude Keychain credentials unavailable", {
      ...baseMetadata(),
      failureKind: "keychain-unavailable",
    });
  }
  if (credentials.hasRefreshableCredentials) {
    return makeClaudeResult("error", "Claude OAuth access token unavailable", {
      ...baseMetadata(),
      failureKind: absence.failureKind,
    });
  }

  return makeClaudeResult(
    "unavailable",
    "No subscription plan — API key billing or not signed in",
    {
      ...baseMetadata(),
      failureKind: "missing-credentials",
    },
  );
}

// ---------------------------------------------------------------------------
// Live-session ingestion mapping (statusline / SDK /usage events)
// ---------------------------------------------------------------------------

export type LiveClaudeUsageEvent = {
  fiveHour?: { utilization?: number; resets_at?: string | number } | undefined;
  sevenDay?: { utilization?: number; resets_at?: string | number } | undefined;
};

export function mapLiveClaudeWindows(event: LiveClaudeUsageEvent): {
  session: UsageLimitWindow | null;
  weekly: UsageLimitWindow | null;
} {
  return {
    session: event.fiveHour ? mapUsageWindow(event.fiveHour, SESSION_WINDOW_MINUTES) : null,
    weekly: event.sevenDay ? mapUsageWindow(event.sevenDay, WEEKLY_WINDOW_MINUTES) : null,
  };
}
