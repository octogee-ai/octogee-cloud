import { describe, it, expect, vi } from "vitest";
import {
  buildHelmTargetMap,
  diffInstancesMap,
  type ReconcileChange,
} from "../reconcile-plan.js";
import { createRetireGatewayHandler, type RetireGatewayDeps } from "../handlers/retire-gateway.js";
import type { OperationContext } from "../operation-router.js";
import type {
  GatewayDesiredState,
  HelmInstanceValue,
  HelmInstancesMap,
  Operation,
  OperationStep,
} from "@octogee/shared/types/glm";

interface SharedState {
  helmReleases: Map<string, HelmInstanceValue>; 
  glmGateways: Map<string, GatewayDesiredState>; 
  gateways: Map<string, { mountedCustomers: string[]; lastHeartbeatAt: number }>;
  operations: Map<string, Operation>;
}

const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
const NS = "octogee-test";

function makeHelm(state: SharedState) {
  return {
    readDeployedInstances: async (): Promise<HelmInstancesMap> => {
      const out: HelmInstancesMap = {};
      for (const [name, v] of state.helmReleases) out[name] = v;
      return out;
    },
    upsertInstance: vi.fn(async () => undefined),
    removeInstance: vi.fn(async ({ gatewayId }: { namespace: string; gatewayId: string }) => {
      state.helmReleases.delete(gatewayId);
    }),
  };
}

function makeCtx(): OperationContext & { reported: OperationStep[] } {
  const reported: OperationStep[] = [];
  return {
    reportStep: vi.fn(async (s: OperationStep) => {
      reported.push(s);
    }),
    reported,
  };
}

async function reconcilerTick(
  state: SharedState,
  helm: ReturnType<typeof makeHelm>,
): Promise<ReconcileChange[]> {
  const desired = [...state.glmGateways.values()];
  const actualMap = await helm.readDeployedInstances();
  const mountedByGatewayId = new Map<string, readonly string[]>();
  for (const [id, hb] of state.gateways) mountedByGatewayId.set(id, hb.mountedCustomers);
  const targetMap = buildHelmTargetMap(desired, actualMap, mountedByGatewayId);
  const changes = diffInstancesMap(actualMap, targetMap);
  for (const change of changes) {
    if (change.kind === "drift") {
      await helm.removeInstance({ namespace: NS, gatewayId: change.gatewayId });
    }
  }
  return changes;
}

function adminDeleteGateway(
  state: SharedState,
  gatewayId: string,
): { status: number; operationId?: string; error?: string } {
  const glm = state.glmGateways.get(gatewayId);
  if (!glm) return { status: 404, error: "not found" };
  const hb = state.gateways.get(gatewayId);
  if (hb && hb.mountedCustomers.length > 0) {
    return { status: 409, error: "still has mounted users" };
  }

  const operationId = `op-${state.operations.size + 1}`;
  state.glmGateways.set(gatewayId, { ...glm, desiredStatus: "retired" });
  state.operations.set(operationId, {
    id: operationId,
    kind: "retire-gateway",
    status: "pending",
    createdBy: "admin@octogee.com",
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    input: { gatewayId, retirementClaimVersion: 1 },
    steps: [],
  });
  return { status: 202, operationId };
}

function makeRetireDeps(state: SharedState): RetireGatewayDeps {
  return {
    verifyRetirementClaim: async ({ gatewayId }: { gatewayId: string }) => {
      const desiredStatus = state.glmGateways.get(gatewayId)?.desiredStatus;
      if (desiredStatus !== undefined && desiredStatus !== "retired") {
        return { ok: false as const, error: "desiredStatus is no longer retired" };
      }
      return { ok: true as const };
    },
    readMountedUsers: async (gatewayId: string) =>
      state.gateways.get(gatewayId)?.mountedCustomers ?? [],
    readAssignmentsForGateway: async () => [],
    helmUninstallGateway: async (gatewayId: string) => {
      state.helmReleases.delete(gatewayId);
    },
    revokeAgentStoreCredentials: async (_gatewayId, assertCurrent) => { await assertCurrent(); },
    deleteGlmGateway: async (gatewayId: string) => {
      state.glmGateways.delete(gatewayId);
    },
    deleteGatewayPersistentVolumeClaim: vi.fn(async () => {}),
    deleteGatewayKubeSecret: vi.fn(async () => {}),
    deleteAuthTokenSecret: vi.fn(async () => {}),
    deleteGatewayServiceAccount: vi.fn(async () => {}),
    deleteGatewayModelKeyKubeSecret: vi.fn(async () => {}),
    deleteGatewayModelKeySource: vi.fn(async () => {}),
    teardownGatewayServiceAccount: vi.fn(async () => {}),
    syncFleetIngress: vi.fn(async () => {}),
    pollIntervalMs: 10,
    now: () => Date.now(),
    wait: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    log: vi.fn(),
  };
}

