import { describe, expect, it, vi } from "vitest";
import { MalformedRecordError, type PlatformStateTransaction } from "@octogee/core/platform-state";
import {
  createDocumentFixtureStore,
  createJournalFixtureStore,
  fixtureDocumentsAt,
  journalRowsAtPaths,
  type FixtureDocuments,
} from "@octogee/core/testing/journal-store";
import {
  assertUserRestoreNotInProgress,
  cancelUserMigrationsForSuspension,
  deactivateUserVisibility,
  releaseUserPlacement,
  revokeOwnerModelBrokerTokens,
} from "../lib/user-ops/user-suspension-runtime.js";

type Documents = Record<string, Record<string, unknown>>;

function countingStore(records: Documents) {
  const base = fixtureDocumentsAt(records);
  let writes = 0;
  const documents: FixtureDocuments = {
    ...base,
    set: (path, row) => { writes += 1; base.set(path, row); },
    delete: (path) => { writes += 1; base.delete(path); },
  };
  const fixture = createJournalFixtureStore(journalRowsAtPaths(records), { documents });
  const committed: number[] = [];
  const store = new Proxy(fixture, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return async <T>(options: { label: string; readOnly?: boolean }, body: (transaction: PlatformStateTransaction) => Promise<T>) => {
        const before = writes;
        const result = await target.transaction(options, body);
        committed.push(writes - before);
        return result;
      };
    },
  });
  return { store, committed };
}

const assignment = (gatewayId: string) => ({
  uid: "uid-1", slug: "alice", gatewayId, source: "onboarding", state: "serving", epoch: 1,
});

function placementRecords(openclaw: Record<string, unknown> | null, assigned: string[] = ["shared-0"]): Documents {
  return {
    ...(openclaw === null ? {} : { "users/uid-1": { username: "alice", provisioning: { openclaw } } }),
    ...Object.fromEntries(assigned.map((gatewayId) => [`gateways/${gatewayId}/assignments/uid-1`, assignment(gatewayId)])),
  };
}

const assignmentPaths = (records: Documents) => Object.keys(records).filter((path) => path.includes("/assignments/")).sort();

describe("assertUserRestoreNotInProgress", () => {
  it("rejects unresolved restore before suspension effects", async () => {
    const store = createDocumentFixtureStore(placementRecords({ restoreFence: { phase: "dispatched" } }));
    await expect(assertUserRestoreNotInProgress(store, "uid-1")).rejects.toThrow("user restore is in progress");
  });
  it("rejects a malformed restore fence before suspension effects", async () => {
    const store = createDocumentFixtureStore(placementRecords({ restoreFence: null }));
    await expect(assertUserRestoreNotInProgress(store, "uid-1")).rejects.toBeInstanceOf(MalformedRecordError);
  });
  it.each([null, { gatewayId: "shared-1" }])("allows an unfenced account or completed cleanup retry", async (openclaw) => {
    const store = createDocumentFixtureStore(placementRecords(openclaw, []));
    await expect(assertUserRestoreNotInProgress(store, "uid-1")).resolves.toBeUndefined();
  });
});

