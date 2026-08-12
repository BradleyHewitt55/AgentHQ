import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SubscriptionUsageSummary } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentSubscriptionUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly summary: SubscriptionUsageSummary | null;
}

const subscriptionUsageAtom = Atom.make((get): readonly EnvironmentSubscriptionUsageStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  return Array.from(presentations, ([environmentId, presentation]) => {
    const result = get(serverEnvironment.subscriptionUsage({ environmentId, input: {} }));
    return {
      environmentId,
      label: presentation.entry.target.label,
      isPending: result.waiting,
      summary: Option.getOrNull(AsyncResult.value(result)),
    };
  });
}).pipe(Atom.withLabel("web-subscription-usage"));

export function useSubscriptionUsage() {
  const environments = useAtomValue(subscriptionUsageAtom);
  return {
    environments,
    isPending:
      environments.length > 0 && environments.every((environment) => environment.isPending),
  };
}
