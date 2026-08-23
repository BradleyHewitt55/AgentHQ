// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Serializes application-owned codex spawns per credential home.
 *
 * Codex OAuth uses rotating refresh tokens in auth.json. Two app-owned codex
 * processes refreshing the same home concurrently can consume one rotation
 * twice and invalidate the stored credential, so quota probes serialize with
 * each other per resolved home. User-driven terminal sessions are not
 * serialized here.
 */
const lockTails = new Map<string, Promise<unknown>>();

function normalizeHomeKey(codexHomePath?: string | null): string {
  return (
    codexHomePath ??
    process.env.CODEX_HOME ??
    NodePath.join(NodeOS.homedir(), ".codex")
  ).toLowerCase();
}

export function resolveCodexHomeProcessLockKey(codexHomePath?: string | null): string {
  return normalizeHomeKey(codexHomePath);
}

export async function withCodexHomeProcessLock<T>(
  lockKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = lockTails.get(lockKey) ?? Promise.resolve();
  const run = prior.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  lockTails.set(lockKey, tail);
  void tail.finally(() => {
    if (lockTails.get(lockKey) === tail) {
      lockTails.delete(lockKey);
    }
  });
  return run;
}
