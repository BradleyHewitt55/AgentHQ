import { createTaskEnvironmentAtoms } from "@t3tools/client-runtime/state/tasks";

import { connectionAtomRuntime } from "../connection/runtime";

export const taskEnvironment = createTaskEnvironmentAtoms(connectionAtomRuntime);
