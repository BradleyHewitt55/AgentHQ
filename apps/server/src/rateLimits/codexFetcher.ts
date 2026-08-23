// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics no-global-process-runtime:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalFetch:off
import * as NodeChildProcess from "node:child_process";
import type { ProviderUsageLimits, UsageLimitResetCredits } from "@t3tools/contracts";

import { probeCodexAuthPresence, readCodexAuthFile } from "./codexAuthPresence.ts";
import {
  CODEX_SESSION_WINDOW_MINUTES,
  classifyCodexRateLimitWindows,
  type CodexRateWindowSnapshot,
  type CodexRateLimitWindowsSnapshot,
  CODEX_WEEKLY_WINDOW_MINUTES,
} from "./codexWindowClassification.ts";
import {
  resolveCodexHomeProcessLockKey,
  withCodexHomeProcessLock,
} from "./codexHomeProcessLock.ts";
import { SESSION_WINDOW_MINUTES, usageWindow, WEEKLY_WINDOW_MINUTES } from "./usageWindows.ts";

/**
 * Codex subscription usage, mirroring the Codex CLI's own contracts:
 *   A. ChatGPT backend `wham/usage` (cheap; no subprocess) — preferred for
 *      remote-style homes and used to fill missing windows after RPC probes.
 *   B. Read-only `codex app-server` JSON-RPC probe (`account/rateLimits/read`).
 *   C. Hidden-PTY `/status` reader on non-Windows platforms only.
 *
 * Probes run real codex processes that may refresh the rotating refresh token
 * in auth.json, so every spawn is serialized through the per-home lock.
 */

const RPC_TIMEOUT_MS = 10_000;
const RPC_INIT_TIMEOUT_MS = 30_000;
const PTY_TIMEOUT_MS = 15_000;
const PTY_STATUS_NUDGE_MS = 2_500;
const PTY_STATUS_ENTER_DELAY_MS = 350;
const PTY_STATUS_ENTER_RETRY_MS = 3_000;
const BACKEND_TIMEOUT_MS = 10_000;
const MAX_DIAGNOSTIC_OUTPUT_LENGTH = 100_000;

// The config override replaces legacy values before Codex validates config.toml.
export const CODEX_READ_ONLY_APP_SERVER_ARGS = [
  "-c",
  "approval_policy=never",
  "-s",
  "read-only",
  "-a",
  "never",
  "app-server",
] as const;

export type FetchCodexRateLimitsOptions = {
  codexHomePath?: string | null;
  codexBinaryPath?: string | null;
  allowPtyFallback?: boolean;
  /** Injected host platform (HostProcessPlatform); never read globally. */
  platform: NodeJS.Platform;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

function abortedResult(): ProviderUsageLimits {
  return {
    provider: "codex",
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: "Rate-limit fetch aborted",
    status: "error",
  };
}

function errorResult(
  error: string,
  status: ProviderUsageLimits["status"] = "error",
): ProviderUsageLimits {
  return { provider: "codex", session: null, weekly: null, updatedAt: Date.now(), error, status };
}

function resolveCodexHome(codexHomePath?: string | null): string {
  return codexHomePath ?? process.env.CODEX_HOME ?? "";
}

// ---------------------------------------------------------------------------
// Reset credits
// ---------------------------------------------------------------------------

type RawResetCredits = {
  availableCount?: unknown;
  totalEarnedCount?: unknown;
  nextExpiresAt?: unknown;
  credits?: { status?: unknown; expiresAt?: unknown; grantedAt?: unknown }[] | null;
};

function parseCreditTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nextAvailableExpiry(
  credits: { status: string; expiresAt: number | null }[] | undefined,
): number | null {
  const expiries =
    credits
      ?.filter((credit) => credit.status === "available")
      .map((credit) => credit.expiresAt)
      .filter((expiresAt): expiresAt is number => expiresAt !== null)
      .sort((a, b) => a - b) ?? [];
  return expiries[0] ?? null;
}

export function mapResetCredits(
  raw: RawResetCredits | null | undefined,
): UsageLimitResetCredits | null | undefined {
  if (!raw) return raw as null | undefined;
  const credits = raw.credits?.map((credit) => ({
    status: typeof credit.status === "string" ? credit.status.toLowerCase() : "unknown",
    expiresAt: parseCreditTimestamp(credit.expiresAt),
    grantedAt: parseCreditTimestamp(credit.grantedAt),
  }));
  // Both camelCase (app-server) and snake_case (backend) shapes are accepted;
  // the available count may be derived from the credit list itself.
  let availableCount: number | null = null;
  for (const candidate of [
    raw.availableCount,
    (raw as { available_count?: unknown }).available_count,
  ]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      availableCount = Math.max(0, Math.floor(candidate));
      break;
    }
  }
  if (availableCount === null && credits) {
    availableCount = Math.max(0, credits.filter((credit) => credit.status === "available").length);
  }
  if (availableCount === null) return null;
  return {
    availableCount,
    ...(typeof raw.totalEarnedCount === "number" && Number.isFinite(raw.totalEarnedCount)
      ? { totalEarnedCount: Math.max(0, Math.floor(raw.totalEarnedCount)) }
      : {}),
    nextExpiresAt: parseCreditTimestamp(raw.nextExpiresAt) ?? nextAvailableExpiry(credits),
    ...(credits ? { credits } : {}),
  };
}

