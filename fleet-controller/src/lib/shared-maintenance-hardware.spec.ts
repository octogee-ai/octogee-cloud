import { describe, expect, it } from "vitest";
import { matchSharedHardware } from "./shared-maintenance-hardware.js";

function observedWorkload() {
  const digest = "a".repeat(64);
  const image = `registry/gateway:abcdef1@sha256:${digest}`;
  const running = { imageID: `registry/gateway@sha256:${digest}`, ready: true, state: { running: {} } };
  const owner = (kind: string, name: string, uid: string) => ({ controller: true, kind, name, uid });
  const metadata = { resourceVersion: "1", namespace: "test", labels: {}, generation: 2 };
  const expected = { podName: "pod", podUid: "pod-uid", replicaSetUid: "rs-uid", deploymentUid: "deployment-uid" };
  const home = { name: "data", mountPath: "/home/node", subPath: undefined as string | undefined };
  const containers = [
    { name: "gateway", image, volumeMounts: [{ ...home }], env: [{ name: "GATEWAY_IMAGE_TAG", value: "abcdef1" }] },
    { name: "gateway-edge", image, volumeMounts: [{ ...home }] },
  ];
  const spec = { containers, initContainers: [{ name: "fix-perms", image }] };
  const template = { metadata: { labels: {} }, spec: structuredClone(spec) };
  return {
    expected,
    deploy: { metadata: { ...metadata, uid: expected.deploymentUid, name: "deploy" },
      spec: { replicas: 1, paused: false, template }, status: { observedGeneration: 2 } },
    rs: { metadata: { ...metadata, uid: expected.replicaSetUid, name: "rs",
      ownerReferences: [owner("Deployment", "deploy", expected.deploymentUid)] },
      spec: { replicas: 1, template }, status: { observedGeneration: 2 } },
    pod: {
      metadata: { ...metadata, uid: expected.podUid, name: expected.podName,
        ownerReferences: [owner("ReplicaSet", "rs", expected.replicaSetUid)] },
      spec: { ...spec, runtimeClassName: "gvisor", volumes: [{ name: "data", emptyDir: {} }] },
      status: {
        podIP: "192.0.2.10", conditions: [{ type: "Ready", status: "True" }],
        containerStatuses: containers.map(({ name }) => ({ ...running, name, containerID: name })),
        initContainerStatuses: [{ ...running, name: "fix-perms", containerID: "init", state: { terminated: { exitCode: 0 } } }],
      },
    },
  };
}

describe("retained Shared hardware", () => {
  it("requires the serving role digests to match their actual Pod spec", () => {
    const { pod, rs, deploy, expected } = observedWorkload();
    expect(matchSharedHardware(pod, rs, deploy, expected).ready).toBe(true);
    pod.status.containerStatuses[1]!.imageID = "registry/gateway@sha256:" + "b".repeat(64);
    expect(matchSharedHardware(pod, rs, deploy, expected).ready).toBe(false);
  });

  it("refuses a new ReplicaSet, mismatched controlling owner or a role mounting a different home", () => {
    for (const change of [
      ({ rs }: ReturnType<typeof observedWorkload>) => { rs.metadata.uid = "replacement"; },
      ({ pod }: ReturnType<typeof observedWorkload>) => { pod.metadata.ownerReferences[0]!.name = "foreign"; },
      ({ pod }: ReturnType<typeof observedWorkload>) => { pod.spec.containers[1]!.volumeMounts[0]!.subPath = "other"; },
      ({ rs }: ReturnType<typeof observedWorkload>) => { rs.metadata.namespace = "elsewhere"; },
    ]) {
      const proof = observedWorkload();
      change(proof);
      expect(() => matchSharedHardware(proof.pod, proof.rs, proof.deploy, proof.expected)).toThrow(/retained workload changed/);
    }
  });
});
