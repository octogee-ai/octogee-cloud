import { describe, expect, it } from "vitest";

import type {
  GatewayPodPlacement,
  GatewayPodReplacements,
} from "@octogee/shared/types/gateway-pod-replacements";
import {
  classifyVacatedPod,
  nextPodReplacementTransition,
  observedPodPlacements,
  observedReplicaSets,
  type ObservedReplicaSet,
} from "./pod-replacement-tracking.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_770_000_000_000;

const OLD_RS = "rs-old";
const NEW_RS = "rs-new";

function placement(uid: string, overrides: Partial<GatewayPodPlacement> = {}): GatewayPodPlacement {
  return {
    uid,
    name: `octogee-gateway-ceckert-test-xs-98d6b8cd7-${uid}`,
    replicaSetUid: OLD_RS,
    nodeName: "gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-q7zd",
    instanceId: "7311234567890123456",
    nodePool: "nap-1dx2tv8d",
    ...overrides,
  };
}

function replicaSet(
  uid: string,
  overrides: Partial<ObservedReplicaSet> = {},
): ObservedReplicaSet {
  return {
    uid,
    name: `octogee-gateway-ceckert-test-xs-${uid}`,
    desiredReplicas: 1,
    observedReplicas: 1,
    ...overrides,
  };
}

function history(overrides: Partial<GatewayPodReplacements> = {}): GatewayPodReplacements {
  return {
    recentAt: [],
    lastAt: null,
    lastVacatedPodUid: null,
    lastVacatedNodeName: null,
    lastVacatedInstanceId: null,
    lastVacatedNodePool: null,
    total: 0,
    ...overrides,
  };
}

function transition(overrides: {
  previousPlacements?: readonly GatewayPodPlacement[] | null;
  previous?: GatewayPodReplacements | null;
  observedPlacements?: readonly GatewayPodPlacement[] | null;
  replicaSets?: readonly ObservedReplicaSet[] | null;
  now?: number;
} = {}) {
  return nextPodReplacementTransition({
    previousPlacements: overrides.previousPlacements === undefined
      ? [placement("uid-a")]
      : overrides.previousPlacements,
    previous: overrides.previous ?? null,
    observedPlacements: overrides.observedPlacements === undefined
      ? [placement("uid-b")]
      : overrides.observedPlacements,
    replicaSets: overrides.replicaSets === undefined
      ? [replicaSet(OLD_RS)]
      : overrides.replicaSets,
    now: overrides.now ?? NOW,
  });
}

describe("observedPodPlacements", () => {
  it("returns null when diagnostics are unreadable so nothing is attributed", () => {
    expect(observedPodPlacements({ status: "unknown", totalPods: 0, readyPods: 0 })).toBeNull();
    expect(observedPodPlacements(undefined)).toBeNull();
    expect(observedPodPlacements({
      status: "ready", totalPods: 1, readyPods: 1, error: "kubectl exploded",
    })).toBeNull();
  });

  it("returns an empty set for a legitimately observed missing pod", () => {
    expect(observedPodPlacements({ status: "missing", totalPods: 0, readyPods: 0, pods: [] }))
      .toEqual([]);
  });

  it("carries the owner and node identity needed to classify and join a loss", () => {
    expect(observedPodPlacements({
      status: "ready",
      totalPods: 1,
      readyPods: 1,
      pods: [{
        uid: "uid-a",
        name: "octogee-gateway-ceckert-test-xs-98d6b8cd7-mg4l5",
        replicaSetUid: OLD_RS,
        nodeName: "gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-q7zd",
        instanceId: "7311234567890123456",
        nodePool: "nap-1dx2tv8d",
      }],
    })).toEqual([{
      uid: "uid-a",
      name: "octogee-gateway-ceckert-test-xs-98d6b8cd7-mg4l5",
      replicaSetUid: OLD_RS,
      nodeName: "gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-q7zd",
      instanceId: "7311234567890123456",
      nodePool: "nap-1dx2tv8d",
    }]);
  });

  it("tolerates a pod that has not been scheduled onto a node yet", () => {
    expect(observedPodPlacements({
      status: "not-ready", totalPods: 1, readyPods: 0, pods: [{ uid: "uid-a", replicaSetUid: OLD_RS }],
    })).toEqual([{
      uid: "uid-a",
      name: "uid-a",
      replicaSetUid: OLD_RS,
      nodeName: null,
      instanceId: null,
      nodePool: null,
    }]);
  });

  it("orders identities by code point so stored and observed sets compare index-wise", () => {
    const placements = observedPodPlacements({
      status: "ready",
      totalPods: 3,
      readyPods: 3,
      pods: [{ uid: "b" }, { uid: "B" }, { uid: "a" }, { uid: "b" }],
    });
    expect(placements?.map((pod) => pod.uid)).toEqual(["B", "a", "b"]);
  });

  it("refuses to guess when a pod carries no uid", () => {
    expect(observedPodPlacements({
      status: "ready", totalPods: 1, readyPods: 1, pods: [{ uid: null }],
    })).toBeNull();
  });
});

