import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { sweepRetiredSharedGateways } from "../shared-gateway-retirement-sweep.js";

type Data = Record<string, unknown>;

const records = new Map<string, Data>();

function store(): PlatformStateStore {
  return createDocumentFixtureStore(records, { serializeTransactions: true });
}

function sweep(platformState: PlatformStateStore = store()) {
  return sweepRetiredSharedGateways({ store: platformState, retiredGatewayKeys: null, log: vi.fn() });
}

function read(path: string): Data | undefined {
  const document = records.get(path);
  return document === undefined ? undefined : structuredClone(document);
}

function patch(path: string, fields: Data): void {
  records.set(path, { ...read(path)!, ...fields });
}

function retiredGateway(gatewayId: string, input: { createdBy?: string; claimVersion?: number } = {}): void {
  records.set(`gateways/${gatewayId}`, {
    gatewayId, createdAt: 1, createdBy: input.createdBy ?? "glm-controller-shared-pool-scaler", updatedAt: 1, updatedBy: "test",
    configSchemaVersion: 1, profile: null, gatewayClass: "shared", imageProfile: "standard", sizingTier: null,
    gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null,
    builderAccess: null, ownerUid: null, builderSlug: null, modelBrokerLimits: null, allocation: null,
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "retired",
    retirementClaim: { operationId: `retire-${gatewayId}`, version: input.claimVersion ?? 1, phase: "claimed" },
    retirementVersion: 1,
  });
  records.set(`gateways/${gatewayId}/releases/1`, {
    gatewayId, release: 1, createdAt: 1, createdBy: "test", sourceRelease: null, note: null, payloadHash: "h",
    payload: { imageRepository: "registry.example/gateway", imageTag: "abc1234" },
  });
}

function retirement(gatewayId: string, fields: Data): void {
  records.set(`glmOperations/retire-${gatewayId}`, {
    kind: "retire-gateway", createdBy: "test", createdAt: 1, steps: [],
    input: { gatewayId, retirementClaimVersion: 1 },
    ...fields,
  });
}

beforeEach(() => records.clear());

