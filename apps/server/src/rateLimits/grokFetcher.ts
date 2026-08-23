// @effect-diagnostics globalDate:off
// @effect-diagnostics globalFetch:off
import type { ProviderUsageLimits, UsageLimitMetadata, UsageLimitWindow } from "@t3tools/contracts";

import {
  isGrokAccessTokenFresh,
  readGrokAuthSession,
  type GrokAuthReadResult,
  type GrokAuthSession,
} from "./grokAuth.ts";
import { MONTHLY_WINDOW_MINUTES, usageWindow, WEEKLY_WINDOW_MINUTES } from "./usageWindows.ts";

/**
 * Grok subscription usage via the Grok CLI billing proxy. The URL and headers
 * must match the CLI or xAI rejects the request. Token refresh is owned by the
 * Grok CLI: an expired stored token reports `delegated-refresh-required`
 * instead of attempting any refresh.
 */

const GROK_CLI_PROXY_BASE =
  process.env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim().replace(/\/$/, "") ||
  "https://cli-chat-proxy.grok.com/v1";
export const GROK_BILLING_CREDITS_URL = `${GROK_CLI_PROXY_BASE}/billing?format=credits`;
export const GROK_BILLING_DEFAULT_URL = `${GROK_CLI_PROXY_BASE}/billing`;
const API_TIMEOUT_MS = 10_000;
const GROK_CLI_AUTH_HEADER = "xai-grok-cli";

export type FetchImpl = typeof fetch;

type MoneyVal = { val?: string | number };
type UsagePeriod = { type?: string; start?: string; end?: string };

type GrokBillingConfig = {
  creditUsagePercent?: number;
  currentPeriod?: UsagePeriod;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  subscriptionTier?: string;
  monthlyLimit?: MoneyVal;
  used?: MoneyVal;
};

type GrokBillingResponse = GrokBillingConfig & { config?: GrokBillingConfig };

function result(
  status: ProviderUsageLimits["status"],
  error: string | null,
  usageMetadata?: UsageLimitMetadata,
): ProviderUsageLimits {
  return {
    provider: "grok",
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...(usageMetadata ? { usageMetadata } : {}),
  };
}

function timestampsMatch(left: string | undefined, right: string | undefined): boolean {
  const leftTs = left ? Date.parse(left) : Number.NaN;
  const rightTs = right ? Date.parse(right) : Number.NaN;
  return Number.isFinite(leftTs) && leftTs === rightTs;
}

function hasConfirmedWeeklyPeriod(config: GrokBillingConfig): boolean {
  const period = config.currentPeriod;
  // Monthly unified-billing responses can also carry a weekly currentPeriod;
  // matching billing bounds identify the omitted protobuf zero unambiguously.
  return (
    period?.type === "USAGE_PERIOD_TYPE_WEEKLY" &&
    timestampsMatch(period.start, config.billingPeriodStart) &&
    timestampsMatch(period.end, config.billingPeriodEnd)
  );
}

export function mapWeeklyCredits(config: GrokBillingConfig): UsageLimitWindow | null {
  const usedPercent =
    config.creditUsagePercent === undefined && hasConfirmedWeeklyPeriod(config)
      ? 0
      : config.creditUsagePercent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return null;
  const periodEnd = config.currentPeriod?.end ?? config.billingPeriodEnd;
  return usageWindow({
    usedPercent,
    windowMinutes: WEEKLY_WINDOW_MINUTES,
    resetsAt: periodEnd ?? null,
  });
}

function parseMoneyVal(value: MoneyVal | undefined): number | null {
  const num = typeof value?.val === "string" ? Number.parseFloat(value.val) : value?.val;
  return typeof num === "number" && Number.isFinite(num) ? num : null;
}

/** Unified-billing accounts expose only a monthly included budget. */
export function mapMonthlyUsage(config: GrokBillingConfig): UsageLimitWindow | null {
  const limit = parseMoneyVal(config.monthlyLimit);
  const used = parseMoneyVal(config.used);
  if (limit === null || used === null || limit <= 0) return null;
  const periodEnd = config.currentPeriod?.end ?? config.billingPeriodEnd;
  return usageWindow({
    usedPercent: (used / limit) * 100,
    windowMinutes: MONTHLY_WINDOW_MINUTES,
    resetsAt: periodEnd ?? null,
  });
}

function grokRequestHeaders(session: GrokAuthSession): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    "X-XAI-Token-Auth": GROK_CLI_AUTH_HEADER,
    Accept: "application/json",
  };
  if (session.userId) headers["x-userid"] = session.userId;
  return headers;
}

