import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createLocalModelsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const lifecycleConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { profileId: string } }) =>
      JSON.stringify([environmentId, input.profileId]),
  };
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:local-models:list",
      tag: WS_METHODS.localModelsList,
      staleTimeMs: 5_000,
    }),
    status: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:local-models:status",
      tag: WS_METHODS.subscribeLocalModelStatus,
      idleTtlMs: 0,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:local-models:start",
      tag: WS_METHODS.localModelsStart,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:local-models:stop",
      tag: WS_METHODS.localModelsStop,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:local-models:save",
      tag: WS_METHODS.localModelsSave,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:local-models:remove",
      tag: WS_METHODS.localModelsRemove,
    }),
  };
}
