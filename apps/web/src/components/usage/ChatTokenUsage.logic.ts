import type { UsageProviderKind } from "@t3tools/contracts";
import type { ProviderTotals } from "@t3tools/shared/usageMerge";

export const CHAT_TOKEN_PROVIDER_ORDER = [
  "claude",
  "codex",
] as const satisfies readonly UsageProviderKind[];

export interface ChatTokenProviderBreakdown {
  readonly provider: UsageProviderKind;
  readonly totalTokens: number;
  readonly share: number;
  /** Whether this provider contributed a transcript bucket in the selected range. */
  readonly reported: boolean;
}

/**
 * Keeps the chat-token comparison stable when one provider has no transcript
 * activity. A missing provider is different from zero total usage overall, so
 * callers can explain that its transcript data was not reported for the range.
 */
export function chatTokenProviderBreakdown(
  totalTokens: number,
  providers: readonly ProviderTotals[],
) {
  const byProvider = new Map(providers.map((provider) => [provider.provider, provider]));

  return CHAT_TOKEN_PROVIDER_ORDER.map((provider) => {
    const reported = byProvider.get(provider);
    const providerTokens = reported?.totalTokens ?? 0;
    return {
      provider,
      totalTokens: providerTokens,
      share: totalTokens === 0 ? 0 : providerTokens / totalTokens,
      reported: reported !== undefined,
    };
  });
}
