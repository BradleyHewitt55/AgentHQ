import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";

export function createTaskEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Task mutations for one environment are serialized so board positions, which
  // are computed server-side from the current column, cannot interleave.
  const commandScheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;

  return {
    list: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:tasks:list",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.subscribeTasks>) =>
        subscribe(WS_METHODS.subscribeTasks, input),
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
    sync: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tasks:sync",
      tag: WS_METHODS.tasksSync,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}
