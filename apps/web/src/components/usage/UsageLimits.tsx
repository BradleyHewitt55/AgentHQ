import type {
  ProviderUsageLimits,
  UsageLimitProviderId,
  UsageLimitStatus,
  UsageLimitWindow,
} from "@t3tools/contracts";
import { useState } from "react";

import { cn } from "../../lib/utils";
import type { EnvironmentUsageLimitsStatus } from "../../state/usageLimits";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { USAGE_LIMIT_PROVIDER_PRESENTATION, usageLimitProviderLabel } from "./usageLimitsProviders";
import {
  formatUsagePercent,
  formatUsageReset,
  formatUsageUpdatedAt,
  primaryPillWindow,
  usageWindowLabel,
} from "./usageLimitsProviders";

function StatusBadge({ status }: { readonly status: UsageLimitStatus }) {
  if (status === "ok") return null;
  const label =
    status === "fetching"
      ? "Refreshing"
      : status === "unavailable"
        ? "Unavailable"
        : status === "error"
          ? "Error"
          : "Idle";
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        status === "error"
          ? "bg-destructive/15 text-destructive"
          : "bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function WindowMeter({
  kind,
  window,
}: {
  readonly kind: "session" | "weekly" | "monthly";
  readonly window: UsageLimitWindow;
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px] tabular-nums">
        <span className="truncate text-muted-foreground">{usageWindowLabel(kind)}</span>
        <span className="text-foreground">{formatUsagePercent(window.usedPercent)}</span>
      </div>
      {/* Canonical storage is consumed percent; bars render it directly. */}
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground/70"
          style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {formatUsageReset(window.resetsAt) ?? "Reset time unavailable"}
      </p>
    </div>
  );
}

function BucketMeter({
  name,
  bucket,
}: {
  readonly name: string;
  readonly bucket: UsageLimitWindow;
}) {
  return (
    <div className="min-w-[120px] flex-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px] tabular-nums">
        <span className="truncate text-muted-foreground">{name}</span>
        <span className="text-foreground">{formatUsagePercent(bucket.usedPercent)}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground/70"
          style={{ width: `${Math.min(100, Math.max(0, bucket.usedPercent))}%` }}
        />
      </div>
    </div>
  );
}

function ProviderUsageCard({
  limits,
  environmentLabel,
}: {
  readonly limits: ProviderUsageLimits;
  readonly environmentLabel: string;
}) {
  const updated = formatUsageUpdatedAt(limits.updatedAt);
  const hasWindows =
    limits.session !== null ||
    limits.weekly !== null ||
    Boolean(limits.monthly) ||
    Boolean(limits.fableWeekly) ||
    (limits.buckets?.length ?? 0) > 0;
  const showWindows = limits.status === "ok" && hasWindows;
  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center">
          {(() => {
            const Mark = USAGE_LIMIT_PROVIDER_PRESENTATION[limits.provider].mark;
            return <Mark className="size-4 shrink-0" aria-hidden />;
          })()}
        </span>
        <h3 className="text-sm font-medium text-foreground">
          {usageLimitProviderLabel(limits.provider)}
        </h3>
        {limits.planType ? (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground capitalize">
            {limits.planType}
          </span>
        ) : null}
        <StatusBadge status={limits.status} />
        <span className="min-w-0 truncate text-xs text-muted-foreground">{environmentLabel}</span>
      </div>
      {showWindows ? (
        <>
          <div className="flex flex-wrap gap-x-5 gap-y-3">
            {limits.session ? <WindowMeter kind="session" window={limits.session} /> : null}
            {limits.weekly ? <WindowMeter kind="weekly" window={limits.weekly} /> : null}
            {limits.monthly ? <WindowMeter kind="monthly" window={limits.monthly} /> : null}
            {limits.fableWeekly ? <WindowMeter kind="weekly" window={limits.fableWeekly} /> : null}
          </div>
          {(limits.buckets?.length ?? 0) > 0 ? (
            <div className="flex flex-wrap gap-x-5 gap-y-3">
              {limits.buckets!.map((bucket) => (
                <BucketMeter key={bucket.name} name={bucket.name} bucket={bucket} />
              ))}
            </div>
          ) : null}
          {limits.rateLimitResetCredits && limits.rateLimitResetCredits.availableCount > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {limits.rateLimitResetCredits.availableCount} rate-limit reset credit
              {limits.rateLimitResetCredits.availableCount === 1 ? "" : "s"} available
            </p>
          ) : null}
        </>
      ) : limits.status === "unavailable" ? (
        <p className="text-xs text-muted-foreground">
          {limits.error ?? "No subscription quota is available for this provider."}
        </p>
      ) : limits.status === "error" ? (
        <p className="text-xs text-destructive">
          {limits.error ?? "The last refresh failed."}
          {hasWindows ? " Showing the most recent reading." : ""}
        </p>
      ) : limits.status === "fetching" ? (
        <p className="text-xs text-muted-foreground">Fetching usage…</p>
      ) : (
        <p className="text-xs text-muted-foreground">Waiting for the first refresh.</p>
      )}
      {updated ? (
        <p className="text-[11px] text-muted-foreground">
          {updated.text}
          {updated.isStale ? " · stale" : ""}
        </p>
      ) : null}
    </article>
  );
}

