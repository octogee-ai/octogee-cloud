import { describe, expect, it, vi } from "vitest";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import { persistKubernetesObservations } from "../gateway-kubernetes-observation.js";

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
