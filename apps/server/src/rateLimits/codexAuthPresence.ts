// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export type CodexAuthPresence = "present" | "absent" | "timeout" | "unavailable";

/**
 * Gates quota probes on sign-in presence: a signed-in Codex always writes
 * auth.json under its home, so without it we never spawn a background codex
 * process that could only fail.
 */
export async function probeCodexAuthPresence(
  codexHomePath?: string | null,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<CodexAuthPresence> {
  if (options?.signal?.aborted) return "timeout";
  const home = codexHomePath ?? process.env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex");
  const authPath = NodePath.join(home, "auth.json");
  const timeoutSignal = AbortSignal.timeout(options?.timeoutMs ?? 5_000);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  try {
    await NodeFSP.access(authPath);
    return "present";
  } catch (error) {
    void signal;
    if (options?.signal?.aborted || signal.aborted) return "timeout";
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unavailable";
  }
}

export type CodexAuthFile = {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
};

export async function readCodexAuthFile(
  codexHomePath?: string | null,
): Promise<CodexAuthFile | null> {
  const home = codexHomePath ?? process.env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex");
  try {
    const raw = await readFileWithTimeout(NodePath.join(home, "auth.json"));
    return JSON.parse(raw) as CodexAuthFile;
  } catch {
    return null;
  }
}

function readFileWithTimeout(path: string, timeoutMs = 5_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return import("node:fs/promises").then(
    (fs) =>
      fs
        .readFile(path, { signal: controller.signal } as Parameters<typeof fs.readFile>[1])
        .finally(() => clearTimeout(timer)) as Promise<string>,
  );
}
