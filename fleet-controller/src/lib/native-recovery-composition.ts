import type { PlatformStateStore } from "@octogee/core/platform-state";
import { createCompensatingSourceServingVerifier, type CompensatingSourceServingInputs } from "./compensating-native-source-serving.js";
import { createCompensatingNativeReturn } from "./compensating-native-return.js";
import { createCompensatingNativeOriginalObserver, createCompensatingNativeReturnActions } from "./compensating-native-return-actions.js";
import { createHeldSharedInertMaintenance } from "./held-shared-inert-maintenance.js";
import { createNativeOldTargetPhysicalProvider, createNativeReturnTargetExclusion } from "./native-return-target-exclusion.js";

type TargetDependencies = Parameters<typeof createNativeOldTargetPhysicalProvider>[0];
type ActionDependencies = Parameters<typeof createCompensatingNativeReturnActions>[0];
type InertDependencies = Parameters<typeof createHeldSharedInertMaintenance>[0];
type SourceDependencies = Parameters<typeof createCompensatingNativeOriginalObserver>[0];

export type NativeRecoveryComposition = Pick<NativeRecoveryCompositionInput, "inert" | "registerOperatorActions"> & {
  readRetainedCompletion: TargetDependencies["readRetainedCompletion"];
};

type NativeRecoveryCompositionInput = {
  target: Omit<TargetDependencies, "namespace" | "store"> & Required<Pick<TargetDependencies, "verifyWholeRetirement">>;
  source: Omit<ActionDependencies, "verifySourceServing"> & Pick<SourceDependencies, "vm"> & { serving: CompensatingSourceServingInputs };
  inert: Omit<InertDependencies, "store" | "now">;
  registerOperatorActions(actions: NativeRecoveryOperatorActions): void;
};

type NativeRecoveryOperatorActions = {
  compensate: ReturnType<typeof createCompensatingNativeReturn>["request"];
  excludeTarget: ReturnType<typeof createNativeReturnTargetExclusion>["reserve"];
  verifyTargetExclusion: ReturnType<typeof createNativeReturnTargetExclusion>["verifyReserved"];
  releaseSharedHandoff: ReturnType<typeof createNativeReturnTargetExclusion>["releaseSharedHandoff"];
  sharedInertMaintenance: ReturnType<typeof createHeldSharedInertMaintenance>;
};

export function createNativeRecoveryComposition(
  environment: string,
  namespace: string,
  store: PlatformStateStore,
  now: () => number,
  enrolled?: NativeRecoveryCompositionInput | null,
) {
  if (environment !== "test" || !enrolled) return undefined;
  const target = createNativeReturnTargetExclusion({
    store, now,
    provider: createNativeOldTargetPhysicalProvider({ ...enrolled.target, namespace, store }),
  });
  const compensation = createCompensatingNativeReturn({
    store, now, actions: createCompensatingNativeReturnActions({
      ...enrolled.source, verifySourceServing: createCompensatingSourceServingVerifier({ ...enrolled.source.serving, store }),
    }),
    provider: {
      readOldTargetExclusion: target.readOldTargetExclusion,
      verifyOldTargetExclusion: target.verifyOldTargetExclusion,
      observeOriginalSource: createCompensatingNativeOriginalObserver({ store, vm: enrolled.source.vm }),
    },
  });
  const inert = createHeldSharedInertMaintenance({ ...enrolled.inert, store, now });
  enrolled.registerOperatorActions({
    compensate: compensation.request, excludeTarget: target.reserve, verifyTargetExclusion: target.verifyReserved,
    releaseSharedHandoff: target.releaseSharedHandoff,
    sharedInertMaintenance: inert,
  });
  return compensation;
}
