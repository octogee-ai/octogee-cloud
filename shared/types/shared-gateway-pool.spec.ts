import { describe, expect, it } from "vitest";

import {
  authoritativeSharedGatewayLoad,
  compareSharedGatewayIds,
  sharedGatewayAddedBy,
  deriveSharedGatewayPoolConfig,
  isAcceptingSharedGateway,
  isSettledSharedGateway,
  isSharedPoolSlotId,
  parseSharedGatewayAutoscalingConfig,
  parseSharedGatewayPoolConfig,
  parseSharedPoolReplicaBounds,
  planSharedGatewayRebalance,
  selectSharedGateway,
} from "./shared-gateway-pool.js";

const config = {
  defaultGatewayId: "shared-0",
  sharedGatewayIds: ["shared-0", "shared-1"],
} as const;

function candidate(
  gatewayId: string,
  overrides: Partial<Parameters<typeof isAcceptingSharedGateway>[1]> = {},
) {
  return {
    gatewayId,
    gatewayClass: "shared",
    desiredStatus: "running",
    ready: true,
    serving: true,
    heartbeatFresh: true,
    liveReleaseReady: true,
    rosterComplete: true,
    incomingMigrationCount: 0,
    assignmentCount: 0,
    ...overrides,
  };
}

function root(
  gatewayId: string,
  overrides: Partial<{ gatewayClass: unknown; desiredStatus: unknown }> = {},
) {
  return { gatewayId, gatewayClass: "shared", desiredStatus: "running", ...overrides };
}

describe("shared pool slot ids", () => {
  it("recognises shared gateway identities without interpreting their suffix", () => {
    for (const id of ["shared-0", "shared-12", "shared-a", "shared-abc012345678"]) {
      expect(isSharedPoolSlotId(id)).toBe(true);
    }
    for (const id of ["shared-", "shared", "builder-0", 7, null]) {
      expect(isSharedPoolSlotId(id)).toBe(false);
    }
  });

  it("orders gateway identities deterministically", () => {
    expect(["shared-b", "shared-10", "shared-2", "shared-a", "shared-0"].sort(compareSharedGatewayIds))
      .toEqual(["shared-0", "shared-10", "shared-2", "shared-a", "shared-b"]);
  });
});

describe("deriveSharedGatewayPoolConfig", () => {
  it("derives the pool from shared roots in a member status only", () => {
    expect(deriveSharedGatewayPoolConfig([
      root("shared-1"),
      root("shared-0", { desiredStatus: "paused" }),
      root("shared-a", { desiredStatus: "draining" }),
      root("walter", { gatewayClass: "isolated" }),
      root("shared-3", { desiredStatus: "retired" }),
      root("NOT VALID"),
    ])).toEqual({
      defaultGatewayId: "shared-1",
      sharedGatewayIds: ["shared-1", "shared-0", "shared-a"],
    });
  });

  it("anchors on the first running member in slot order, else the first member", () => {
    expect(deriveSharedGatewayPoolConfig([
      root("shared-2"),
      root("shared-0", { desiredStatus: "paused" }),
    ])?.defaultGatewayId).toBe("shared-2");
    expect(deriveSharedGatewayPoolConfig([
      root("shared-1", { desiredStatus: "paused" }),
      root("shared-0", { desiredStatus: "paused" }),
    ])?.defaultGatewayId).toBe("shared-0");
  });

  it("is null for an empty pool and carries the autoscaling knobs when given", () => {
    expect(deriveSharedGatewayPoolConfig([root("walter", { gatewayClass: "isolated" })])).toBeNull();
    expect(deriveSharedGatewayPoolConfig(
      [root("shared-0")],
      { enabled: false, buildersPerGateway: 3 },
    )).toEqual({
      defaultGatewayId: "shared-0",
      sharedGatewayIds: ["shared-0"],
      sharedGatewayAutoscaling: { enabled: false, buildersPerGateway: 3 },
    });
  });
});

describe("parseSharedGatewayPoolConfig", () => {
  it("requires a valid unique pool with the anchor first", () => {
    expect(parseSharedGatewayPoolConfig(config)).toEqual(config);
    expect(parseSharedGatewayPoolConfig({ defaultGatewayId: "shared-0" })).toBeNull();
    expect(parseSharedGatewayPoolConfig({
      defaultGatewayId: "shared-0",
      sharedGatewayIds: ["shared-1", "shared-0"],
    })).toBeNull();
    expect(parseSharedGatewayPoolConfig({
      defaultGatewayId: "shared-0",
      sharedGatewayIds: ["shared-0", "shared-0"],
    })).toBeNull();
    expect(parseSharedGatewayPoolConfig({
      defaultGatewayId: "shared-0",
      sharedGatewayIds: ["shared-0", "NOT VALID"],
    })).toBeNull();
  });
});

