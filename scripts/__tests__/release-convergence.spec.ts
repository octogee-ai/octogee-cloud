import { describe, expect, it } from "vitest";

import {
  assessReleaseConvergence,
  hasBlockingRolloutFailure,
  type ReleaseConvergenceSnapshot,
} from "../lib/release-convergence.js";

function snapshot(
  overrides: Partial<ReleaseConvergenceSnapshot> = {},
): ReleaseConvergenceSnapshot {
  return {
    expectedImageTag: "abc1234-oc2026.7.1",
    configuredDefaultGatewayId: "shared-blue",
    gateways: [
      {
        gatewayId: "shared-blue",
        desiredStatus: "running",
        gatewayClass: "shared",
        desiredRelease: 4,
        liveRelease: 4,
        desiredImageTag: "abc1234-oc2026.7.1",
      },
      {
        gatewayId: "builder-chris",
        desiredStatus: "running",
        gatewayClass: "isolated",
        desiredRelease: 7,
        liveRelease: 7,
        desiredImageTag: "abc1234-oc2026.7.1",
      },
    ],
    rolloutOperations: [
      {
        id: "roll-shared",
        gatewayId: "shared-blue",
        imageTag: "abc1234-oc2026.7.1",
        status: "succeeded",
        error: null,
      },
      {
        id: "roll-user",
        gatewayId: "builder-chris",
        imageTag: "abc1234-oc2026.7.1",
        status: "succeeded",
        error: null,
      },
    ],
    defaultRuntime: {
      gatewayId: "shared-blue",
      release: 4,
      lifecycle: "serving",
      heartbeatStatus: "ready",
      heartbeatVersion: "abc1234-oc2026.7.1",
      mountedCustomers: ["chris", "jack"],
    },
    defaultAssignments: ["chris", "jack"],
    defaultAssignmentsServing: true,
    deployment: {
      name: "octogee-gateway-shared-blue",
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
    },
    pods: [
      {
        uid: "new-pod",
        name: "octogee-gateway-shared-blue-new",
        phase: "Running",
        ready: true,
        images: {
          gateway: "repo/octogee-gateway:abc1234-oc2026.7.1",
          "gateway-edge": "repo/gateway-edge:abc1234-oc2026.7.1",
        },
      },
    ],
    replicaSets: [
      { name: "current", current: true, desiredReplicas: 1, replicas: 1 },
      { name: "predecessor", current: false, desiredReplicas: 0, replicas: 0 },
    ],
    ...overrides,
  };
}