function resolveBillingConfig(data: GrokBillingResponse): GrokBillingConfig | null {
  if (data.config) return data.config;
  if (typeof data.creditUsagePercent === "number") return data;
  return null;
}

function billingUsageResult(
  windows: { weekly?: UsageLimitWindow | null; monthly?: UsageLimitWindow | null },
  config: GrokBillingConfig,
  session: GrokAuthSession,
): ProviderUsageLimits {
  const tier = config.subscriptionTier?.trim();
  const authLabel = session.email?.trim() || session.userId || "Grok account";
  return {
    provider: "grok",
    session: null,
    weekly: windows.weekly ?? null,
    ...(windows.monthly ? { monthly: windows.monthly } : {}),
    updatedAt: Date.now(),
    error: null,
    status: "ok",
    usageMetadata: {
      source: "oauth",
      credentialSource: "grok-auth-file",
      authProvenance: tier ? `${authLabel} (${tier})` : authLabel,
    },
  };
}

type BillingOutcome =
  | { kind: "data"; data: GrokBillingResponse }
  | { kind: "result"; result: ProviderUsageLimits };

async function fetchBillingData(
  url: string,
  session: GrokAuthSession,
  options?: { signal?: AbortSignal; fetchImpl?: FetchImpl },
): Promise<BillingOutcome> {
  const signal = options?.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS);
  const res = await (options?.fetchImpl ?? fetch)(url, {
    headers: grokRequestHeaders(session),
    signal,
  });
  if (res.status === 401 || res.status === 403) {
    return {
      kind: "result",
      result: result("error", `Grok usage request unauthorized (HTTP ${res.status})`),
    };
  }
  if (!res.ok) {
    return {
      kind: "result",
      result: result("error", `Grok usage request failed (HTTP ${res.status})`),
    };
  }
  const data: unknown = await res.json();
  return {
    kind: "data",
    data: typeof data === "object" && data !== null ? (data as GrokBillingResponse) : {},
  };
}

// Failures propagate as 'error' so the stale policy keeps the last good
// monthly snapshot; only a successful response without monthly fields means
// the account truly has no visible quota.
async function fetchMonthlyFallback(
  session: GrokAuthSession,
  options?: { signal?: AbortSignal; fetchImpl?: FetchImpl },
): Promise<
  | { kind: "window"; window: UsageLimitWindow | null }
  | { kind: "result"; result: ProviderUsageLimits }
> {
  const outcome = await fetchBillingData(GROK_BILLING_DEFAULT_URL, session, options);
  if (outcome.kind === "result") return outcome;
  return { kind: "window", window: mapMonthlyUsage(outcome.data.config ?? outcome.data) };
}

export async function fetchGrokRateLimits(
  options: {
    signal?: AbortSignal;
    fetchImpl?: FetchImpl;
    authReadResult?: GrokAuthReadResult;
  } = {},
): Promise<ProviderUsageLimits> {
  const readResult = options.authReadResult ?? readGrokAuthSession();
  if (readResult.status === "missing") {
    return result("unavailable", "Not signed in to Grok — run `grok` to sign in");
  }
  if (readResult.status === "error") {
    return result("error", readResult.error);
  }
  const session = readResult.session;
  if (!isGrokAccessTokenFresh(session)) {
    // A genuine sign-out returns 'missing' earlier, so reaching here means a
    // stored refreshable session that the Grok CLI will rotate on its next run.
    return result("error", "Grok sign-in expired — run Grok once so it can refresh its session.", {
      failureKind: "delegated-refresh-required",
      source: "oauth",
      credentialSource: "grok-auth-file",
    });
  }

  try {
    const outcome = await fetchBillingData(GROK_BILLING_CREDITS_URL, session, options);
    if (outcome.kind === "result") return outcome.result;
    const config = resolveBillingConfig(outcome.data);
    // A 200 without credit usage means the plan has no weekly credits:
    // 'unavailable' hides the bar instead of painting a permanent alert.
    if (!config) return result("unavailable", "Grok billing response did not include config");
    const weekly = mapWeeklyCredits(config);
    if (weekly) return billingUsageResult({ weekly }, config, session);
    const fallback = await fetchMonthlyFallback(session, options);
    if (fallback.kind === "result") return fallback.result;
    if (fallback.window) return billingUsageResult({ monthly: fallback.window }, config, session);
    return result("unavailable", "Grok billing response did not include credit usage");
  } catch (err) {
    return result("error", err instanceof Error ? err.message : "Grok usage request failed");
  }
}
