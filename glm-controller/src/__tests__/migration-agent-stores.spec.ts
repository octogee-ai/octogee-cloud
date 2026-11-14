import type { AgentStoreAnchor, AgentStoreRecord, Revision, Stored } from "@octogee/core/platform-state";
import { describe, expect, it, vi } from "vitest";
import { createMigrationAgentStorePreparer, readUserAgentStoreInventory } from "../migration-agent-stores.js";
import { classifyUserMigrationV2Error } from "@octogee/core/user-migration-v2";
import { classifyOperationFailure } from "../operation-retry.js";

function harness(gateway: { gatewayClass: "shared" | "isolated"; ownerUid: string | null; builderSlug: string | null } | null) {
  const order: string[] = [];
  const readGateway = vi.fn(async () => gateway);
  const readUserBySlug = vi.fn(async () => ({ uid: "uid-alice", slug: "alice" }));
  const ensureCredentials = vi.fn(async () => { order.push("credentials"); });
  const transferOwnership = vi.fn<(user: { uid: string; slug: string }, target: "shared" | "isolated", assertCurrent?: () => Promise<void>) => Promise<void>>(async () => { order.push("ownership"); });
  return { order, readGateway, readUserBySlug, ensureCredentials, transferOwnership,
    prepare: createMigrationAgentStorePreparer({ readGateway, readUserBySlug, ensureCredentials, transferOwnership }) };
}

describe("migration agent-store ownership", () => {
  it.each([
    ["55P03", "canceling statement due to lock timeout"],
    ["57014", "canceling statement due to statement timeout"],
  ])("treats PostgreSQL %s handoff timeout as retryable through both migration paths", async (code, message) => {
    const h = harness({ gatewayClass: "shared", ownerUid: null, builderSlug: null });
    h.transferOwnership.mockRejectedValue(Object.assign(new Error(message), { code }));
    const error = await h.prepare("target", "alice").catch(error => error);
    expect(error.message).toMatch(/^agent-store handoff timeout:/);
    expect(classifyUserMigrationV2Error(error)).toBe("retry");
    expect(classifyOperationFailure(error.message)).toBe("transient");
  });
  it("does not turn PostgreSQL authorization failure into a retry", async () => {
    const h = harness({ gatewayClass: "shared", ownerUid: null, builderSlug: null });
    h.transferOwnership.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "42501" }));
    const error = await h.prepare("target", "alice").catch(error => error);
    expect(classifyUserMigrationV2Error(error)).toBe("terminal");
    expect(classifyOperationFailure(error.message)).toBe("terminal");
  });
  it.each(["shared", "isolated"] as const)("prepares %s ownership from the authoritative user identity", async gatewayClass => {
    const h = harness({ gatewayClass, ownerUid: gatewayClass === "isolated" ? "uid-alice" : null, builderSlug: gatewayClass === "isolated" ? "alice" : null });
    await h.prepare("target", "alice");
    expect(h.readGateway).toHaveBeenCalledWith("target");
    expect(h.readUserBySlug).toHaveBeenCalledWith("alice");
    expect(h.ensureCredentials).toHaveBeenCalledWith("target");
    expect(h.transferOwnership).toHaveBeenCalledWith({ uid: "uid-alice", slug: "alice" }, gatewayClass);
    expect(h.order).toEqual(["credentials", "ownership"]);
  });

  it.each([
    null,
    { gatewayClass: "isolated" as const, ownerUid: "uid-bob", builderSlug: "alice" },
    { gatewayClass: "isolated" as const, ownerUid: "uid-alice", builderSlug: "bob" },
    { gatewayClass: "shared" as const, ownerUid: "uid-alice", builderSlug: "alice" },
  ])("rejects a missing or mismatched desired owner (%j)", async gateway => {
    const h = harness(gateway);
    await expect(h.prepare("target", "alice")).rejects.toThrow();
    expect(h.ensureCredentials).not.toHaveBeenCalled();
    expect(h.transferOwnership).not.toHaveBeenCalled();
  });

  it("refuses a missing user or a slug mismatch", async () => {
    const h = harness({ gatewayClass: "shared", ownerUid: null, builderSlug: null });
    h.readUserBySlug.mockResolvedValue({ uid: "", slug: "alice" });
    await expect(h.prepare("target", "alice")).rejects.toThrow("identity changed");
    h.readUserBySlug.mockResolvedValue({ uid: "uid-alice", slug: "bob" });
    await expect(h.prepare("target", "alice")).rejects.toThrow("identity changed");
    expect(h.transferOwnership).not.toHaveBeenCalled();
  });

  it("stops before ownership changes if credential publication fails", async () => {
    const h = harness({ gatewayClass: "shared", ownerUid: null, builderSlug: null });
    h.ensureCredentials.mockRejectedValue(new Error("publication failed"));
    await expect(h.prepare("target", "alice")).rejects.toThrow("publication failed");
    expect(h.transferOwnership).not.toHaveBeenCalled();
  });

  it("surfaces ownership failures so import or rollback stays fenced", async () => {
    const h = harness({ gatewayClass: "shared", ownerUid: null, builderSlug: null });
    h.transferOwnership.mockRejectedValue(new Error("ownership failed"));
    await expect(h.prepare("target", "alice")).rejects.toThrow("ownership failed");
  });
});


