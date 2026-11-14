import { describe, expect, it, vi } from "vitest";
import {
  GatewayRetirementConflictError,
  GatewayRetirementReleaseUnconvergedError,
  GatewayRetirementTelemetryUnavailableError,
} from "@octogee/core/gateway-retirement-claim";

import type { PlatformStateTransaction } from "@octogee/core/platform-state";
import { createJournalFixtureStore, journalRowsIn, type FixtureDocuments } from "@octogee/core/testing/journal-store";
import { ensureOwnedGatewaysRetired } from "../lib/user-ops/user-gateway-retirement.js";

interface Root {
  gatewayId: string;
  latestRelease: number;
  desiredRelease: number;
  liveRelease: number | null;
  ownerUid: string | null;
  gatewayClass: "shared" | "isolated";
  desiredStatus: "running" | "paused" | "retired";
  allocation?: { kind: string; claimedByUid?: string; leaseId?: string; generation?: number };
  builderSlug?: string;
  retirementVersion?: number;
  retirementClaim?: { operationId: string; version: number; phase: string };
  updatedAt?: number;
  updatedBy?: string;
}

type Rows = Record<string, Record<string, unknown>>;
type OperationRow = Record<string, unknown> & { input: Record<string, unknown> };

function durableRoot(gatewayId: string, fields: Omit<Root, "gatewayId" | "latestRelease" | "desiredRelease" | "liveRelease">): Root {
  return { gatewayId, latestRelease: 1, desiredRelease: 1, liveRelease: 1, ...fields };
}

function runtimeRecord(gatewayId: string): Record<string, unknown> {
  return { docKind: "runtime", gatewayId, release: 1, lifecycle: "serving" };
}

function assignedUser(gatewayId: string): Record<string, unknown> {
  return { provisioning: { openclaw: { gatewayId } } };
}

function harness(
  roots: Record<string, Root>,
  operations: Rows = {},
  users: Rows = {},
  runtimes: Rows = {},
  assignments: string[] = [],
  subcollections: Record<string, string[]> = {},
  recoveryReceipts: Rows = {},
) {
  const deleted: string[] = [];
  const committed: string[][] = [];
  const failures = { commit: false };
  const hooks: { beforeTransaction?: () => void; releaseCleanup?: () => void } = {};
  let applying: string[] | null = null;
  const tables: Record<string, Rows> = {
    gateways: roots as unknown as Rows,
    glmOperations: operations,
    users,
    glmGateways: runtimes,
    gatewayRecoveryReceipts: recoveryReceipts,
  };
  const assignmentsPath = (gatewayId: string) => `gateways/${gatewayId}/assignments`;
  const erase = (path: string) => {
    deleted.push(path);
    applying?.push(path);
    const [collection, id, child, childId] = path.split("/");
    if (childId === undefined && child === undefined) delete tables[collection!]?.[id!];
    if (child === "assignments" && childId !== undefined) assignments.splice(assignments.indexOf(childId), 1);
    if (child === "releases" && childId !== undefined) {
      const collectionPath = `${collection}/${id}/releases`;
      const remaining = (subcollections[collectionPath] ?? []).filter((release) => release !== childId);
      if (remaining.length === 0) delete subcollections[collectionPath];
      else subcollections[collectionPath] = remaining;
    }
  };
  const documents: FixtureDocuments = {
    get: (path) => {
      const [collection, id, child] = path.split("/");
      return child === undefined ? tables[collection!]?.[id!] : undefined;
    },
    set: (path, row) => {
      const [collection, id] = path.split("/");
      tables[collection!]![id!] = row;
    },
    delete: (path) => erase(path),
    children: (collectionPath) => {
      if (collectionPath.endsWith("/assignments")) {
        return assignmentsPath(collectionPath.split("/")[1]!) === collectionPath
          ? assignments.map((uid) => [uid, { uid }] as const)
          : [];
      }
      if (collectionPath.endsWith("/releases")) {
        hooks.releaseCleanup?.();
        return (subcollections[collectionPath] ?? []).map((release) => [release, {}] as const);
      }
      if (collectionPath.includes("/")) return [];
      return Object.entries(tables[collectionPath] ?? {});
    },
    group: (collectionId) => { throw new Error(`unexpected collection group ${collectionId}`); },
  };
  const fixture = createJournalFixtureStore(journalRowsIn(operations), { documents });
  const store = new Proxy(fixture, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return async <T>(options: { label: string; readOnly?: boolean }, body: (transaction: PlatformStateTransaction) => Promise<T>) => {
        hooks.beforeTransaction?.();
        const writes: string[] = [];
        const result = await target.transaction(options, async (transaction) => {
          const value = await body(transaction);
          if (failures.commit && options.label.endsWith(".finish")) throw new Error("retirement cleanup commit unavailable");
          applying = writes;
          return value;
        });
        applying = null;
        if (writes.length > 0) committed.push(writes);
        return result;
      };
    },
  });
  return { store, deleted, committed, failures, hooks };
}

