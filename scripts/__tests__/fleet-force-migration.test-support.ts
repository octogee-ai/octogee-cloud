import { createJournalFixtureStore, fixtureDocumentsAt, journalRowsAtPaths } from "@octogee/core/testing/journal-store";
import type { Firestore } from "firebase-admin/firestore";
import { keepJournalRowsIn } from "./journal-fixture-store.test-support.js";

export const forceMigrationTarget = { operationId: "move-1", uid: "u1", slug: "alice", fromGatewayId: "builder-a", toGatewayId: "shared-b" };

export function forceMigrationAssignment(gatewayId: string, uid: string, slug: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { uid, slug, gatewayId, source: "onboarding", state: "serving", epoch: 75, createdAt: 10, updatedAt: 20, updatedByOperationId: "move-1", ...overrides };
}

export function forceMigrationHarness() {
  const docs = new Map<string, Record<string, any>>([
    ["glmOperations/move-1", {
      kind: "migrate-user", status: "pending", createdAt: 0, startedAt: null, completedAt: null,
      input: { uid: "u1", fromGatewayId: "builder-a", toGatewayId: "shared-b", source: "placement" },
      attempts: 3, firstStartedAt: 100, nextAttemptAt: 9000, lastProgressAt: 450, steps: [],
      attemptHistory: [{ attempt: 3, startedAt: 400, completedAt: 450, error: "sessions.list UNAVAILABLE", steps: [
        { name: "pre-sync-state", status: "done" },
        { name: "quiesce-source", status: "failed" },
        { name: "rollback:unmount-target", status: "done" },
      ] }],
      schedulerHandoff: { migrationId: "mig-move-1:scheduler:3", uid: "u1", slug: "alice", fromGatewayId: "builder-a", toGatewayId: "shared-b" },
    }],
    ["users/u1", { username: "alice", provisioning: { openclaw: {
      gatewayId: "builder-a", status: "complete", migration: { state: "preparing", phase: "waiting", operationId: "move-1", startedAt: 400 },
    } } }],
    ["gateways/builder-a/assignments/u1", forceMigrationAssignment("builder-a", "u1", "alice")],
    ["gateways/builder-a", { gatewayId: "builder-a", gatewayClass: "isolated", ownerUid: "u1", builderSlug: "alice", runtime: "cluster", desiredStatus: "draining", latestRelease: 1, desiredRelease: 1, liveRelease: 1 }],
    ["gateways/shared-b", { gatewayId: "shared-b", gatewayClass: "shared", desiredStatus: "running", latestRelease: 1, desiredRelease: 1, liveRelease: 1 }],
  ]);
  const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
  const documents = fixtureDocumentsAt(docs);
  const tracked = {
    ...documents,
    set: (path: string, data: Record<string, unknown>) => { writes.push({ path, data }); documents.set(path, data); },
    delete: (path: string) => { writes.push({ path, data: {} }); documents.delete(path); },
  };
  const store = createJournalFixtureStore(journalRowsAtPaths(docs), { documents: tracked });
  const usernameQuery = (value: unknown) => ({
    limit: () => usernameQuery(value),
    get: async () => {
      const matching = [...docs].filter(([key, doc]) => key.startsWith("users/") && key.split("/").length === 2 && doc.username === value)
        .map(([key]) => ({ id: key.split("/")[1], data: () => structuredClone(docs.get(key)) }));
      return { docs: matching, empty: matching.length === 0 };
    },
  });
  const db = {
    collection: (path: string) => {
      if (path !== "users") throw new Error(`the force migration fake only answers user account lookups, not ${path}`);
      return {
        where: (field: string, _op: string, value: unknown) => {
          if (field !== "username") throw new Error(`the force migration fake only looks up usernames, not ${field}`);
          return usernameQuery(value);
        },
      };
    },
  };
  keepJournalRowsIn(db, docs, { documents: tracked });
  return { db: db as unknown as Firestore, store, docs, writes, op: () => docs.get("glmOperations/move-1")! };
}