describe("claimed agent-store recovery authority", () => {
  it("passes the exact recovery authority to the PostgreSQL transaction owner", async () => {
    const h = harness({ gatewayClass: "shared", ownerUid: null, builderSlug: null });
    const assertCurrent = vi.fn(async () => undefined);
    await h.prepare("source", "alice", { expectedUserUid: "uid-alice", assertCurrent });
    expect(h.transferOwnership).toHaveBeenCalledExactlyOnceWith({ uid: "uid-alice", slug: "alice" }, "shared", assertCurrent);
  });

  it.each(["changed-uid", "claim-lost", "gateway-rebound", "slug-reassigned"] as const)("refuses stale ownership before transfer after credential await: %s", async scenario => {
    const h = harness({ gatewayClass: "shared", ownerUid: null, builderSlug: null });
    let credentialsDone = false;
    const assertCurrent = vi.fn(async () => { if (scenario === "claim-lost" && credentialsDone) throw new Error("recovery claim replaced"); });
    if (scenario === "changed-uid") h.readUserBySlug.mockResolvedValue({ uid: "uid-bob", slug: "alice" });
    h.ensureCredentials.mockImplementation(async () => {
      credentialsDone = true;
      if (scenario === "gateway-rebound") h.readGateway.mockResolvedValue({ gatewayClass: "isolated", ownerUid: "uid-bob", builderSlug: "alice" });
      if (scenario === "slug-reassigned") h.readUserBySlug.mockResolvedValue({ uid: "uid-bob", slug: "alice" });
    });
    await expect(h.prepare("source", "alice", { expectedUserUid: "uid-alice", assertCurrent })).rejects.toThrow();
    expect(h.transferOwnership).not.toHaveBeenCalled();
    if (scenario === "changed-uid") expect(h.ensureCredentials).not.toHaveBeenCalled();
  });
});

describe("migration agent-store inventory", () => {
  function stored(anchor: AgentStoreAnchor): Stored<AgentStoreRecord> {
    return { ...anchor, gatewayId: "source", generation: null, assignmentEpoch: 1, recordedAt: 1, revision: "1" as Revision };
  }

  it("transfers user agents without gateway-wide stores or the unmatched-route service agent", async () => {
    const defaultAgent = { kind: "agent", agentId: "octogee-alice-coach", storeId: "coach-store", schema: "coach_schema" } as const;
    const project = { kind: "agent", agentId: "octogee-alice-proj-site-coach", storeId: "project-store", schema: "project_schema" } as const;
    const list = vi.fn(async () => [
      stored(defaultAgent), stored(project),
      stored({ kind: "agent", agentId: "octogee-unmatched-route", storeId: "service-store", schema: "service_schema" }),
      stored({ kind: "gateway-state", storeId: "gateway-store", schema: "gateway_schema" }),
      stored({ kind: "auxiliary", family: "workboard", storeId: "auxiliary-store", schema: "workboard_schema" }),
    ]);
    expect(await readUserAgentStoreInventory({ list }, "uid-alice")).toEqual([
      { agentId: defaultAgent.agentId, storeId: defaultAgent.storeId, schema: defaultAgent.schema },
      { agentId: project.agentId, storeId: project.storeId, schema: project.schema },
    ]);
    expect(list).toHaveBeenCalledExactlyOnceWith("uid-alice");
  });

  it("keeps foreign agent identities visible to the ownership validator", async () => {
    const list = vi.fn(async () => [stored({ kind: "agent", agentId: "octogee-bob-coach", storeId: "foreign-store", schema: "foreign_schema" })]);
    expect(await readUserAgentStoreInventory({ list }, "uid-alice")).toEqual([
      { agentId: "octogee-bob-coach", storeId: "foreign-store", schema: "foreign_schema" },
    ]);
  });
});
