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
