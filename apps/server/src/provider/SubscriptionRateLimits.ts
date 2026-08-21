// @effect-diagnostics globalDate:off
import type {
  ProviderSubscriptionUsage,
  SubscriptionRateLimitWindow,
  SubscriptionRateLimitsUpdate,
  UsageProviderKind,
} from "@t3tools/contracts";

type ProviderRateLimitWindow = {
  readonly usedPercent: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
};

/**
 * How often a live session re-polls subscription usage while idle. Turn
 * boundaries and rate-limit signals already refresh immediately; this cadence
 * keeps the meters honest between turns.
 */
export const SUBSCRIPTION_USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The subset of the Claude SDK's structured `/usage` response we consume. Every
 * window reports `utilization` as a percentage in `0-100` and `resets_at` as an
 * ISO 8601 string, unlike the epoch-second `rate_limit_event` telemetry.
 */
type ClaudeUsageWindow = {
  readonly utilization?: number | null;
  readonly resets_at?: string | null;
};

export type ClaudeUsageSnapshot = {
  readonly rate_limits_available?: boolean;
  readonly rate_limits?: {
    readonly five_hour?: ClaudeUsageWindow | null;
    readonly seven_day?: ClaudeUsageWindow | null;
    readonly seven_day_opus?: ClaudeUsageWindow | null;
    readonly seven_day_sonnet?: ClaudeUsageWindow | null;
  } | null;
};

function toPercent(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.min(100, Math.round(value * 10) / 10);
}

function toIsoDateTime(timestamp: number | null | undefined): string | null {
  if (timestamp === undefined || timestamp === null || !Number.isFinite(timestamp)) return null;
  // Codex and Claude both report epoch seconds, but the millisecond branch keeps
  // us honest if either ever switches units.
  const milliseconds = Math.abs(timestamp) < 1_000_000_000_000 ? timestamp * 1_000 : timestamp;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toIsoDateTimeFromString(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toWindow(
  source: { readonly usedPercent: number; readonly resetsAt?: number | null },
  options?: { readonly label?: string },
): SubscriptionRateLimitWindow | undefined {
  const usedPercent = toPercent(source.usedPercent);
  if (usedPercent === undefined) return undefined;
  return {
    usedPercent,
    resetsAt: toIsoDateTime(source.resetsAt),
    ...(options?.label ? { label: options.label } : {}),
  };
}

/**
 * Reduces Codex's primary/secondary snapshot to the subscription windows the
 * UI exposes. Sparse notifications deliberately omit unknown windows.
 */
export function normalizeCodexSubscriptionRateLimits(input: {
  readonly primary?: ProviderRateLimitWindow | null;
  readonly secondary?: ProviderRateLimitWindow | null;
}): SubscriptionRateLimitsUpdate | undefined {
  const primary = input.primary ? toWindow(input.primary) : undefined;
  const secondary = input.secondary ? toWindow(input.secondary) : undefined;

  const windows = [
    {
      window: primary,
      durationMinutes: input.primary?.windowDurationMins ?? null,
      fallback: "fiveHour",
    },
    {
      window: secondary,
      durationMinutes: input.secondary?.windowDurationMins ?? null,
      fallback: "weekly",
    },
  ] as const;

  let fiveHour: SubscriptionRateLimitWindow | undefined;
  let weekly: SubscriptionRateLimitWindow | undefined;
  for (const candidate of windows) {
    if (!candidate.window) continue;
    if (candidate.durationMinutes !== null && candidate.durationMinutes <= 12 * 60) {
      fiveHour = candidate.window;
    } else if (candidate.durationMinutes !== null && candidate.durationMinutes >= 3 * 24 * 60) {
      weekly = candidate.window;
    } else if (candidate.fallback === "fiveHour") {
      fiveHour = candidate.window;
    } else {
      weekly = candidate.window;
    }
  }

  if (!fiveHour && !weekly) return undefined;
  return {
    provider: "codex",
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly: [weekly] } : {}),
  };
}

function claudeUsageWindow(
  window: ClaudeUsageWindow | null | undefined,
  label?: string,
): SubscriptionRateLimitWindow | undefined {
  if (!window || window.utilization === undefined || window.utilization === null) return undefined;
  const usedPercent = toPercent(window.utilization);
  if (usedPercent === undefined) return undefined;
  return {
    usedPercent,
    resetsAt: toIsoDateTimeFromString(window.resets_at),
    ...(label ? { label } : {}),
  };
}

/**
 * Normalizes the Claude SDK's structured `/usage` snapshot.
 *
 * This is the only source of Claude subscription utilization: `rate_limit_event`
 * carries a threshold status (`allowed` / `allowed_warning` / `rejected`) and a
 * reset timestamp, but no utilization figure, so it can never populate the
 * meters on its own.
 *
 * `rate_limits_available` is false for API-key, Bedrock, and Vertex sessions,
 * where plan limits simply do not apply.
 */
export function normalizeClaudeUsageSnapshot(
  snapshot: ClaudeUsageSnapshot,
): SubscriptionRateLimitsUpdate | undefined {
  if (snapshot.rate_limits_available === false) return undefined;
  const limits = snapshot.rate_limits;
  if (!limits) return undefined;

  const fiveHour = claudeUsageWindow(limits.five_hour);
  // Claude reports an overall seven-day window plus per-model windows on plans
  // that meter Opus separately; we surface whichever of the three it sends.
  const weekly = [
    claudeUsageWindow(limits.seven_day),
    claudeUsageWindow(limits.seven_day_opus, "Opus"),
    claudeUsageWindow(limits.seven_day_sonnet, "Sonnet"),
  ].filter((window): window is SubscriptionRateLimitWindow => window !== undefined);

  if (!fiveHour && weekly.length === 0) return undefined;
  return {
    provider: "claude",
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly.length > 0 ? { weekly } : {}),
  };
}

export function unavailableSubscriptionUsage(
  provider: UsageProviderKind,
): ProviderSubscriptionUsage {
  return {
    provider,
    status: "unavailable",
    fiveHour: null,
    weekly: [],
    updatedAt: null,
  };
}

/** Merges sparse runtime updates, preserving a second Claude weekly model window. */
export function applySubscriptionRateLimitsUpdate(
  current: ProviderSubscriptionUsage,
  update: SubscriptionRateLimitsUpdate,
  updatedAt: string,
): ProviderSubscriptionUsage {
  const weekly = update.weekly
    ? [
        ...current.weekly.filter(
          (existing) => !update.weekly?.some((next) => next.label === existing.label),
        ),
        ...update.weekly,
      ]
    : current.weekly;

  return {
    provider: update.provider,
    status: "available",
    fiveHour: update.fiveHour ?? current.fiveHour,
    weekly,
    updatedAt,
  };
}