describe("releaseUserPlacement", () => {
  it.each(["shared-0", undefined])("clears the migration projection after releasing placement %j", async (gatewayId) => {
    const records = placementRecords({
      ...(gatewayId === undefined ? {} : { gatewayId }),
      migration: { state: "preparing", phase: "waiting", operationId: "failed-activation" },
    });
    await releaseUserPlacement(createDocumentFixtureStore(records), "uid-1", "shared-0");
    expect(records["users/uid-1"]).toEqual({ username: "alice", provisioning: { openclaw: {} } });
  });

  it.each([
    ["a malformed", null, MalformedRecordError],
    ["a malformed", false, MalformedRecordError],
    ["an unresolved", { phase: "dispatched", claimStartedAt: 1 }, "user restore is in progress"],
  ])("preserves all assignments while %s restore fence remains: %j", async (_label, restoreFence, refusal) => {
    const records = placementRecords({ gatewayId: "shared-1", restoreFence }, ["shared-0", "shared-1"]);
    const before = structuredClone(records);
    const attempt = releaseUserPlacement(createDocumentFixtureStore(records), "uid-1", "shared-0");
    if (typeof refusal === "string") await expect(attempt).rejects.toThrow(refusal);
    else await expect(attempt).rejects.toBeInstanceOf(refusal);
    expect(records).toEqual(before);
  });

  it.each([
    ["a malformed", null, MalformedRecordError],
    ["a malformed", false, MalformedRecordError],
    ["an unresolved", { sourceGatewayId: "shared-1", targetGatewayId: "target", phase: "dispatched", claimStartedAt: 1 }, "user source transfer is in progress"],
  ])("preserves all assignments while %s source transfer fence remains: %j", async (_label, sourceTransferFence, refusal) => {
    const records = placementRecords({ gatewayId: "shared-1", sourceTransferFence }, ["shared-0", "shared-1"]);
    const before = structuredClone(records);
    const attempt = releaseUserPlacement(createDocumentFixtureStore(records), "uid-1", "shared-0");
    if (typeof refusal === "string") await expect(attempt).rejects.toThrow(refusal);
    else await expect(attempt).rejects.toBeInstanceOf(refusal);
    expect(records).toEqual(before);
  });

  it("deletes the assignment and clears the user mirror that still points at the gateway", async () => {
    const records = placementRecords({
      gatewayId: "shared-0", gatewayAssignedAt: 10, gatewayProfile: "standard", controlUiEnabled: true, status: "complete",
    });

    await releaseUserPlacement(createDocumentFixtureStore(records), "uid-1", "shared-0");

    expect(assignmentPaths(records)).toEqual([]);
    expect(records["users/uid-1"]).toEqual({ username: "alice", provisioning: { openclaw: { status: "complete" } } });
  });

  it("releases the gateway the mirror names now as well as the one captured at suspension time", async () => {
    const records = placementRecords({ gatewayId: "shared-1" }, ["shared-0", "shared-1", "shared-2"]);

    await releaseUserPlacement(createDocumentFixtureStore(records), "uid-1", "shared-0");

    expect(assignmentPaths(records)).toEqual(["gateways/shared-2/assignments/uid-1"]);
    expect(records["users/uid-1"]).toEqual({ username: "alice", provisioning: { openclaw: {} } });
  });

  it("releases the current placement when nothing was captured at suspension time", async () => {
    const records = placementRecords({ gatewayId: "shared-1" }, ["shared-0", "shared-1"]);

    await releaseUserPlacement(createDocumentFixtureStore(records), "uid-1", null);

    expect(assignmentPaths(records)).toEqual(["gateways/shared-0/assignments/uid-1"]);
    expect(records["users/uid-1"]).toEqual({ username: "alice", provisioning: { openclaw: {} } });
  });

  it("still deletes the captured assignment when the user document is gone", async () => {
    const records = placementRecords(null, ["shared-0", "shared-1"]);

    await releaseUserPlacement(createDocumentFixtureStore(records), "uid-1", "shared-0");

    expect(records).toEqual({ "gateways/shared-1/assignments/uid-1": assignment("shared-1") });
  });
});

function token(): Record<string, unknown> {
  return {
    capped: true, gatewayId: "builder-1", ownerUid: "uid-1", provider: "anthropic", secretName: "broker-secret",
    createdAt: 1, expiresAt: null, limits: { spendWindowUsd: null, spendWeekUsd: null, requestsPerMinute: null },
  };
}

function tokens(prefix: string, count: number): Documents {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`modelBrokerTokens/${prefix}${index}`, token()]));
}

function pointers(prefix: string, count: number): Documents {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`modelBrokerGatewayTokens/${prefix}${index}`, {
    gatewayId: "builder-1", ownerUid: "uid-1", provider: "anthropic", secretName: "broker-secret", tokenHash: `hash-${index}`, updatedAt: 1,
  }]));
}

function migration(id: string, fields: Record<string, unknown>): Documents {
  return {
    [`glmOperations/${id}`]: {
      kind: "migrate-user", status: "pending", createdBy: "glm-controller", createdAt: 10, startedAt: null, completedAt: null,
      steps: [], inputUid: "uid-1", input: { uid: "uid-1", fromGatewayId: "default", toGatewayId: "builder-1" },
      waitingOn: "source", nextAttemptAt: 70, ...fields,
    },
  };
}