describe("assessReleaseConvergence", () => {
  it("accepts a fully converged configured shared gateway and fleet", () => {
    expect(assessReleaseConvergence(snapshot(), {
      configuredDefaultGatewayId: "shared-blue",
      predecessorPodUids: ["old-pod"],
      capturedAt: 1,
    })).toEqual({ converged: true, failures: [] });
  });

  it("accepts digest-pinned desired and heartbeat tags for the expected release tag", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const value = snapshot({
      gateways: snapshot().gateways.map((gateway) => ({
        ...gateway,
        desiredImageTag: `${gateway.desiredImageTag}@${digest}`,
      })),
      rolloutOperations: snapshot().rolloutOperations.map((operation) => ({
        ...operation,
        imageTag: `${operation.imageTag}@${digest}`,
      })),
      defaultRuntime: {
        ...snapshot().defaultRuntime!,
        heartbeatVersion: `abc1234-oc2026.7.1@${digest}`,
      },
    });

    expect(assessReleaseConvergence(value, {
      configuredDefaultGatewayId: "shared-blue",
      predecessorPodUids: ["old-pod"],
      capturedAt: 1,
    })).toEqual({ converged: true, failures: [] });
  });

  it("waits for every tagged fleet rollout operation", () => {
    const value = snapshot({
      rolloutOperations: [
        {
          id: "roll-shared",
          gatewayId: "shared-blue",
          imageTag: "abc1234-oc2026.7.1",
          status: "running",
          error: null,
        },
      ],
    });

    expect(assessReleaseConvergence(value, {
      configuredDefaultGatewayId: "shared-blue",
      predecessorPodUids: [],
      capturedAt: 1,
    }).failures).toContain("rollout roll-shared for shared-blue is running");
  });

  it("waits for every active gateway desired release to become live", () => {
    const value = snapshot({
      gateways: snapshot().gateways.map((gateway) => gateway.gatewayId === "builder-chris"
        ? { ...gateway, liveRelease: 6 }
        : gateway),
    });

    expect(assessReleaseConvergence(value, {
      configuredDefaultGatewayId: "shared-blue",
      predecessorPodUids: [],
      capturedAt: 1,
    }).failures).toContain("gateway builder-chris desired/live release drift: 7/6");
  });

  it("reports a failed tagged rollout with its controller error", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const value = snapshot({
      rolloutOperations: [
        {
          id: "roll-shared",
          gatewayId: "shared-blue",
          imageTag: `abc1234-oc2026.7.1@${digest}`,
          status: "failed",
          error: "readiness timeout",
        },
      ],
    });

    expect(assessReleaseConvergence(value, {
      configuredDefaultGatewayId: "shared-blue",
      predecessorPodUids: [],
      capturedAt: 1,
    }).failures).toContain(
      "rollout roll-shared for shared-blue failed: readiness timeout",
    );
    expect(hasBlockingRolloutFailure(value)).toBe(true);
  });

  it("ignores a failed tagged rollout superseded by gateway retirement", () => {
    const value = snapshot({
      gateways: [
        snapshot().gateways[0]!,
        {
          ...snapshot().gateways[1]!,
          desiredStatus: "retired",
        },
      ],
      rolloutOperations: [
        snapshot().rolloutOperations[0]!,
        {
          id: "roll-retired-user",
          gatewayId: "builder-chris",
          imageTag: "abc1234-oc2026.7.1",
          status: "failed",
          error: "readiness timeout",
        },
      ],
    });

    expect(assessReleaseConvergence(value, {
      configuredDefaultGatewayId: "shared-blue",
      predecessorPodUids: [],
      capturedAt: 1,
    })).toEqual({ converged: true, failures: [] });
    expect(hasBlockingRolloutFailure(value)).toBe(false);
  });

  it("rejects a default-pointer change during release", () => {
    const result = assessReleaseConvergence(snapshot({
      configuredDefaultGatewayId: "shared-green",
    }), {
      configuredDefaultGatewayId: "shared-blue",
      predecessorPodUids: [],
      capturedAt: 1,
    });

    expect(result.failures).toContain(
      "configured default changed during release: shared-blue -> shared-green",
    );
  });

  it("rejects assignment drift", () => {
    const result = assessReleaseConvergence(snapshot({
      defaultAssignments: ["chris"],
    }), {
      configuredDefaultGatewayId: "shared-blue",
      predecessorPodUids: [],
      capturedAt: 1,
    });

    expect(result.failures).toEqual(expect.arrayContaining([
      "default assignment roster does not equal mounted users (missing: none; orphan: jack)",
    ]));
  });

  it("rejects a configured-default assignment that remains quiesced", () => {
    const result = assessReleaseConvergence(snapshot({
      defaultAssignmentsServing: false,
    }), {
      configuredDefaultGatewayId: "shared-blue",
      predecessorPodUids: [],
      capturedAt: 1,
    });

    expect(result.failures).toContain("configured default has a non-serving assignment");
  });

  it("requires one ready current pod on both tagged images", () => {
    const value = snapshot({
      deployment: {
        name: "octogee-gateway-shared-blue",
        replicas: 2,
        updatedReplicas: 2,
        readyReplicas: 2,
        availableReplicas: 2,
      },
      pods: [
        {
          uid: "new-pod",
          name: "new-pod",
          phase: "Running",
          ready: true,
          images: {
            gateway: "repo/octogee-gateway:abc1234-oc2026.7.1",
            "gateway-edge": "repo/gateway-edge:old-tag",
          },
        },
        {
          uid: "second-pod",
          name: "second-pod",
          phase: "Running",
          ready: true,
          images: {
            gateway: "repo/octogee-gateway:abc1234-oc2026.7.1",
            "gateway-edge": "repo/gateway-edge:abc1234-oc2026.7.1",
          },
        },
      ],
    });

    const result = assessReleaseConvergence(value, {
      configuredDefaultGatewayId: "shared-blue",
      predecessorPodUids: [],
      capturedAt: 1,
    });
    expect(result.failures).toEqual(expect.arrayContaining([
      "default Deployment does not have exactly one desired, updated, Ready, available replica",
      "default Deployment does not have exactly one Ready current pod",
      "pod new-pod gateway-edge image is not tagged abc1234-oc2026.7.1",
    ]));
  });

  it("requires predecessor pods gone and old ReplicaSets scaled to zero", () => {
    const result = assessReleaseConvergence(snapshot({
      pods: [
        ...snapshot().pods,
        {
          uid: "old-pod",
          name: "old-pod",
          phase: "Running",
          ready: false,
          images: {
            gateway: "repo/octogee-gateway:old-tag",
            "gateway-edge": "repo/gateway-edge:old-tag",
          },
        },
      ],
      replicaSets: [
        { name: "current", current: true, desiredReplicas: 1, replicas: 1 },
        { name: "predecessor", current: false, desiredReplicas: 1, replicas: 1 },
      ],
    }), {
      configuredDefaultGatewayId: "shared-blue",
      predecessorPodUids: ["old-pod"],
      capturedAt: 1,
    });

    expect(result.failures).toEqual(expect.arrayContaining([
      "predecessor pods remain: old-pod",
      "old ReplicaSet predecessor still has pods (desired=1, observed=1)",
    ]));
  });
});
