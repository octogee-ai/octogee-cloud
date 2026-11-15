import type { UntypedRecord } from "@octogee/core/platform-state";
import { json, type SharedPodRecoveryDeps } from "./shared-restore-runtime.js";

type Deps = Pick<SharedPodRecoveryDeps, "namespace" | "runKubectl">;
type Images = Record<string, string>;
export interface SourceRecoveryWorkload {
  deploymentName: string; deploymentUid: string; replicaSetName: string; replicaSetUid: string;
}

function assertResource(value: UntypedRecord, name: string, uid: string, namespace: string): void {
  if (value.metadata?.name !== name || value.metadata?.uid !== uid || value.metadata.namespace !== namespace ||
      value.metadata.deletionTimestamp || typeof value.metadata.resourceVersion !== "string" || value.spec?.replicas !== 1) {
    throw new Error("source recovery workload custody changed");
  }
}

async function workloadResources(deps: Deps, workload: SourceRecoveryWorkload) {
  const [deployment, replicaSet] = await Promise.all([
    json(deps, ["get", "deployment", workload.deploymentName]),
    json(deps, ["get", "replicaset", workload.replicaSetName]),
  ]);
  assertResource(deployment, workload.deploymentName, workload.deploymentUid, deps.namespace);
  assertResource(replicaSet, workload.replicaSetName, workload.replicaSetUid, deps.namespace);
  const strategy = deployment.spec.strategy;
  if (strategy?.type !== "RollingUpdate" || strategy.rollingUpdate?.maxSurge !== 1 || strategy.rollingUpdate.maxUnavailable !== 0) {
    throw new Error("source recovery requires its canonical surge strategy");
  }
  if (!replicaSet.metadata.ownerReferences?.some((owner: UntypedRecord) => owner.controller && owner.kind === "Deployment" && owner.uid === workload.deploymentUid)) {
    throw new Error("source recovery ReplicaSet ownership changed");
  }
  return { deployment, replicaSet };
}

export async function captureSourceRecoveryWorkload(deps: Deps, gatewayId: string, pod: UntypedRecord, allowPaused = false): Promise<SourceRecoveryWorkload> {
  const owner = pod.metadata.ownerReferences?.find((row: UntypedRecord) => row.controller && row.kind === "ReplicaSet");
  if (!owner || typeof owner.name !== "string" || typeof owner.uid !== "string") throw new Error("source recovery Pod owner is unavailable");
  const deploymentName = `octogee-gateway-${gatewayId}`;
  const deployment = await json(deps, ["get", "deployment", deploymentName]);
  if (typeof deployment.metadata?.uid !== "string") throw new Error("source recovery Deployment is unavailable");
  const workload = { deploymentName, deploymentUid: deployment.metadata.uid, replicaSetName: owner.name, replicaSetUid: owner.uid };
  const current = await workloadResources(deps, workload);
  if (current.deployment.spec.paused === true && !allowPaused) throw new Error("source recovery Deployment is already paused outside this claim");
  return workload;
}

function templatePatch(value: UntypedRecord, images: Images, original: Images) {
  const patch = resourceTests(value);
  const containers = value.spec.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== Object.keys(images).length ||
      new Set(containers.map(c => c.name)).size !== containers.length) throw new Error("source recovery container roster changed");
  containers.forEach((container: UntypedRecord, index: number) => {
    if (!images[container.name] || ![original[container.name], images[container.name]].includes(container.image)) {
      throw new Error("source recovery workload image changed outside its claim");
    }
    patch.push({ op: "test", path: `/spec/template/spec/containers/${index}/image`, value: container.image });
    if (container.image !== images[container.name]) patch.push({ op: "replace", path: `/spec/template/spec/containers/${index}/image`, value: images[container.name] });
  });
  return patch;
}

function resourceTests(value: UntypedRecord): Array<{ op: string; path: string; value: unknown }> {
  return [{ op: "test", path: "/metadata/uid", value: value.metadata.uid },
    { op: "test", path: "/metadata/resourceVersion", value: value.metadata.resourceVersion }];
}

async function patchResource(deps: Deps, kind: string, value: UntypedRecord, patch: ReturnType<typeof resourceTests>, assertCurrent: () => Promise<void>) {
  await assertCurrent();
  await json(deps, ["patch", kind, value.metadata.name, "--type=json", "-p", JSON.stringify(patch)]);
  await assertCurrent();
}

export async function pinSourceRecoveryImages(deps: Deps, workload: SourceRecoveryWorkload, images: Images,
  original: Images, assertCurrent: () => Promise<void>): Promise<void> {
  await assertCurrent();
  const initial = await workloadResources(deps, workload);
  templatePatch(initial.deployment, images, original);
  templatePatch(initial.replicaSet, images, original);
  if (initial.deployment.spec.paused !== true) {
    await patchResource(deps, "deployment", initial.deployment,
      [...resourceTests(initial.deployment), { op: "add", path: "/spec/paused", value: true }], assertCurrent);
  }
  const paused = await workloadResources(deps, workload);
  if (paused.deployment.spec.paused !== true) throw new Error("source recovery Deployment pause was not acknowledged");
  await patchResource(deps, "replicaset", paused.replicaSet, templatePatch(paused.replicaSet, images, original), assertCurrent);
  const current = await workloadResources(deps, workload);
  if (current.deployment.spec.paused !== true) throw new Error("source recovery Deployment was resumed before image pinning");
  await patchResource(deps, "deployment", current.deployment, templatePatch(current.deployment, images, original), assertCurrent);
  const pinned = await workloadResources(deps, workload);
  if (pinned.deployment.spec.paused !== true) throw new Error("source recovery Deployment pause changed before Pod upgrade");
  templatePatch(pinned.deployment, images, images);
  templatePatch(pinned.replicaSet, images, images);
  await assertCurrent();
}

export async function resumeSourceRecoveryWorkload(deps: Deps, workload: SourceRecoveryWorkload, images: Images,
  assertCurrent: () => Promise<void>): Promise<void> {
  await assertCurrent();
  const { deployment, replicaSet } = await workloadResources(deps, workload);
  templatePatch(deployment, images, images);
  templatePatch(replicaSet, images, images);
  if (deployment.spec.paused === true) await patchResource(deps, "deployment", deployment,
    [...resourceTests(deployment), { op: "replace", path: "/spec/paused", value: false }], assertCurrent);
}