describe("observedReplicaSets", () => {
  it("returns null when the ReplicaSet list was not read", () => {
    expect(observedReplicaSets({ status: "ready", totalPods: 1, readyPods: 1 })).toBeNull();
    expect(observedReplicaSets(undefined)).toBeNull();
  });

  it("returns an empty list when the gateway has no ReplicaSet at all", () => {
    expect(observedReplicaSets({ status: "missing", totalPods: 0, readyPods: 0, replicaSets: [] }))
      .toEqual([]);
  });
});

describe("classifyVacatedPod", () => {
  const observedNone: GatewayPodPlacement[] = [];

  it("is unplanned when the ReplicaSet still wants the pod and agrees it is gone", () => {
    expect(classifyVacatedPod(
      placement("uid-a"),
      [replicaSet(OLD_RS, { desiredReplicas: 1, observedReplicas: 0 })],
      observedNone,
    )).toBe("unplanned");
  });

  it("is unplanned when the ReplicaSet already counts the replacement pod", () => {
    expect(classifyVacatedPod(
      placement("uid-a"),
      [replicaSet(OLD_RS, { desiredReplicas: 1, observedReplicas: 1 })],
      [placement("uid-c")],
    )).toBe("unplanned");
  });

  it("is planned when the ReplicaSet was scaled to zero", () => {
    expect(classifyVacatedPod(
      placement("uid-a"),
      [replicaSet(OLD_RS, { desiredReplicas: 0, observedReplicas: 0 })],
      observedNone,
    )).toBe("planned");
  });

  it("is planned when the ReplicaSet no longer exists", () => {
    expect(classifyVacatedPod(placement("uid-a"), [replicaSet(NEW_RS)], observedNone))
      .toBe("planned");
  });

  it("is deferred when the ReplicaSet controller counts more pods than were observed", () => {
    expect(classifyVacatedPod(
      placement("uid-a"),
      [replicaSet(OLD_RS, { desiredReplicas: 1, observedReplicas: 1 })],
      observedNone,
    )).toBe("deferred");
  });

  it("is unowned when the pod had no ReplicaSet", () => {
    expect(classifyVacatedPod(
      placement("uid-a", { replicaSetUid: null }),
      [replicaSet(OLD_RS)],
      observedNone,
    )).toBe("unowned");
  });
});

