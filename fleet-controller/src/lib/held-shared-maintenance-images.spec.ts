import { beforeEach, expect, it, vi } from "vitest";
import { captureSourceRecoveryWorkload, pinSourceRecoveryImages, resumeSourceRecoveryWorkload } from "./shared-source-images.js";
import { existingOwnedPod, json, recoveredPodReady } from "./shared-restore-runtime.js";
import { holdSharedMaintenanceImages, transitionHeldSharedPod } from "./held-shared-maintenance-images.js";

vi.mock("./shared-source-images.js");
vi.mock("./held-shared-maintenance-helm.js");
vi.mock("./shared-restore-runtime.js", async load => ({
  ...await load<typeof import("./shared-restore-runtime.js")>(), existingOwnedPod: vi.fn(), json: vi.fn(), recoveredPodReady: vi.fn(),
}));
const old = { gateway: "gateway@" + "sha256:" + "1".repeat(64), "gateway-edge": "edge@sha256:" + "2".repeat(64) };
const next = { gateway: "gateway@sha256:" + "3".repeat(64), "gateway-edge": "edge@sha256:" + "4".repeat(64) };
const workload = { deploymentName: "octogee-gateway-shared-t", deploymentUid: "dep", replicaSetName: "rs-name", replicaSetUid: "rs" };
const bound = { installedChartFingerprint:"a".repeat(64), gatewayId: "shared-t", workload: { podName: "pod", podUid: "original", deploymentUid: "dep", replicaSetUid: "rs" },
  originalImages: old, maintenanceImages: next };
const deps = { environment: "test" as const, chart:"retained-chart",runHelm:vi.fn(),namespace: "octogee-test", runKubectl: vi.fn(), assertCurrent: vi.fn(async () => {}), wait: vi.fn(async () => {}) };
const pod = (images: typeof old) => ({ metadata: { name: "pod", uid: "original", resourceVersion: "23" },
  spec: { containers: Object.entries(images).map(([name,image]) => ({ name, image })) } });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(captureSourceRecoveryWorkload).mockResolvedValue(workload);
});
it("refuses production before opening any workload or Helm transport", async () => {
  await expect(transitionHeldSharedPod({ ...deps, environment: "prod" }, bound, "install")).rejects.toThrow(/requires TEST/);
  expect(existingOwnedPod).not.toHaveBeenCalled();
  expect(deps.runHelm).not.toHaveBeenCalled();
});
it("refuses a replacement for the retained home before pausing the Deployment", async () => {
  vi.mocked(existingOwnedPod).mockResolvedValue({ ...pod(old), metadata: { name: "pod", uid: "replacement" } });
  await expect(transitionHeldSharedPod(deps, bound, "install")).rejects.toThrow(/retained/i);
  expect(pinSourceRecoveryImages).not.toHaveBeenCalled();
});
it.each([["install",old,next],["rollback",next,old]] as const)("pins the %s images and tests the exact Pod before resuming its workload", async (direction,from,to) => {
  const current=pod(from);
  vi.mocked(existingOwnedPod).mockResolvedValue(current);
  vi.mocked(json).mockImplementation(async () => { Object.assign(current,pod(to)); return current; });
  vi.mocked(recoveredPodReady).mockReturnValue(true);
  await transitionHeldSharedPod(deps,bound,direction);
  expect(pinSourceRecoveryImages).toHaveBeenCalledWith(expect.anything(),workload,to,from,expect.any(Function));
  const args=vi.mocked(json).mock.calls[0]![1];
  const patch=JSON.parse(args[args.indexOf("-p")+1]!);
  expect(patch).toContainEqual({op:"test",path:"/metadata/uid",value:"original"});
  expect(patch).toContainEqual({op:"test",path:"/metadata/resourceVersion",value:"23"});
  expect(resumeSourceRecoveryWorkload).toHaveBeenCalledTimes(1);
});
it("refuses a replacement ReplicaSet and observes a lost Fleet claim before each mutation", async () => {
  vi.mocked(existingOwnedPod).mockResolvedValue(pod(old));
  vi.mocked(captureSourceRecoveryWorkload).mockResolvedValue({ ...workload, replicaSetUid:"different" });
  await expect(transitionHeldSharedPod(deps,bound,"install")).rejects.toThrow(/workload/i);
  expect(json).not.toHaveBeenCalled();
  deps.assertCurrent.mockRejectedValue(new Error("lost maintenance claim"));
  await expect(transitionHeldSharedPod(deps,bound,"install")).rejects.toThrow(/claim/);
  expect(pinSourceRecoveryImages).not.toHaveBeenCalled();
});


it("separates the initial retained Pod image change from rollout readiness and Helm publication", async () => {
  const current = pod(old);
  vi.mocked(existingOwnedPod).mockResolvedValue(current);
  vi.mocked(json).mockImplementation(async () => { Object.assign(current, pod(next)); return current; });
  const pending = await holdSharedMaintenanceImages(deps, bound, "install");
  expect(json).toHaveBeenCalledOnce();
  expect(recoveredPodReady).not.toHaveBeenCalled();
  expect(resumeSourceRecoveryWorkload).not.toHaveBeenCalled();
  vi.mocked(recoveredPodReady).mockReturnValue(true);
  await pending.publishReady();
  expect(resumeSourceRecoveryWorkload).toHaveBeenCalledOnce();
});