function hasCompleteResetCredits(credits: UsageLimitResetCredits | null | undefined): boolean {
  return Boolean(credits && (credits.availableCount === 0 || credits.nextExpiresAt != null));
}

// ---------------------------------------------------------------------------
// Backend (chatgpt.com wham)
// ---------------------------------------------------------------------------

type BackendWindow = { used_percent?: number; limit_window_seconds?: number; reset_at?: number };

type BackendUsageResponse = {
  plan_type?: string;
  rate_limit?: {
    primary_window?: BackendWindow | null;
    secondary_window?: BackendWindow | null;
  } | null;
  rate_limit_reset_credits?: RawResetCredits | null;
};

function backendWindowToSnapshot(
  raw: BackendWindow | null | undefined,
): CodexRateWindowSnapshot | null {
  if (!raw) return null;
  return {
    usedPercent: raw.used_percent,
    windowDurationMins:
      typeof raw.limit_window_seconds === "number" && raw.limit_window_seconds > 0
        ? Math.ceil(raw.limit_window_seconds / 60)
        : undefined,
    resetsAt: raw.reset_at,
  };
}

function snapshotToWindow(
  snapshot: CodexRateWindowSnapshot | null,
  fallbackMinutes: number,
): ProviderUsageLimits["session"] {
  if (
    !snapshot ||
    typeof snapshot.usedPercent !== "number" ||
    !Number.isFinite(snapshot.usedPercent)
  ) {
    return null;
  }
  const minutes =
    typeof snapshot.windowDurationMins === "number" && snapshot.windowDurationMins > 0
      ? snapshot.windowDurationMins
      : fallbackMinutes;
  return usageWindow({
    usedPercent: snapshot.usedPercent,
    windowMinutes: minutes,
    resetsAt: typeof snapshot.resetsAt === "number" ? snapshot.resetsAt : null,
  });
}

async function getBackendAuthHeaders(
  options: FetchCodexRateLimitsOptions,
): Promise<Record<string, string> | null> {
  const auth = await readCodexAuthFile(options.codexHomePath);
  const accessToken = auth?.tokens?.access_token;
  if (!accessToken) return null;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "codex-cli",
    "OpenAI-Beta": "codex-1",
    originator: "Codex Desktop",
  };
  if (auth.tokens?.account_id) headers["ChatGPT-Account-Id"] = auth.tokens.account_id;
  return headers;
}

export async function fetchCodexBackendUsage(
  options: FetchCodexRateLimitsOptions,
): Promise<ProviderUsageLimits | null> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(BACKEND_TIMEOUT_MS)])
    : AbortSignal.timeout(BACKEND_TIMEOUT_MS);
  const headers = await getBackendAuthHeaders(options);
  if (!headers || signal.aborted) return null;
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch("https://chatgpt.com/backend-api/wham/usage", { headers, signal });
  if (!response.ok) return null;
  const payload = (await response.json()) as BackendUsageResponse;
  // Missing plan_type means an unexpected contract shape; let other paths answer.
  if (typeof payload.plan_type !== "string") return null;
  const classified = classifyCodexRateLimitWindows({
    primary: backendWindowToSnapshot(payload.rate_limit?.primary_window),
    secondary: backendWindowToSnapshot(payload.rate_limit?.secondary_window),
  });
  const resetCredits = mapResetCredits(payload.rate_limit_reset_credits);
  return {
    provider: "codex",
    session: snapshotToWindow(classified.session, SESSION_WINDOW_MINUTES),
    weekly: snapshotToWindow(classified.weekly, WEEKLY_WINDOW_MINUTES),
    planType: payload.plan_type,
    ...(resetCredits !== undefined ? { rateLimitResetCredits: resetCredits } : {}),
    updatedAt: Date.now(),
    error: null,
    status: "ok",
  };
}

