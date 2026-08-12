import type { MergedUsage } from "@t3tools/shared/usageMerge";

import { formatCount, formatPercent, formatTokens } from "@t3tools/shared/usageFormat";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { ProviderMark } from "./ProviderMark";
import { chatTokenProviderBreakdown } from "./ChatTokenUsage.logic";
import { PROVIDER_COLOR, PROVIDER_LABEL } from "./usageProviders";

export function ChatTokenUsageSection({
  merged,
  environments,
  sinceDay,
  untilDay,
}: {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly sinceDay: string;
  readonly untilDay: string;
}) {
  const summaryCount = environments.filter((environment) => environment.summary !== null).length;
  const hasCurrentSummary = summaryCount > merged.staleEnvironments.length;
  const partialCoverage =
    hasCurrentSummary &&
    (merged.staleEnvironments.length > 0 ||
      environments.some((environment) => environment.error !== null));

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-4">
      <div>
        <h2 className="text-sm font-medium text-foreground">Chat token usage</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Transcript-derived chat tokens from {sinceDay} to {untilDay}, across connected
          environments.
        </p>
      </div>

      {!hasCurrentSummary ? (
        <p className="text-sm text-muted-foreground">
          Chat-token summaries are unavailable for the connected environments. No token total is
          shown.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs tracking-wide text-muted-foreground uppercase">
                Total chat tokens
              </span>
              <span className="text-3xl font-semibold text-foreground tabular-nums">
                {formatTokens(merged.totalTokens)}
              </span>
              <span className="text-xs text-muted-foreground">
                Input, cache reads, cache writes, and output across {formatCount(merged.sessions)}
                {merged.sessions === 1 ? " session" : " sessions"}.
              </span>
            </div>
            {partialCoverage ? (
              <span className="text-xs text-muted-foreground">
                Partial coverage; unavailable environments are excluded.
              </span>
            ) : null}
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Claude vs Codex
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {chatTokenProviderBreakdown(merged.totalTokens, merged.providers).map((provider) => (
                <div key={provider.provider} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="flex items-center gap-2 text-sm text-foreground">
                      <ProviderMark provider={provider.provider} className="size-4" />
                      {PROVIDER_LABEL[provider.provider]}
                    </span>
                    <span className="text-lg text-foreground tabular-nums">
                      {formatTokens(provider.totalTokens)}
                    </span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full"
                      style={{
                        width: `${(provider.share * 100).toFixed(1)}%`,
                        backgroundColor: PROVIDER_COLOR[provider.provider],
                      }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {provider.reported
                      ? `${formatPercent(provider.share)} of total chat tokens`
                      : "No transcript usage reported in this range"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            These transcript totals are separate from subscription-window consumption, shown in
            Subscription usage above.
          </p>
        </>
      )}
    </section>
  );
}
