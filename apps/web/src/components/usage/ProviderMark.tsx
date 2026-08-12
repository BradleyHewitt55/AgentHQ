import type { UsageProviderKind } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { PROVIDER_MARK } from "./usageProviders";

/** Brand mark for the harness a row belongs to. */
export function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const Mark = PROVIDER_MARK[provider];
  return <Mark className={cn("shrink-0", className)} aria-hidden />;
}
