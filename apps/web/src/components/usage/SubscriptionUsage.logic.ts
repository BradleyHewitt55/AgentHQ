import type { SubscriptionRateLimitWindow } from "@t3tools/contracts";

export function formatSubscriptionPercent(usedPercent: number): string {
  return `${Math.round(usedPercent)}%`;
}

export function formatSubscriptionReset(resetsAt: string | null): string | null {
  if (resetsAt === null) return null;
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) return null;
  return `Resets ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(reset)}`;
}

export function subscriptionWindowLabel(
  kind: "fiveHour" | "weekly",
  window?: SubscriptionRateLimitWindow,
): string {
  if (kind === "fiveHour") return "5-hour";
  return window?.label ? `Weekly · ${window.label}` : "Weekly";
}

/**
 * A snapshot only advances while a provider session is running, so a value from
 * a previous session can sit in the meters indefinitely. Past this age we label
 * it rather than presenting it as the account's current usage.
 */
const SUBSCRIPTION_STALE_AFTER_MS = 30 * 60 * 1000;

export function formatSubscriptionUpdatedAt(
  updatedAt: string | null,
  now: number = Date.now(),
): { readonly text: string; readonly isStale: boolean } | null {
  if (updatedAt === null) return null;
  const updated = new Date(updatedAt);
  if (Number.isNaN(updated.getTime())) return null;

  const elapsedMs = Math.max(0, now - updated.getTime());
  const isStale = elapsedMs >= SUBSCRIPTION_STALE_AFTER_MS;
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return { text: "Updated just now", isStale };
  if (minutes < 60) return { text: `Updated ${minutes}m ago`, isStale };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { text: `Updated ${hours}h ago`, isStale };
  return { text: `Updated ${Math.floor(hours / 24)}d ago`, isStale };
}
