import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { queuedSharedMigrationOwnsSourceInStore } from "./queued-shared-migration.js";

function fixture(migrationId: string) {
  const error = "expected exactly one ready pod for transport=shared-a; found 0";
  const row = {
    kind: "migrate-user", status: "pending", startedAt: null, completedAt: null, attempts: 1, steps: [],
    input: { uid: "alice", userSlug: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
    schedulerHandoff: { migrationId, uid: "alice", slug: "alice", fromGatewayId: "shared-a", toGatewayId: "shared-b" },
    attemptHistory: [{ attempt: 1, startedAt: 1_000, completedAt: 2_000, classification: "transient", error,
      steps: [{ name: "keys-sync-state", status: "failed", error }] }],
  };
  const store = createDocumentFixtureStore({
    "users/alice": { provisioning: { openclaw: { gatewayId: "shared-a", status: "complete",
      migration: { state: "preparing", phase: "preparing", startedAt: 1_000, operationId: "op-1" } } } },
    "gateways/shared-a/assignments/alice": { uid: "alice", slug: "alice", gatewayId: "shared-a", source: "migrate-user", state: "serving", epoch: 4,
      createdAt: 500, updatedAt: 500, updatedByOperationId: null },
  });
  return { row, store };
}

describe("queued Shared migration custody", () => {
  it.each(["mig-op-1:scheduler:1:claim:1000"])("admits exact untouched attempt custody %s", async id => {
    const h = fixture(id);
    expect(await queuedSharedMigrationOwnsSourceInStore(h.store, h.row, "op-1")).toBe(true);
  });
  it.each(["mig-op-1:scheduler:1", "mig-other:scheduler:1:claim:1000", "mig-op-1:scheduler:2:claim:1000", "mig-op-1:scheduler:1:claim:999"])("rejects foreign operation, attempt or claim %s", async id => {
    const h = fixture(id);
    expect(await queuedSharedMigrationOwnsSourceInStore(h.store, h.row, "op-1")).toBe(false);
  });
});
