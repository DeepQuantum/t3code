import { createLocalModelsEnvironmentAtoms } from "@t3tools/client-runtime/state/localModels";

import { connectionAtomRuntime } from "../connection/runtime";

export const localModelsEnvironment = createLocalModelsEnvironmentAtoms(connectionAtomRuntime);