describe("scaling configuration", () => {
  it("parses the operator autoscaling knobs with defaults", () => {
    expect(parseSharedGatewayAutoscalingConfig(undefined)).toEqual({
      enabled: true,
      buildersPerGateway: 10,
    });
    expect(parseSharedGatewayAutoscalingConfig({ enabled: false, buildersPerGateway: 2 })).toEqual({
      enabled: false,
      buildersPerGateway: 2,
    });
    expect(parseSharedGatewayAutoscalingConfig({ buildersPerGateway: 1 })).toBeNull();
    expect(parseSharedGatewayAutoscalingConfig({ enabled: "yes" })).toBeNull();
    expect(parseSharedGatewayAutoscalingConfig({ minHotMembers: 2 })).toEqual({
      enabled: true,
      buildersPerGateway: 10,
    });
  });

  it("parses the environment replica bounds", () => {
    expect(parseSharedPoolReplicaBounds({ minReplicas: "0", maxReplicas: "8" })).toEqual({
      minReplicas: 0,
      maxReplicas: 8,
    });
    expect(parseSharedPoolReplicaBounds({ minReplicas: 2, maxReplicas: 2 })).toEqual({
      minReplicas: 2,
      maxReplicas: 2,
    });
    for (const bounds of [
      { minReplicas: "3", maxReplicas: "2" },
      { minReplicas: "-1", maxReplicas: "2" },
      { minReplicas: "0", maxReplicas: "0" },
      { minReplicas: "1.5", maxReplicas: "2" },
      { minReplicas: undefined, maxReplicas: "2" },
    ]) {
      expect(parseSharedPoolReplicaBounds(bounds)).toBeNull();
    }
  });
});