describe("sweepRetiredSharedGateways", () => {
  it("deletes a retired shared gateway whose retirement succeeded and keeps the journal", async () => {
    retiredGateway("shared-0");
    retirement("shared-0", { status: "succeeded" });

    await sweep();

    expect(records.has("gateways/shared-0")).toBe(false);
    expect(records.has("gateways/shared-0/releases/1")).toBe(false);
    expect(read("glmOperations/retire-shared-0")?.status).toBe("succeeded");
  });

  it("finishes an operator's retirement of a shared gateway it added", async () => {
    retiredGateway("shared-ops", { createdBy: "operator-uid" });
    retirement("shared-ops", { status: "failed", error: "reaped: controller restarted" });

    await sweep();
    expect(read("glmOperations/retire-shared-ops")?.status).toBe("pending");

    patch("glmOperations/retire-shared-ops", { status: "succeeded" });
    await sweep();
    expect(records.has("gateways/shared-ops")).toBe(false);
  });

  it.each([
    [
      "failed only on terminating resources",
      "helm uninstall failed: helm uninstall octogee-gw-shared-0 failed (code=1): Error: uninstallation completed with 1 error(s): " +
        "resource Deployment/octogee/octogee-gateway-shared-0 still exists. status: Terminating, message: Resource scheduled for deletion",
    ],
    [
      "failed only on an already-purged release record",
      "helm uninstall failed: helm uninstall octogee-gw-shared-0 failed (code=1): Error: uninstallation completed with 1 error(s): " +
        "uninstall: Failed to purge the release: secrets \"sh.helm.release.v1.octogee-gw-shared-0.v1\" not found",
    ],
    [
      "the stuck-op reaper failed after a controller restart orphaned it",
      "reaped: op exceeded 15m running budget — controller likely restarted mid-op or the work hung past the inner deadlines",
    ],
    [
      "the stopped Gateway still had draining PostgreSQL sessions",
      "agent-store credential retirement failed (records preserved for retry): Agent-store Gateway shared-0 still has database sessions",
    ],
  ])("re-arms a retirement that %s", async (_label, failure) => {
    retiredGateway("shared-0");
    const steps = [{ name: "helm-uninstall", status: "failed" }];
    const attemptHistory = [{ attempt: 1, startedAt: 5, completedAt: 6, classification: "terminal", error: failure, steps }];
    retirement("shared-0", {
      status: "failed", error: failure, startedAt: 5, completedAt: 6, lastProgressAt: 6, expireAt: new Date(7), steps, attemptHistory,
    });

    await sweep();

    const rearmed = read("glmOperations/retire-shared-0");
    expect(rearmed).toMatchObject({ status: "pending", startedAt: null, completedAt: null, steps: [] });
    expect(rearmed).not.toHaveProperty("error");
    expect(rearmed).not.toHaveProperty("expireAt");
    expect(rearmed?.input).toEqual({ gatewayId: "shared-0", retirementClaimVersion: 1 });
    expect(rearmed?.attemptHistory).toEqual(attemptHistory);
    expect(records.has("gateways/shared-0")).toBe(true);
  });

  it.each([
    ["another error", "helm uninstall failed: helm uninstall octogee-gw-shared-0 failed (code=1): Error: pre-delete hook failed"],
    ["a mounted user", "gateway shared-0 still has 1 mounted user(s): someone — migrate them off before retiring"],
    ["a foreign Gateway's sessions", "agent-store credential retirement failed (records preserved for retry): Agent-store Gateway shared-foreign still has database sessions"],
    ["credential access denial", "agent-store credential retirement failed (records preserved for retry): permission denied"],
  ])("leaves a retirement that failed on %s failed for the operator", async (_label, error) => {
    retiredGateway("shared-0");
    retirement("shared-0", { status: "failed", error });

    await sweep();

    expect(read("glmOperations/retire-shared-0")).toMatchObject({ status: "failed", error });
  });

  it("does not re-arm a drain failure after the retirement claim version changes", async () => {
    retiredGateway("shared-0", { claimVersion: 2 });
    retirement("shared-0", {
      status: "failed",
      error: "agent-store credential retirement failed (records preserved for retry): Agent-store Gateway shared-0 still has database sessions",
    });

    await sweep();

    expect(read("glmOperations/retire-shared-0")).toMatchObject({ status: "failed" });
  });

  it.each(["pending", "running", "failed"])("keeps a retired gateway while its retirement is %s", async (status) => {
    retiredGateway("shared-0");
    retirement("shared-0", { status, error: status === "failed" ? "pre-delete hook failed" : null });

    await sweep();

    expect(records.has("gateways/shared-0")).toBe(true);
  });

  it.each(["runtime", "assignment", "user", "missing-operation"])("keeps a retired gateway while %s still requires it", async (residue) => {
    retiredGateway("shared-0");
    retirement("shared-0", { status: "succeeded" });
    if (residue === "runtime") records.set("glmGateways/shared-0", { docKind: "runtime", gatewayId: "shared-0", release: 1, lifecycle: "serving" });
    if (residue === "assignment") records.set("gateways/shared-0/assignments/someone", { slug: "someone" });
    if (residue === "user") records.set("users/someone", { provisioning: { openclaw: { gatewayId: "shared-0" } } });
    if (residue === "missing-operation") records.delete("glmOperations/retire-shared-0");

    await sweep();

    expect(records.has("gateways/shared-0")).toBe(true);
  });

  it("keeps a retired gateway whose retirement changed after the verdict", async () => {
    retiredGateway("shared-0");
    retirement("shared-0", { status: "succeeded" });
    const platformState = store();
    const reclaimedAfterVerdict = new Proxy(platformState, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (...args: Parameters<PlatformStateStore["transaction"]>) => {
          const verdict = await target.transaction(...args);
          if (args[0].label === "shared-pool-scaler.retired-slot") patch("gateways/shared-0", { retirementVersion: 2 });
          return verdict;
        };
      },
    });

    await sweep(reclaimedAfterVerdict);

    expect(read("gateways/shared-0")).toMatchObject({ desiredStatus: "retired", retirementVersion: 2 });
    expect(records.has("gateways/shared-0/releases/1")).toBe(true);
  });

  describe("with the provisioning service holding the gateway's git keys", () => {
    function keysAnswering(answer: () => Promise<{ remaining: number }>) {
      return { releaseGatewayGitKeys: vi.fn(answer) };
    }

    it("releases the gateway's git keys and deletes the root once none remain", async () => {
      retiredGateway("shared-0");
      retirement("shared-0", { status: "succeeded" });
      const retiredGatewayKeys = keysAnswering(async () => ({ remaining: 0 }));

      await sweepRetiredSharedGateways({ store: store(), retiredGatewayKeys, log: vi.fn() });

      expect(retiredGatewayKeys.releaseGatewayGitKeys).toHaveBeenCalledExactlyOnceWith("shared-0");
      expect(records.has("gateways/shared-0")).toBe(false);
    });

    it("keeps the root and logs how many rows remain while the service still holds them", async () => {
      retiredGateway("shared-0");
      retirement("shared-0", { status: "succeeded" });
      const log = vi.fn();

      await sweepRetiredSharedGateways({ store: store(), retiredGatewayKeys: keysAnswering(async () => ({ remaining: 3 })), log });

      expect(read("gateways/shared-0")?.desiredStatus).toBe("retired");
      expect(log).toHaveBeenCalledExactlyOnceWith("[shared-pool-scaler] kept retired slot shared-0: the provisioning service still holds 3 of its git key rows");
    });

    it("keeps the root, logs the failure and deletes it on a later pass once the release succeeds", async () => {
      retiredGateway("shared-0");
      retirement("shared-0", { status: "succeeded" });
      const log = vi.fn();
      const retiredGatewayKeys = keysAnswering(async () => ({ remaining: 0 }));
      retiredGatewayKeys.releaseGatewayGitKeys.mockRejectedValueOnce(new Error("provisioning service unavailable"));

      await sweepRetiredSharedGateways({ store: store(), retiredGatewayKeys, log });
      expect(read("gateways/shared-0")?.desiredStatus).toBe("retired");
      expect(log).toHaveBeenCalledExactlyOnceWith("[shared-pool-scaler] ⚠ kept retired slot shared-0: releasing its git keys failed — provisioning service unavailable");

      await sweepRetiredSharedGateways({ store: store(), retiredGatewayKeys, log });
      expect(records.has("gateways/shared-0")).toBe(false);
    });

    it("asks for no release while the slot's retirement is unfinished", async () => {
      retiredGateway("shared-0");
      retirement("shared-0", { status: "running" });
      const retiredGatewayKeys = keysAnswering(async () => ({ remaining: 0 }));

      await sweepRetiredSharedGateways({ store: store(), retiredGatewayKeys, log: vi.fn() });

      expect(retiredGatewayKeys.releaseGatewayGitKeys).not.toHaveBeenCalled();
      expect(records.has("gateways/shared-0")).toBe(true);
    });
  });

  it("deletes the root without asking for any release when the provisioning service is off", async () => {
    retiredGateway("shared-0");
    retirement("shared-0", { status: "succeeded" });

    await sweepRetiredSharedGateways({ store: store(), retiredGatewayKeys: null, log: vi.fn() });

    expect(records.has("gateways/shared-0")).toBe(false);
  });
});
