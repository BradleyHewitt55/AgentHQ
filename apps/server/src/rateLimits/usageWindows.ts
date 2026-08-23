// @effect-diagnostics globalDate:off
import type { UsageLimitWindow } from "@t3tools/contracts";

/** Canonical window lengths in minutes. */
export const SESSION_WINDOW_MINUTES = 300;
export const WEEKLY_WINDOW_MINUTES = 10_080;
export const MONTHLY_WINDOW_MINUTES = 43_200;

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 100) / 100));
}

/**
 * Accepts Unix seconds or Unix milliseconds (and numeric strings); anything
 * above 1e11 is already milliseconds. Returns normalized Unix ms or null.
 */
export function toUnixMs(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const asNumber = typeof value === "number" ? value : Number(String(value).trim());
  if (Number.isFinite(asNumber)) {
    return asNumber > 10_000_000_000 ? asNumber : asNumber * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/** "3:45 PM" today, "Thu 3:45 PM" otherwise — matches the provider UIs. */
export function resetDescription(resetsAtMs: number | null): string | null {
  if (resetsAtMs === null) return null;
  try {
    const date = new Date(resetsAtMs);
    if (Number.isNaN(date.getTime())) return null;
    const isToday = date.toDateString() === new Date().toDateString();
    return isToday
      ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : date.toLocaleDateString(undefined, {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
        });
  } catch {
    return null;
  }
}

export function usageWindow(input: {
  usedPercent: number;
  windowMinutes: number;
  resetsAt?: number | string | null;
}): UsageLimitWindow {
  const resetsAt = toUnixMs(input.resetsAt ?? null);
  return {
    usedPercent: clampPercent(input.usedPercent),
    windowMinutes: input.windowMinutes,
    resetsAt,
    resetDescription: resetDescription(resetsAt),
  };
}

/** Converts a remaining-percentage report into the canonical consumed form. */
export function usedFromRemaining(remainingPercent: number): number {
  return clampPercent(100 - remainingPercent);
}

export function hasUsageData(limits: {
  session: UsageLimitWindow | null;
  weekly: UsageLimitWindow | null;
  monthly?: UsageLimitWindow | null | undefined;
  fableWeekly?: UsageLimitWindow | null | undefined;
  buckets?: ReadonlyArray<{ name: string }> | undefined;
}): boolean {
  return Boolean(
    limits.session ||
    limits.weekly ||
    limits.monthly ||
    limits.fableWeekly ||
    (limits.buckets && limits.buckets.length > 0),
  );
}

/**
 * Parses an HTTP Retry-After header (delay-seconds or HTTP-date). A hostile or
 * missing value must not gate refreshes for days, so it caps at 24h.
 */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && header.trim() !== "") {
    return seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null;
  }
  const dateMs = Date.parse(header);
  if (!Number.isFinite(dateMs)) return null;
  const delta = dateMs - Date.now();
  return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_MS) : null;
}
