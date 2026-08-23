import type {
  ProviderUsageLimits,
  UsageLimitProviderId,
  UsageLimitWindow,
} from "@t3tools/contracts";

import {
  ClaudeAI,
  type Icon,
  AntigravityIcon,
  CursorIcon,
  GrokIcon,
  OpenAI,
  OpenCodeIcon,
  PiAgentIcon,
} from "../Icons";

type UsageLimitProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly mark: Icon;
};

/** Presentation for every provider in the usage-limit registry. */
export const USAGE_LIMIT_PROVIDER_PRESENTATION: Record<
  UsageLimitProviderId,
  UsageLimitProviderPresentation
> = {
  codex: { label: "Codex", color: "var(--foreground)", mark: OpenAI },
  claude: { label: "Claude", color: "#d97757", mark: ClaudeAI },
  antigravity: { label: "Antigravity", color: "#5b8def", mark: AntigravityIcon },
  grok: { label: "Grok", color: "#e8e8e8", mark: GrokIcon },
  cursor: { label: "Cursor", color: "#9aa0a6", mark: CursorIcon },
  opencode: { label: "OpenCode", color: "#7aa2f7", mark: OpenCodeIcon },
  pi: { label: "Pi", color: "#b48ead", mark: PiAgentIcon },
};

export function usageLimitProviderLabel(provider: UsageLimitProviderId): string {
  return provider === "codex"
    ? "ChatGPT / Codex"
    : USAGE_LIMIT_PROVIDER_PRESENTATION[provider].label;
}

export function formatUsagePercent(usedPercent: number): string {
  return `${Math.round(usedPercent)}%`;
}

export function formatUsageReset(resetsAt: number | null): string | null {
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

export type UsageLimitWindowKind = "session" | "weekly" | "monthly";

export function usageWindowLabel(kind: UsageLimitWindowKind): string {
  switch (kind) {
    case "session":
      return "5-hour";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
  }
}

/** A snapshot only advances on polls; past this age we date it prominently. */
const USAGE_LIMIT_STALE_AFTER_MS = 30 * 60 * 1000;

export function formatUsageUpdatedAt(
  updatedAt: number,
  now: number = Date.now(),
): { readonly text: string; readonly isStale: boolean } | null {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  const elapsedMs = Math.max(0, now - updatedAt);
  const isStale = elapsedMs >= USAGE_LIMIT_STALE_AFTER_MS;
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return { text: "Updated just now", isStale };
  if (minutes < 60) return { text: `Updated ${minutes}m ago`, isStale };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { text: `Updated ${hours}h ago`, isStale };
  return { text: `Updated ${Math.floor(hours / 24)}d ago`, isStale };
}

/** The window each pill surfaces by default (provider-preferred ordering). */
export function primaryPillWindow(limits: ProviderUsageLimits): UsageLimitWindow | null {
  const preferSession =
    limits.provider === "claude" ||
    limits.provider === "antigravity" ||
    Boolean(limits.session && !limits.weekly && !limits.monthly);
  if (preferSession) {
    return limits.session ?? limits.weekly ?? limits.monthly ?? null;
  }
  return limits.weekly ?? limits.monthly ?? limits.session ?? null;
}
