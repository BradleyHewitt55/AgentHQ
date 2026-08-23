export const CODEX_SESSION_WINDOW_MINUTES = 300;
export const CODEX_WEEKLY_WINDOW_MINUTES = 10_080;

/** Older app-server builds report canonical bucket lengths off by a minute. */
const DURATION_TOLERANCE_MINUTES = 1;

export type CodexRateWindowSnapshot = {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
};

export type CodexRateLimitWindowsSnapshot = {
  primary?: CodexRateWindowSnapshot | null;
  secondary?: CodexRateWindowSnapshot | null;
};

type MappableWindow = CodexRateWindowSnapshot & { usedPercent: number };

function isMappable(raw: CodexRateWindowSnapshot | null | undefined): raw is MappableWindow {
  return typeof raw?.usedPercent === "number" && Number.isFinite(raw.usedPercent);
}

function classifyDuration(raw: MappableWindow): "session" | "weekly" | null {
  const duration = raw.windowDurationMins;
  if (typeof duration !== "number" || !Number.isFinite(duration)) return null;
  if (Math.abs(duration - CODEX_SESSION_WINDOW_MINUTES) <= DURATION_TOLERANCE_MINUTES) {
    return "session";
  }
  if (Math.abs(duration - CODEX_WEEKLY_WINDOW_MINUTES) <= DURATION_TOLERANCE_MINUTES) {
    return "weekly";
  }
  return null;
}

/**
 * Classifies Codex's primary/secondary windows into session/weekly by their
 * reported duration instead of trusting the field order; unknown durations
 * keep the legacy primary=session, secondary=weekly mapping.
 */
export function classifyCodexRateLimitWindows(
  result: CodexRateLimitWindowsSnapshot | null | undefined,
): {
  session: MappableWindow | null;
  weekly: MappableWindow | null;
} {
  const primary = isMappable(result?.primary) ? result.primary : null;
  const secondary = isMappable(result?.secondary) ? result.secondary : null;
  let session: MappableWindow | null = null;
  let weekly: MappableWindow | null = null;
  for (const window of [primary, secondary]) {
    if (!window) continue;
    const kind = classifyDuration(window);
    if (kind === "session" && !session) session = window;
    else if (kind === "weekly" && !weekly) weekly = window;
  }
  if (!session && primary && classifyDuration(primary) === null) session = primary;
  if (!weekly && secondary && classifyDuration(secondary) === null) weekly = secondary;
  return { session, weekly };
}
