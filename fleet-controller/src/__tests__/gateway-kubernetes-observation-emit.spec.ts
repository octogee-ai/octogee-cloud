import { describe, expect, it, vi } from "vitest";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";

import { observeGatewayKubernetes, persistKubernetesObservations } from "../gateway-kubernetes-observation.js";

const RS = { uid: "rs-live", name: "octogee-gateway-shared-a-98d6b8cd7", desiredReplicas: 1, observedReplicas: 0 };

function runtimeDoc(kubernetes: Record<string, unknown>) {
  return {
    docKind: "runtime",
    gatewayId: "shared-a",
    release: 1,
    lifecycle: "serving",
    createdAt: 1,
    createdByOperationId: null,
    helm: {},
    heartbeat: { status: "ready", mountedCustomers: [] },
    lastError: { message: null, at: null },
    kubernetes,
  };
}

// The store re-runs a transaction body on contention. The body must therefore
// be free of side effects: the structured record feeds a DELTA log metric that
// would count every retry as another loss.
function contendedStore(stored: Record<string, unknown>, attempts: number) {
  const documents = new Map<string, Record<string, unknown>>([["glmGateways/shared-a", stored]]);
  const committed = createDocumentFixtureStore(documents);
  const bodies = vi.fn();
  const store = new Proxy(committed, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return async (...[options, body]: Parameters<PlatformStateStore["transaction"]>) => {
        const counted: typeof body = (transaction) => {
          bodies();
          return body(transaction);
        };
        for (let attempt = 1; attempt < attempts; attempt += 1) {
          await createDocumentFixtureStore(structuredClone(documents)).transaction(options, counted);
        }
        return target.transaction(options, counted);
      };
    },
  });
  return { store, documents, bodies, scanned: [{ gatewayId: "shared-a", kubernetes: stored.kubernetes }] };
}

describe("persistKubernetesObservations — emission is outside the transaction", () => {
  it("emits exactly one record for a lost pod even when the transaction callback is retried", async () => {
    const { store, documents, bodies, scanned } = contendedStore(runtimeDoc({
      status: "ready",
      totalPods: 1,
      readyPods: 1,
      observedAt: 20_000,
      pods: [{
        uid: "uid-a",
        name: "octogee-gateway-shared-a-98d6b8cd7-uid-a",
        replicaSetUid: RS.uid,
        nodeName: "node-1",
        instanceId: "111",
        nodePool: "nap-1dx2tv8d",
      }],
    }), 3);
    const emitted: unknown[] = [];
    const log = vi.fn();

    await persistKubernetesObservations(store, scanned, {
      "shared-a": { status: "missing", totalPods: 0, readyPods: 0, pods: [], replicaSets: [RS] },
    }, 25_000, { emitReplacement: (record) => emitted.push(record), log, namespace: "octogee-test" });

    expect(bodies).toHaveBeenCalledTimes(3);
    expect(documents.get("glmGateways/shared-a")).toMatchObject({ podReplacements: { total: 1 } });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ vacatedPodUid: "uid-a", instanceId: "111", total: 1 });
    expect(log.mock.calls.filter(([line]) => /lost pod/.test(String(line)))).toHaveLength(1);
  });

  it("emits nothing when the transaction never commits an observation", async () => {
    const { store, scanned } = contendedStore(runtimeDoc({
      status: "ready",
      totalPods: 1,
      readyPods: 1,
      observedAt: 90_000,
      pods: [{ uid: "uid-a", name: "pod-a", replicaSetUid: RS.uid, nodeName: null, instanceId: null, nodePool: null }],
    }), 1);
    const emitted: unknown[] = [];

    await persistKubernetesObservations(store, scanned, {
      "shared-a": { status: "missing", totalPods: 0, readyPods: 0, pods: [], replicaSets: [RS] },
    }, 20_000, { emitReplacement: (record) => emitted.push(record) });

    expect(emitted).toEqual([]);
  });
});


it("remembers a terminal exact writer independently of a replacement or a provider VM lookup", async () => {
  const gatewayId = "builder-alice";
  const node = { providerId: "gce://octogee-test/us-central1-a/node-a", instanceId: "123" };
  const pod = { uid: "original", name: "octogee-gateway-builder-alice-rs-original" };
  const documents = new Map<string, Record<string, unknown>>([
    [`gateways/${gatewayId}`, {
      gatewayId, createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
      latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running", configSchemaVersion: 1,
      gatewayClass: "isolated", imageProfile: "isolated", profile: null, sizingTier: "s", sizingProfile: "hobby",
      gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null,
      builderAccess: null, ownerUid: "uid-alice", builderSlug: "alice", modelBrokerLimits: null,
      allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "one", generation: 1, claimedByUid: "uid-alice", ephemeralHomeGiB: 4 },
      ephemeralWriter: { podUid: pod.uid, podName: pod.name, node },
    }],
    [`glmGateways/${gatewayId}`, { ...runtimeDoc({}), gatewayId }],
  ]);
  const store = createDocumentFixtureStore(documents);
  const checkCompute = vi.fn(async () => false);
  const check = (writerTerminated?: true) => observeGatewayKubernetes({
    store, namespace: "octogee-test", now: 4_000, log: vi.fn(), gatewayIds: [gatewayId],
    runtimes: [{ gatewayId, runtime: "cluster", kubernetes: undefined }],
    readGatewayPodDiagnosticsBatch: async () => ({
      [gatewayId]: { status: "not-ready", totalPods: 1, readyPods: 0,
        pods: [{ ...pod, deleting: true, writerTerminated }] },
    }),
    observeEphemeralNodeExclusion: checkCompute,
  });

  await check();
  expect((await store.gateways.roots.get(gatewayId))?.ephemeralWriter?.node).toEqual(node);
  await check(true);
  expect((await store.gateways.roots.get(gatewayId))?.ephemeralWriter?.node).toMatchObject({
    permanentlyExcludedAt: 4_000, exclusionMethod: "terminal-pod",
  });
  expect(checkCompute).not.toHaveBeenCalled();
});