/** Supplements missing reset-credit metadata from the dedicated backend view. */
async function withBackendResetCredits(
  limits: ProviderUsageLimits,
  options: FetchCodexRateLimitsOptions,
): Promise<ProviderUsageLimits> {
  if (options.signal?.aborted || hasCompleteResetCredits(limits.rateLimitResetCredits)) {
    return limits;
  }
  try {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(BACKEND_TIMEOUT_MS)])
      : AbortSignal.timeout(BACKEND_TIMEOUT_MS);
    const headers = await getBackendAuthHeaders(options);
    if (!headers || signal.aborted) return limits;
    const doFetch = options.fetchImpl ?? fetch;
    const response = await doFetch(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      {
        headers,
        signal,
      },
    );
    if (!response.ok) return limits;
    const payload = (await response.json()) as RawResetCredits;
    const mapped = mapResetCredits(payload);
    return mapped ? { ...limits, rateLimitResetCredits: mapped } : limits;
  } catch {
    return limits;
  }
}

/** Fills a missing session window from the backend when RPC returned weekly-only. */
async function withBackendSessionWindow(
  limits: ProviderUsageLimits,
  options: FetchCodexRateLimitsOptions,
): Promise<ProviderUsageLimits> {
  if (options.signal?.aborted || limits.session || !limits.weekly) return limits;
  try {
    const backend = await fetchCodexBackendUsage(options);
    if (!backend?.session) return limits;
    return {
      ...limits,
      session: backend.session,
      weekly: backend.weekly ?? limits.weekly,
      planType: backend.planType ?? limits.planType,
      ...((backend.rateLimitResetCredits ?? limits.rateLimitResetCredits)
        ? {
            rateLimitResetCredits:
              backend.rateLimitResetCredits ?? limits.rateLimitResetCredits ?? null,
          }
        : {}),
      updatedAt: backend.updatedAt,
    };
  } catch {
    return limits;
  }
}

// ---------------------------------------------------------------------------
// RPC probe — read-only `codex app-server`
// ---------------------------------------------------------------------------

type RpcResponse = { id?: number; result?: unknown; error?: { code: number; message: string } };

type RpcRateLimitsResponse = {
  rateLimits?: CodexRateLimitWindowsSnapshot | null;
  rateLimitResetCredits?: RawResetCredits | null;
};

/** Routes .cmd/.bat launchers through cmd.exe on Windows (shell:true is unsafe). */
function resolveSpawnTarget(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
): { file: string; args: string[] } {
  if (platform === "win32" && /\.cmd$/i.test(command)) {
    return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/c", command, ...args] };
  }
  return { file: command, args: [...args] };
}

