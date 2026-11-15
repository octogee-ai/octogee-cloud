import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { describe, expect, it, vi } from "vitest";
import type { UserNotification } from "../../lib/user-notifications.js";
import {
  TENANT_DENIAL_NOTIFICATION_BUCKET_MS,
  createTenantDenialReporter,
  type TenantDenial,
} from "../tenant-denial.js";

const NOW = 1_800_000_000_000;

function harness(opts: {
  users?: Record<string, Record<string, unknown>>;
  fanOut?: (event: UserNotification, targetUserIds: string[]) => Promise<{ eventId: string; delivered: string[]; deduplicated: string[]; failed: Array<{ uid: string; error: string }> }>;
} = {}) {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const fanOut = vi.fn(opts.fanOut ?? (async (event: UserNotification, targetUserIds: string[]) =>
    ({ eventId: event.eventId, delivered: targetUserIds, deduplicated: [], failed: [] })));
  const users = opts.users ?? {
    "uid-alice": {
      provisioning: { openclaw: { gatewayId: "shared-0", agentIds: ["octogee-alice-coach", "octogee-alice-proj-orbit-coach"] } },
    },
    "uid-bob": {
      provisioning: { openclaw: { gatewayId: "shared-0", agentIds: ["octogee-bob-coach"] } },
    },
  };
  const report = createTenantDenialReporter({
    store: createDocumentFixtureStore(Object.fromEntries(
      Object.entries(users).map(([uid, data]) => [`users/${uid}`, data]),
    )),
    logger,
    notifyUsers: fanOut,
    now: () => NOW,
  });
  return { report, logger, fanOut };
}

const DELEGATE_DENIAL: TenantDenial = {
  method: "POST",
  path: "/internal/agent-projects/delegate",
  reason: "route is not admitted for gateway tenants and the request names no owned user, slug, gateway, or flow",
  cause: "policy",
  tenant: { kind: "gateway", gatewayId: "shared-0" },
  agentId: "octogee-alice-coach",
};

const PLACEMENT_DENIAL: TenantDenial = {
  method: "POST",
  path: "/internal/fleet/npm-registry-credentials",
  reason: "request names a workspace slug not assigned to the bound gateway",
  cause: "placement",
  tenant: { kind: "gateway", gatewayId: "alice-s-73080b5c", ownerUid: "uid-alice" },
  agentId: null,
};

describe("tenant denial reporter", () => {
  it("logs every denial with its fields", async () => {
    const { report, logger } = harness();
    await report(DELEGATE_DENIAL);
    expect(logger.warn).toHaveBeenCalledWith("[tenant-enforcement] denied", {
      method: "POST",
      path: "/internal/agent-projects/delegate",
      reason: DELEGATE_DENIAL.reason,
      cause: "policy",
      tenant: { kind: "gateway", gatewayId: "shared-0" },
      agentId: "octogee-alice-coach",
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs but never notifies a placement denial, so a user moving between gateways sees no inbox noise", async () => {
    const { report, fanOut, logger } = harness();
    await report(PLACEMENT_DENIAL);
    await report({ ...PLACEMENT_DENIAL, path: "/internal/fleet/configured-builder-bootstrap", reason: "request names a gatewayId other than the bound gateway" });
    expect(fanOut).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith("[tenant-enforcement] denied", expect.objectContaining({ cause: "placement", tenant: PLACEMENT_DENIAL.tenant }));
  });

  it("notifies the user whose agent was denied, deduplicated per gateway, route, and hour", async () => {
    const { report, fanOut } = harness();
    await report(DELEGATE_DENIAL);
    const bucket = Math.floor(NOW / TENANT_DENIAL_NOTIFICATION_BUCKET_MS);
    expect(fanOut).toHaveBeenCalledWith(
      {
        eventId: `tenant-denied:shared-0:/internal/agent-projects/delegate:${bucket}`,
        category: "system.security",
        title: "Your agent hit a platform permission error",
        body:
          "Your workspace agent asked the platform for /internal/agent-projects/delegate and was refused: " +
          `${DELEGATE_DENIAL.reason}. Octogee has logged it for follow-up.`,
        action: { type: "navigate", path: "/@me" },
      },
      ["uid-alice"],
    );
  });

  it("still logs the denial when the platform has no notifier", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const report = createTenantDenialReporter({
      store: createDocumentFixtureStore({}),
      logger,
      now: () => NOW,
    });

    await report(DELEGATE_DENIAL);

    expect(logger.warn).toHaveBeenCalledWith("[tenant-enforcement] denied", expect.objectContaining({ path: DELEGATE_DENIAL.path }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("names the project for a project agent and resolves that agent's user", async () => {
    const { report, fanOut } = harness();
    await report({ ...DELEGATE_DENIAL, path: "/internal/agent-projects/identity", agentId: "octogee-alice-proj-orbit-coach" });
    const [event, targets] = fanOut.mock.calls[0]!;
    expect(targets).toEqual(["uid-alice"]);
    expect(event.body).toMatch(/^Your orbit project agent asked the platform for \/internal\/agent-projects\/identity/);
  });

  it("falls back to the bound owner when the agent is not on the gateway roster", async () => {
    const { report, fanOut } = harness();
    await report({ ...DELEGATE_DENIAL, tenant: { kind: "gateway", gatewayId: "shared-0", ownerUid: "uid-owner" }, agentId: "octogee-stranger-coach" });
    expect(fanOut.mock.calls[0]![1]).toEqual(["uid-owner"]);
    expect(fanOut.mock.calls[0]![0].body).toMatch(/^Your workspace agent/);
  });

  it("skips the notification when no user can be resolved and says so", async () => {
    const { report, fanOut, logger } = harness();
    await report({ ...DELEGATE_DENIAL, agentId: null });
    expect(fanOut).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[tenant-enforcement] denial names no assigned user; inbox notification skipped",
      expect.objectContaining({ path: "/internal/agent-projects/delegate" }),
    );
  });

  it.each([
    { kind: "platform", actor: "cron" } as const,
    { kind: "unbound" } as const,
  ])("only logs a non-gateway denial ($kind)", async (tenant) => {
    const { report, fanOut, logger } = harness();
    await report({ ...DELEGATE_DENIAL, tenant, agentId: null });
    expect(fanOut).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("logs and resolves when the notification pipeline throws", async () => {
    const { report, logger } = harness({ fanOut: async () => { throw new Error("firestore down"); } });
    await expect(report(DELEGATE_DENIAL)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "[tenant-enforcement] denial notification failed",
      expect.objectContaining({ path: "/internal/agent-projects/delegate", error: expect.any(Error) }),
    );
  });

  it("logs a per-recipient fan-out failure", async () => {
    const { report, logger } = harness({
      fanOut: async (event) => ({ eventId: event.eventId, delivered: [], deduplicated: [], failed: [{ uid: "uid-alice", error: "quota" }] }),
    });
    await report(DELEGATE_DENIAL);
    expect(logger.error).toHaveBeenCalledWith(
      "[tenant-enforcement] denial notification failed",
      expect.objectContaining({ uid: "uid-alice", failed: [{ uid: "uid-alice", error: "quota" }] }),
    );
  });
});