describe("nextPodReplacementTransition", () => {
  it("counts a pod lost while its ReplicaSet still wanted it running", () => {
    const result = transition({
      observedPlacements: [placement("uid-b")],
      replicaSets: [replicaSet(OLD_RS, { observedReplicas: 1 })],
    });
    expect(result!.vacated.map((pod) => pod.uid)).toEqual(["uid-a"]);
    expect(result!.replacements).toMatchObject({
      recentAt: [NOW],
      lastAt: NOW,
      lastVacatedPodUid: "uid-a",
      lastVacatedNodeName: "gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-q7zd",
      lastVacatedInstanceId: "7311234567890123456",
      lastVacatedNodePool: "nap-1dx2tv8d",
      total: 1,
    });
    expect(result!.placements.map((pod) => pod.uid)).toEqual(["uid-b"]);
  });

  it("counts the loss immediately when no successor pod exists yet", () => {
    const result = transition({
      observedPlacements: [],
      replicaSets: [replicaSet(OLD_RS, { desiredReplicas: 1, observedReplicas: 0 })],
    });
    expect(result!.vacated.map((pod) => pod.uid)).toEqual(["uid-a"]);
    expect(result!.replacements?.total).toBe(1);
    expect(result!.placements).toEqual([]);
  });

  // A surge roll: the new ReplicaSet's pod comes up first, then the old
  // ReplicaSet is scaled to zero and its pod removed one or more ticks later.
  it("attributes the old pod of a surge roll to the roll, not to a loss", () => {
    const result = transition({
      previousPlacements: [placement("uid-a"), placement("uid-b", { replicaSetUid: NEW_RS })],
      observedPlacements: [placement("uid-b", { replicaSetUid: NEW_RS })],
      replicaSets: [
        replicaSet(OLD_RS, { desiredReplicas: 0, observedReplicas: 0 }),
        replicaSet(NEW_RS, { desiredReplicas: 1, observedReplicas: 1 }),
      ],
    });
    expect(result!.vacated).toEqual([]);
    expect(result!.replacements).toBeNull();
    expect(result!.placements.map((pod) => pod.uid)).toEqual(["uid-b"]);
  });

  // A recreate roll: the old pod is removed before the new one is created, so
  // an observation can land on zero pods with only the scaled-down ReplicaSet.
  it("attributes the empty window of a recreate roll to the roll", () => {
    const result = transition({
      observedPlacements: [],
      replicaSets: [replicaSet(OLD_RS, { desiredReplicas: 0, observedReplicas: 0 })],
    });
    expect(result!.vacated).toEqual([]);
    expect(result!.replacements).toBeNull();
  });

  it("attributes a pod removed by a rollout restart to the restart", () => {
    const result = transition({
      observedPlacements: [placement("uid-b", { replicaSetUid: NEW_RS })],
      replicaSets: [
        replicaSet(OLD_RS, { desiredReplicas: 0, observedReplicas: 0 }),
        replicaSet(NEW_RS),
      ],
    });
    expect(result!.vacated).toEqual([]);
  });

  it("attributes a pod removed by a pause to the pause", () => {
    const result = transition({
      observedPlacements: [],
      replicaSets: [replicaSet(OLD_RS, { desiredReplicas: 0, observedReplicas: 0 })],
    });
    expect(result!.vacated).toEqual([]);
  });

  it("attributes a pod removed by an uninstall to the uninstall", () => {
    const result = transition({ observedPlacements: [], replicaSets: [] });
    expect(result!.vacated).toEqual([]);
  });

  it("counts a preemption during a roll only for the pod the roll still wanted", () => {
    const result = transition({
      previousPlacements: [placement("uid-a"), placement("uid-b", { replicaSetUid: NEW_RS })],
      observedPlacements: [],
      replicaSets: [
        replicaSet(OLD_RS, { desiredReplicas: 0, observedReplicas: 0 }),
        replicaSet(NEW_RS, { desiredReplicas: 1, observedReplicas: 0 }),
      ],
    });
    expect(result!.vacated.map((pod) => pod.uid)).toEqual(["uid-b"]);
  });

  it("defers the verdict while the pod list is behind the ReplicaSet controller", () => {
    const result = transition({
      observedPlacements: [],
      replicaSets: [replicaSet(OLD_RS, { desiredReplicas: 1, observedReplicas: 1 })],
    });
    expect(result!.vacated).toEqual([]);
    expect(result!.deferred.map((pod) => pod.uid)).toEqual(["uid-a"]);
    expect(result!.placements.map((pod) => pod.uid)).toEqual(["uid-a"]);
    expect(result!.replacements).toBeNull();
  });

  it("resolves a deferred pod on the next observation", () => {
    const deferred = transition({
      observedPlacements: [],
      replicaSets: [replicaSet(OLD_RS, { desiredReplicas: 1, observedReplicas: 1 })],
    });
    const resolved = transition({
      previousPlacements: deferred!.placements,
      previous: deferred!.replacements,
      observedPlacements: [],
      replicaSets: [replicaSet(OLD_RS, { desiredReplicas: 1, observedReplicas: 0 })],
      now: NOW + 15_000,
    });
    expect(resolved!.vacated.map((pod) => pod.uid)).toEqual(["uid-a"]);
    expect(resolved!.replacements?.total).toBe(1);
  });

  it("does not count a mass disappearance the ReplicaSet controllers do not confirm", () => {
    const result = transition({
      previousPlacements: [placement("uid-a"), placement("uid-b", { replicaSetUid: NEW_RS })],
      observedPlacements: [],
      replicaSets: [replicaSet(OLD_RS), replicaSet(NEW_RS)],
    });
    expect(result!.vacated).toEqual([]);
    expect(result!.deferred.map((pod) => pod.uid)).toEqual(["uid-a", "uid-b"]);
  });

  it("defers every verdict when the ReplicaSet list was not read", () => {
    const result = transition({ replicaSets: null });
    expect(result!.vacated).toEqual([]);
    expect(result!.deferred.map((pod) => pod.uid)).toEqual(["uid-a"]);
    expect(result!.placements.map((pod) => pod.uid)).toEqual(["uid-a", "uid-b"]);
  });

  it("drops an unowned pod without counting it", () => {
    const result = transition({
      previousPlacements: [placement("uid-a", { replicaSetUid: null })],
      observedPlacements: [],
    });
    expect(result!.vacated).toEqual([]);
    expect(result!.unowned.map((pod) => pod.uid)).toEqual(["uid-a"]);
    expect(result!.placements).toEqual([]);
  });

  it("does not count the first observation of a gateway", () => {
    const result = transition({ previousPlacements: null });
    expect(result!.vacated).toEqual([]);
    expect(result!.replacements).toBeNull();
    expect(result!.placements.map((pod) => pod.uid)).toEqual(["uid-b"]);
  });

  it("does not count an unchanged pod identity set", () => {
    const result = transition({ observedPlacements: [placement("uid-a")] });
    expect(result!.vacated).toEqual([]);
  });

  it("does not count a pod that changed nodes but kept its identity", () => {
    const result = transition({
      observedPlacements: [placement("uid-a", { nodeName: "other-node", instanceId: "999" })],
    });
    expect(result!.vacated).toEqual([]);
    expect(result!.placements[0]?.instanceId).toBe("999");
  });

  it("does not count a newly appeared pod on its own", () => {
    const result = transition({ previousPlacements: [], observedPlacements: [placement("uid-b")] });
    expect(result!.vacated).toEqual([]);
  });

  it("counts the loss once across the empty window and its recovery", () => {
    const gone = transition({
      observedPlacements: [],
      replicaSets: [replicaSet(OLD_RS, { observedReplicas: 0 })],
    });
    const back = transition({
      previousPlacements: gone!.placements,
      previous: gone!.replacements,
      observedPlacements: [placement("uid-c")],
      replicaSets: [replicaSet(OLD_RS)],
      now: NOW + HOUR,
    });
    expect(gone!.replacements?.total).toBe(1);
    expect(back!.replacements?.total).toBe(1);
    expect(back!.replacements?.lastVacatedPodUid).toBe("uid-a");
  });

  it("skips accounting entirely when the pod list is unreadable", () => {
    expect(transition({ observedPlacements: null })).toBeNull();
  });

  it("writes no loss history for a gateway that has never lost a pod", () => {
    const result = transition({ observedPlacements: [placement("uid-a")] });
    expect(result!.replacements).toBeNull();
  });

  it("carries prior history forward and appends the new loss", () => {
    const result = transition({
      previous: history({ recentAt: [NOW - 2 * HOUR], lastAt: NOW - 2 * HOUR, total: 5 }),
      replicaSets: [replicaSet(OLD_RS, { observedReplicas: 1 })],
    });
    expect(result!.replacements?.recentAt).toEqual([NOW - 2 * HOUR, NOW]);
    expect(result!.replacements?.total).toBe(6);
  });

  it("drops window entries older than seven days while keeping the lifetime total", () => {
    const result = transition({
      previous: history({ recentAt: [NOW - 8 * DAY, NOW - 2 * DAY], lastAt: NOW - 2 * DAY, total: 7 }),
      replicaSets: [replicaSet(OLD_RS, { observedReplicas: 1 })],
    });
    expect(result!.replacements?.recentAt).toEqual([NOW - 2 * DAY, NOW]);
    expect(result!.replacements?.total).toBe(8);
  });

  it("keeps a loss stamped by a newer clock rather than erasing it", () => {
    const result = transition({
      previous: history({ recentAt: [NOW + 200], lastAt: NOW + 200, total: 1 }),
      observedPlacements: [placement("uid-a")],
    });
    expect(result!.replacements?.recentAt).toEqual([NOW + 200]);
  });

  it("bounds the retained window so a hot-looping gateway cannot grow the document", () => {
    const result = transition({
      previous: history({
        recentAt: Array.from({ length: 200 }, (_, index) => NOW - 200 * 1000 + index),
        lastAt: NOW - 1000,
        total: 200,
      }),
      replicaSets: [replicaSet(OLD_RS, { observedReplicas: 1 })],
    });
    expect(result!.replacements?.recentAt.length).toBe(64);
    expect(result!.replacements?.recentAt.at(-1)).toBe(NOW);
    expect(result!.replacements?.total).toBe(201);
  });

  it("treats identity order as insignificant", () => {
    const result = transition({
      previousPlacements: [placement("uid-b"), placement("uid-a")],
      observedPlacements: [placement("uid-a"), placement("uid-b")],
    });
    expect(result!.vacated).toEqual([]);
  });
});
