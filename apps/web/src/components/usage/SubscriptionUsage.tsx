import type {
  ProviderSubscriptionUsage,
  SubscriptionRateLimitWindow,
  UsageProviderKind,
} from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import type { EnvironmentSubscriptionUsageStatus } from "../../state/subscriptionUsage";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProviderMark } from "./ProviderMark";
import { PROVIDER_LABEL } from "./usageProviders";
import {
  formatSubscriptionPercent,
  formatSubscriptionReset,
  formatSubscriptionUpdatedAt,
  subscriptionWindowLabel,
} from "./SubscriptionUsage.logic";

function providerLabel(provider: ProviderSubscriptionUsage["provider"]): string {
  return provider === "codex" ? "ChatGPT / Codex" : PROVIDER_LABEL[provider];
}

function WindowMeter({
  kind,
  window,
}: {
  readonly kind: "fiveHour" | "weekly";
  readonly window: NonNullable<ProviderSubscriptionUsage["fiveHour"]>;
}) {
  return (
    <div className="min-w-0 flex-1">
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
      <p className="mt-1 text-[11px] text-muted-foreground">
        {formatSubscriptionReset(window.resetsAt) ?? "Reset time unavailable"}
      </p>
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
  const updated = formatSubscriptionUpdatedAt(provider.updatedAt);
  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        <ProviderMark provider={provider.provider} className="size-4" />
        <h3 className="text-sm font-medium text-foreground">{providerLabel(provider.provider)}</h3>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{environmentLabel}</span>
      </div>
      {provider.status === "available" && hasWindows ? (
        <>
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
          {updated ? (
            <p className="text-[11px] text-muted-foreground">
              {updated.text}
              {updated.isStale ? " · reported by the provider's last session" : null}
            </p>
          ) : null}
        </>
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

/**
 * The window each pill surfaces by default: Claude reports its 5-hour cap
 * prominently, Codex its weekly one. The hover popover shows the rest.
 */
const PILL_PRIMARY_WINDOW_KIND: Record<UsageProviderKind, "fiveHour" | "weekly"> = {
  claude: "fiveHour",
  codex: "weekly",
};

/** Short window tag next to the percentage on each pill. */
const PILL_WINDOW_TAG: Record<UsageProviderKind, string> = {
  claude: "5h",
  codex: "Wk",
};

/** Brand accent for the percentage: Claude's terracotta, Codex monochrome. */
const PILL_ACCENT_TEXT: Record<UsageProviderKind, string> = {
  claude: "text-[#d97757]",
  codex: "text-foreground",
};

/** Icon chip shell behind the brand mark. */
const PILL_ICON_CHIP: Record<UsageProviderKind, string> = {
  claude: "bg-[#d97757]/15",
  codex: "bg-black dark:bg-white",
};

/** Icon fills that read against the chip. The marks ship their own fills. */
const PILL_ICON: Record<UsageProviderKind, string> = {
  claude: "fill-[#d97757]",
  codex: "fill-white dark:fill-black",
};

function pillPrimaryWindow(
  provider: ProviderSubscriptionUsage,
): SubscriptionRateLimitWindow | null {
  const preferFiveHour = PILL_PRIMARY_WINDOW_KIND[provider.provider] === "fiveHour";
  return preferFiveHour
    ? (provider.fiveHour ?? provider.weekly[0] ?? null)
    : (provider.weekly[0] ?? provider.fiveHour ?? null);
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
        return provider.fiveHour !== null || provider.weekly.length > 0
          ? [{ environment, provider }]
          : [];
      }) ?? [],
  );
  if (providers.length === 0) return null;

  return (
    <aside
      aria-label="Subscription usage"
      className="fixed right-4 bottom-4 z-30 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2"
    >
      {providers.map(({ environment, provider }) => {
        const primary = pillPrimaryWindow(provider);
        if (!primary) return null;
        const updated = formatSubscriptionUpdatedAt(provider.updatedAt);
        return (
          <Popover key={`${environment.environmentId}-${provider.provider}`}>
            <PopoverTrigger
              openOnHover
              delay={150}
              closeDelay={0}
              render={
                <div
                  // A stale snapshot still carries the last real reading, so
                  // dim it rather than hiding it — the popover dates it.
                  className={cn(
                    "flex cursor-default items-center gap-2 rounded-full border border-border/50 bg-background/55 py-1.5 pr-3 pl-1.5 shadow-sm backdrop-blur-md transition-colors hover:bg-background/80",
                    updated?.isStale ? "opacity-60" : null,
                  )}
                >
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full",
                      PILL_ICON_CHIP[provider.provider],
                    )}
                  >
                    <ProviderMark
                      provider={provider.provider}
                      className={cn("size-3.5 shrink-0", PILL_ICON[provider.provider])}
                    />
                  </span>
                  <span className="flex items-baseline gap-1 text-[11px] leading-none tabular-nums">
                    <span className="text-muted-foreground">
                      {PILL_WINDOW_TAG[provider.provider]}
                    </span>
                    <span className={cn("font-semibold", PILL_ACCENT_TEXT[provider.provider])}>
                      {formatSubscriptionPercent(primary.usedPercent)}
                    </span>
                  </span>
                </div>
              }
            />
            <PopoverPopup
              tooltipStyle
              side="top"
              align="end"
              viewportClassName="p-0"
              className="w-64 max-w-none text-left whitespace-normal"
            >
              <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
                <div className="flex items-center gap-2">
                  <ProviderMark provider={provider.provider} className="size-3.5 shrink-0" />
                  <span className="font-medium">{providerLabel(provider.provider)}</span>
                  <span className="truncate text-muted-foreground">{environment.label}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {provider.fiveHour ? (
                    <WindowMeter kind="fiveHour" window={provider.fiveHour} />
                  ) : null}
                  {provider.weekly.map((window) => (
                    <WindowMeter
                      key={`weekly-${window.label ?? window.resetsAt ?? "unnamed"}`}
                      kind="weekly"
                      window={window}
                    />
                  ))}
                </div>
                {updated ? (
                  <p className="text-[11px] text-muted-foreground">
                    {updated.text}
                    {updated.isStale ? " · reported by the provider's last session" : null}
                  </p>
                ) : null}
              </div>
            </PopoverPopup>
          </Popover>
        );
      })}
    </aside>
  );
}
