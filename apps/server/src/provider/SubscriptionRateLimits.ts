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

type ClaudeRateLimitInfo = {
  readonly rateLimitType?:
    | "five_hour"
    | "seven_day"
    | "seven_day_opus"
    | "seven_day_sonnet"
    | "overage";
  readonly resetsAt?: number;
  readonly utilization?: number;
};

function toPercent(value: number, fractional: boolean): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  const percent = fractional && value <= 1 ? value * 100 : value;
  return Math.min(100, Math.round(percent * 10) / 10);
}

function toIsoDateTime(timestamp: number | null | undefined): string | null {
  if (timestamp === undefined || timestamp === null || !Number.isFinite(timestamp)) return null;
  // Codex reports epoch seconds while Claude's SDK currently reports epoch milliseconds.
  const milliseconds = Math.abs(timestamp) < 1_000_000_000_000 ? timestamp * 1_000 : timestamp;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toWindow(
  source: { readonly usedPercent: number; readonly resetsAt?: number | null },
  options?: { readonly fractional?: boolean; readonly label?: string },
): SubscriptionRateLimitWindow | undefined {
  const usedPercent = toPercent(source.usedPercent, options?.fractional ?? false);
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

/** Normalizes Claude Code's subscription telemetry without exposing SDK payloads. */
export function normalizeClaudeSubscriptionRateLimits(
  input: ClaudeRateLimitInfo,
): SubscriptionRateLimitsUpdate | undefined {
  if (input.utilization === undefined) return undefined;
  const label =
    input.rateLimitType === "seven_day_opus"
      ? "Opus"
      : input.rateLimitType === "seven_day_sonnet"
        ? "Sonnet"
        : undefined;
  const window = toWindow(
    {
      usedPercent: input.utilization,
      ...(input.resetsAt === undefined ? {} : { resetsAt: input.resetsAt }),
    },
    { fractional: true, ...(label ? { label } : {}) },
  );
  if (!window) return undefined;

  switch (input.rateLimitType) {
    case "five_hour":
      return { provider: "claude", fiveHour: window };
    case "seven_day":
    case "seven_day_opus":
    case "seven_day_sonnet":
      return { provider: "claude", weekly: [window] };
    default:
      return undefined;
  }
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
