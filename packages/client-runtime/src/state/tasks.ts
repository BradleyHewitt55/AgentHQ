import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Tasks live on a GitHub Projects v2 board, which pushes nothing, so the list
 * is a query that refetches (after mutations or explicitly) instead of a
 * server-driven subscription.
 */
export function createTaskEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Task mutations for one environment are serialized so concurrent writes to
  // the same GitHub project cannot interleave.
  const commandScheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;

  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:tasks:list",
      tag: WS_METHODS.tasksList,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tasks:create",
      tag: WS_METHODS.tasksCreate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tasks:update",
      tag: WS_METHODS.tasksUpdate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tasks:delete",
      tag: WS_METHODS.tasksDelete,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    promote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tasks:promote",
      tag: WS_METHODS.tasksPromote,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}
