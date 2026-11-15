import type { WorkspaceMigrationRecoveryParams } from "@octogee/core/fleet-state";
import type { SurgeUserHandoffDeps, SurgePod } from "./surge-user-handoff.js";
import { isReleasedSurgeTargetHold } from "./surge-user-handoff-runtime.js";

export interface IsolatedRecoveryTargetInput {
  recovery: WorkspaceMigrationRecoveryParams;
  targetGatewayId: string;
  migrationId: string;
  slug: string;
}

interface IsolatedRecoveryTargetDeps {
  assertAuthority: (input: WorkspaceMigrationRecoveryParams) => Promise<void>;
  targetAssigned: (gatewayId: string) => Promise<boolean>;
  listPods: SurgeUserHandoffDeps["listPods"];
  holdTargetOpenClaw: NonNullable<SurgeUserHandoffDeps["holdTargetOpenClaw"]>;
  unreserveTargetOpenClaw: NonNullable<SurgeUserHandoffDeps["unreserveTargetOpenClaw"]>;
}

function sameAllocation(left: SurgePod, right: SurgePod): boolean {
  return left.uid === right.uid && left.name === right.name && left.podIP === right.podIP;
}

export async function prepareIsolatedRecoveryTarget(deps: IsolatedRecoveryTargetDeps, input: IsolatedRecoveryTargetInput): Promise<void> {
  const assertAuthority = () => deps.assertAuthority(input.recovery);
  const resolveTarget = async () => {
    await assertAuthority();
    const assigned = await deps.targetAssigned(input.targetGatewayId);
    await assertAuthority();
    if (assigned) throw new Error("User recovery target has an assignment");
    const snapshot = await deps.listPods(input.targetGatewayId);
    await assertAuthority();
    const [target] = snapshot.pods;
    if (snapshot.pods.length !== 1 || !target || target.terminating || target.crashLooping ||
        snapshot.observedPodUids.length !== 1 || snapshot.observedPodUids[0] !== target.uid) {
      throw new Error("User recovery target has no single current allocation");
    }
    return target;
  };
  const targetPod = await resolveTarget();
  const assertCurrent = async () => {
    if (!sameAllocation(targetPod, await resolveTarget())) throw new Error("User recovery target allocation changed");
  };
  const request = { gatewayId: input.targetGatewayId, slug: input.slug, operationId: input.migrationId, targetPod };
  await assertCurrent();
  try { await deps.holdTargetOpenClaw(request); }
  catch (error) {
    if (!isReleasedSurgeTargetHold(error)) throw error;
    await assertCurrent();
    await deps.unreserveTargetOpenClaw(request);
  }
  await assertCurrent();
}