function buildWslCommand(
  homePath: string,
  args: readonly string[],
  platform: NodeJS.Platform,
): { file: string; args: string[] } | null {
  // A UNC home (\\wsl$\<distro>\...) means the credential store lives inside a
  // distro; run the probe there rather than against host installs.
  if (platform !== "win32") return null;
  const match = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\(.+)$/i.exec(homePath);
  if (!match) return null;
  const winPath: string = match[2] ?? "";
  const linuxPath = `/mnt/${winPath.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => drive.toLowerCase())}`;
  return {
    file: "wsl.exe",
    args: [
      "--exec",
      "sh",
      "-c",
      `CODEX_HOME='${linuxPath.replaceAll("'", `'\\''`)}' exec ${args.join(" ")}`,
    ],
  };
}

function fetchViaRpc(options: FetchCodexRateLimitsOptions): Promise<ProviderUsageLimits> {
  if (options.signal?.aborted) return Promise.resolve(abortedResult());
  return new Promise<ProviderUsageLimits>((resolve) => {
    let buffer = "";
    let stderr = "";
    let resolved = false;
    let rpcId = 0;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const command = options.codexBinaryPath?.trim() || "codex";
    const wsl = options.codexHomePath
      ? buildWslCommand(options.codexHomePath, CODEX_READ_ONLY_APP_SERVER_ARGS, options.platform)
      : null;
    const initTimeoutMs = wsl ? RPC_INIT_TIMEOUT_MS + 10_000 : RPC_INIT_TIMEOUT_MS;
    const rpcTimeoutMs = wsl ? RPC_TIMEOUT_MS + 15_000 : RPC_TIMEOUT_MS;
    const target = wsl
      ? { file: wsl.file, args: wsl.args }
      : resolveSpawnTarget(command, CODEX_READ_ONLY_APP_SERVER_ARGS, options.platform);

    const child = NodeChildProcess.spawn(target.file, target.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: wsl
        ? process.env
        : {
            ...process.env,
            ...(options.codexHomePath ? { CODEX_HOME: options.codexHomePath } : {}),
          },
    });

    function cleanup(): void {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout.off("data", onData);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
    }

    function killChild(): Promise<void> {
      return new Promise((done) => {
        if (child.exitCode !== null || child.killed) {
          done();
          return;
        }
        child.once("exit", () => done());
        child.kill();
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
          done();
        }, 2_000);
      });
    }

    function settle(result: ProviderUsageLimits, kill = true): void {
      if (resolved) return;
      resolved = true;
      cleanup();
      if (kill) {
        void killChild().then(
          () => resolve(result),
          () => resolve(result),
        );
        return;
      }
      resolve(result);
    }

    function armDeadline(ms: number, message: string): void {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => settle({ ...errorResult(message) }), ms);
    }

    async function onAbort(): Promise<void> {
      settle(abortedResult());
    }
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    armDeadline(initTimeoutMs, "RPC timeout");

    function send(method: string, params?: unknown): number {
      const id = ++rpcId;
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`,
      );
      return id;
    }

    child.stdin.on("error", onError);
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_DIAGNOSTIC_OUTPUT_LENGTH)
        stderr = stderr.slice(-MAX_DIAGNOSTIC_OUTPUT_LENGTH);
    });
    child.on("error", onError);
    child.on("close", onClose);

    let initId: number;
    let rateLimitsId: number | null = null;
    try {
      initId = send("initialize", { clientInfo: { name: "t3code", version: "1.0.0" } });
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    function onData(chunk: Buffer): void {
      buffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        let msg: RpcResponse;
        try {
          msg = JSON.parse(line) as RpcResponse;
        } catch {
          continue;
        }
        if (msg.id == null) continue;
        if (msg.id === initId) {
          // Boot/auth-refresh budget ends here; the read gets its own deadline.
          armDeadline(rpcTimeoutMs, "RPC timeout");
          try {
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
            );
            rateLimitsId = send("account/rateLimits/read");
          } catch (error) {
            onError(error instanceof Error ? error : new Error(String(error)));
          }
          continue;
        }
        if (rateLimitsId !== null && msg.id === rateLimitsId) {
          if (resolved) return;
          if (msg.error) {
            settle({ ...errorResult(msg.error.message) });
            return;
          }
          const wrapper = msg.result as RpcRateLimitsResponse | undefined;
          const classified = classifyCodexRateLimitWindows(wrapper?.rateLimits);
          const resetCredits = mapResetCredits(wrapper?.rateLimitResetCredits);
          settle({
            provider: "codex",
            session: snapshotToWindow(classified.session, CODEX_SESSION_WINDOW_MINUTES),
            weekly: snapshotToWindow(classified.weekly, CODEX_WEEKLY_WINDOW_MINUTES),
            ...(resetCredits !== undefined ? { rateLimitResetCredits: resetCredits } : {}),
            updatedAt: Date.now(),
            error: null,
            status: "ok",
          });
          return;
        }
      }
    }

    function onStderr(): void {
      // diagnostic only
    }

    function onError(err: Error): void {
      const isEnoent = (err as NodeJS.ErrnoException).code === "ENOENT";
      settle(
        isEnoent && command === "codex"
          ? { ...errorResult("Codex CLI not found", "unavailable") }
          : { ...errorResult(err.message) },
      );
    }

    function onClose(): void {
      settle({ ...errorResult("RPC process exited unexpectedly") }, false);
    }
  });
}