describe("shared gateway selection", () => {
  it("chooses the least authoritative load", () => {
    expect(authoritativeSharedGatewayLoad(candidate("shared-0", {
      assignmentCount: 2,
      incomingMigrationCount: 1,
    }))).toBe(3);
    expect(selectSharedGateway({
      buildersPerGateway: 4,
      uid: "uid-alice",
      purpose: "initial-placement",
      config,
      candidates: [candidate("shared-0", { assignmentCount: 4 }), candidate("shared-1", { assignmentCount: 2 })],
    })).toMatchObject({ kind: "selected", gatewayId: "shared-1", load: 2 });
  });

  it("uses a stable uid hash to distribute equal loads", () => {
    const candidates = [candidate("shared-0"), candidate("shared-1")];
    const picks = new Set(
      Array.from({ length: 32 }, (_, index) => selectSharedGateway({
        buildersPerGateway: 4,
        uid: `uid-${index}`,
        purpose: "initial-placement",
        config,
        candidates,
      })).map((selection) => selection.kind === "selected" ? selection.gatewayId : null),
    );
    expect(picks).toEqual(new Set(["shared-0", "shared-1"]));
    expect(selectSharedGateway({ uid: "uid-7", config, candidates, purpose: "initial-placement", buildersPerGateway: 4 })).toEqual(
      selectSharedGateway({ uid: "uid-7", config, candidates, purpose: "initial-placement", buildersPerGateway: 4 }),
    );
  });

  it("keeps a healthy current member until its load is more than one above the minimum", () => {
    expect(selectSharedGateway({
      buildersPerGateway: 4,
      uid: "uid-alice",
      purpose: "initial-placement",
      config,
      currentGatewayId: "shared-0",
      candidates: [candidate("shared-0", { assignmentCount: 3 }), candidate("shared-1", { assignmentCount: 2 })],
    })).toMatchObject({ gatewayId: "shared-0", retainedCurrent: true });
    expect(selectSharedGateway({
      buildersPerGateway: 4,
      uid: "uid-alice",
      purpose: "initial-placement",
      config,
      currentGatewayId: "shared-0",
      candidates: [candidate("shared-0", { assignmentCount: 4 }), candidate("shared-1", { assignmentCount: 2 })],
    })).toMatchObject({ gatewayId: "shared-1", retainedCurrent: false });
  });

  it("excludes invalid destinations and blocks visibly when none accept", () => {
    for (const overrides of [
      { ready: false },
      { heartbeatFresh: false },
      { gatewayClass: "isolated" },
      { gatewayId: "isolated" },
    ]) {
      expect(isAcceptingSharedGateway(config, candidate("shared-0", overrides))).toBe(false);
    }
    expect(selectSharedGateway({
      buildersPerGateway: 4,
      uid: "uid-alice",
      purpose: "initial-placement",
      config,
      candidates: [candidate("shared-0", { ready: false })],
    })).toEqual({ kind: "blocked", reason: "no-accepting-shared-gateway" });
  });

  it("accepts a gateway still mounting an earlier user for a new signup, but not as a migration target", () => {
    const mounting = candidate("shared-0", { rosterComplete: false, assignmentCount: 1 });
    expect(isAcceptingSharedGateway(config, mounting)).toBe(true);
    expect(isSettledSharedGateway(config, mounting)).toBe(false);
    expect(selectSharedGateway({
      buildersPerGateway: 4,
      uid: "uid-alice",
      purpose: "initial-placement",
      config,
      candidates: [mounting],
    })).toMatchObject({ kind: "selected", gatewayId: "shared-0", load: 1 });
    expect(selectSharedGateway({
      buildersPerGateway: 4,
      uid: "uid-alice",
      purpose: "migration",
      config,
      candidates: [mounting],
    })).toEqual({ kind: "blocked", reason: "no-accepting-shared-gateway" });
  });

  it("keeps a user on its current gateway while that roster is still mounting, even beside a settled peer", () => {
    const mounting = candidate("shared-0", { rosterComplete: false, assignmentCount: 2 });
    const settledPeer = candidate("shared-1", { assignmentCount: 1 });
    expect(selectSharedGateway({
      buildersPerGateway: 4,
      uid: "uid-alice",
      purpose: "migration",
      config,
      currentGatewayId: "shared-0",
      candidates: [mounting, settledPeer],
    })).toMatchObject({ kind: "selected", gatewayId: "shared-0", retainedCurrent: true });
    expect(selectSharedGateway({
      buildersPerGateway: 4,
      uid: "uid-alice",
      purpose: "migration",
      config,
      currentGatewayId: "shared-0",
      candidates: [mounting],
    })).toMatchObject({ kind: "selected", gatewayId: "shared-0", retainedCurrent: true });
  });

  it("still leaves a current gateway that is no longer accepting", () => {
    expect(selectSharedGateway({
      buildersPerGateway: 4,
      uid: "uid-alice",
      purpose: "migration",
      config,
      currentGatewayId: "shared-0",
      candidates: [candidate("shared-0", { serving: false }), candidate("shared-1")],
    })).toMatchObject({ kind: "selected", gatewayId: "shared-1", retainedCurrent: false });
  });

  it("uses queued migrations as projected load without rejecting their target", () => {
    expect(selectSharedGateway({
      buildersPerGateway: 4,
      uid: "uid-alice",
      purpose: "initial-placement",
      config,
      candidates: [
        candidate("shared-0", { assignmentCount: 1, incomingMigrationCount: 2 }),
        candidate("shared-1", { assignmentCount: 2 }),
      ],
    })).toMatchObject({ kind: "selected", gatewayId: "shared-1", load: 2 });
  });

  it("plans one recovery rebalance only when the healthy pool differs by two", () => {
    expect(planSharedGatewayRebalance({
      config,
      candidates: [candidate("shared-0", { assignmentCount: 4 }), candidate("shared-1", { assignmentCount: 2 })],
    })).toEqual({ fromGatewayId: "shared-0", toGatewayId: "shared-1" });
    expect(planSharedGatewayRebalance({
      config,
      candidates: [candidate("shared-0", { assignmentCount: 3 }), candidate("shared-1", { assignmentCount: 2 })],
    })).toBeNull();
    expect(planSharedGatewayRebalance({
      config,
      candidates: [
        candidate("shared-0", { assignmentCount: 4 }),
        candidate("shared-1", { assignmentCount: 2, rosterComplete: false }),
      ],
    })).toBeNull();
  });
});

describe("initial placement capacity", () => {
  it("queues a signup while the only warm member is full and its peer is starting", () => {
    expect(selectSharedGateway({
      buildersPerGateway: 4,
      uid: "new", config, purpose: "initial-placement",
      candidates: [candidate("shared-0", { assignmentCount: 4 }), candidate("shared-1", { ready: false })],
    })).toEqual({ kind: "blocked", reason: "no-accepting-shared-gateway" });
  });
  it("counts incoming migrations against the new-placement budget", () => {
    expect(selectSharedGateway({
      buildersPerGateway: 4,
      uid: "new", config, purpose: "initial-placement",
      candidates: [candidate("shared-0", { assignmentCount: 3, incomingMigrationCount: 1 })],
    })).toEqual({ kind: "blocked", reason: "no-accepting-shared-gateway" });
  });
  it("retains an existing assignment even when its member is over budget", () => {
    expect(selectSharedGateway({
      buildersPerGateway: 4,
      uid: "existing", config, purpose: "initial-placement",
      currentGatewayId: "shared-0", candidates: [candidate("shared-0", { assignmentCount: 20 })],
    })).toMatchObject({ kind: "selected", gatewayId: "shared-0", retainedCurrent: true });
  });
});

describe("sharedGatewayAddedBy", () => {
  it("names the scaler's gateways automation and every other creator operator", () => {
    expect(sharedGatewayAddedBy({ createdBy: "glm-controller-shared-pool-scaler" })).toBe("automation");
    expect(sharedGatewayAddedBy({ createdBy: "operator-uid" })).toBe("operator");
  });
});
