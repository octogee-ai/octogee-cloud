import { isDeepStrictEqual } from "node:util";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { createCompensatingSourceServingVerifier, type CompensatingSourceServingInputs } from "./compensating-native-source-serving.js";
import { createCompensatingNativeReturn } from "./compensating-native-return.js";
import { createCompensatingNativeOriginalObserver, createCompensatingNativeReturnActions, createCompensatingNativeSourceStoreVerifier } from "./compensating-native-return-actions.js";
import { createHeldSharedInertMaintenance } from "./held-shared-inert-maintenance.js";
import { createNativeOldTargetPhysicalProvider, createNativeReturnTargetExclusion } from "./native-return-target-exclusion.js";

type TargetDependencies = Parameters<typeof createNativeOldTargetPhysicalProvider>[0];
type ActionDependencies = Parameters<typeof createCompensatingNativeReturnActions>[0];
type InertDependencies = Parameters<typeof createHeldSharedInertMaintenance>[0];
type SourceDependencies = Parameters<typeof createCompensatingNativeOriginalObserver>[0];

type RetainedComposition = {
  mode?: undefined;
  readRetainedCompletion: NonNullable<TargetDependencies["readRetainedCompletion"]>;
  inert: Omit<InertDependencies, "store" | "now">;
  registerOperatorActions(actions: NativeRecoveryOperatorActions): void;
};

type RetiredComposition = {
  mode: "retired-only";
  registerOperatorActions(actions: {
    compensate: ReturnType<typeof createCompensatingNativeReturn>["requestRetired"];
    releaseSharedHandoff: ReturnType<typeof createNativeReturnTargetExclusion>["releaseRetiredSharedHandoff"];
  }): void;
};

export type NativeRecoveryComposition = RetainedComposition | RetiredComposition;

type NativeRecoveryCompositionInput = NativeRecoveryComposition & {
  target: Omit<TargetDependencies, "namespace" | "store" | "readRetainedCompletion"> & Required<Pick<TargetDependencies, "verifyWholeRetirement">>;
  source: Omit<ActionDependencies, "verifySourceServing" | "verifyRetiredSourceStores"> & Pick<SourceDependencies, "vm"> & { serving: CompensatingSourceServingInputs };
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
  const observeOriginalSource = createCompensatingNativeOriginalObserver({ store, vm: enrolled.source.vm });
  const verifyRestoredServing = createCompensatingSourceServingVerifier({ ...enrolled.source.serving, store, terminal: true });
  const target = createNativeReturnTargetExclusion({
    verifyRearmedTargetStores: createCompensatingNativeSourceStoreVerifier(store, enrolled.target.agentStoreAdminDsn, "active"),
    async verifyRestoredSource(authority, assertCurrent) {
      const verifyInstance = async () => {
        await assertCurrent();
        if (!isDeepStrictEqual(await observeOriginalSource(authority), authority.source)) {
          throw new Error("Original Native instance or disks changed");
        }
        await assertCurrent();
      };
      await verifyInstance();
      await verifyRestoredServing(authority, assertCurrent);
      await verifyInstance();
    },
    store, now,
    provider: createNativeOldTargetPhysicalProvider({ ...enrolled.target, namespace, store,
      readRetainedCompletion: enrolled.mode === "retired-only" ? undefined : enrolled.readRetainedCompletion }),
  });
  const compensation = createCompensatingNativeReturn({
    store, now, actions: createCompensatingNativeReturnActions({
      ...enrolled.source, verifyRetiredSourceStores: createCompensatingNativeSourceStoreVerifier(store, enrolled.target.agentStoreAdminDsn, "retired"),
      verifySourceServing: createCompensatingSourceServingVerifier({ ...enrolled.source.serving, store }),
    }),
    provider: {
      readOldTargetExclusion: target.readOldTargetExclusion,
      verifyOldTargetExclusion: target.verifyOldTargetExclusion,
      readRetiredTargetExclusion: target.readRetiredTargetExclusion,
      verifyRetiredTargetExclusion: target.verifyRetiredTargetExclusion,
      observeOriginalSource,
    },
  });
  if (enrolled.mode === "retired-only") {
    enrolled.registerOperatorActions({
      compensate: compensation.requestRetired,
      releaseSharedHandoff: target.releaseRetiredSharedHandoff,
    });
  } else {
    enrolled.registerOperatorActions({
      compensate: compensation.request, excludeTarget: target.reserve, verifyTargetExclusion: target.verifyReserved,
      releaseSharedHandoff: target.releaseSharedHandoff,
      sharedInertMaintenance: createHeldSharedInertMaintenance({ ...enrolled.inert, store, now }),
    });
  }
  return compensation;
}