describe("retire-gateway choreography (integration)", () => {
  it("admin DELETE → reconciler uninstall → op handler cleanup leaves zero traces", async () => {
    const state: SharedState = {
      helmReleases: new Map([
        [
          "default",
          {
            enabled: true,
            image: { repository: REPO, tag: "abc1234" },
            gatewayId: "default",
          },
        ],
      ]),
      glmGateways: new Map([
        [
          "default",
          {
            gatewayId: "default",
            imageRepository: REPO,
            imageTag: "abc1234",
            desiredStatus: "running",
            createdBy: "ci",
          },
        ],
      ]),
      gateways: new Map([
        ["default", { mountedCustomers: [], lastHeartbeatAt: Date.now() }],
      ]),
      operations: new Map(),
    };
    const helm = makeHelm(state);

const adminRes = adminDeleteGateway(state, "default");
    expect(adminRes.status).toBe(202);
    expect(state.glmGateways.get("default")?.desiredStatus).toBe("retired");
    expect(state.operations.size).toBe(1);

const changes = await reconcilerTick(state, helm);
    expect(changes).toEqual([
      expect.objectContaining({ kind: "drift", gatewayId: "default" }),
    ]);
    expect(helm.removeInstance).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: "default" }),
    );
    expect(state.helmReleases.size).toBe(0);

const op = state.operations.get(adminRes.operationId!);
    expect(op).toBeDefined();
    const handler = createRetireGatewayHandler(makeRetireDeps(state));
    const ctx = makeCtx();
    const result = await handler(op!, ctx);
    expect(result.success).toBe(true);

expect(state.helmReleases.size).toBe(0);
    expect(state.glmGateways.size).toBe(0);

    const stepFlow = ctx.reported.map((s) => `${s.name}:${s.status}`);
    expect(stepFlow).toEqual([
      "helm-uninstall:running",
      "helm-uninstall:done",
      "revoke-agent-store-credentials:running",
      "revoke-agent-store-credentials:done",
      "delete-pvc:running",
      "delete-pvc:done",
      "delete-kube-secret:running",
      "delete-kube-secret:done",
      "delete-sm-secret:running",
      "delete-sm-secret:done",
      "delete-ksa:running",
      "delete-ksa:done",
      "delete-model-key-kube-secret:running",
      "delete-model-key-kube-secret:done",
      "delete-model-key-source:running",
      "delete-model-key-source:done",
      "teardown-gsa:running",
      "teardown-gsa:done",
      "cleanup:running",
      "cleanup:done",
      "fleet-ingress:running",
      "fleet-ingress:done",
    ]);
  });

  it("admin refuses (409) when gateway has mounted users — reconciler not engaged, no helm uninstall", async () => {
    const state: SharedState = {
      helmReleases: new Map([
        [
          "default",
          {
            enabled: true,
            image: { repository: REPO, tag: "abc1234" },
            gatewayId: "default",
          },
        ],
      ]),
      glmGateways: new Map([
        [
          "default",
          {
            gatewayId: "default",
            imageRepository: REPO,
            imageTag: "abc1234",
            desiredStatus: "running",
            createdBy: "ci",
          },
        ],
      ]),
      gateways: new Map([
        ["default", { mountedCustomers: ["cust-a"], lastHeartbeatAt: Date.now() }],
      ]),
      operations: new Map(),
    };
    const helm = makeHelm(state);

    const adminRes = adminDeleteGateway(state, "default");
    expect(adminRes.status).toBe(409);
    expect(state.glmGateways.get("default")?.desiredStatus).toBe("running");
    expect(state.operations.size).toBe(0);

await reconcilerTick(state, helm);
    expect(helm.removeInstance).not.toHaveBeenCalled();
    expect(state.helmReleases.size).toBe(1);
  });

  it("retire while drained-with-zero-users but heartbeat is missing (stranded crash-loop) still cleans up", async () => {
    const state: SharedState = {
      helmReleases: new Map([
        [
          "default",
          {
            enabled: true,
            image: { repository: REPO, tag: "abc1234" },
            gatewayId: "default",
          },
        ],
      ]),
      glmGateways: new Map([
        [
          "default",
          {
            gatewayId: "default",
            imageRepository: REPO,
            imageTag: "abc1234",
            desiredStatus: "running",
            createdBy: "ci",
          },
        ],
      ]),
      
      gateways: new Map(),
      operations: new Map(),
    };
    const helm = makeHelm(state);

    const adminRes = adminDeleteGateway(state, "default");
    expect(adminRes.status).toBe(202);

    await reconcilerTick(state, helm);
    expect(state.helmReleases.size).toBe(0);

    const handler = createRetireGatewayHandler(makeRetireDeps(state));
    const result = await handler(state.operations.get(adminRes.operationId!)!, makeCtx());
    expect(result.success).toBe(true);
    expect(state.helmReleases.size).toBe(0);
    expect(state.glmGateways.size).toBe(0);
  });

it("regression — numeric imageTag does NOT short-circuit either step", async () => {
    const state: SharedState = {
      helmReleases: new Map([
        
        [
          "smoke",
          {
            enabled: true,
            image: { repository: REPO, tag: "9778420" },
            gatewayId: "smoke",
          },
        ],
      ]),
      glmGateways: new Map([
        [
          "smoke",
          {
            gatewayId: "smoke",
            imageRepository: REPO,

imageTag: "9778420",
            desiredStatus: "running",
            createdBy: "ci",
          },
        ],
      ]),
      gateways: new Map([
        ["smoke", { mountedCustomers: [], lastHeartbeatAt: Date.now() }],
      ]),
      operations: new Map(),
    };
    const helm = makeHelm(state);

    const adminRes = adminDeleteGateway(state, "smoke");
    expect(adminRes.status).toBe(202);

    await reconcilerTick(state, helm);
    expect(state.helmReleases.size).toBe(0);

    const handler = createRetireGatewayHandler(makeRetireDeps(state));
    const result = await handler(state.operations.get(adminRes.operationId!)!, makeCtx());
    expect(result.success).toBe(true);
    expect(state.helmReleases.size).toBe(0);
    expect(state.glmGateways.size).toBe(0);
  });
});
