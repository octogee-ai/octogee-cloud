import { describe, it, expect, vi } from "vitest";
import {
  createKubeSubprocessRunner,
  type KubectlSubprocess,
} from "../lib/kube-ops";

type SubprocessResponse = { stdout?: string; stderr?: string; code?: number };

function mockSubprocess(
  responses: SubprocessResponse[],
): { runKubectl: KubectlSubprocess; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const runKubectl: KubectlSubprocess = vi.fn(async (args: string[]) => {
    calls.push(args);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      code: r.code ?? 0,
    };
  });
  return { runKubectl, calls };
}

describe("createKubeSubprocessRunner — scaleDeployment", () => {
  it("builds correct kubectl scale argv for the targeted deployment", async () => {
    const { runKubectl, calls } = mockSubprocess([{ stdout: "deployment.apps/x scaled" }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await kube.scaleDeployment({
      namespace: "octogee-test",
      name: "octogee-gateway-walter",
      replicas: 0,
    });

    expect(calls).toEqual([
      [
        "-n",
        "octogee-test",
        "scale",
        "deploy/octogee-gateway-walter",
        "--replicas=0",
      ],
    ]);
  });

  it("scales back up with --replicas=1 on resume", async () => {
    const { runKubectl, calls } = mockSubprocess([{ stdout: "" }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await kube.scaleDeployment({
      namespace: "octogee",
      name: "octogee-gateway-default",
      replicas: 1,
    });

    expect(calls[0]).toContain("--replicas=1");
  });

  it("treats NotFound on scale as idempotent success (no throw, log only)", async () => {
    const log = vi.fn();
    const { runKubectl } = mockSubprocess([
      {
        stderr: 'Error from server (NotFound): deployments.apps "octogee-gateway-walter" not found',
        code: 1,
      },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log });

    await expect(
      kube.scaleDeployment({
        namespace: "octogee-test",
        name: "octogee-gateway-walter",
        replicas: 0,
      }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("octogee-gateway-walter"),
    );
  });

  it("throws on non-NotFound scale failures with the stderr surfaced", async () => {
    const { runKubectl } = mockSubprocess([
      { stderr: "Error: connection refused", code: 1 },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.scaleDeployment({
        namespace: "octogee-test",
        name: "octogee-gateway-walter",
        replicas: 0,
      }),
    ).rejects.toThrow(/connection refused/);
  });

  it("rejects negative replicas synchronously before invoking kubectl", async () => {
    const { runKubectl, calls } = mockSubprocess([{}]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.scaleDeployment({
        namespace: "octogee-test",
        name: "octogee-gateway-walter",
        replicas: -1,
      }),
    ).rejects.toThrow(/replicas/);
    expect(calls.length).toBe(0);
  });
});

describe("createKubeSubprocessRunner — restartOpenClawInPlace", () => {
  it("execs `openclaw gateway restart --safe --skip-deferral` in the gateway container", async () => {
    const { runKubectl, calls } = mockSubprocess([
      { stdout: "safe restart requested; gateway bypassing active-work deferral" },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await kube.restartOpenClawInPlace({
      namespace: "octogee-test",
      name: "octogee-gateway-walter",
    });

    // In-process OpenClaw restart via the local gateway RPC (self-authorizing,
    // --skip-deferral bypasses the idle-drain wait). The container/pod is NOT
    // rolled — only the OpenClaw process restarts. Targets `deploy/<name>` so
    // kubectl selects the (single-replica) gateway pod; `-c gateway` because
    // the openclaw CLI + process live in that container, not gateway-edge.
    expect(calls).toEqual([
      [
        "-n",
        "octogee-test",
        "exec",
        "deploy/octogee-gateway-walter",
        "-c",
        "gateway",
        "--",
        "openclaw",
        "gateway",
        "restart",
        "--safe",
        "--skip-deferral",
      ],
    ]);
  });

  it("throws on NotFound (restart against a gateway that isn't there is a real mistake)", async () => {
    const { runKubectl } = mockSubprocess([
      {
        stderr: 'Error from server (NotFound): deployments.apps "octogee-gateway-walter" not found',
        code: 1,
      },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.restartOpenClawInPlace({
        namespace: "octogee-test",
        name: "octogee-gateway-walter",
      }),
    ).rejects.toThrow(/NotFound/);
  });

  it("throws when the in-pod restart command fails, surfacing stderr (e.g. commands.restart=false)", async () => {
    const { runKubectl } = mockSubprocess([
      {
        stderr:
          "Gateway restart is disabled in the running gateway config (commands.restart=false)",
        code: 1,
      },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.restartOpenClawInPlace({
        namespace: "octogee-test",
        name: "octogee-gateway-walter",
      }),
    ).rejects.toThrow(/commands\.restart=false/);
  });
});

describe("createKubeSubprocessRunner — readDeployedReplicas", () => {
  it("returns the deployment's .spec.replicas via kubectl get -o jsonpath", async () => {
    const { runKubectl, calls } = mockSubprocess([{ stdout: "0" }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    const replicas = await kube.readDeployedReplicas({
      namespace: "octogee-test",
      name: "octogee-gateway-walter",
    });

    expect(replicas).toBe(0);
    expect(calls[0]).toEqual([
      "-n",
      "octogee-test",
      "get",
      "deploy/octogee-gateway-walter",
      "-o",
      "jsonpath={.spec.replicas}",
    ]);
  });

  it("returns null when the deployment does not exist (NotFound)", async () => {
    const { runKubectl } = mockSubprocess([
      {
        stderr: 'Error from server (NotFound): deployments.apps "x" not found',
        code: 1,
      },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    const replicas = await kube.readDeployedReplicas({
      namespace: "octogee-test",
      name: "octogee-gateway-walter",
    });

    expect(replicas).toBeNull();
  });

  it("throws when stdout is non-numeric (signal mismatch — never quiet)", async () => {
    const { runKubectl } = mockSubprocess([{ stdout: "banana" }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.readDeployedReplicas({
        namespace: "octogee-test",
        name: "octogee-gateway-walter",
      }),
    ).rejects.toThrow(/replicas/);
  });
});

describe("createKubeSubprocessRunner — readAvailableReplicas", () => {
  it("returns the deployment's .status.availableReplicas via kubectl get -o jsonpath", async () => {
    const { runKubectl, calls } = mockSubprocess([{ stdout: "1" }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    const replicas = await kube.readAvailableReplicas({
      namespace: "octogee-test",
      name: "octogee-gateway-walter",
    });

    expect(replicas).toBe(1);
    expect(calls[0]).toEqual([
      "-n",
      "octogee-test",
      "get",
      "deploy/octogee-gateway-walter",
      "-o",
      "jsonpath={.status.availableReplicas}",
    ]);
  });

  it("returns zero when availableReplicas is absent on an existing deployment", async () => {
    const { runKubectl } = mockSubprocess([{ stdout: "" }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.readAvailableReplicas({
        namespace: "octogee-test",
        name: "octogee-gateway-walter",
      }),
    ).resolves.toBe(0);
  });

  it("returns null when the deployment does not exist (NotFound)", async () => {
    const { runKubectl } = mockSubprocess([
      {
        stderr: 'Error from server (NotFound): deployments.apps "x" not found',
        code: 1,
      },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    const replicas = await kube.readAvailableReplicas({
      namespace: "octogee-test",
      name: "octogee-gateway-walter",
    });

    expect(replicas).toBeNull();
  });

  it("throws when stdout is non-numeric (signal mismatch — never quiet)", async () => {
    const { runKubectl } = mockSubprocess([{ stdout: "banana" }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.readAvailableReplicas({
        namespace: "octogee-test",
        name: "octogee-gateway-walter",
      }),
    ).rejects.toThrow(/availableReplicas/);
  });
});

describe("createKubeSubprocessRunner — readGatewayPodDiagnostics", () => {
  it("summarizes kubectl get pods output for a gateway", async () => {
    const { runKubectl, calls } = mockSubprocess([
      {
        stdout: JSON.stringify({
          items: [
            {
              metadata: {
                name: "octogee-gateway-walter-abc",
                creationTimestamp: "2026-06-27T10:00:00.000Z",
              },
              spec: { nodeName: "gke-node-1" },
              status: {
                phase: "Running",
                containerStatuses: [
                  { name: "gateway", ready: true, restartCount: 1 },
                  { name: "gateway-edge", ready: true, restartCount: 2 },
                ],
              },
            },
          ],
        }),
      },
      {
        stdout: JSON.stringify({
          items: [
            {
              metadata: {
                name: "gke-node-1",
                labels: { "cloud.google.com/gke-spot": "true" },
              },
            },
          ],
        }),
      },
    ]);
    const kube = createKubeSubprocessRunner({
      runKubectl,
      log: vi.fn(),
      now: () => new Date("2026-06-27T10:02:00.000Z").getTime(),
    });

    const diagnostics = await kube.readGatewayPodDiagnostics({
      namespace: "octogee-test",
      gatewayId: "walter",
    });

    expect(calls[0]).toEqual([
      "-n",
      "octogee-test",
      "get",
      "pods",
      "-l",
      "gateway-instance=walter",
      "-o",
      "json",
    ]);
    expect(calls[1]).toEqual(["get", "nodes", "-o", "json"]);
    expect(diagnostics).toMatchObject({
      status: "ready",
      totalPods: 1,
      readyPods: 1,
      totalRestarts: 3,
      pods: [
        {
          name: "octogee-gateway-walter-abc",
          phase: "Running",
          readyContainers: 2,
          totalContainers: 2,
          restarts: 3,
          reason: null,
          nodeName: "gke-node-1",
          capacityType: "spot",
          ageMs: 120_000,
        },
      ],
      spotPods: 1,
      onDemandPods: 0,
      unknownCapacityPods: 0,
    });
  });

  it("surfaces waiting reasons and reports not-ready pods", async () => {
    const { runKubectl } = mockSubprocess([
      {
        stdout: JSON.stringify({
          items: [
            {
              metadata: { name: "octogee-gateway-walter-def" },
              status: {
                phase: "Pending",
                containerStatuses: [
                  {
                    name: "gateway",
                    ready: false,
                    restartCount: 4,
                    state: { waiting: { reason: "CrashLoopBackOff" } },
                  },
                ],
              },
            },
          ],
        }),
      },
      { stdout: JSON.stringify({ items: [] }) },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.readGatewayPodDiagnostics({
        namespace: "octogee-test",
        gatewayId: "walter",
      }),
    ).resolves.toMatchObject({
      status: "not-ready",
      totalPods: 1,
      readyPods: 0,
      totalRestarts: 4,
      pods: [{ phase: "Pending", reason: "CrashLoopBackOff" }],
    });
  });

  it("reads every gateway's pods and their scheduled node capacity in one batch", async () => {
    const { runKubectl, calls } = mockSubprocess([
      {
        stdout: JSON.stringify({
          items: [
            {
              metadata: {
                name: "octogee-gateway-alpha-abc",
                labels: { "gateway-instance": "alpha" },
              },
              spec: { nodeName: "standard-node" },
              status: {
                phase: "Running",
                containerStatuses: [
                  { name: "gateway", ready: true, restartCount: 0 },
                  { name: "gateway-edge", ready: true, restartCount: 0 },
                ],
              },
            },
            {
              metadata: {
                name: "octogee-gateway-bravo-def",
                labels: { "gateway-instance": "bravo" },
              },
              spec: { nodeName: "spot-node" },
              status: {
                phase: "Pending",
                containerStatuses: [
                  {
                    name: "gateway",
                    ready: false,
                    restartCount: 1,
                    state: { waiting: { reason: "ContainerCreating" } },
                  },
                ],
              },
            },
          ],
        }),
      },
      {
        stdout: JSON.stringify({
          items: [
            { metadata: { name: "standard-node", labels: {} } },
            {
              metadata: {
                name: "spot-node",
                labels: { "cloud.google.com/gke-spot": "true" },
              },
            },
          ],
        }),
      },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    const diagnostics = await kube.readGatewayPodDiagnosticsBatch({
      namespace: "octogee-test",
      gatewayIds: ["alpha", "bravo", "charlie"],
    });

    expect(calls).toEqual([
      [
        "-n",
        "octogee-test",
        "get",
        "pods",
        "-l",
        "app=octogee-gateway",
        "-o",
        "json",
      ],
      ["get", "nodes", "-o", "json"],
    ]);
    expect(diagnostics).toMatchObject({
      alpha: {
        status: "ready",
        totalPods: 1,
        readyPods: 1,
        spotPods: 0,
        onDemandPods: 1,
        unknownCapacityPods: 0,
      },
      bravo: {
        status: "not-ready",
        totalPods: 1,
        readyPods: 0,
        totalRestarts: 1,
        spotPods: 1,
        onDemandPods: 0,
        unknownCapacityPods: 0,
        pods: [{ reason: "ContainerCreating", capacityType: "spot" }],
      },
      charlie: {
        status: "missing",
        totalPods: 0,
        readyPods: 0,
        spotPods: 0,
        onDemandPods: 0,
        unknownCapacityPods: 0,
      },
    });
  });
});

describe("gateway container startup observation", () => {
  it("observes the unready gateway container before the provisioner heartbeat", async () => {
    const now = Date.parse("2026-10-16T15:03:04Z");
    const { runKubectl } = mockSubprocess([{ stdout: JSON.stringify({ items: [{
      metadata: { name: "octogee-gateway-cold-pod", uid: "current-pod", creationTimestamp: "2026-10-16T14:52:49Z", labels: { "gateway-instance": "cold" } },
      status: { phase: "Running", containerStatuses: [
        { name: "gateway-edge", ready: true, state: { running: { startedAt: "2026-10-16T14:55:26Z" } } },
        { name: "gateway", ready: false, state: { running: { startedAt: "2026-10-16T14:56:41Z" } } },
      ] },
    }] }) }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn(), now: () => now });

    const result = await kube.readGatewayPodDiagnosticsBatch({ namespace: "octogee", gatewayIds: ["cold"] });

    expect(result.cold.pods[0]).toMatchObject({ gatewayId: "cold", uid: "current-pod", deleting: false, gatewayContainerStartedAt: Date.parse("2026-10-16T14:56:41Z") });
  });
});

describe("createKubeSubprocessRunner — pod identity and ReplicaSet intent", () => {
  const NODE = "gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-vbsk";

  function batchResponses(replicaSets: unknown): SubprocessResponse[] {
    return [
      {
        stdout: JSON.stringify({
          items: [
            {
              metadata: {
                name: "octogee-gateway-ceckert-test-xs-08a5a3dd-98d6b8cd7-mg4l5",
                uid: "pod-uid-mg4l5",
                creationTimestamp: "2026-08-18T17:20:00.000Z",
                labels: {
                  "app": "octogee-gateway",
                  "gateway-instance": "ceckert-test-xs-08a5a3dd",
                  "pod-template-hash": "98d6b8cd7",
                },
                ownerReferences: [
                  {
                    apiVersion: "apps/v1",
                    kind: "ReplicaSet",
                    name: "octogee-gateway-ceckert-test-xs-08a5a3dd-98d6b8cd7",
                    uid: "rs-uid-new",
                    controller: true,
                  },
                ],
              },
              spec: { nodeName: NODE },
              status: {
                phase: "Running",
                containerStatuses: [
                  { name: "gateway", ready: false, restartCount: 0 },
                  { name: "gateway-edge", ready: true, restartCount: 0 },
                ],
              },
            },
          ],
        }),
      },
      {
        stdout: JSON.stringify({
          items: [
            {
              metadata: {
                name: NODE,
                labels: {
                  "cloud.google.com/gke-spot": "true",
                  "cloud.google.com/gke-nodepool": "nap-1dx2tv8d",
                },
                annotations: {
                  "container.googleapis.com/instance_id": "7311234567890123456",
                },
              },
            },
          ],
        }),
      },
      { stdout: JSON.stringify(replicaSets) },
    ];
  }

  it("projects the pod uid, its owning ReplicaSet, and the node's GCE identity", async () => {
    const { runKubectl, calls } = mockSubprocess(batchResponses({
      items: [
        {
          metadata: {
            name: "octogee-gateway-ceckert-test-xs-08a5a3dd-7c9f4b6d5",
            uid: "rs-uid-old",
            labels: { "app": "octogee-gateway", "gateway-instance": "ceckert-test-xs-08a5a3dd" },
          },
          spec: { replicas: 0 },
          status: { replicas: 0 },
        },
        {
          metadata: {
            name: "octogee-gateway-ceckert-test-xs-08a5a3dd-98d6b8cd7",
            uid: "rs-uid-new",
            labels: { "app": "octogee-gateway", "gateway-instance": "ceckert-test-xs-08a5a3dd" },
          },
          spec: { replicas: 1 },
          status: { replicas: 1 },
        },
        {
          metadata: {
            name: "octogee-gateway-shared-a-66d46fc76c",
            uid: "rs-uid-shared-a",
            labels: { "app": "octogee-gateway", "gateway-instance": "shared-a" },
          },
          spec: { replicas: 1 },
          status: { replicas: 1 },
        },
      ],
    }));
    const kube = createKubeSubprocessRunner({
      runKubectl,
      log: vi.fn(),
      now: () => new Date("2026-08-18T17:24:14.000Z").getTime(),
    });

    const diagnostics = await kube.readGatewayPodDiagnosticsBatch({
      namespace: "octogee-test",
      gatewayIds: ["ceckert-test-xs-08a5a3dd"],
      includeReplicaSets: true,
    });

    expect(calls[2]).toEqual([
      "-n",
      "octogee-test",
      "get",
      "replicasets",
      "-l",
      "app=octogee-gateway",
      "-o",
      "json",
    ]);
    const gateway = diagnostics["ceckert-test-xs-08a5a3dd"]!;
    expect(gateway.pods).toEqual([
      expect.objectContaining({
        name: "octogee-gateway-ceckert-test-xs-08a5a3dd-98d6b8cd7-mg4l5",
        uid: "pod-uid-mg4l5",
        replicaSetUid: "rs-uid-new",
        nodeName: NODE,
        instanceId: "7311234567890123456",
        nodePool: "nap-1dx2tv8d",
        capacityType: "spot",
        readyContainers: 1,
        totalContainers: 2,
        restarts: 0,
      }),
    ]);
    expect(gateway.replicaSets).toEqual([
      {
        uid: "rs-uid-old",
        name: "octogee-gateway-ceckert-test-xs-08a5a3dd-7c9f4b6d5",
        desiredReplicas: 0,
        observedReplicas: 0,
      },
      {
        uid: "rs-uid-new",
        name: "octogee-gateway-ceckert-test-xs-08a5a3dd-98d6b8cd7",
        desiredReplicas: 1,
        observedReplicas: 1,
      },
    ]);
  });

  it("reports an empty ReplicaSet list for a gateway whose deployment is gone", async () => {
    const { runKubectl } = mockSubprocess(batchResponses({ items: [] }));
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    const diagnostics = await kube.readGatewayPodDiagnosticsBatch({
      namespace: "octogee-test",
      gatewayIds: ["ceckert-test-xs-08a5a3dd", "retired-gw"],
      includeReplicaSets: true,
    });

    expect(diagnostics["retired-gw"]?.replicaSets).toEqual([]);
    expect(diagnostics["ceckert-test-xs-08a5a3dd"]?.replicaSets).toEqual([]);
  });

  it("does not read ReplicaSets unless asked", async () => {
    const { runKubectl, calls } = mockSubprocess(batchResponses({ items: [] }));
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    const diagnostics = await kube.readGatewayPodDiagnosticsBatch({
      namespace: "octogee-test",
      gatewayIds: ["ceckert-test-xs-08a5a3dd"],
    });

    expect(calls).toHaveLength(2);
    expect(diagnostics["ceckert-test-xs-08a5a3dd"]).not.toHaveProperty("replicaSets");
  });

  it("logs and omits ReplicaSet intent when the list is unreadable, keeping the pod observation", async () => {
    const responses = batchResponses({ items: [] });
    responses[2] = { stdout: "", stderr: 'Error from server (Forbidden): replicasets.apps is forbidden', code: 1 };
    const { runKubectl } = mockSubprocess(responses);
    const log = vi.fn();
    const kube = createKubeSubprocessRunner({ runKubectl, log });

    const diagnostics = await kube.readGatewayPodDiagnosticsBatch({
      namespace: "octogee-test",
      gatewayIds: ["ceckert-test-xs-08a5a3dd"],
      includeReplicaSets: true,
    });

    expect(diagnostics["ceckert-test-xs-08a5a3dd"]).toMatchObject({ status: "not-ready", totalPods: 1 });
    expect(diagnostics["ceckert-test-xs-08a5a3dd"]).not.toHaveProperty("replicaSets");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/kubectl get replicasets .* failed .*Forbidden/));
  });

  it("leaves a pod without a ReplicaSet owner unattributed rather than guessing", async () => {
    const responses = batchResponses({ items: [] });
    const pods = JSON.parse(responses[0]!.stdout!) as { items: Array<{ metadata: Record<string, unknown> }> };
    delete pods.items[0]!.metadata.ownerReferences;
    responses[0] = { stdout: JSON.stringify(pods) };
    const { runKubectl } = mockSubprocess(responses);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    const diagnostics = await kube.readGatewayPodDiagnosticsBatch({
      namespace: "octogee-test",
      gatewayIds: ["ceckert-test-xs-08a5a3dd"],
    });

    expect(diagnostics["ceckert-test-xs-08a5a3dd"]?.pods[0]?.replicaSetUid).toBeNull();
  });
});

describe("createKubeSubprocessRunner — deletePersistentVolumeClaim", () => {
  it("deletes the named PVC idempotently", async () => {
    const { runKubectl, calls } = mockSubprocess([
      { stdout: "persistentvolumeclaim/octogee-gateway-walter-data deleted" },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await kube.deletePersistentVolumeClaim({
      namespace: "octogee-test",
      name: "octogee-gateway-walter-data",
    });

    expect(calls).toEqual([
      [
        "-n",
        "octogee-test",
        "delete",
        "pvc/octogee-gateway-walter-data",
        "--ignore-not-found=true",
      ],
    ]);
  });

  it("reports a PVC that was never allocated as absent, not deleted", async () => {
    const log = vi.fn();
    const { runKubectl } = mockSubprocess([
      { stdout: "persistentvolumeclaim/octogee-gateway-walter-data deleted\n" },
      { stdout: "" },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log });

    await kube.deletePersistentVolumeClaim({ namespace: "octogee-test", name: "octogee-gateway-walter-data" });
    await kube.deletePersistentVolumeClaim({ namespace: "octogee-test", name: "octogee-gateway-sep092-s-77f99da1-data" });

    expect(log.mock.calls.flat()).toEqual([
      "[kube-ops] deleted pvc/octogee-gateway-walter-data ns=octogee-test",
      "[kube-ops] pvc/octogee-gateway-sep092-s-77f99da1-data ns=octogee-test already absent",
    ]);
  });

  it("throws on kubectl delete PVC failures", async () => {
    const { runKubectl } = mockSubprocess([
      { stderr: "Error from server (Forbidden): denied", code: 1 },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.deletePersistentVolumeClaim({
        namespace: "octogee-test",
        name: "octogee-gateway-walter-data",
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("createKubeSubprocessRunner — deleteSecret", () => {
  it("deletes the named secret idempotently", async () => {
    const { runKubectl, calls } = mockSubprocess([
      { stdout: "secret/gateway-auth-token-walter deleted" },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await kube.deleteSecret({
      namespace: "octogee-test",
      name: "gateway-auth-token-walter",
    });

    expect(calls).toEqual([
      [
        "-n",
        "octogee-test",
        "delete",
        "secret/gateway-auth-token-walter",
        "--ignore-not-found=true",
      ],
    ]);
  });

  it("throws on kubectl delete secret failures", async () => {
    const { runKubectl } = mockSubprocess([
      { stderr: "Error from server (Forbidden): denied", code: 1 },
    ]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.deleteSecret({
        namespace: "octogee-test",
        name: "gateway-auth-token-walter",
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("createKubeSubprocessRunner — delete gateway-owned identity and service", () => {
  it("deletes a ServiceAccount and Service idempotently", async () => {
    const { runKubectl, calls } = mockSubprocess([{}, {}]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await kube.deleteServiceAccount({ namespace: "octogee-test", name: "octogee-gw-walter" });
    await kube.deleteService({ namespace: "octogee-test", name: "gateway-edge-walter" });

    expect(calls).toEqual([
      ["-n", "octogee-test", "delete", "serviceaccount/octogee-gw-walter", "--ignore-not-found=true"],
      ["-n", "octogee-test", "delete", "service/gateway-edge-walter", "--ignore-not-found=true"],
    ]);
  });

  it("surfaces deletion failures", async () => {
    const { runKubectl } = mockSubprocess([{ stderr: "Forbidden", code: 1 }]);
    const kube = createKubeSubprocessRunner({ runKubectl, log: vi.fn() });

    await expect(
      kube.deleteServiceAccount({ namespace: "octogee-test", name: "octogee-gw-walter" }),
    ).rejects.toThrow(/Forbidden/);
  });
});