function retiredRoot(operationId: string): Root {
  return durableRoot("builder-alice", {
    ownerUid: "uid-1", gatewayClass: "isolated", desiredStatus: "retired",
    retirementVersion: 1, retirementClaim: { operationId, version: 1, phase: "claimed" },
  });
}

function retirementOperation(status: string): OperationRow {
  return {
    kind: "retire-gateway", status, gatewayId: "builder-alice",
    input: { gatewayId: "builder-alice", retirementClaimVersion: 1, uid: "uid-1" },
  };
}

function recoveredRoot(operationId: string): Root {
  return {
    ...retiredRoot(operationId), builderSlug: "alice",
    allocation: { kind: "disposable-builder", claimedByUid: "uid-1", leaseId: "lease-1", generation: 1 },
  };
}

function recoveryOperation(): OperationRow {
  return {
    kind: "recover-unreachable-disposable", status: "succeeded", gatewayId: "builder-alice",
    input: { uid: "uid-1", userSlug: "alice", gatewayId: "builder-alice", leaseId: "lease-1", generation: 1 },
    recoveryReceipt: { schemaVersion: 1, pods: 0 },
  };
}

describe("owned user gateway retirement", () => {
  it("preserves completed retirement before removing its source records", async () => {
    const operationId = "delete-retire-delete-1-builder-alice";
    const roots = { "builder-alice": retiredRoot(operationId) };
    const operations = { [operationId]: { ...retirementOperation("succeeded"), completedAt: 90 } };
    const { store } = harness(roots, operations);
    const preserveRetirementProof = vi.fn(async proof => {
      expect(roots["builder-alice"]).toBeDefined();
      expect(operations[operationId]).toBeDefined();
      expect(proof).toEqual({ gatewayId: "builder-alice", operationId, version: 1, completedAt: 90, runtime: "cluster" });
    });
    await expect(ensureOwnedGatewaysRetired({ store, uid: "uid-1", deletionId: "delete-1", now: 100, preserveRetirementProof })).resolves.toBe("retired");
    expect(preserveRetirementProof).toHaveBeenCalledTimes(1);
    expect(roots).toEqual({});
    expect(operations).toEqual({});
  });

  it("follows the recorded placement retirement operation after it succeeds", async () => {
    const operationId = "placement-retire-owner-builder-alice";
    const { store, deleted } = harness({ "builder-alice": retiredRoot(operationId) }, {
      [operationId]: retirementOperation("succeeded"),
    });
    const claimRetirement = vi.fn();
    await expect(ensureOwnedGatewaysRetired({ store, uid: "uid-1", deletionId: "delete-1", now: 100, claimRetirement: claimRetirement as never }))
      .resolves.toBe("retired");
    expect(deleted).toEqual(["gateways/builder-alice", `glmOperations/${operationId}`]);
    expect(claimRetirement).not.toHaveBeenCalled();
  });

  it("atomically erases both owned recovery artifacts before losing the owned gateway", async () => {
    const operationId = "placement-retire-owner-builder-alice";
    const recoveryId = "builder-recover-builder-alice-g1";
    const roots = { "builder-alice": recoveredRoot(operationId) };
    const operations = { [operationId]: retirementOperation("succeeded"), [recoveryId]: recoveryOperation() };
    const receipts = { [recoveryId]: recoveryOperation() };
    const { store, committed } = harness(roots, operations, {}, {}, [], {}, receipts);
    const input = { store, uid: "uid-1", deletionId: "delete-1", now: 100 };

    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retired");
    expect(committed).toEqual([[
      "gateways/builder-alice", `glmOperations/${operationId}`,
      `glmOperations/${recoveryId}`, `gatewayRecoveryReceipts/${recoveryId}`,
    ]]);
    expect(roots).toEqual({});
    expect(operations).toEqual({});
    expect(receipts).toEqual({});
    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("not-owned");
  });

  it.each(["children", "commit"])("retries %s failure without losing the recovery privacy cleanup path", async (failure) => {
    const operationId = "placement-retire-owner-builder-alice";
    const recoveryId = "builder-recover-builder-alice-g1";
    const roots = { "builder-alice": recoveredRoot(operationId) };
    const operations = { [operationId]: retirementOperation("succeeded"), [recoveryId]: recoveryOperation() };
    const receipts = { [recoveryId]: recoveryOperation() };
    const subcollections = { "gateways/builder-alice/releases": ["release-1"] };
    const { store, failures, committed, hooks } = harness(roots, operations, {}, {}, [], subcollections, receipts);
    if (failure === "children") hooks.releaseCleanup = () => { throw new Error("recovery child cleanup unavailable"); };
    else failures.commit = true;
    const input = { store, uid: "uid-1", deletionId: "delete-1", now: 100 };

    await expect(ensureOwnedGatewaysRetired(input)).rejects.toThrow(/unavailable/);
    expect(roots["builder-alice"]).toBeDefined();
    expect(operations[operationId]).toBeDefined();
    expect(operations[recoveryId]).toBeDefined();
    expect(receipts[recoveryId]).toBeDefined();
    expect(committed).toEqual([]);

    failures.commit = false;
    hooks.releaseCleanup = undefined;
    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retired");
    expect(roots).toEqual({});
    expect(operations).toEqual({});
    expect(receipts).toEqual({});
    expect(subcollections).toEqual({});
    expect(committed).toHaveLength(1);
    expect(committed[0]).toHaveLength(4);
  });

  it.each(["legacy operation", "receipt"])("refuses foreign or mismatched %s recovery identity", async (artifact) => {
    for (const change of [
      { uid: "foreign" }, { gatewayId: "foreign" }, { userSlug: "foreign" },
      { leaseId: "new-incarnation" }, { generation: 2 },
    ]) {
      const operationId = "placement-retire-owner-builder-alice";
      const recoveryId = "builder-recover-builder-alice-g1";
      const roots = { "builder-alice": recoveredRoot(operationId) };
      const recovery = recoveryOperation();
      recovery.input = { ...recovery.input, ...change };
      const operations: Rows = {
        [operationId]: retirementOperation("succeeded"),
        ...(artifact === "legacy operation" ? { [recoveryId]: recovery } : {}),
      };
      const receipts: Rows = artifact === "receipt" ? { [recoveryId]: recovery } : {};
      const { store, deleted } = harness(roots, operations, {}, {}, [], {}, receipts);

      await expect(ensureOwnedGatewaysRetired({ store, uid: "uid-1", deletionId: "delete-1", now: 100 }))
        .rejects.toThrow(/recovery.*does not match/);
      expect(deleted).toEqual([]);
      expect(roots["builder-alice"]).toBeDefined();
    }
  });

  it("revalidates recovery ownership after child cleanup before any parent deletion", async () => {
    const operationId = "placement-retire-owner-builder-alice";
    const recoveryId = "builder-recover-builder-alice-g1";
    const roots = { "builder-alice": recoveredRoot(operationId) };
    const operations = { [operationId]: retirementOperation("succeeded") };
    const receipts = { [recoveryId]: recoveryOperation() };
    const { store, committed, hooks } = harness(roots, operations, {}, {}, [], {
      "gateways/builder-alice/releases": ["release-1"],
    }, receipts);
    hooks.releaseCleanup = () => {
      receipts[recoveryId] = { ...recoveryOperation(), input: { uid: "other", gatewayId: "builder-alice" } };
    };

    await expect(ensureOwnedGatewaysRetired({ store, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .rejects.toThrow(/recovery.*does not match/);
    expect(roots["builder-alice"]).toBeDefined();
    expect(operations[operationId]).toBeDefined();
    expect(receipts[recoveryId].input).toEqual({ uid: "other", gatewayId: "builder-alice" });
    expect(committed).toEqual([]);
  });

  it("keeps a newly appearing recovery artifact discoverable until its children are cleaned", async () => {
    const operationId = "placement-retire-owner-builder-alice";
    const recoveryId = "builder-recover-builder-alice-g1";
    const roots = { "builder-alice": recoveredRoot(operationId) };
    const operations = { [operationId]: retirementOperation("succeeded") };
    const receipts: Record<string, Record<string, unknown>> = {};
    const subcollections: Record<string, string[]> = { "gateways/builder-alice/releases": ["release-1"] };
    const { store, committed, hooks } = harness(roots, operations, {}, {}, [], subcollections, receipts);
    hooks.releaseCleanup = () => {
      receipts[recoveryId] = recoveryOperation();
    };
    const input = { store, uid: "uid-1", deletionId: "delete-1", now: 100 };

    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retirement-pending");
    expect(roots["builder-alice"]).toBeDefined();
    expect(receipts[recoveryId]).toBeDefined();
    expect(committed).toEqual([]);

    hooks.releaseCleanup = undefined;
    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retired");
    expect(roots).toEqual({});
    expect(operations).toEqual({});
    expect(receipts).toEqual({});
    expect(subcollections).toEqual({});
  });

  it("keeps the retirement receipt discoverable after partial root child cleanup fails and retries it", async () => {
    const operationId = "placement-retire-owner-builder-alice";
    const roots = { "builder-alice": retiredRoot(operationId) };
    const operation = retirementOperation("succeeded");
    operation.input = { ...operation.input as object, userSlug: "alice" };
    const operations = { [operationId]: operation };
    const subcollections = { "gateways/builder-alice/releases": ["release-1"] };
    const { store, committed, hooks } = harness(roots, operations, {}, {}, [], subcollections);
    hooks.releaseCleanup = () => { throw new Error("root child cleanup unavailable"); };
    const input = { store, uid: "uid-1", deletionId: "delete-1", now: 100 };

    await expect(ensureOwnedGatewaysRetired(input)).rejects.toThrow(/cleanup unavailable/);
    expect(roots["builder-alice"]?.retirementClaim?.operationId).toBe(operationId);
    expect(operations[operationId]).toBe(operation);
    expect(subcollections).toEqual({ "gateways/builder-alice/releases": ["release-1"] });
    expect(committed).toEqual([]);

    hooks.releaseCleanup = undefined;
    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retired");
    expect(roots).toEqual({});
    expect(operations).toEqual({});
    expect(subcollections).toEqual({});
    expect(committed).toEqual([["gateways/builder-alice", `glmOperations/${operationId}`]]);
  });

  it("keeps both roots on a final commit failure and atomically deletes them on retry", async () => {
    const operationId = "placement-retire-owner-builder-alice";
    const roots = { "builder-alice": retiredRoot(operationId) };
    const operations = { [operationId]: retirementOperation("succeeded") };
    const { store, failures, committed } = harness(roots, operations);
    const input = { store, uid: "uid-1", deletionId: "delete-1", now: 100 };
    failures.commit = true;

    await expect(ensureOwnedGatewaysRetired(input)).rejects.toThrow(/commit unavailable/);
    expect(roots["builder-alice"]?.retirementClaim?.operationId).toBe(operationId);
    expect(operations[operationId]).toBeDefined();
    expect(committed).toEqual([]);

    failures.commit = false;
    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retired");
    expect(committed).toEqual([["gateways/builder-alice", `glmOperations/${operationId}`]]);
    expect(roots).toEqual({});
    expect(operations).toEqual({});
  });

  it.each(["owner", "claim", "receipt", "retention"])("revalidates %s after child cleanup before deleting either root", async (changed) => {
    const operationId = "placement-retire-owner-builder-alice";
    const roots = { "builder-alice": retiredRoot(operationId) };
    const operations = { [operationId]: retirementOperation("succeeded") };
    const { store, committed, hooks } = harness(roots, operations, {}, {}, [], {
      "gateways/builder-alice/releases": ["release-1"],
    });
    hooks.releaseCleanup = () => {
      if (changed === "owner") roots["builder-alice"] = { ...retiredRoot(operationId), ownerUid: "other" };
      if (changed === "claim") roots["builder-alice"] = retiredRoot("new-retirement");
      if (changed === "receipt") operations[operationId] = { ...retirementOperation("succeeded"), input: { gatewayId: "foreign" } };
      if (changed === "retention") operations[operationId] = {
        ...retirementOperation("succeeded"),
        input: { ...retirementOperation("succeeded").input, retainData: true },
      };
    };

    await expect(ensureOwnedGatewaysRetired({ store, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .rejects.toThrow(/ownership changed|retirement claim changed|retirement operation does not match|retained resources/);
    expect(roots["builder-alice"]).toBeDefined();
    expect(operations[operationId]).toBeDefined();
    expect(committed).toEqual([]);
  });

  it.each(["runtime", "assignment", "user", "handoff"])("keeps both roots when %s state appears during child cleanup", async (remaining) => {
    const operationId = "placement-retire-owner-builder-alice";
    const roots = { "builder-alice": recoveredRoot(operationId) };
    const operations: Record<string, Record<string, unknown>> = { [operationId]: retirementOperation("succeeded") };
    const users: Record<string, Record<string, unknown>> = {};
    const runtimes: Record<string, Record<string, unknown>> = {};
    const assignments: string[] = [];
    const subcollections: Record<string, string[]> = {
      "gateways/builder-alice/releases": ["release-1"],
      "gateways/builder-alice/assignments": [],
    };
    const { store, deleted, committed, hooks } = harness(roots, operations, users, runtimes, assignments, subcollections);
    hooks.releaseCleanup = () => {
      if (remaining === "runtime") runtimes["builder-alice"] = runtimeRecord("builder-alice");
      if (remaining === "assignment") {
        assignments.push("uid-2");
        subcollections["gateways/builder-alice/assignments"] = ["uid-2"];
      }
      if (remaining === "user") users["uid-2"] = assignedUser("builder-alice");
      if (remaining === "handoff") operations["builder-return-builder-alice-g1"] = {
        status: "failed", schedulerHandoffReleased: false,
        schedulerHandoff: { migrationId: "move-1", fromGatewayId: "builder-alice", toGatewayId: "shared-new", uid: "uid-1", slug: "alice" },
      };
    };

    await expect(ensureOwnedGatewaysRetired({ store, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .resolves.toBe("retirement-pending");
    expect(roots["builder-alice"]).toBeDefined();
    expect(operations[operationId]).toBeDefined();
    expect(deleted).toEqual(["gateways/builder-alice/releases/release-1"]);
    expect(committed).toEqual([]);
    if (remaining === "assignment") expect(subcollections["gateways/builder-alice/assignments"]).toEqual(["uid-2"]);
  });

  it("surfaces the actual existing retirement failure", async () => {
    const operationId = "placement-retire-owner-builder-alice";
    const { store, deleted } = harness({ "builder-alice": retiredRoot(operationId) }, {
      [operationId]: { ...retirementOperation("failed"), error: "RESOURCE_NOT_FOUND during VM deletion" },
    });
    await expect(ensureOwnedGatewaysRetired({ store, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .rejects.toThrow(/retirement failed: RESOURCE_NOT_FOUND/);
    expect(deleted).toEqual([]);
  });

  it.each(["pending", "running", "absent"])("keeps %s existing retirement blocked", async (status) => {
    const operationId = "placement-retire-owner-builder-alice";
    const { store, deleted } = harness({ "builder-alice": retiredRoot(operationId) }, status === "absent" ? {} : {
      [operationId]: retirementOperation(status),
    });
    const claimRetirement = vi.fn();
    await expect(ensureOwnedGatewaysRetired({ store, uid: "uid-1", deletionId: "delete-1", now: 100, claimRetirement: claimRetirement as never }))
      .resolves.toBe("retirement-pending");
    expect(deleted).toEqual([]);
    expect(claimRetirement).not.toHaveBeenCalled();
  });

  it.each([
    { label: "foreign gateway", change: { input: { gatewayId: "foreign", retirementClaimVersion: 1 } } },
    { label: "foreign owner", change: { input: { gatewayId: "builder-alice", retirementClaimVersion: 1, uid: "other" } } },
    { label: "wrong kind", change: { kind: "add-gateway" } },
    { label: "old claim", change: { input: { gatewayId: "builder-alice", retirementClaimVersion: 2 } } },
  ])("rejects $label retirement receipts", async ({ change }) => {
    const operationId = "delete-retire-delete-1-builder-alice";
    const { store, deleted } = harness({ "builder-alice": retiredRoot(operationId) }, {
      [operationId]: { ...retirementOperation("succeeded"), ...change },
    });
    await expect(ensureOwnedGatewaysRetired({ store, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .rejects.toThrow(/retirement operation does not match/);
    expect(deleted).toEqual([]);
  });

  it.each(["retainData", "retainServiceAccount"])("rejects a completed retirement retaining %s", async (flag) => {
    const operationId = "placement-retire-owner-builder-alice";
    const operation = retirementOperation("succeeded");
    operation.input = { ...operation.input, [flag]: true };
    const { store, deleted } = harness({ "builder-alice": retiredRoot(operationId) }, { [operationId]: operation });
    await expect(ensureOwnedGatewaysRetired({ store, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .rejects.toThrow(/retained resources/);
    expect(deleted).toEqual([]);
  });

  it("does not complete a retired root without a validated claim", async () => {
    const root = retiredRoot("delete-retire-delete-1-builder-alice");
    delete root.retirementClaim;
    const { store, deleted } = harness({ "builder-alice": root }, {
      "delete-retire-delete-1-builder-alice": retirementOperation("succeeded"),
    });
    await expect(ensureOwnedGatewaysRetired({ store, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .rejects.toThrow(/invalid retirement claim/);
    expect(deleted).toEqual([]);
  });

  it.each(["runtime", "assignment", "user"])("blocks succeeded retirement cleanup while a %s remains", async (remaining) => {
    const operationId = "delete-retire-delete-1-builder-alice";
    const { store, deleted } = harness({ "builder-alice": retiredRoot(operationId) }, {
      [operationId]: retirementOperation("succeeded"),
    }, remaining === "user" ? { "uid-1": assignedUser("builder-alice") } : {},
    remaining === "runtime" ? { "builder-alice": runtimeRecord("builder-alice") } : {},
    remaining === "assignment" ? ["uid-1"] : []);
    await expect(ensureOwnedGatewaysRetired({ store, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .resolves.toBe("retirement-pending");
    expect(deleted).toEqual([]);
  });

  it.each(["owner", "claim"])("revalidates the %s after selecting the owned root", async (changed) => {
    const operationId = "placement-retire-owner-builder-alice";
    const roots = { "builder-alice": retiredRoot(operationId) };
    const { store, deleted, hooks } = harness(roots, { [operationId]: retirementOperation("succeeded") });
    hooks.beforeTransaction = () => {
      roots["builder-alice"] = changed === "owner"
        ? { ...retiredRoot(operationId), ownerUid: "other" }
        : retiredRoot("new-retirement");
    };
    await expect(ensureOwnedGatewaysRetired({ store, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .rejects.toThrow(changed === "owner" ? /ownership changed/ : /retirement claim changed/);
    expect(deleted).toEqual([]);
  });

  it("refuses to finish a disposable retirement whose allocation lost its generation", async () => {
    const operationId = "placement-retire-owner-builder-alice";
    const root = recoveredRoot(operationId);
    root.allocation = { kind: "disposable-builder", claimedByUid: "uid-1", leaseId: "lease-1" };
    const { store, deleted } = harness({ "builder-alice": root }, { [operationId]: retirementOperation("succeeded") });
    await expect(ensureOwnedGatewaysRetired({ store, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .rejects.toThrow(/allocation has no generation/);
    expect(deleted).toEqual([]);
  });

  it("ignores a previous generation's handoff once the gateway carries a new allocation", async () => {
    const operationId = "placement-retire-owner-builder-alice";
    const root = recoveredRoot(operationId);
    root.allocation = { ...root.allocation!, generation: 2 };
    const operations = {
      [operationId]: retirementOperation("succeeded"),
      "builder-return-builder-alice-g1": {
        status: "failed", schedulerHandoffReleased: false,
        schedulerHandoff: { migrationId: "move-1", fromGatewayId: "builder-alice", toGatewayId: "shared-new", uid: "uid-1", slug: "alice" },
      },
    };
    const { store } = harness({ "builder-alice": root }, operations);
    await expect(ensureOwnedGatewaysRetired({ store, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .resolves.toBe("retired");
  });

  it.each(["builder-activate", "builder-return"])("waits for %s handoff release after retirement succeeds", async (prefix) => {
    const operationId = "placement-retire-owner-builder-alice";
    const operations = {
      [operationId]: retirementOperation("succeeded"),
      [`${prefix}-builder-alice-g1`]: {
        status: "failed", schedulerHandoffReleased: false,
        schedulerHandoff: { migrationId: "move-1", fromGatewayId: "builder-alice", toGatewayId: "shared-new", uid: "uid-1", slug: "alice" },
      },
    };
    const { store, deleted } = harness({ "builder-alice": recoveredRoot(operationId) }, operations);
    const input = { store, uid: "uid-1", deletionId: "delete-1", now: 100 };
    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retirement-pending");
    expect(deleted).toEqual([]);
    operations[`${prefix}-builder-alice-g1`].schedulerHandoffReleased = true;
    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retired");
  });

  it.each([
    ["this deletion", "delete-1", "retired"],
    ["another deletion", "delete-0", "retirement-pending"],
  ])("follows a user activation awaiting source recovery that %s cancelled", async (_label, cancelledByDeletionId, outcome) => {
    const operationId = "delete-retire-delete-1-builder-alice";
    const operations = {
      [operationId]: retirementOperation("succeeded"),
      "builder-activate-builder-alice-g1": {
        kind: "migrate-user", status: "failed", rolledBack: false, schedulerHandoffReleased: false, cancelledByDeletionId,
        error: "user migration cancelled because the account was suspended",
        input: {
          uid: "uid-1", userSlug: "alice", fromGatewayId: "shared-a", toGatewayId: "builder-alice",
          source: "builder-activation-lease", recoverSourceOnly: true,
        },
        schedulerHandoff: {
          migrationId: "mig-builder-activate-builder-alice-g1:scheduler:1:claim:1", fromGatewayId: "shared-a",
          toGatewayId: "builder-alice", uid: "uid-1", slug: "alice", stageAfterCutover: true,
        },
      },
    };
    const { store } = harness({ "builder-alice": recoveredRoot(operationId) }, operations);

    await expect(ensureOwnedGatewaysRetired({ store, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .resolves.toBe(outcome);
  });

  it.each([
    ["telemetry is unavailable", GatewayRetirementTelemetryUnavailableError, "telemetry is stale or unavailable"],
    ["desired release never went live", GatewayRetirementReleaseUnconvergedError, "desired release is not converged to live"],
  ])("pauses a running owned user whose %s, then retires it paused", async (_label, Refusal, reason) => {
    const roots: Record<string, Root> = {
      "builder-alice": durableRoot("builder-alice", {
        ownerUid: "uid-1", gatewayClass: "isolated", desiredStatus: "running",
        allocation: { kind: "disposable-builder", claimedByUid: "uid-1", leaseId: "lease-1", generation: 1 },
      }),
    };
    const { store } = harness(roots);
    const claimRetirement = vi.fn(async ({ gatewayId }: { gatewayId: string }) => {
      if (roots[gatewayId]!.desiredStatus === "running") {
        throw new Refusal(`gateway ${gatewayId} ${reason}`);
      }
      return { version: 1 };
    });
    const input = { store, uid: "uid-1", deletionId: "delete-1", now: 100, claimRetirement: claimRetirement as never };

    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retirement-pending");
    expect(roots["builder-alice"]).toMatchObject({ desiredStatus: "paused", updatedAt: 100, updatedBy: "customer-deletion-lifecycle" });

    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retirement-pending");
    expect(claimRetirement).toHaveBeenCalledTimes(2);
    await expect(claimRetirement.mock.results[1]!.value).resolves.toEqual({ version: 1 });
  });

  it("keeps a running owned user running when retirement is refused for another reason", async () => {
    const roots: Record<string, Root> = {
      "builder-alice": durableRoot("builder-alice", {
        ownerUid: "uid-1", gatewayClass: "isolated", desiredStatus: "running",
        allocation: { kind: "disposable-builder", claimedByUid: "uid-1", leaseId: "lease-1", generation: 1 },
      }),
    };
    const { store } = harness(roots);
    const claimRetirement = vi.fn(async () => {
      throw new GatewayRetirementConflictError("gateway builder-alice still has mounted users: alice");
    });

    await expect(ensureOwnedGatewaysRetired({
      store, uid: "uid-1", deletionId: "delete-1", now: 100, claimRetirement: claimRetirement as never,
    })).rejects.toThrow(/still has mounted users/);
    expect(roots["builder-alice"]!.desiredStatus).toBe("running");
  });

  it("retires the owned disposable isolated gateway while the user's current placement is shared", async () => {
    const { store } = harness({
      default: durableRoot("default", { ownerUid: null, gatewayClass: "shared", desiredStatus: "running" }),
      "builder-alice": durableRoot("builder-alice", {
        ownerUid: "uid-1",
        gatewayClass: "isolated",
        desiredStatus: "running",
        allocation: { kind: "disposable-builder", claimedByUid: "uid-1", leaseId: "lease-1", generation: 1 },
      }),
    });
    const claimRetirement = vi.fn(async () => ({ version: 1 }));

    await expect(ensureOwnedGatewaysRetired({
      store,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: claimRetirement as never,
    })).resolves.toBe("retirement-pending");

    expect(claimRetirement).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "builder-alice",
      operationId: "delete-retire-delete-1-builder-alice",
    }));
  });

  it("stamps user-deletion retirement work as automatic", async () => {
    const { store } = harness({
      "builder-alice": durableRoot("builder-alice", {
        ownerUid: "uid-1",
        gatewayClass: "isolated",
        desiredStatus: "running",
        allocation: { kind: "disposable-builder", claimedByUid: "uid-1", leaseId: "lease-1", generation: 1 },
      }),
    });
    const claimRetirement = vi.fn(async () => ({ version: 1 }));

    await ensureOwnedGatewaysRetired({
      store,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: claimRetirement as never,
    });

    expect(claimRetirement).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({ origin: "automatic" }),
    }));
  });

  it("retires a disposable root during suspension cleanup", async () => {
    const { store } = harness({
      "run-alice": durableRoot("run-alice", {
        ownerUid: "uid-1",
        gatewayClass: "isolated",
        desiredStatus: "running",
        allocation: { kind: "disposable-builder", claimedByUid: "uid-1", leaseId: "lease-1", generation: 1 },
      }),
    });
    const claimRetirement = vi.fn(async () => ({ version: 1 }));

    await expect(ensureOwnedGatewaysRetired({
      store,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: claimRetirement as never,
    })).resolves.toBe("retirement-pending");

    expect(claimRetirement).toHaveBeenCalledTimes(1);
    expect(claimRetirement).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "run-alice",
    }));
  });

  it("deletes every durable gateway root only after its retirement operation succeeds", async () => {
    const operationId = "delete-retire-delete-1-builder-alice";
    const { store, deleted } = harness(
      {
        "builder-alice": durableRoot("builder-alice", {
          ownerUid: "uid-1",
          gatewayClass: "isolated",
          desiredStatus: "retired",
          retirementVersion: 1,
          retirementClaim: { operationId, version: 1, phase: "claimed" },
          allocation: { kind: "disposable-builder", claimedByUid: "uid-1", leaseId: "lease-1", generation: 1 },
        }),
      },
      { [operationId]: { ...retirementOperation("succeeded"), origin: "automatic" } },
    );

    await expect(ensureOwnedGatewaysRetired({
      store,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: vi.fn() as never,
    })).resolves.toBe("retired");

    expect(deleted).toEqual([
      "gateways/builder-alice",
      `glmOperations/${operationId}`,
    ]);
  });

  it("cleans up a succeeded retirement for a missing-origin operation", async () => {
    const operationId = "delete-retire-delete-1-builder-alice";
    const { store, deleted } = harness(
      {
        "builder-alice": durableRoot("builder-alice", {
          ownerUid: "uid-1",
          gatewayClass: "isolated",
          desiredStatus: "retired",
          retirementVersion: 1,
          retirementClaim: { operationId, version: 1, phase: "claimed" },
          allocation: { kind: "disposable-builder", claimedByUid: "uid-1", leaseId: "lease-1", generation: 1 },
        }),
      },
      { [operationId]: retirementOperation("succeeded") },
    );

    await expect(ensureOwnedGatewaysRetired({
      store,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: vi.fn() as never,
    })).resolves.toBe("retired");

    expect(deleted).toEqual(["gateways/builder-alice", `glmOperations/${operationId}`]);
  });

  it("leaves a shared gateway alone even if malformed ownership data points at the user", async () => {
    const { store } = harness({
      default: durableRoot("default", { ownerUid: "uid-1", gatewayClass: "shared", desiredStatus: "running" }),
    });
    const claimRetirement = vi.fn();

    await expect(ensureOwnedGatewaysRetired({
      store,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: claimRetirement as never,
    })).resolves.toBe("not-owned");
    expect(claimRetirement).not.toHaveBeenCalled();
  });

  it("retires a legacy owner root without a disposable allocation", async () => {
    const { store } = harness({
      "legacy-user": durableRoot("legacy-user", {
        ownerUid: "uid-1",
        gatewayClass: "isolated",
        desiredStatus: "running",
      }),
    });
    const claimRetirement = vi.fn(async () => ({ version: 1 }));

    await expect(ensureOwnedGatewaysRetired({
      store,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: claimRetirement as never,
    })).resolves.toBe("retirement-pending");

    expect(claimRetirement).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "legacy-user",
    }));
  });
});