// ---------------------------------------------------------------------------
// PTY fallback — hidden interactive codex, `/status`
// ---------------------------------------------------------------------------

// Matches the /status rows ("5h limit"/"Weekly limit"), tolerating meter bars
// between label and percent; the lookbehind rejects model-scoped rows.
const FIVE_HOUR_RE = /(?<![\w-][^\S\r\n]{0,4})5h\s+limit[^\d%\r\n]*(\d+)%(?:\s*(used|left))?/i;
const WEEKLY_RE = /(?<![\w-][^\S\r\n]{0,4})weekly\s+limit[^\d%\r\n]*(\d+)%(?:\s*(used|left))?/i;
// eslint-disable-next-line no-control-regex
const PTY_CONTROL_SEQUENCE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function stripPtyControlSequences(output: string): string {
  return output.replace(PTY_CONTROL_SEQUENCE_RE, "");
}

function ptyUsedPercent(match: RegExpExecArray): number {
  const pct = Number.parseInt(match[1] ?? "", 10);
  const oriented = match[2]?.toLowerCase() === "left" ? 100 - pct : pct;
  return Math.min(100, Math.max(0, oriented));
}

/** Parses `% used` and `% left` orientations into canonical consumed percent. */
export function parsePtyStatusOutput(output: string): {
  session: ProviderUsageLimits["session"];
  weekly: ProviderUsageLimits["weekly"];
} {
  const clean = stripPtyControlSequences(output);
  const fiveMatch = FIVE_HOUR_RE.exec(clean);
  const weeklyMatch = WEEKLY_RE.exec(clean);
  return {
    session: fiveMatch
      ? usageWindow({
          usedPercent: ptyUsedPercent(fiveMatch),
          windowMinutes: SESSION_WINDOW_MINUTES,
        })
      : null,
    weekly: weeklyMatch
      ? usageWindow({
          usedPercent: ptyUsedPercent(weeklyMatch),
          windowMinutes: WEEKLY_WINDOW_MINUTES,
        })
      : null,
  };
}

