import { describe, expect, it, vi } from "vitest";
import { captureSourceRecoveryWorkload, pinSourceRecoveryImages, resumeSourceRecoveryWorkload } from "./shared-source-images.js";

function fixture() {
  const images = { gateway: "registry/gateway:new", "gateway-edge": "registry/edge:new" };
  const containers = [{ name: "gateway", image: "registry/gateway:old" }, { name: "gateway-edge", image: "registry/edge:old" }];
  const deployment = { metadata: { name: "octogee-gateway-shared-source", namespace: "octogee-test", uid: "deployment", resourceVersion: "d1" },
    spec: { replicas: 1, strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } }, template: { spec: { containers: structuredClone(containers) } } } };
  const rs = { metadata: { name: "source-rs", namespace: "octogee-test", uid: "rs", resourceVersion: "r1", ownerReferences: [{ controller: true, kind: "Deployment", uid: "deployment" }] },
    spec: { replicas: 1, template: { spec: { containers: structuredClone(containers) } } } };
  const pod = { metadata: { ownerReferences: [{ controller: true, kind: "ReplicaSet", name: "source-rs", uid: "rs" }] }, spec: { containers } };
  const effects: string[] = [], assertCurrent = vi.fn(async () => {});
  const runKubectl = vi.fn(async (args: string[]) => {
    const object = args.includes("deployment") ? deployment : rs;
    if (args.includes("patch")) {
      const patch = JSON.parse(args[args.indexOf("-p") + 1]);
      expect(patch.slice(0, 2)).toEqual([{ op: "test", path: "/metadata/uid", value: object.metadata.uid },
        { op: "test", path: "/metadata/resourceVersion", value: object.metadata.resourceVersion }]);
      for (const item of patch.filter((row: any) => row.op !== "test")) {
        if (item.path === "/spec/paused") { (deployment.spec as any).paused = item.value; effects.push(item.value ? "pause" : "resume"); }
        else { object.spec.template.spec.containers[Number(item.path.split("/")[5])].image = item.value; effects.push(object === rs ? "pin-rs" : "pin-deployment"); }
      }
    }
    return { code: 0, stdout: JSON.stringify(object), stderr: "" };
  });
  return { deps: { namespace: "octogee-test", runKubectl }, pod, deployment, rs, images, effects, assertCurrent };
}

describe("stopped source image durability", () => {
  it("pins the replacement ReplicaSet and paused Deployment before the retained Pod is upgraded", async () => {
    const h = fixture(), workload = await captureSourceRecoveryWorkload(h.deps, "shared-source", h.pod);
    await pinSourceRecoveryImages(h.deps, workload, h.images, Object.fromEntries(h.pod.spec.containers.map(c => [c.name, c.image])), h.assertCurrent);
    expect(h.effects).toEqual(["pause", "pin-rs", "pin-rs", "pin-deployment", "pin-deployment"]);
    expect(h.rs.spec.template.spec.containers.map(c => c.image)).toEqual(Object.values(h.images));
    expect((h.deployment.spec as any).paused).toBe(true);
    await resumeSourceRecoveryWorkload(h.deps, workload, h.images, h.assertCurrent);
    expect(h.effects.at(-1)).toBe("resume");
    expect(h.pod.spec.containers[0].image).toBe("registry/gateway:old");
  });
  it.each(["claim", "deployment", "replicaset", "foreign-image"])("refuses changed %s custody before continuing", async changed => {
    const h = fixture(), workload = await captureSourceRecoveryWorkload(h.deps, "shared-source", h.pod);
    if (changed === "claim") h.assertCurrent.mockRejectedValue(new Error("claim lost"));
    if (changed === "deployment") h.deployment.metadata.uid = "foreign";
    if (changed === "replicaset") h.rs.metadata.uid = "foreign";
    if (changed === "foreign-image") h.rs.spec.template.spec.containers[0].image = "foreign";
    await expect(pinSourceRecoveryImages(h.deps, workload, h.images,
      Object.fromEntries(h.pod.spec.containers.map(c => [c.name, c.image])), h.assertCurrent)).rejects.toThrow();
    expect(h.effects).not.toContain("pin-rs");
    expect(h.effects).not.toContain("pin-deployment");
  });
  it("does not resume a workload whose replacement template no longer has the qualified image", async () => {
    const h = fixture(), workload = await captureSourceRecoveryWorkload(h.deps, "shared-source", h.pod);
    await expect(resumeSourceRecoveryWorkload(h.deps, workload, h.images, h.assertCurrent)).rejects.toThrow();
    expect(h.effects).toEqual([]);
  });
  it.each(["Recreate", "source-unavailable", "no-surge"])("refuses unsafe %s strategy at capture and after capture", async changed => {
    for (const phase of ["capture", "pin", "resume"]) {
      const h = fixture(), workload = await captureSourceRecoveryWorkload(h.deps, "shared-source", h.pod);
      if (changed === "Recreate") h.deployment.spec.strategy = { type: "Recreate" } as typeof h.deployment.spec.strategy;
      if (changed === "source-unavailable") h.deployment.spec.strategy.rollingUpdate.maxUnavailable = 1;
      if (changed === "no-surge") h.deployment.spec.strategy.rollingUpdate.maxSurge = 0;
      const original = Object.fromEntries(h.pod.spec.containers.map(c => [c.name, c.image]));
      if (phase === "resume") {
        (h.deployment.spec as any).paused = true;
        for (const resource of [h.deployment, h.rs]) for (const container of resource.spec.template.spec.containers) container.image = h.images[container.name as keyof typeof h.images];
      }
      const run = phase === "capture" ? () => captureSourceRecoveryWorkload(h.deps, "shared-source", h.pod) :
        phase === "pin" ? () => pinSourceRecoveryImages(h.deps, workload, h.images, original, h.assertCurrent) :
          () => resumeSourceRecoveryWorkload(h.deps, workload, h.images, h.assertCurrent);
      await expect(run()).rejects.toThrow("surge strategy");
      expect(h.effects).toEqual([]);
    }
  });
});
