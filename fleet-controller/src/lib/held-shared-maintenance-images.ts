import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { captureSourceRecoveryWorkload, pinSourceRecoveryImages, resumeSourceRecoveryWorkload } from "./shared-source-images.js";
import { adoptRetainedSharedHelm } from "./held-shared-maintenance-helm.js";
import type { HelmSubprocess } from "../helm-runner.js";
import { existingOwnedPod, imagePatch, json, recoveredPodReady, type SharedPodRecoveryDeps } from "./shared-restore-runtime.js";

interface MaintenanceTarget {
  gatewayId: string;
  installedChartFingerprint: string;
  workload: { podName: string; podUid: string; replicaSetUid: string; deploymentUid: string };
  originalImages: Record<"gateway" | "gateway-edge", string>;
  maintenanceImages: Record<"gateway" | "gateway-edge", string>;
}

type Dependencies = Pick<SharedPodRecoveryDeps, "namespace" | "runKubectl" | "now" | "wait"> & {
  environment: "test" | "prod";
  chart: string;
  runHelm: HelmSubprocess;
  assertCurrent(): Promise<void>;
};

async function readHeldWorkload(deps: Dependencies, bound: MaintenanceTarget) {
  await deps.assertCurrent();
  const pod = await existingOwnedPod(deps, bound.gatewayId);
  if (pod.metadata.uid !== bound.workload.podUid || pod.metadata.name !== bound.workload.podName) {
    throw new Error("Shared maintenance lost its retained home Pod");
  }
  const workload = await captureSourceRecoveryWorkload(deps, bound.gatewayId, pod, true);
  if (workload.deploymentUid !== bound.workload.deploymentUid || workload.replicaSetUid !== bound.workload.replicaSetUid) {
    throw new Error("Shared maintenance workload ownership changed");
  }
  return { pod, workload };
}

export async function transitionHeldSharedPod(deps: Dependencies, bound: MaintenanceTarget, direction: "install" | "rollback") {
  await (await holdSharedMaintenanceImages(deps, bound, direction)).publishReady();
}

export async function holdSharedMaintenanceImages(deps: Dependencies, bound: MaintenanceTarget, direction: "install" | "rollback") {
  if (deps.environment !== "test") throw new Error("Shared held maintenance requires TEST");
  const { pod, workload } = await readHeldWorkload(deps, bound);
  const [from, to] = direction === "install" ? [bound.originalImages, bound.maintenanceImages] : [bound.maintenanceImages, bound.originalImages];
  const saved = { target: { originalImages: from } };
  imagePatch(pod, saved, to);
  const assertHeld = async () => { await readHeldWorkload(deps, bound); };
  await pinSourceRecoveryImages(deps, workload, to, from, assertHeld);
  const current = await readHeldWorkload(deps, bound);
  if (!isDeepStrictEqual(current.workload, workload)) throw new Error("Shared maintenance workload changed while pinning images");
  const patch = imagePatch(current.pod, saved, to);
  if (current.pod.spec.containers.some((container: { name: keyof typeof to; image: string }) => container.image !== to[container.name])) {
    await deps.assertCurrent();
    await json(deps, ["patch", "pod", bound.workload.podName, "--type=json", "-p", JSON.stringify(patch)]);
  }
  return { async publishReady() {
    const now = deps.now ?? Date.now, wait = deps.wait ?? delay;
    const deadline = now() + 10 * 60_000;
    while (now() < deadline) {
      const observed = await readHeldWorkload(deps, bound);
      if (recoveredPodReady(observed.pod, bound.workload, to)) {
        await adoptRetainedSharedHelm(deps, workload, { gatewayId: bound.gatewayId, chart: deps.chart, installedChartFingerprint: bound.installedChartFingerprint, from, to }, assertHeld);
        await resumeSourceRecoveryWorkload(deps, workload, to, assertHeld);
        const resumed = await readHeldWorkload(deps, bound);
        if (!recoveredPodReady(resumed.pod, bound.workload, to)) throw new Error("Retained Shared Pod lost readiness after Deployment resume");
        return;
      }
      await wait(2_000);
    }
    throw new Error("Retained Shared Pod did not become ready on both accepted role images");
  } };
}
