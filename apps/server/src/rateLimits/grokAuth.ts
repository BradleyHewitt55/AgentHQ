// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Grok CLI credential reading. The CLI owns token refresh; this module only
 * reads the same auth file the CLI writes (`$GROK_HOME/auth.json`, defaulting
 * to ~/.grok), preferring the standard xAI OAuth issuer when multiple entries
 * exist. File contents never leave this module — errors are pre-redacted.
 */

export type GrokAuthSession = {
  accessToken: string;
  userId: string | null;
  email: string | null;
  teamId: string | null;
  expiresAtMs: number | null;
};

export type GrokAuthReadResult =
  | { status: "missing" }
  | { status: "error"; error: string }
  | { status: "ok"; session: GrokAuthSession };

export function resolveGrokHome(homeDir = NodeOS.homedir()): string {
  return process.env.GROK_HOME?.trim() || NodePath.join(homeDir, ".grok");
}

export function resolveGrokAuthPath(homeDir = NodeOS.homedir()): string {
  return NodePath.join(resolveGrokHome(homeDir), "auth.json");
}

type GrokAuthEntry = {
  key?: string;
  user_id?: string;
  email?: string;
  team_id?: string;
  expires_at?: string;
};

const TOKEN_SKEW_MS = 5 * 60 * 1000;
const PREFERRED_GROK_AUTH_ISSUER = "https://auth.x.ai";

export function isGrokAccessTokenFresh(session: GrokAuthSession, now = Date.now()): boolean {
  if (session.expiresAtMs === null) return true;
  return session.expiresAtMs - now > TOKEN_SKEW_MS;
}

function parseAuthEntry(value: unknown): GrokAuthSession | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as GrokAuthEntry;
  if (typeof entry.key !== "string" || entry.key.length === 0) return null;
  const expiresAtMs = entry.expires_at ? Date.parse(entry.expires_at) : Number.NaN;
  return {
    accessToken: entry.key,
    userId: typeof entry.user_id === "string" ? entry.user_id : null,
    email: typeof entry.email === "string" ? entry.email : null,
    teamId: typeof entry.team_id === "string" ? entry.team_id : null,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
  };
}

function isPreferredKey(key: string): boolean {
  return key === PREFERRED_GROK_AUTH_ISSUER || key.startsWith(`${PREFERRED_GROK_AUTH_ISSUER}::`);
}

/** Reads and classifies the Grok auth file without exposing its contents. */
export function readGrokAuthSession(
  options: { authPath?: string; now?: number } = {},
): GrokAuthReadResult {
  const authPath = options.authPath ?? resolveGrokAuthPath();
  if (!NodeFS.existsSync(authPath)) return { status: "missing" };
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(authPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) {
      return { status: "error", error: "Grok auth file is invalid" };
    }
    const now = options.now ?? Date.now();
    let preferredKeySeen = false;
    let expiredPreferred: GrokAuthSession | null = null;
    let fallback: GrokAuthSession | null = null;
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const preferred = isPreferredKey(key);
      preferredKeySeen ||= preferred;
      const session = parseAuthEntry(entry);
      if (!session) continue;
      if (preferred) {
        if (isGrokAccessTokenFresh(session, now)) return { status: "ok", session };
        expiredPreferred ??= session;
        continue;
      }
      fallback ??= session;
    }
    // Alternate issuers are compatibility fallbacks only when no default
    // xAI OAuth entry exists; a stale preferred entry still beats them.
    const selected = expiredPreferred ?? (preferredKeySeen ? null : fallback);
    if (selected) return { status: "ok", session: selected };
    return { status: "missing" };
  } catch {
    // Never surface filesystem paths or file contents.
    return { status: "error", error: "Unable to read Grok auth file" };
  }
}
