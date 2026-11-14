import { describe, expect, it, vi } from "vitest";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { pruneSurgeOrphanAssignments } from "../surge-orphan-assignment.js";
import type { SurgeAssignment } from "../surge-user-handoff.js";

type Data = Record<string, unknown>;

function assignment(uid: string, slug: string): SurgeAssignment {
  return {
    uid,
    slug,
    state: "serving",
    epoch: 4,
    updatedByOperationId: null,
  };
}

function runtime(now: number, mountedCustomers: string[]): Data {
  return {
    docKind: "runtime",
    gatewayId: "shared-a",
    release: 1,
    lifecycle: "active",
    heartbeat: {
      status: "ready",
      lastHeartbeatAt: now - 1_000,
      mountedCustomers,
    },
  };
}

function storedAssignment(value: SurgeAssignment): Data {
  return { ...value, gatewayId: "shared-a", source: "migrate-user", createdAt: 1, updatedAt: 1 };
}

function seeded(seed: Record<string, Data>) {
  const records: Record<string, Data> = { ...seed };
  const documents = {
    has: (path: string) => records[path] !== undefined,
    get: (path: string) => records[path],
  };
  return { state: createDocumentFixtureStore(records), documents };
}

describe("surge orphan assignment repair", () => {
  const now = 500_000;
  const orphan = assignment("uid-orphan", "smoke-dave-smoke");
  const valid = assignment("uid-valid", "alice");
  const orphanPath = "gateways/shared-a/assignments/uid-orphan";
  const validPath = "gateways/shared-a/assignments/uid-valid";
  const journalPath = "glmOperations/surge-prune-orphan-shared-a-uid-orphan-4";

  it.each([{}, { phase: "dispatched" }])("retains an orphan assignment while restore is unresolved: %j", async (restoreFence) => {
    const { state, documents } = seeded({
      [orphanPath]: storedAssignment(orphan),
      "users/uid-orphan": { provisioning: { openclaw: { gatewayId: "shared-b", restoreFence } } },
      "glmGateways/shared-a": runtime(now, []),
    });
    const log = vi.fn();
    await expect(pruneSurgeOrphanAssignments({ store: state, gatewayId: "shared-a", assignments: [orphan], users: [], now, log })).resolves.toEqual([orphan]);
    expect(documents.has(orphanPath)).toBe(true);
    expect(documents.has(journalPath)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("restore"));
  });

  it.each([{}, { phase: "dispatched" }])("retains an orphan assignment while source transfer is unresolved: %j", async (sourceTransferFence) => {
    const { state, documents } = seeded({
      [orphanPath]: storedAssignment(orphan),
      "users/uid-orphan": { provisioning: { openclaw: { gatewayId: "shared-b", sourceTransferFence } } },
      "glmGateways/shared-a": runtime(now, []),
    });
    const log = vi.fn();
    await expect(pruneSurgeOrphanAssignments({ store: state, gatewayId: "shared-a", assignments: [orphan], users: [], now, log })).resolves.toEqual([orphan]);
    expect(documents.has(orphanPath)).toBe(true);
    expect(documents.has(journalPath)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("restore"));
  });

  it("atomically removes and journals only the unmounted assignment whose user is absent", async () => {
    const { state, documents } = seeded({
      [orphanPath]: storedAssignment(orphan),
      [validPath]: storedAssignment(valid),
      "users/uid-valid": { username: "alice" },
      "glmGateways/shared-a": runtime(now, []),
    });
    const log = vi.fn();

    await expect(pruneSurgeOrphanAssignments({
      store: state,
      gatewayId: "shared-a",
      assignments: [orphan, valid],
      users: [{ uid: "uid-valid", slug: "alice" }],
      now,
      log,
    })).resolves.toEqual([valid]);

    expect(documents.has(orphanPath)).toBe(false);
    expect(documents.get(validPath)).toMatchObject({ slug: "alice" });
    expect(documents.get(journalPath)).toMatchObject({
      kind: "deprovision-user",
      status: "succeeded",
      origin: "automatic",
      input: {
        uid: "uid-orphan",
        slug: "smoke-dave-smoke",
        gatewayId: "shared-a",
        epoch: 4,
        reason: "user-not-authoritative-runtime-unmounted",
      },
      output: { assignmentDeleted: true },
    });
    expect(log).toHaveBeenCalledOnce();
  });

  it("keeps an assignment if the user reappears before the repair transaction", async () => {
    const { state, documents } = seeded({
      [orphanPath]: storedAssignment(orphan),
      "users/uid-orphan": {
        username: "smoke-dave-smoke",
        provisioning: {
          openclaw: { gatewayId: "shared-a", slug: "smoke-dave-smoke" },
        },
      },
      "glmGateways/shared-a": runtime(now, []),
    });

    await expect(pruneSurgeOrphanAssignments({
      store: state,
      gatewayId: "shared-a",
      assignments: [orphan],
      users: [],
      now,
      log: vi.fn(),
    })).resolves.toEqual([orphan]);

    expect(documents.has(orphanPath)).toBe(true);
    expect(documents.has(journalPath)).toBe(false);
  });

  it("removes a stale source assignment after the user mirror moved elsewhere", async () => {
    const { state, documents } = seeded({
      [orphanPath]: storedAssignment(orphan),
      "users/uid-orphan": {
        username: "smoke-dave-smoke",
        provisioning: {
          openclaw: { gatewayId: "shared-b", slug: "smoke-dave-smoke" },
        },
      },
      "glmGateways/shared-a": runtime(now, []),
    });

    await expect(pruneSurgeOrphanAssignments({
      store: state,
      gatewayId: "shared-a",
      assignments: [orphan],
      users: [],
      now,
      log: vi.fn(),
    })).resolves.toEqual([]);

    expect(documents.has(orphanPath)).toBe(false);
    expect(documents.get(journalPath)).toMatchObject({
      status: "succeeded",
      input: { reason: "user-not-authoritative-runtime-unmounted" },
    });
  });

  it("removes an unmounted assignment when the authoritative slug changed", async () => {
    const { state, documents } = seeded({
      [orphanPath]: storedAssignment(orphan),
      "users/uid-orphan": {
        username: "dave-renamed",
        provisioning: {
          openclaw: { gatewayId: "shared-a", slug: "dave-renamed" },
        },
      },
      "glmGateways/shared-a": runtime(now, []),
    });

    await expect(pruneSurgeOrphanAssignments({
      store: state,
      gatewayId: "shared-a",
      assignments: [orphan],
      users: [{ uid: "uid-orphan", slug: "dave-renamed" }],
      now,
      log: vi.fn(),
    })).resolves.toEqual([]);

    expect(documents.has(orphanPath)).toBe(false);
    expect(documents.get(journalPath)).toMatchObject({ status: "succeeded" });
  });

  it("keeps an orphan assignment while runtime telemetry still mounts its slug", async () => {
    const { state, documents } = seeded({
      [orphanPath]: storedAssignment(orphan),
      "glmGateways/shared-a": runtime(now, ["smoke-dave-smoke"]),
    });

    await expect(pruneSurgeOrphanAssignments({
      store: state,
      gatewayId: "shared-a",
      assignments: [orphan],
      users: [],
      now,
      log: vi.fn(),
    })).resolves.toEqual([orphan]);

    expect(documents.has(orphanPath)).toBe(true);
    expect(documents.has(journalPath)).toBe(false);
  });

  it("keeps an unmounted orphan when the runtime proof is stale", async () => {
    const stale = runtime(now, []);
    (stale.heartbeat as Data).lastHeartbeatAt = 1;
    const { state, documents } = seeded({
      [orphanPath]: storedAssignment(orphan),
      "glmGateways/shared-a": stale,
    });

    await expect(pruneSurgeOrphanAssignments({
      store: state,
      gatewayId: "shared-a",
      assignments: [orphan],
      users: [],
      now,
      log: vi.fn(),
    })).resolves.toEqual([orphan]);

    expect(documents.has(orphanPath)).toBe(true);
    expect(documents.has(journalPath)).toBe(false);
  });

  it("removes an unmounted orphan behind a stale heartbeat when the sole live pod proves it unmounted", async () => {
    const stale = runtime(now, ["smoke-dave-smoke"]);
    (stale.heartbeat as Data).lastHeartbeatAt = 1;
    const { state, documents } = seeded({
      [orphanPath]: storedAssignment(orphan),
      "glmGateways/shared-a": stale,
    });

    await expect(pruneSurgeOrphanAssignments({
      store: state,
      gatewayId: "shared-a",
      assignments: [orphan],
      users: [],
      liveRoster: { mountedCustomers: ["alice"] },
      now,
      log: vi.fn(),
    })).resolves.toEqual([]);

    expect(documents.has(orphanPath)).toBe(false);
    expect(documents.get(journalPath)).toMatchObject({
      kind: "deprovision-user",
      status: "succeeded",
      input: { reason: "user-not-authoritative-runtime-unmounted" },
    });
  });

  it("keeps an orphan while the sole live pod still mounts its slug", async () => {
    const { state, documents } = seeded({
      [orphanPath]: storedAssignment(orphan),
      "glmGateways/shared-a": runtime(now, []),
    });

    await expect(pruneSurgeOrphanAssignments({
      store: state,
      gatewayId: "shared-a",
      assignments: [orphan],
      users: [],
      liveRoster: { mountedCustomers: ["smoke-dave-smoke"] },
      now,
      log: vi.fn(),
    })).resolves.toEqual([orphan]);

    expect(documents.has(orphanPath)).toBe(true);
    expect(documents.has(journalPath)).toBe(false);
  });

  it("refuses to repair a malformed assignment without journaling a deletion", async () => {
    const { state, documents } = seeded({
      [orphanPath]: { malformed: true },
      "glmGateways/shared-a": runtime(now, []),
    });

    await expect(pruneSurgeOrphanAssignments({
      store: state,
      gatewayId: "shared-a",
      assignments: [orphan],
      users: [],
      now,
      log: vi.fn(),
    })).rejects.toBeInstanceOf(MalformedRecordError);

    expect(documents.has(orphanPath)).toBe(true);
    expect(documents.has(journalPath)).toBe(false);
  });
});
