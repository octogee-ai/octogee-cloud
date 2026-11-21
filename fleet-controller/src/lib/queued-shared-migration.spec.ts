import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { queuedSharedMigrationNeverTouchedDestinationInStore, queuedSharedMigrationOwnsSourceInStore } from "./queued-shared-migration.js";

const preparingMarker = { state: "preparing", phase: "preparing", startedAt: 1_000, operationId: "op-1" };

function fixture(migrationId: string, migration?: Record<string, unknown> | null, withDestination = false) {
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
      ...(migration === null ? {} : { migration: migration ?? preparingMarker }) } } },
    "gateways/shared-a/assignments/alice": { uid: "alice", slug: "alice", gatewayId: "shared-a", source: "migrate-user", state: "serving", epoch: 4,
      createdAt: 500, updatedAt: 500, updatedByOperationId: null },
    ...(withDestination ? { "gateways/shared-b/assignments/alice": { uid: "alice", slug: "alice", gatewayId: "shared-b",
      source: "migrate-user", state: "serving", epoch: 5, createdAt: 1000, updatedAt: 1000, updatedByOperationId: "op-1" } } : {}),
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

describe("queued Shared destination custody", () => {
  it("releases only queue dependency when the untouched source has no workspace marker", async () => {
    const h = fixture("mig-op-1:scheduler:1:claim:1000", null);
    expect(await queuedSharedMigrationNeverTouchedDestinationInStore(h.store, h.row, "op-1")).toBe(true);
    expect(await queuedSharedMigrationOwnsSourceInStore(h.store, h.row, "op-1")).toBe(false);
  });

  it.each([{ ...preparingMarker, operationId: "foreign" }, { phase: "preparing" }])(
    "preserves the target dependency with a foreign or malformed marker %#",
    async marker => {
      const h = fixture("mig-op-1:scheduler:1:claim:1000", marker);
      expect(await queuedSharedMigrationNeverTouchedDestinationInStore(h.store, h.row, "op-1")).toBe(false);
    },
  );

  it("preserves the target dependency without a marker when older attempts are no longer retained", async () => {
    const h = fixture("mig-op-1:scheduler:21:claim:1000", null);
    h.row.attempts = 21;
    h.row.attemptHistory = Array.from({ length: 20 }, (_, index) => ({
      ...h.row.attemptHistory[0],
      attempt: index + 2,
    }));
    expect(await queuedSharedMigrationNeverTouchedDestinationInStore(h.store, h.row, "op-1")).toBe(false);
  });

  it("preserves the target dependency once a target assignment exists", async () => {
    const h = fixture("mig-op-1:scheduler:1:claim:1000", null, true);
    expect(await queuedSharedMigrationNeverTouchedDestinationInStore(h.store, h.row, "op-1")).toBe(false);
  });
});
