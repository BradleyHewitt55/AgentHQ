import type { ProviderUsageLimits } from "@t3tools/contracts";

/**
 * Antigravity usage is never queried directly: the CLI keeps its token in the
 * OS keyring and shares Google Code Assist quota with Gemini CLI. Only a
 * *successful* quota read describes shared quota, so a Gemini failure must not
 * surface as an Antigravity request failure that was never made.
 */

const NO_SIGN_IN_REASON =
  "Antigravity usage is unavailable: shared Google Code Assist quota requires a Gemini CLI sign-in.";
const QUOTA_UNREADABLE_REASON =
  "Antigravity usage is unavailable: the shared Google Code Assist quota could not be read right now.";

export function deriveAntigravityRateLimits(
  geminiResult: ProviderUsageLimits,
): ProviderUsageLimits {
  if (geminiResult.provider !== "antigravity") {
    return {
      provider: "antigravity",
      session: null,
      weekly: null,
      updatedAt: 0,
      error: NO_SIGN_IN_REASON,
      status: "unavailable",
    };
  }
  if (geminiResult.status === "ok") {
    return geminiResult;
  }
  return {
    provider: "antigravity",
    session: null,
    weekly: null,
    buckets: undefined,
    // Reuse the source timestamp so activation freshness checks do not force
    // an independent refetch loop for the mirrored provider.
    updatedAt: geminiResult.updatedAt,
    error: geminiResult.status === "unavailable" ? NO_SIGN_IN_REASON : QUOTA_UNREADABLE_REASON,
    status: "unavailable",
  };
}
