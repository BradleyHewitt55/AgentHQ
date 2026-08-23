import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, UsageLimitsSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentUsageLimitsStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly snapshot: UsageLimitsSnapshot | null;
}

const usageLimitsAtom = Atom.make((get): readonly EnvironmentUsageLimitsStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  return Array.from(presentations, ([environmentId, presentation]) => {
    const result = get(serverEnvironment.usageLimits({ environmentId, input: {} }));
    return {
      environmentId,
      label: presentation.entry.target.label,
      isPending: result.waiting,
      snapshot: Option.getOrNull(AsyncResult.value(result)),
    };
  });
}).pipe(Atom.withLabel("web-usage-limits"));

/**
 * Live usage-limit snapshots per connected environment. The server owns
 * polling, credential access, and normalization; this hook only replays its
 * published state.
 */
export function useUsageLimits() {
  const environments = useAtomValue(usageLimitsAtom);
  return {
    environments,
    isPending:
      environments.length > 0 && environments.every((environment) => environment.isPending),
  };
}