export function UsageLimitsSection({
  environments,
  isPending,
  onRefresh,
  isRefreshing,
}: {
  readonly environments: readonly EnvironmentUsageLimitsStatus[];
  readonly isPending: boolean;
  readonly onRefresh?: () => void;
  readonly isRefreshing?: boolean;
}) {
  if (isPending) {
    return <p className="text-sm text-muted-foreground">Loading subscription usage…</p>;
  }
  const cards = environments.flatMap((environment) =>
    (environment.snapshot?.providers ?? []).map((limits) => (
      <ProviderUsageCard
        key={`${environment.environmentId}-${limits.provider}`}
        limits={limits}
        environmentLabel={environment.label}
      />
    )),
  );
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-foreground">Subscription usage</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Provider-reported limits for your subscription windows.
          </p>
        </div>
        {onRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
          >
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </button>
        ) : null}
      </div>
      {cards.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2">{cards}</div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Usage limits are unavailable for the connected environments.
        </p>
      )}
    </section>
  );
}

const PILL_WINDOW_TAG: Record<UsageLimitProviderId, string> = {
  claude: "5h",
  codex: "Wk",
  antigravity: "5h",
  grok: "Wk",
  cursor: "—",
  opencode: "Mo",
  pi: "—",
};

/** Brand accent for the pill percentage. */
const PILL_ACCENT_TEXT: Record<UsageLimitProviderId, string> = {
  claude: "text-[#d97757]",
  codex: "text-foreground",
  antigravity: "text-[#5b8def]",
  grok: "text-foreground",
  cursor: "text-foreground",
  opencode: "text-foreground",
  pi: "text-foreground",
};

export function UsageLimitsPills({
  environments,
}: {
  readonly environments: readonly EnvironmentUsageLimitsStatus[];
}) {
  const [refreshingProvider, setRefreshingProvider] = useState<UsageLimitProviderId | null>(null);
  const refreshUsageLimits = useAtomCommand(serverEnvironment.refreshUsageLimits, {
    reportFailure: false,
  });
  const refreshOne = (
    environmentId: EnvironmentUsageLimitsStatus["environmentId"],
    provider: UsageLimitProviderId,
  ) => {
    setRefreshingProvider(provider);
    void refreshUsageLimits({ environmentId, input: {} }).finally(() =>
      setRefreshingProvider(null),
    );
  };
  const providers = environments.flatMap((environment) =>
    (environment.snapshot?.providers ?? [])
      .filter(
        (limits) =>
          (limits.status === "ok" || limits.status === "error") &&
          primaryPillWindow(limits) !== null,
      )
      .map((limits) => ({ environment, limits })),
  );
  if (providers.length === 0) return null;

  return (
    <aside
      aria-label="Subscription usage"
      className="fixed right-4 bottom-4 z-30 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2"
    >
      {providers.map(({ environment, limits }) => {
        const primary = primaryPillWindow(limits);
        if (!primary) return null;
        const updated = formatUsageUpdatedAt(limits.updatedAt);
        const presentation = USAGE_LIMIT_PROVIDER_PRESENTATION[limits.provider];
        const Mark = presentation.mark;
        return (
          <Popover key={`${environment.environmentId}-${limits.provider}`}>
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
                    updated?.isStale || limits.status === "error" ? "opacity-60" : null,
                  )}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-black dark:bg-white">
                    <Mark className="size-3.5 shrink-0 fill-white dark:fill-black" aria-hidden />
                  </span>
                  <span className="flex items-baseline gap-1 text-[11px] leading-none tabular-nums">
                    <span className="text-muted-foreground">
                      {PILL_WINDOW_TAG[limits.provider]}
                    </span>
                    <span className={cn("font-semibold", PILL_ACCENT_TEXT[limits.provider])}>
                      {formatUsagePercent(primary.usedPercent)}
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
                  <Mark className="size-3.5 shrink-0" aria-hidden />
                  <span className="font-medium">{usageLimitProviderLabel(limits.provider)}</span>
                  <span className="truncate text-muted-foreground">{environment.label}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {limits.session ? <WindowMeter kind="session" window={limits.session} /> : null}
                  {limits.weekly ? <WindowMeter kind="weekly" window={limits.weekly} /> : null}
                  {limits.monthly ? <WindowMeter kind="monthly" window={limits.monthly} /> : null}
                  {limits.fableWeekly ? (
                    <WindowMeter kind="weekly" window={limits.fableWeekly} />
                  ) : null}
                  {(limits.buckets ?? []).map((bucket) => (
                    <BucketMeter key={bucket.name} name={bucket.name} bucket={bucket} />
                  ))}
                </div>
                {limits.status === "error" && limits.error ? (
                  <p className="text-[11px] text-destructive">{limits.error}</p>
                ) : null}
                <div className="flex items-center justify-between gap-2">
                  {updated ? (
                    <p className="text-[11px] text-muted-foreground">{updated.text}</p>
                  ) : (
                    <span />
                  )}
                  <button
                    type="button"
                    disabled={refreshingProvider !== null}
                    onClick={() => refreshOne(environment.environmentId, limits.provider)}
                    className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    {refreshingProvider === limits.provider ? "Refreshing…" : "Refresh"}
                  </button>
                </div>
              </div>
            </PopoverPopup>
          </Popover>
        );
      })}
    </aside>
  );
}
