// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

/**
 * Claude OAuth credential reading.
 *
 * Claude Code owns credential refresh; the usage integration only *reads*.
 * Sources, in Orca's order:
 *   1. macOS Keychain scoped by CLAUDE_CONFIG_DIR (Claude Code 2.1+)
 *   2. legacy unscoped macOS Keychain item
 *   3. `<config dir>/.credentials.json` (Linux/Windows and older CLIs)
 *
 * API keys (`ANTHROPIC_API_KEY`, `apiKeyHelper`) are deliberately not
 * credentials here: they bill per token, which is not subscription quota, and
 * they 401 against the OAuth usage endpoint.
 */

export type ClaudeCredentialSource = "scoped-keychain" | "legacy-keychain" | "credentials-file";

export type ClaudeOAuthCredentials = {
  token: string | null;
  hasRefreshableCredentials: boolean;
  source: ClaudeCredentialSource | "none";
  keychainUnavailable?: boolean;
};

type ClaudeKeychainCredentials = {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
};

export function parseClaudeCredentialsJson(
  raw: string,
  source: ClaudeCredentialSource,
): ClaudeOAuthCredentials {
  try {
    const parsed = JSON.parse(raw) as ClaudeKeychainCredentials;
    const oauth = parsed?.claudeAiOauth;
    const refreshToken =
      typeof oauth?.refreshToken === "string" && oauth.refreshToken.trim() !== ""
        ? oauth.refreshToken
        : null;
    if (!oauth || typeof oauth.accessToken !== "string" || oauth.accessToken === "") {
      return { token: null, hasRefreshableCredentials: refreshToken !== null, source };
    }
    // A locally-expired access token is still sent: /api/oauth/usage accepts
    // expired creds and the CLI refreshes on its next run regardless.
    return { token: oauth.accessToken, hasRefreshableCredentials: refreshToken !== null, source };
  } catch {
    return { token: null, hasRefreshableCredentials: false, source: "none" };
  }
}

export type ReadClaudeKeychain = (
  configDir: string | undefined,
) => Promise<string | null | undefined>;

async function readMacOSKeychainService(
  service: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  if (platform !== "darwin") return null;
  // Claude Code stores its OAuth blob as a generic password; 2.1+ scopes the
  // service name by config dir.
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-w"],
      { encoding: "utf-8", timeout: 5_000 },
    );
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function readFromKeychain(
  configDir: string | undefined,
  options: {
    platform?: NodeJS.Platform | undefined;
    readKeychain?: ReadClaudeKeychain | undefined;
  } = {},
): Promise<ClaudeOAuthCredentials> {
  const platform = options.platform ?? "darwin";
  const readImpl =
    options.readKeychain ??
    ((dir: string | undefined) =>
      readMacOSKeychainService(
        dir ? `Claude Code-credentials ${dir}` : "Claude Code-credentials",
        platform,
      ));
  try {
    if (configDir) {
      const scopedRaw = await readImpl(configDir);
      const legacyRaw = await readImpl(undefined);
      const scoped = scopedRaw
        ? parseClaudeCredentialsJson(scopedRaw, "scoped-keychain")
        : { token: null, hasRefreshableCredentials: false, source: "scoped-keychain" as const };
      const legacy = legacyRaw
        ? parseClaudeCredentialsJson(legacyRaw, "legacy-keychain")
        : { token: null, hasRefreshableCredentials: false, source: "legacy-keychain" as const };
      // A real legacy token beats refresh-only creds: this app cannot refresh
      // Claude credentials, so a stale scoped item must not shadow a working
      // legacy token.
      if (scoped.token) return scoped;
      if (legacy.token) return legacy;
      if (scoped.hasRefreshableCredentials) return scoped;
      if (legacy.hasRefreshableCredentials) return legacy;
      return scoped;
    }
    const raw = await readImpl(undefined);
    return raw
      ? parseClaudeCredentialsJson(raw, "legacy-keychain")
      : { token: null, hasRefreshableCredentials: false, source: "none" };
  } catch {
    return {
      token: null,
      hasRefreshableCredentials: false,
      source: "none",
      keychainUnavailable: true,
    };
  }
}

export async function readFromCredentialsFile(
  configDir: string | undefined,
  readText: (path: string) => Promise<string> = (p) => NodeFSP.readFile(p, "utf-8"),
): Promise<ClaudeOAuthCredentials> {
  const credPath = NodePath.join(
    configDir ?? NodePath.join(NodeOS.homedir(), ".claude"),
    ".credentials.json",
  );
  try {
    return parseClaudeCredentialsJson(await readText(credPath), "credentials-file");
  } catch {
    return { token: null, hasRefreshableCredentials: false, source: "none" };
  }
}

export async function readClaudeOAuthCredentials(input: {
  configDir?: string | undefined;
  platform: NodeJS.Platform;
  readKeychain?: ReadClaudeKeychain | undefined;
  readText?: ((path: string) => Promise<string>) | undefined;
}): Promise<ClaudeOAuthCredentials> {
  const fromKeychain = await readFromKeychain(input.configDir, {
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.readKeychain ? { readKeychain: input.readKeychain } : {}),
  });
  if (fromKeychain.token || fromKeychain.hasRefreshableCredentials) {
    return fromKeychain;
  }
  const fromFile = await readFromCredentialsFile(input.configDir, input.readText);
  if (fromFile.token || fromFile.hasRefreshableCredentials) {
    return fromFile;
  }
  return fromKeychain.keychainUnavailable ? fromKeychain : fromFile;
}
