import type { ProviderTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "@effect/vitest";

import { chatTokenProviderBreakdown } from "./ChatTokenUsage.logic";

function provider(
  overrides: Partial<ProviderTotals> & Pick<ProviderTotals, "provider">,
): ProviderTotals {
  return {
    costUsd: 0,
    totalTokens: 0,
    records: 0,
    costShare: 0,
    tokenShare: 0,
    ...overrides,
  };
}

describe("chatTokenProviderBreakdown", () => {
  it("always presents Claude and Codex for a direct comparison", () => {
    expect(
      chatTokenProviderBreakdown(1_000, [provider({ provider: "codex", totalTokens: 1_000 })]),
    ).toEqual([
      { provider: "claude", totalTokens: 0, share: 0, reported: false },
      { provider: "codex", totalTokens: 1_000, share: 1, reported: true },
    ]);
  });

  it("uses the merged chat-token total for provider shares", () => {
    expect(
      chatTokenProviderBreakdown(1_000, [
        provider({ provider: "claude", totalTokens: 250 }),
        provider({ provider: "codex", totalTokens: 750 }),
      ]).map(({ provider: kind, share }) => [kind, share]),
    ).toEqual([
      ["claude", 0.25],
      ["codex", 0.75],
    ]);
  });
});
