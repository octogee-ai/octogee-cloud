import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertSharedHeldReturnMaintenance,
  type HeldNativeReturnSelection,
  type ObservedSharedMaintenanceHelm,
  type SharedHeldReturnMaintenanceClaim,
  type SharedHeldReturnMaintenancePlan,
  type SharedHeldReturnMaintenanceResult,
} from "@octogee/core/fleet-state";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { HelmSubprocess } from "../helm-runner.js";
import type { SurgeKubectl } from "../surge-user-handoff-runtime.js";
import { computeChartFingerprint } from "../chart-fingerprint.js";
import { createHeldNativeReturnDestinationVerifier } from "./held-native-return-destination.js";
import { transitionHeldSharedPod } from "./held-shared-maintenance-images.js";
import type { SharedHeldReturnMaintenancePhysical } from "./held-shared-maintenance-operator.js";
import { createSharedHardwareObserver } from "./shared-maintenance-hardware.js";
import { createSharedMaintenancePolicyRuntime, type SharedMigrationPolicy } from "./shared-maintenance-policy-runtime.js";

export interface SharedMaintenanceEnrollment {
  plan: SharedHeldReturnMaintenancePlan;
  retainedChart: string;
  migrationPolicy: SharedMigrationPolicy;
}

interface Dependencies {
  environment: "test" | "prod";
  namespace: string;
  privateKey: string;
  store: PlatformStateStore;
  runKubectl: SurgeKubectl;
  runHelm: HelmSubprocess;
  readEnrollment(selection: HeldNativeReturnSelection): Promise<SharedMaintenanceEnrollment>;
  verifyRollback(enrollment: SharedMaintenanceEnrollment, attemptId: string, point: "admission" | "dispatch"): Promise<void>;
  verifyClosedMigrationIngress(enrollment: SharedMaintenanceEnrollment): Promise<void>;
  observeInstalledHelm(gatewayId: string): Promise<ObservedSharedMaintenanceHelm>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

function requireCustody(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error("Shared maintenance " + message);
}

const ROLLED_BACK = "rolled-back";

export function createSharedHeldReturnMaintenancePhysical(deps: Dependencies): SharedHeldReturnMaintenancePhysical {
  requireCustody(deps.environment === "test", "requires TEST");
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? delay;
  const hardware = createSharedHardwareObserver(deps.runKubectl, deps.namespace);
  const migration = createSharedMaintenancePolicyRuntime(deps.runKubectl, deps.namespace);

  async function enrolled(selection: HeldNativeReturnSelection, plan?: SharedHeldReturnMaintenancePlan) {
    const binding = await deps.readEnrollment(selection);
    const normalized = { ...binding.plan, owners: [...binding.plan.owners].sort((a, b) => a.uid.localeCompare(b.uid)) };
    requireCustody(isDeepStrictEqual(normalized.selection, selection) &&
      (!plan || isDeepStrictEqual(normalized, plan)), "enrollment changed");
    requireCustody(computeChartFingerprint(binding.retainedChart) === binding.plan.installedChartFingerprint,
      "enrollment does not name the exact retained chart");
    return { ...binding, plan: normalized };
  }

  async function readHardware(plan: SharedHeldReturnMaintenancePlan) {
    const observed = await hardware.physical(plan.selection.targetGatewayId, plan.workload, plan.owners);
    requireCustody(isDeepStrictEqual(observed.observation.owners, plan.owners) &&
      isDeepStrictEqual(observed.hardware.retainedBoot, plan.retainedBoot), "owner or retained boot identity changed");
    return observed;
  }

  function policyScope(enrollment: SharedMaintenanceEnrollment, observed: Awaited<ReturnType<typeof readHardware>>) {
    return {
      namespace: deps.namespace,
      gatewayId: enrollment.plan.selection.targetGatewayId,
      policyUid: enrollment.migrationPolicy.uid,
      labels: observed.hardware.pod.metadata.labels,
    };
  }

  function imageOutcome(plan: SharedHeldReturnMaintenancePlan, observed: Awaited<ReturnType<typeof readHardware>>) {
    const { nativeSource } = observed.observation;
    const { images } = observed.hardware;
    if (nativeSource === plan.originalNativeSource && isDeepStrictEqual(images, plan.originalImages)) return ROLLED_BACK;
    requireCustody(nativeSource === plan.acceptedNativeSource && isDeepStrictEqual(images, plan.maintenanceImages),
      "observed neither authorized image tuple");
    return "installed";
  }

  async function waitForCanonicalObservation(claim: SharedHeldReturnMaintenanceClaim, after: number) {
    const deadline = now() + 50_000;
    for (;;) {
      const runtime = await deps.store.fleetRegistry.get(claim.gatewayId);
      const pod = runtime?.kubernetes?.pods?.[0];
      requireCustody(pod?.uid === claim.plan.workload.podUid && pod.replicaSetUid === claim.plan.workload.replicaSetUid &&
        runtime?.kubernetes?.totalPods === 1, "lost the canonical retained Pod");
      if (runtime.kubernetes.observedAt >= after && (runtime.heartbeat.lastHeartbeatAt ?? 0) >= after) return;
      requireCustody(now() < deadline, "did not receive fresh canonical readiness observations");
      await wait(1_000);
    }
  }

  async function verifyImportHold(claim: SharedHeldReturnMaintenanceClaim) {
    const { selection } = claim.plan;
    const operation = await deps.store.journal.operations.get(selection.operationId);
    const slug = operation?.schedulerHandoff?.slug;
    requireCustody(typeof slug === "string" && slug === operation?.input.userSlug,
      "cannot bind the return owner to the destination witness");
    const verify = createHeldNativeReturnDestinationVerifier({ ...deps, loopbackPodUid: claim.plan.workload.podUid });
    await verify({ ...selection, slug }, async () => {
      requireCustody(await assertSharedHeldReturnMaintenance(deps.store, claim) === "dispatched",
        "lost authority to verify the retained owner import hold");
    });
  }

  async function result(claim: SharedHeldReturnMaintenanceClaim): Promise<SharedHeldReturnMaintenanceResult> {
    await enrolled(claim.plan.selection, claim.plan);
    const observed = await readHardware(claim.plan);
    const outcome = imageOutcome(claim.plan, observed);
    if (outcome === "installed") await verifyImportHold(claim);
    await waitForCanonicalObservation(claim, observed.observedAt);
    return {
      attemptId: claim.attemptId, outcome, verifiedAt: observed.observedAt,
      workload: observed.hardware.workload, retainedBoot: observed.hardware.retainedBoot,
      images: observed.hardware.images, runningImageIds: observed.hardware.runningImageIds,
      owners: observed.observation.owners, nativeSource: observed.observation.nativeSource,
      noInFlightTasks: true, noPreparedImports: true, exclusiveReady: true,
    };
  }

  return {
    async readVerifiedAdmission(selection, attemptId) {
      const binding = await enrolled(selection);
      const { plan } = binding;
      await deps.verifyRollback(binding, attemptId, "admission");
      const observed = await readHardware(plan);
      requireCustody(imageOutcome(plan, observed) === ROLLED_BACK, "original images changed before admission");
      await migration.verify(policyScope(binding, observed), binding.migrationPolicy, "original");
      return { ...plan, observedAt: observed.observedAt, exactWorkloadObserved: true,
        noInFlightTasks: true, noPreparedImports: true, rollbackVerified: true };
    },
    async holdMigrationPolicy(claim, assertReserved) {
      const binding = await enrolled(claim.plan.selection, claim.plan);
      const observed = await readHardware(claim.plan);
      requireCustody(imageOutcome(claim.plan, observed) === ROLLED_BACK, "lost original before holding migration ingress");
      await migration.change(policyScope(binding, observed), binding.migrationPolicy, "hold", assertReserved);
    },
    async verifyReadyToDispatch(claim, assertReserved) {
      const binding = await enrolled(claim.plan.selection, claim.plan);
      const observed = await readHardware(claim.plan);
      const scope = policyScope(binding, observed);
      requireCustody(imageOutcome(claim.plan, observed) === ROLLED_BACK, "original images changed before dispatch");
      await migration.verify(scope, binding.migrationPolicy, "held");
      await deps.verifyClosedMigrationIngress(binding);
      await deps.verifyRollback(binding, claim.attemptId, "dispatch");
      await assertReserved();
      await migration.verify(scope, binding.migrationPolicy, "held");
      await readHardware(claim.plan);
    },
    async applyStagedRelease(claim, staged, assertCurrent) {
      const binding = await enrolled(claim.plan.selection, claim.plan);
      const current = await hardware.topology(claim.gatewayId, claim.plan.workload);
      const scope = { namespace: deps.namespace, gatewayId: claim.gatewayId,
        policyUid: binding.migrationPolicy.uid, labels: current.pod.metadata.labels };
      await transitionHeldSharedPod({ ...deps, chart: binding.retainedChart, assertCurrent: async () => {
        await assertCurrent();
        await migration.verify(scope, binding.migrationPolicy, "held");
      } }, { gatewayId: claim.gatewayId, ...claim.plan }, staged.phase === "dispatched" ? "install" : "rollback");
    },
    async restoreMigrationPolicy(claim, assertCurrent) {
      const binding = await enrolled(claim.plan.selection, claim.plan);
      const observed = await readHardware(claim.plan);
      if (imageOutcome(claim.plan, observed) === "installed") await verifyImportHold(claim);
      await migration.change(policyScope(binding, observed), binding.migrationPolicy, "restore", assertCurrent);
    },
    async readVerifiedWithdrawal(claim) {
      const binding = await enrolled(claim.plan.selection, claim.plan);
      const observed = await readHardware(claim.plan);
      await migration.verify(policyScope(binding, observed), binding.migrationPolicy, "original");
      const [{ outcome, ...retained }, installed] = await Promise.all([result(claim), deps.observeInstalledHelm(claim.gatewayId)]);
      requireCustody(outcome === ROLLED_BACK, "withdrawal requires the original images");
      return { ...retained, migrationPolicyRestored: true, installed };
    },
    readVerifiedResult: result,
    readInstalledHelm: claim => deps.observeInstalledHelm(claim.gatewayId),
  };
}