async function fetchViaPty(options: FetchCodexRateLimitsOptions): Promise<ProviderUsageLimits> {
  if (options.signal?.aborted) return abortedResult();
  const pty = await import("node-pty");
  if (options.signal?.aborted) return abortedResult();

  const command = options.codexBinaryPath?.trim() || "codex";
  const isWin32 = options.platform === "win32";
  const spawnFile = isWin32 ? (process.env.ComSpec ?? "cmd.exe") : command;
  const spawnArgs = isWin32 ? ["/d", "/c", command] : [];

  return new Promise<ProviderUsageLimits>((resolve) => {
    let output = "";
    let resolved = false;
    let sentStatus = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const term = pty.spawn(spawnFile, spawnArgs, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        ...(options.codexHomePath && !isWin32 ? { CODEX_HOME: options.codexHomePath } : {}),
      } as Record<string, string>,
    });

    function finish(result: ProviderUsageLimits): void {
      if (resolved) return;
      resolved = true;
      for (const timer of timers) clearTimeout(timer);
      if (settleTimer) clearTimeout(settleTimer);
      options.signal?.removeEventListener("abort", onAbort);
      dataDisposable.dispose();
      exitDisposable.dispose();
      try {
        term.kill();
      } catch {
        // already gone
      }
      resolve(result);
    }

    function onAbort(): void {
      finish(abortedResult());
    }
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    timers.push(setTimeout(() => finish({ ...errorResult("PTY timeout") }), PTY_TIMEOUT_MS));

    function sendStatusCommand(): void {
      sentStatus = true;
      term.write("/status");
      timers.push(
        setTimeout(() => {
          term.write("\r");
          timers.push(
            setTimeout(() => {
              if (!resolved && !settleTimer) term.write("\r");
            }, PTY_STATUS_ENTER_RETRY_MS),
          );
        }, PTY_STATUS_ENTER_DELAY_MS),
      );
    }

    const dataDisposable = term.onData((data: string) => {
      output += data;
      if (output.length > MAX_DIAGNOSTIC_OUTPUT_LENGTH)
        output = output.slice(-MAX_DIAGNOSTIC_OUTPUT_LENGTH);
      if (!sentStatus && /[>›]\s*$/.test(data)) {
        sendStatusCommand();
        return;
      }
      if (sentStatus && !settleTimer) {
        const probe = stripPtyControlSequences(output);
        if (FIVE_HOUR_RE.test(probe) || WEEKLY_RE.test(probe)) {
          // Let the panel finish flushing before parsing.
          settleTimer = setTimeout(() => {
            const { session, weekly } = parsePtyStatusOutput(output);
            finish({
              provider: "codex",
              session,
              weekly,
              updatedAt: Date.now(),
              error: session || weekly ? null : "Failed to parse CLI output",
              status: session || weekly ? "ok" : "error",
            });
          }, 500);
        }
      }
    });

    const exitDisposable = term.onExit(() => {
      const { session, weekly } = parsePtyStatusOutput(output);
      finish({
        provider: "codex",
        session,
        weekly,
        updatedAt: Date.now(),
        error: session || weekly ? null : "CLI exited before status was available",
        status: session || weekly ? "ok" : "error",
      });
    });

    timers.push(
      setTimeout(() => {
        if (!sentStatus && !resolved) sendStatusCommand();
      }, PTY_STATUS_NUDGE_MS),
    );
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchCodexRateLimits(
  options: FetchCodexRateLimitsOptions,
): Promise<ProviderUsageLimits> {
  if (options.signal?.aborted) return abortedResult();

  const presenceProbeOptions = options.signal ? { signal: options.signal } : {};
  const authPresence = await probeCodexAuthPresence(options.codexHomePath, presenceProbeOptions);
  if (options.signal?.aborted) return abortedResult();
  if (authPresence !== "present") {
    return authPresence === "absent"
      ? errorResult("Codex not signed in", "unavailable")
      : errorResult(
          authPresence === "timeout"
            ? "Timed out while checking Codex sign-in status"
            : "Codex sign-in status is unavailable",
        );
  }

  // Remote-style homes (e.g. a WSL UNC path) skip subprocess spawning entirely:
  // the backend request answers without waking a login shell every poll.
  const homePath = resolveCodexHome(options.codexHomePath);
  const isRemoteStyleHome = Boolean(
    options.codexHomePath && /\\\\wsl(?:\$|\.localhost)\\/i.test(options.codexHomePath),
  );
  if (isRemoteStyleHome) {
    try {
      const backend = await fetchCodexBackendUsage(options);
      if (options.signal?.aborted) return abortedResult();
      if (backend) return await withBackendResetCredits(backend, options);
    } catch {
      // Token/routing differences can make the backend fail where CLI succeeds.
    }
  }

  const homeLockKey = resolveCodexHomeProcessLockKey(homePath || undefined);
  try {
    const rpcResult = await withCodexHomeProcessLock(homeLockKey, () => fetchViaRpc(options));
    if (options.signal?.aborted) return abortedResult();
    if (rpcResult.status === "ok" || rpcResult.status === "unavailable") {
      const withSession = await withBackendSessionWindow(rpcResult, options);
      return await withBackendResetCredits(withSession, options);
    }
    if (/not signed in|unauthorized/i.test(rpcResult.error ?? "")) return rpcResult;
    if (options.allowPtyFallback === false) return rpcResult;
  } catch {
    if (options.signal?.aborted) return abortedResult();
    if (options.allowPtyFallback === false) return errorResult("RPC failed");
  }

  // Hidden-PTY fallback is unreliable inside ConPTY on Windows; degrade to RPC.
  if (options.platform === "win32") {
    return errorResult("Codex CLI not found or could not be probed");
  }
  try {
    const ptyResult = await withCodexHomeProcessLock(homeLockKey, () => fetchViaPty(options));
    if (options.signal?.aborted) return abortedResult();
    const withSession = await withBackendSessionWindow(ptyResult, options);
    return await withBackendResetCredits(withSession, options);
  } catch (err) {
    if (options.signal?.aborted) return abortedResult();
    const message = err instanceof Error ? err.message : "Unknown error";
    return message.includes("ENOENT")
      ? errorResult("Codex CLI not found", "unavailable")
      : errorResult(message);
  }
}
