import type { ProviderSubscriptionUsage } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import type { EnvironmentSubscriptionUsageStatus } from "../../state/subscriptionUsage";
import { ProviderMark } from "./ProviderMark";
import { PROVIDER_LABEL } from "./usageProviders";
import {
  formatSubscriptionPercent,
  formatSubscriptionReset,
  subscriptionWindowLabel,
} from "./SubscriptionUsage.logic";

function providerLabel(provider: ProviderSubscriptionUsage["provider"]): string {
  return provider === "codex" ? "ChatGPT / Codex" : PROVIDER_LABEL[provider];
}

function WindowMeter({
  kind,
  window,
  compact = false,
}: {
  readonly kind: "fiveHour" | "weekly";
  readonly window: NonNullable<ProviderSubscriptionUsage["fiveHour"]>;
  readonly compact?: boolean;
}) {
  return (
    <div className={cn("min-w-0", compact ? "w-20" : "flex-1")}>
      <div className="flex items-baseline justify-between gap-2 text-[11px] tabular-nums">
        <span className="truncate text-muted-foreground">
          {subscriptionWindowLabel(kind, window)}
        </span>
        <span className="text-foreground">{formatSubscriptionPercent(window.usedPercent)}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground/70"
          style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
        />
      </div>
      {!compact ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {formatSubscriptionReset(window.resetsAt) ?? "Reset time unavailable"}
        </p>
      ) : null}
    </div>
  );
}

function ProviderUsageCard({
  provider,
  environmentLabel,
}: {
  readonly provider: ProviderSubscriptionUsage;
  readonly environmentLabel: string;
}) {
  const hasWindows = provider.fiveHour !== null || provider.weekly.length > 0;
  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        <ProviderMark provider={provider.provider} className="size-4" />
        <h3 className="text-sm font-medium text-foreground">{providerLabel(provider.provider)}</h3>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{environmentLabel}</span>
      </div>
      {provider.status === "available" && hasWindows ? (
        <div className="flex flex-wrap gap-x-5 gap-y-3">
          {provider.fiveHour ? <WindowMeter kind="fiveHour" window={provider.fiveHour} /> : null}
          {provider.weekly.map((window, index) => (
            <WindowMeter
              key={`${window.label ?? "weekly"}-${index}`}
              kind="weekly"
              window={window}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Subscription limits have not been reported by this provider yet.
        </p>
      )}
    </article>
  );
}

export function SubscriptionUsageSection({
  environments,
  isPending,
}: {
  readonly environments: readonly EnvironmentSubscriptionUsageStatus[];
  readonly isPending: boolean;
}) {
  if (isPending) {
    return <p className="text-sm text-muted-foreground">Loading subscription usage…</p>;
  }

  const cards = environments.flatMap(
    (environment) =>
      environment.summary?.providers.map((provider) => (
        <ProviderUsageCard
          key={`${environment.environmentId}-${provider.provider}`}
          provider={provider}
          environmentLabel={environment.label}
        />
      )) ?? [],
  );

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium text-foreground">Subscription usage</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Provider-reported limits for your 5-hour and weekly subscription windows.
        </p>
      </div>
      {cards.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2">{cards}</div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Subscription usage is unavailable for the connected environments.
        </p>
      )}
    </section>
  );
}

export function SubscriptionUsagePills({
  environments,
}: {
  readonly environments: readonly EnvironmentSubscriptionUsageStatus[];
}) {
  const providers = environments.flatMap(
    (environment) =>
      environment.summary?.providers.flatMap((provider) => {
        if (provider.status !== "available") return [];
        const windows = [
          ...(provider.fiveHour ? [["fiveHour", provider.fiveHour] as const] : []),
          ...provider.weekly.map((window) => ["weekly", window] as const),
        ];
        return windows.length > 0 ? [{ environment, provider, windows }] : [];
      }) ?? [],
  );
  if (providers.length === 0) return null;

  return (
    <aside
      aria-label="Subscription usage"
      className="pointer-events-none fixed right-4 bottom-4 z-30 flex max-w-[calc(100vw-2rem)] flex-wrap justify-end gap-2"
    >
      {providers.map(({ environment, provider, windows }) => (
        <div
          key={`${environment.environmentId}-${provider.provider}`}
          className="flex items-center gap-3 rounded-full border border-border/50 bg-background/55 px-3 py-2 shadow-sm backdrop-blur-md"
        >
          <ProviderMark provider={provider.provider} className="size-3.5 shrink-0" />
          <span className="text-[11px] text-foreground/80">{providerLabel(provider.provider)}</span>
          <div className="flex min-w-0 items-center gap-2">
            {windows.map(([kind, window], index) => (
              <WindowMeter
                key={`${kind}-${window.label ?? index}`}
                kind={kind}
                window={window}
                compact
              />
            ))}
          </div>
        </div>
      ))}
    </aside>
  );
}