describe("platform suspension fences", () => {
  it("terminally cancels queued user migrations and requests cancellation for started work", async () => {
    const records: Documents = {
      ...migration("queued-migration", {}),
      ...migration("started-migration", { status: "running", startedAt: 20, userMigrationV2: { phase: "initialized" } }),
      ...migration("forward-retry", { schedulerHandoff: { forwardRecovery: { schemaVersion: 1, phase: "source-flushed" } } }),
      ...migration("other-user", { inputUid: "uid-2", input: { uid: "uid-2", fromGatewayId: "default", toGatewayId: "builder-2" } }),
    };
    const before = structuredClone(records);

    await expect(cancelUserMigrationsForSuspension(createDocumentFixtureStore(records), "uid-1", "delete-1", 80)).resolves.toBe(true);

    const { waitingOn: _waitingOn, nextAttemptAt: _nextAttemptAt, ...queued } = before["glmOperations/queued-migration"];
    expect(records["glmOperations/queued-migration"]).toEqual({
      ...queued,
      status: "failed",
      completedAt: 80,
      error: "user migration cancelled because the account was suspended",
      rolledBack: false,
      cancelledByDeletionId: "delete-1",
    });
    expect(records["glmOperations/started-migration"]).toEqual({ ...before["glmOperations/started-migration"], cancellationRequestedAt: 80 });
    expect(records["glmOperations/forward-retry"]).toEqual({ ...before["glmOperations/forward-retry"], cancellationRequestedAt: 80 });
    expect(records["glmOperations/other-user"]).toEqual(before["glmOperations/other-user"]);
  });

  it("leaves a migration alone once it left the live statuses before its cancellation transaction", async () => {
    const records: Documents = migration("queued-migration", {});
    const store = createDocumentFixtureStore(records);
    const listed = await store.journal.operations.listByStatus(["pending", "running"]);
    records["glmOperations/queued-migration"].status = "succeeded";
    const listing = vi.spyOn(store.journal.operations, "listByStatus").mockResolvedValue(listed);

    await expect(cancelUserMigrationsForSuspension(store, "uid-1", "delete-1", 80)).resolves.toBe(false);

    expect(listing).toHaveBeenCalledWith(["pending", "running"]);
    expect(records["glmOperations/queued-migration"]).toMatchObject({ status: "succeeded" });
    expect(records["glmOperations/queued-migration"]).not.toHaveProperty("cancelledByDeletionId");
  });

  it("deactivates every public projection in bounded batches", async () => {
    const records: Documents = Object.fromEntries(Array.from({ length: 250 }, (_, index) => [
      [`workspaces/ws-${index}`, { id: `ws-${index}`, slug: `ws-${index}`, ownerUid: "uid-1", ownerActive: true }],
      [`workspaces/ws-0/projects/p-${index}`, { ownerUid: "uid-1", ownerActive: true }],
    ]).flat());
    records["workspaces/other"] = { id: "other", slug: "other", ownerUid: "uid-2", ownerActive: true };
    const { store, committed: transactions } = countingStore(records);

    await deactivateUserVisibility(store, "uid-1");

    expect(transactions).toEqual([400, 100]);
    const owned = Object.entries(records).filter(([path]) => path !== "workspaces/other");
    expect(owned).toHaveLength(500);
    expect(owned.every(([, row]) => row.ownerActive === false)).toBe(true);
    expect(records["workspaces/other"]).toMatchObject({ ownerActive: true });
  });

  it("revokes every owner token and deletes every owner pointer", async () => {
    const records: Documents = {
      ...tokens("t", 2),
      "modelBrokerTokens/foreign": { ...token(), ownerUid: "uid-2" },
      ...pointers("p", 1),
    };

    await revokeOwnerModelBrokerTokens(createDocumentFixtureStore(records), "uid-1", 50);

    expect(records["modelBrokerTokens/t0"]).toEqual({ ...token(), revoked: true, revokedAt: 50 });
    expect(records["modelBrokerTokens/t1"]).toEqual({ ...token(), revoked: true, revokedAt: 50 });
    expect(records["modelBrokerTokens/foreign"]).toEqual({ ...token(), ownerUid: "uid-2" });
    expect(records).not.toHaveProperty("modelBrokerGatewayTokens/p0");
  });

  it("revokes tens of thousands of owner tokens in bounded batches", async () => {
    const records: Documents = { ...tokens("tokens", 1_050), ...pointers("pointers", 3) };
    const { store, committed } = countingStore(records);

    await revokeOwnerModelBrokerTokens(store, "uid-1", 50);

    expect(committed).toEqual([400, 400, 253]);
  });

  it("refuses to revoke from a malformed owner token record", async () => {
    const records: Documents = { ...tokens("t", 1), "modelBrokerTokens/legacy": { ...token(), capped: false } };

    await expect(revokeOwnerModelBrokerTokens(createDocumentFixtureStore(records), "uid-1", 50))
      .rejects.toBeInstanceOf(MalformedRecordError);

    expect(records["modelBrokerTokens/t0"]).toEqual(token());
  });
});
