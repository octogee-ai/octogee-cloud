import { isDeepStrictEqual } from "node:util";
import {
  isGatewayDesiredDoc,
  isGatewayRuntimeDoc,
  isReleasePayload,
  parsePlatformReleaseRecord,
  PLATFORM_RELEASE_RECORD_DOC_PATH,
  upgradeReleasePayloadSchema,
} from "@octogee/shared/types/gateway-releases";
import {
  gatewayVmRuntimeDocPath,
  isGatewayVmRuntimeBundle,
  isOperationAuditRecord,
  isOperationAuditRow,
  type GatewayVmRuntimeBundle,
  type GlmOperationRecord,
} from "@octogee/shared/types/glm";
import { USER_DELETION_JOBS_COLLECTION } from "@octogee/shared/types/account-lifecycle";
import { MODEL_BROKER_GATEWAY_POINTERS_COLLECTION, MODEL_BROKER_TOKENS_COLLECTION } from "@octogee/shared/types/model-broker-usage";
import { placementReceiptDocId, type PlacementReceipt } from "@octogee/shared/types/placement-receipts";
import { SCHEDULE_TRANSFERS_SUBCOLLECTION, type ScheduleTransferDoc } from "@octogee/shared/types/fleet-controller";
import type {
  ActivationLeaseFence,
  AgentStoreRecord,
  UserFence,
  PlatformUserRecord,
  UserAccountRecord,
  UserRepositories,
  GatewayFenceHolders,
} from "../platform-state/users.js";
import {
  requireSizingProfile,
  type ConfigRepositories,
  type GatewaySizingProfile,
  type OrchestratorConfig,
  type PlatformConfigEntry,
  type PlatformConfigKey,
} from "../platform-state/config.js";
import type { ControllerStateRepositories, SharedPoolScalerFence, SharedPoolScalerState } from "../platform-state/controller-state.js";
import {
  AlreadyExistsError,
  DuplicateRecordError,
  FenceMismatchError,
  MalformedRecordError,
  MissingRecordError,
  UnsupportedOperationError,
  type FenceName,
  type RecordKey,
} from "../platform-state/errors.js";
import type { FleetRegistryForeignEntry, FleetRegistryRecord, FleetRegistryRepository } from "../platform-state/fleet-registry.js";
import {
  ACTIVATED_AGENTS_PATH,
  ADMITTED_STEP,
  agentStoreFromData,
  agentStoreKeyOf,
  USER_ACTIVATION_LEASE_PATH,
  USER_FENCE_PATHS,
  SLUG_PATH,
  USER_MIRROR_PATHS,
  userPatchPaths,
  userRecordFromData,
  userRoleFromData,
} from "../platform-state/documents/users.js";
import { parseOrchestratorConfig, parsePlatformConfigValue, platformConfigEntryFromData } from "../platform-state/documents/config.js";
import { SCALER_KEY, parseSharedPoolScalerState } from "../platform-state/documents/controller-state.js";
import { assertAbsentFence, assertFenceEquals, assertFenceOneOf } from "../platform-state/documents/fences.js";
import { migrationTransferTaskFromData } from "../platform-state/documents/migration-tasks.js";
import { decodeGatewayAssignmentData } from "../platform-state/documents/gateways.js";
import {
  agentImportDocument,
  agentImportPointerDocument,
  agentImportPointerFromData,
  agentImportRecordFromData,
  anonymousArchiveFromData,
  storedDeletionStatus,
} from "../platform-state/documents/jobs.js";
import {
  userSecretFromData,
  userSecretToData,
  CONTROL_SESSION_FIELDS,
  CONTROL_TICKET_FIELDS,
  controlSessionFromData,
  controlTicketFromData,
  GATEWAY_TICKET_FIELDS,
  gatewayAccessDenialAuditId,
  gatewayTicketFromData,
  modelBrokerGatewayTokenFromData,
  modelBrokerTokenDocument,
  modelBrokerTokenFromData,
  secretKindOf,
} from "../platform-state/documents/secrets.js";
import {
  agentIdentityFromData,
  workspaceChannelFromData,
  workspaceMemberFromData,
  workspaceProjectFromData,
  workspaceProjectMemberFromData,
  isWorkspaceReservation,
  workspaceRecordFromData,
} from "../platform-state/documents/workspaces.js";
import type { UserDeletionJob, UserDeletionJobStatus, JobRepositories } from "../platform-state/jobs.js";
import type {
  GatewayAssignment,
  GatewayAssignmentFence,
  GatewayRelease,
  GatewayRepositories,
  GatewayRoot,
  GatewayRootFence,
} from "../platform-state/gateways.js";
import type { MigrationTasksRepository, MigrationTransferTask } from "../platform-state/migration-tasks.js";
import type {
  GatewayRecoveryReceipt,
  JournalRepositories,
  OperationAuditFence,
  OperationAuditRow,
  OperationRecord,
} from "../platform-state/operations.js";
import type { AccessRepositories, SecretsRepository } from "../platform-state/secrets.js";
import type { Page, PageRequest, PlatformStateStore, PlatformStateTransaction, Revision, Stored } from "../platform-state/store.js";
import type { ActivityReceiptKey, WorkspaceChannelScope, WorkspaceRepositories } from "../platform-state/workspaces.js";

export interface JournalRows {
  get(id: string): Record<string, unknown> | undefined;
  set(id: string, row: Record<string, unknown>): void;
}

export function journalRowsIn(records: Record<string, Record<string, unknown>>): JournalRows {
  return {
    get: (id) => records[id],
    set: (id, row) => {
      records[id] = row;
    },
  };
}

export function journalRowsAtPaths(
  records: Map<string, Record<string, unknown>> | Record<string, Record<string, unknown> | undefined>,
): JournalRows {
  const path = (id: string) => `glmOperations/${id}`;
  if (records instanceof Map) {
    return {
      get: (id) => records.get(path(id)),
      set: (id, row) => {
        records.set(path(id), row);
      },
    };
  }
  return {
    get: (id) => records[path(id)],
    set: (id, row) => {
      records[path(id)] = row;
    },
  };
}

export interface FixtureDocuments {
  get(path: string): Record<string, unknown> | undefined;
  set(path: string, row: Record<string, unknown>): void;
  delete(path: string): void;
  children(collectionPath: string): ReadonlyArray<readonly [string, Record<string, unknown>]>;
  group(collectionId: string): ReadonlyArray<readonly [string, Record<string, unknown>]>;
  descendants?(documentPath: string): readonly string[];
}

export type FixtureDocumentRecords =
  | Map<string, Record<string, unknown>>
  | Record<string, Record<string, unknown> | undefined>;

function fixtureEntries(records: FixtureDocumentRecords): Array<readonly [string, Record<string, unknown>]> {
  const entries = records instanceof Map ? [...records.entries()] : Object.entries(records);
  return entries.flatMap(([path, row]) => (row === undefined ? [] : [[path, row] as const]));
}

export function fixtureDocumentsAt(records: FixtureDocumentRecords): FixtureDocuments {
  return {
    get: (path) => (records instanceof Map ? records.get(path) : records[path]),
    set: (path, row) => {
      if (records instanceof Map) records.set(path, row);
      else records[path] = row;
    },
    delete: (path) => {
      if (records instanceof Map) records.delete(path);
      else delete records[path];
    },
    children: (collectionPath) =>
      fixtureEntries(records).flatMap(([path, row]) => {
        if (!path.startsWith(`${collectionPath}/`)) return [];
        const id = path.slice(collectionPath.length + 1);
        return id.includes("/") ? [] : [[id, row] as const];
      }),
    group: (collectionId) =>
      fixtureEntries(records).filter(([path]) => {
        const segments = path.split("/");
        return segments.length % 2 === 0 && segments[segments.length - 2] === collectionId;
      }),
    descendants: (documentPath) =>
      fixtureEntries(records).flatMap(([path]) => (path.startsWith(`${documentPath}/`) ? [path] : [])),
  };
}

const FIXTURE_REVISION = "fixture" as Revision;

function auditKey(id: string): RecordKey {
  return { aggregate: "operation-audit", key: id };
}

function stored<T>(id: string, row: Record<string, unknown>): Stored<T> {
  return { ...structuredClone(row), id, revision: FIXTURE_REVISION } as unknown as Stored<T>;
}

function decode(id: string, row: Record<string, unknown> | undefined): Stored<GlmOperationRecord> | null {
  if (row === undefined) return null;
  if (isOperationAuditRow(row) && !isOperationAuditRecord(row)) {
    throw new MalformedRecordError(auditKey(id), "fails the operation audit schema");
  }
  return stored<GlmOperationRecord>(id, row);
}

function isClear(value: unknown): boolean {
  return value !== null && typeof value === "object" && "clear" in value && (value as { clear: unknown }).clear === true;
}

function applyPatch(row: Record<string, unknown>, patch: object): Record<string, unknown> {
  const next = { ...row };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isClear(value)) {
      delete next[field];
    } else {
      next[field] = value;
    }
  }
  return next;
}

function assertAuditFence(id: string, fence: OperationAuditFence, current: Record<string, unknown>): void {
  const key = auditKey(id);
  if (fence.status !== undefined && !fence.status.includes(current.status as never)) {
    throw new FenceMismatchError(key, "status", fence.status, current.status);
  }
  for (const [name, expected, actual] of [
    ["actionClaimId", fence.actionClaimId, current.actionClaimId],
    ["actionStartedAt", fence.actionStartedAt, current.actionStartedAt],
  ] as const) {
    if (expected !== undefined && !isDeepStrictEqual(expected, actual ?? null)) {
      throw new FenceMismatchError(key, name, expected, actual ?? null);
    }
  }
}

function unimplemented(path: string): never {
  throw new Error(`the journal fixture store does not implement ${path}`);
}

function partialRepository<T extends object>(path: string, implemented: Partial<T>): T {
  return new Proxy(implemented as T, {
    get: (target, method) =>
      method in target ? Reflect.get(target, method) : () => unimplemented(`${path}.${String(method)}`),
  });
}

type Write = (apply: () => void) => void;

function deleteTree(documents: FixtureDocuments, documentPath: string): void {
  if (documents.descendants === undefined) unimplemented(`recursive delete of ${documentPath}`);
  for (const path of documents.descendants(documentPath)) documents.delete(path);
  documents.delete(documentPath);
}

function assertOutsideTransaction(transactional: boolean, operation: string): void {
  if (transactional) throw new UnsupportedOperationError("firestore", operation, "backend-capability");
}

function withoutIdentity(record: object): Record<string, unknown> {
  const { id: _id, revision: _revision, ...row } = record as Record<string, unknown>;
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

const OPERATIONS = "glmOperations";

function operationRepository(documents: FixtureDocuments, write: Write): JournalRepositories["operations"] {
  const key = (id: string): RecordKey => ({ aggregate: "operation", key: id });
  const decodeOperation = (id: string, row: Record<string, unknown> | undefined) =>
    row === undefined || isOperationAuditRow(row) ? null : stored<OperationRecord>(id, row);
  let minted = 0;
  const create = (operation: OperationRecord) => {
    const path = `${OPERATIONS}/${operation.id}`;
    if (documents.get(path) !== undefined) throw new AlreadyExistsError(key(operation.id));
    write(() => {
      if (documents.get(path) !== undefined) throw new AlreadyExistsError(key(operation.id));
      documents.set(path, withoutIdentity(operation));
    });
  };
  const listWhere = (matches: (operation: Stored<OperationRecord>) => boolean) =>
    documents.children(OPERATIONS).flatMap(([id, row]) => {
      const operation = decodeOperation(id, row);
      return operation !== null && matches(operation) ? [operation] : [];
    });
  return partialRepository<JournalRepositories["operations"]>("journal.operations", {
    get: async (id) => decodeOperation(id, documents.get(`${OPERATIONS}/${id}`)),
    getMany: async (ids) => new Map(ids.flatMap((id) => {
      const operation = decodeOperation(id, documents.get(`${OPERATIONS}/${id}`));
      return operation === null ? [] : [[id, operation] as const];
    })),
    listByStatus: async (statuses) => listWhere((operation) => statuses.includes(operation.status)),
    listUnreleasedSchedulerHandoffs: async (statuses) =>
      listWhere((operation) => statuses.includes(operation.status) && operation.schedulerHandoffReleased === false),
    listByKind: async (kind, statuses) => listWhere((operation) =>
      operation.kind === kind && (statuses === undefined || statuses.includes(operation.status))),
    listByGateway: async (gatewayId, limit) =>
      listWhere((operation) => operation.gatewayId === gatewayId).slice(0, limit),
    listByInputGateway: async (gatewayId) =>
      listWhere((operation) => isMap(operation.input) && operation.input.gatewayId === gatewayId),
    listReferencingUid: async (uid) => listWhere((operation) =>
      operation.inputUid === uid || (isMap(operation.input) && operation.input.uid === uid) || operation.createdBy === uid),
    listForUid: async (uid, filter) => listWhere((operation) =>
      operation.inputUid === uid &&
      (filter.statuses === undefined || filter.statuses.includes(operation.status)) &&
      (filter.kind === undefined || operation.kind === filter.kind)),
    enqueue: async (operation) => {
      let id: string;
      do {
        minted += 1;
        id = `fixture-operation-${minted}`;
      } while (documents.get(`${OPERATIONS}/${id}`) !== undefined);
      create({ ...operation, id });
      return id;
    },
    create: async (operation) => create(operation),
    put: async (operation) => {
      write(() => documents.set(`${OPERATIONS}/${operation.id}`, withoutIdentity(operation)));
    },
    patch: async (id, patch, fence) => {
      const current = decodeOperation(id, documents.get(`${OPERATIONS}/${id}`));
      if (current === null) throw new MissingRecordError(key(id));
      if (fence !== undefined) {
        assertFenceOneOf(key(id), "status", fence.status, current.status);
        assertFenceEquals(key(id), "startedAt", fence.startedAt, current.startedAt);
      }
      write(() => {
        const latest = documents.get(`${OPERATIONS}/${id}`);
        if (latest === undefined) throw new MissingRecordError(key(id));
        documents.set(`${OPERATIONS}/${id}`, applyPatch(latest, structuredClone(patch)));
      });
    },
    delete: async (id) => {
      write(() => documents.delete(`${OPERATIONS}/${id}`));
    },
  });
}

const RECOVERY_RECEIPTS = "gatewayRecoveryReceipts";

function recoveryReceiptRepository(documents: FixtureDocuments, write: Write): JournalRepositories["recoveryReceipts"] {
  const path = (id: string) => `${RECOVERY_RECEIPTS}/${id}`;
  const key = (id: string): RecordKey => ({ aggregate: "gateway-recovery-receipt", key: id });
  const decodeReceipt = (id: string) => {
    const row = documents.get(path(id));
    return row === undefined ? null : stored<GatewayRecoveryReceipt>(id, row);
  };
  return partialRepository<JournalRepositories["recoveryReceipts"]>("journal.recoveryReceipts", {
    get: async (id) => decodeReceipt(id),
    listReferencingUid: async (uid) => documents.children(RECOVERY_RECEIPTS).flatMap(([id, row]) =>
      row.inputUid === uid || (isMap(row.input) && row.input.uid === uid) ? [stored<GatewayRecoveryReceipt>(id, row)] : []),
    create: async (receipt) => {
      if (documents.get(path(receipt.id)) !== undefined) throw new AlreadyExistsError(key(receipt.id));
      write(() => {
        if (documents.get(path(receipt.id)) !== undefined) throw new AlreadyExistsError(key(receipt.id));
        documents.set(path(receipt.id), withoutIdentity(receipt));
      });
    },
    patch: async (id, patch) => {
      if (decodeReceipt(id) === null) throw new MissingRecordError(key(id));
      write(() => {
        const latest = documents.get(path(id));
        if (latest === undefined) throw new MissingRecordError(key(id));
        documents.set(path(id), applyPatch(latest, structuredClone(patch)));
      });
    },
    delete: async (id) => {
      write(() => documents.delete(path(id)));
    },
  });
}

function journalRepositories(rows: JournalRows, write: Write, documents?: FixtureDocuments): JournalRepositories {
  const getAudit = async (id: string): Promise<Stored<OperationAuditRow> | null> => {
    const record = decode(id, rows.get(id));
    return record !== null && isOperationAuditRow(record) ? (record as Stored<OperationAuditRow>) : null;
  };
  return {
    getRecord: async (id) => decode(id, rows.get(id)),
    listRecent: async (page) => {
      if (documents === undefined) return unimplemented("journal.listRecent");
      const records = documents.children(OPERATIONS)
        .map(([id, row]) => decode(id, row)!)
        .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0));
      const start = page.after === undefined ? 0 : records.findIndex((record) => record.id === page.after) + 1;
      const items = records.slice(start, start + page.limit);
      return { items, next: start + page.limit < records.length ? items[items.length - 1].id : null };
    },
    operations: documents === undefined
      ? partialRepository<JournalRepositories["operations"]>("journal.operations", {})
      : operationRepository(documents, write),
    recoveryReceipts: documents === undefined
      ? partialRepository<JournalRepositories["recoveryReceipts"]>("journal.recoveryReceipts", {})
      : recoveryReceiptRepository(documents, write),
    audits: {
      get: getAudit,
      getByIdempotencyKey: () => unimplemented("journal.audits.getByIdempotencyKey"),
      async create(audit) {
        if (rows.get(audit.id) !== undefined) throw new AlreadyExistsError(auditKey(audit.id));
        const { id, ...row } = audit;
        write(() => {
          if (rows.get(id) !== undefined) throw new AlreadyExistsError(auditKey(id));
          rows.set(id, structuredClone(row));
        });
      },
      async patch(auditId, patch, fence) {
        const current = rows.get(auditId);
        if (current === undefined || !isOperationAuditRow(current)) throw new MissingRecordError(auditKey(auditId));
        if (fence !== undefined) assertAuditFence(auditId, fence, current);
        write(() => {
          const latest = rows.get(auditId);
          if (latest === undefined) throw new MissingRecordError(auditKey(auditId));
          rows.set(auditId, applyPatch(latest, patch));
        });
      },
      delete: () => unimplemented("journal.audits.delete"),
    },
  };
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRootFence(id: string, fence: GatewayRootFence, current: Record<string, unknown>): void {
  const record: RecordKey = { aggregate: "gateway", key: id };
  const allocation = isMap(current.allocation) ? current.allocation : undefined;
  const checks: Array<[FenceName, unknown, unknown]> = [
    ["updatedAt", fence.updatedAt, current.updatedAt],
    ["latestRelease", fence.latestRelease, current.latestRelease],
    ["retirementVersion", fence.retirementVersion, current.retirementVersion],
    ["generation", fence.allocationGeneration, allocation?.generation],
    ["present", fence.lastErrorSlug, isMap(current.lastError) ? current.lastError.slug : undefined],
  ];
  for (const [name, expected, actual] of checks) {
    if (expected !== undefined && !isDeepStrictEqual(expected, actual ?? null)) {
      throw new FenceMismatchError(record, name, expected, actual ?? null);
    }
  }
  if (fence.desiredStatus !== undefined && !fence.desiredStatus.includes(current.desiredStatus as never)) {
    throw new FenceMismatchError(record, "status", fence.desiredStatus, current.desiredStatus);
  }
}

function gatewayRepositories(documents: FixtureDocuments, write: Write): GatewayRepositories {
  const rootPath = (id: string) => `gateways/${id}`;
  const releasePath = (id: string, release: number) => `gateways/${id}/releases/${release}`;
  const rootKey = (id: string): RecordKey => ({ aggregate: "gateway", key: id });
  const releaseKey = (id: string, release: number): RecordKey => ({ aggregate: "gateway-release", key: `${id}/${release}` });
  const decodeRoot = (id: string): Stored<GatewayRoot> | null => {
    const row = documents.get(rootPath(id));
    if (row === undefined) return null;
    if (!isGatewayDesiredDoc(row) || row.gatewayId !== id) throw new MalformedRecordError(rootKey(id), "is not a durable gateway root");
    return { ...structuredClone(row), revision: FIXTURE_REVISION } as unknown as Stored<GatewayRoot>;
  };
  const decodeRelease = (id: string, release: number): GatewayRelease | null => {
    const row = documents.get(releasePath(id, release));
    if (row === undefined) return null;
    if (row.gatewayId !== id || row.release !== release) {
      throw new MalformedRecordError(releaseKey(id, release), "stores another release");
    }
    if (isReleasePayload(row.payload)) return structuredClone(row) as unknown as GatewayRelease;
    const upgrade = upgradeReleasePayloadSchema(row.payload, row.payloadHash);
    if (upgrade.status === "unsupported") throw new MalformedRecordError(releaseKey(id, release), upgrade.reason);
    return { ...structuredClone(row), payload: upgrade.payload, payloadHash: upgrade.payloadHash } as unknown as GatewayRelease;
  };
  const presentRoot = (id: string): Record<string, unknown> => {
    const row = documents.get(rootPath(id));
    if (row === undefined) throw new MissingRecordError(rootKey(id));
    return row;
  };
  const updateRoot = (id: string, patch: object) =>
    write(() => documents.set(rootPath(id), applyPatch(presentRoot(id), patch)));
  return {
    roots: partialRepository<GatewayRepositories["roots"]>("gateways.roots", {
      deleteChildren: async (id) => {
        write(() => {
          for (const [release] of documents.children(`gateways/${id}/releases`)) {
            documents.delete(`gateways/${id}/releases/${release}`);
          }
        });
      },
      get: async (id) => decodeRoot(id),
      getMany: async (ids) => new Map(ids.flatMap((id) => {
        const root = decodeRoot(id);
        return root === null ? [] : [[id, root] as const];
      })),
      findByServiceAccountName: async (serviceAccountName) => {
        const found = documents.children("gateways").filter(([, row]) => row.serviceAccountName === serviceAccountName);
        if (found.length > 1) {
          throw new DuplicateRecordError("gateway", "serviceAccountName", serviceAccountName, found.map(([id]) => id));
        }
        return found.length === 0 ? null : decodeRoot(found[0][0]);
      },
      list: async (filter = {}) =>
        documents.children("gateways").flatMap(([id]) => {
          const root = decodeRoot(id);
          if (root === null) return [];
          if (filter.gatewayClass !== undefined && root.gatewayClass !== filter.gatewayClass) return [];
          return filter.ownerUid === undefined || root.ownerUid === filter.ownerUid ? [root] : [];
        }),
      create: async (root) => {
        if (documents.get(rootPath(root.gatewayId)) !== undefined) throw new AlreadyExistsError(rootKey(root.gatewayId));
        write(() => documents.set(rootPath(root.gatewayId), withoutIdentity(root)));
      },
      patch: async (id, patch, fence) => {
        const current = presentRoot(id);
        if (fence !== undefined) assertRootFence(id, fence, current);
        updateRoot(id, patch);
      },
      compareAndSetRuntimeRestartFence: async (id, expected, next) => {
        const actual = presentRoot(id).runtimeRestartFence ?? null;
        if (!isDeepStrictEqual(expected, actual)) {
          throw new FenceMismatchError(rootKey(id), "runtimeRestartFence", expected, actual);
        }
        updateRoot(id, { runtimeRestartFence: next ?? { clear: true } });
      },
      delete: async (id, fence) => {
        if (fence !== undefined) assertRootFence(id, fence, presentRoot(id));
        write(() => {
          for (const child of ["releases", "assignments"]) {
            for (const [childId] of documents.children(`${rootPath(id)}/${child}`)) {
              documents.delete(`${rootPath(id)}/${child}/${childId}`);
            }
          }
          documents.delete(rootPath(id));
        });
      },
    }),
    releases: partialRepository<GatewayRepositories["releases"]>("gateways.releases", {
      get: async (id, release) => decodeRelease(id, release),
      list: async (id, order, limit) => {
        const releases = documents.children(`gateways/${id}/releases`)
          .map(([release]) => decodeRelease(id, Number(release))!)
          .sort((left, right) => (order === "asc" ? left.release - right.release : right.release - left.release));
        return releases.slice(0, limit);
      },
      append: async (input) => {
        const latest = presentRoot(input.gatewayId).latestRelease;
        if (latest !== input.expectedLatestRelease) {
          throw new FenceMismatchError(rootKey(input.gatewayId), "latestRelease", input.expectedLatestRelease, latest);
        }
        const release = input.expectedLatestRelease + 1;
        if (documents.get(releasePath(input.gatewayId, release)) !== undefined) {
          throw new AlreadyExistsError(releaseKey(input.gatewayId, release));
        }
        const document: GatewayRelease = {
          gatewayId: input.gatewayId,
          release,
          createdAt: input.createdAt,
          createdBy: input.createdBy,
          sourceRelease: input.sourceRelease,
          note: input.note,
          payloadHash: input.payloadHash,
          payload: input.payload,
        };
        write(() => documents.set(releasePath(input.gatewayId, release), withoutIdentity(document)));
        updateRoot(input.gatewayId, {
          latestRelease: release,
          ...(input.activate ? { desiredRelease: release } : {}),
          updatedAt: input.createdAt,
          updatedBy: input.updatedBy,
        });
        return release;
      },
      createInitial: async (release) => {
        if (documents.get(releasePath(release.gatewayId, release.release)) !== undefined) {
          throw new AlreadyExistsError(releaseKey(release.gatewayId, release.release));
        }
        write(() => documents.set(releasePath(release.gatewayId, release.release), withoutIdentity(release)));
      },
    }),
    assignments: assignmentRepository(documents, write),
    vmRuntime: vmRuntimeRepository(documents, write),
  };
}

function vmRuntimeRepository(documents: FixtureDocuments, write: Write): GatewayRepositories["vmRuntime"] {
  const key = (gatewayId: string): RecordKey => ({ aggregate: "gateway-vm-runtime", key: gatewayId });
  return partialRepository<GatewayRepositories["vmRuntime"]>("gateways.vmRuntime", {
    get: async (gatewayId) => {
      const row = documents.get(gatewayVmRuntimeDocPath(gatewayId));
      if (row === undefined) return null;
      if (!isGatewayVmRuntimeBundle(row) || row.gatewayId !== gatewayId) {
        throw new MalformedRecordError(key(gatewayId), "is not this gateway's VM runtime bundle");
      }
      return { ...structuredClone(row), revision: FIXTURE_REVISION } as unknown as Stored<GatewayVmRuntimeBundle>;
    },
    put: async (gatewayId, bundle) => {
      if (bundle.gatewayId !== gatewayId) {
        throw new MalformedRecordError(key(gatewayId), `bundle names gateway ${JSON.stringify(bundle.gatewayId)}`);
      }
      write(() => documents.set(gatewayVmRuntimeDocPath(gatewayId), withoutIdentity(bundle)));
    },
    delete: async (gatewayId) => {
      write(() => documents.delete(gatewayVmRuntimeDocPath(gatewayId)));
    },
  });
}

function assignmentRepository(documents: FixtureDocuments, write: Write): GatewayRepositories["assignments"] {
  const path = (gatewayId: string, uid: string) => `gateways/${gatewayId}/assignments/${uid}`;
  const key = (gatewayId: string, uid: string): RecordKey => ({ aggregate: "gateway-assignment", key: `${gatewayId}/${uid}` });
  const decodeAssignment = (gatewayId: string, uid: string): Stored<GatewayAssignment> | null => {
    const row = documents.get(path(gatewayId, uid));
    if (row === undefined) return null;
    return { ...decodeGatewayAssignmentData(gatewayId, uid, structuredClone(row)), revision: FIXTURE_REVISION };
  };
  const assertFence = (gatewayId: string, uid: string, fence: GatewayAssignmentFence | undefined): void => {
    const current = decodeAssignment(gatewayId, uid);
    if (current === null) throw new MissingRecordError(key(gatewayId, uid));
    if (fence === undefined) return;
    assertFenceEquals(key(gatewayId, uid), "epoch", fence.epoch, current.epoch);
    assertFenceEquals(key(gatewayId, uid), "updatedAt", fence.updatedAt, current.updatedAt);
    assertFenceOneOf(key(gatewayId, uid), "status", fence.state, current.state);
  };
  const listAll = () =>
    documents.group("assignments").flatMap(([assignmentPath]) => {
      const [collection, gatewayId, , uid] = assignmentPath.split("/");
      return collection === "gateways" ? [decodeAssignment(gatewayId, uid)!] : [];
    });
  return partialRepository<GatewayRepositories["assignments"]>("gateways.assignments", {
    get: async (gatewayId, uid) => decodeAssignment(gatewayId, uid),
    list: async (gatewayId, limit) =>
      documents.children(`gateways/${gatewayId}/assignments`)
        .map(([uid]) => decodeAssignment(gatewayId, uid)!)
        .slice(0, limit),
    isEmpty: async (gatewayId) => documents.children(`gateways/${gatewayId}/assignments`).length === 0,
    findBySlug: async (gatewayId, slug) => {
      const found = documents.children(`gateways/${gatewayId}/assignments`)
        .map(([uid]) => decodeAssignment(gatewayId, uid)!)
        .filter((assignment) => assignment.slug === slug);
      if (found.length > 1) {
        throw new DuplicateRecordError("gateway-assignment", "slug", slug, found.map((assignment) => `${gatewayId}/${assignment.uid}`));
      }
      return found[0] ?? null;
    },
    listAll: async () => listAll(),
    listForUid: async (uid) => listAll().filter((assignment) => assignment.uid === uid),
    create: async (assignment) => {
      const assignmentPath = path(assignment.gatewayId, assignment.uid);
      if (documents.get(assignmentPath) !== undefined) throw new AlreadyExistsError(key(assignment.gatewayId, assignment.uid));
      write(() => {
        if (documents.get(assignmentPath) !== undefined) throw new AlreadyExistsError(key(assignment.gatewayId, assignment.uid));
        documents.set(assignmentPath, withoutIdentity(assignment));
      });
    },
    put: async (assignment) => {
      write(() => documents.set(path(assignment.gatewayId, assignment.uid), withoutIdentity(assignment)));
    },
    patch: async (gatewayId, uid, patch, fence) => {
      assertFence(gatewayId, uid, fence);
      write(() => {
        const latest = documents.get(path(gatewayId, uid));
        if (latest === undefined) throw new MissingRecordError(key(gatewayId, uid));
        documents.set(path(gatewayId, uid), applyPatch(latest, structuredClone(patch)));
      });
    },
    delete: async (gatewayId, uid, fence) => {
      if (fence !== undefined) assertFence(gatewayId, uid, fence);
      write(() => documents.delete(path(gatewayId, uid)));
    },
  });
}

function withDottedFields(row: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(row);
  for (const [path, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const segments = path.split(".");
    let cursor = next;
    for (const segment of segments.slice(0, -1)) {
      if (!isMap(cursor[segment])) cursor[segment] = {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    const field = segments[segments.length - 1];
    if (isClear(value)) delete cursor[field];
    else cursor[field] = isServerNow(value) ? Date.now() : structuredClone(value);
  }
  return next;
}

function isServerNow(value: unknown): boolean {
  return isMap(value) && Object.keys(value).length === 1 && value.serverNow === true;
}

function fixturePage<T>(items: readonly T[], idOf: (item: T) => string, page: PageRequest, missing: (id: string) => Error): Page<T> {
  const start = page.after === undefined ? 0 : items.findIndex((item) => idOf(item) === page.after) + 1;
  if (page.after !== undefined && start === 0) throw missing(page.after);
  const pageItems = items.slice(start, start + page.limit);
  return { items: pageItems, next: start + page.limit < items.length ? idOf(pageItems[pageItems.length - 1]) : null };
}

function fixtureUserRecord(documents: FixtureDocuments, uid: string, row: Record<string, unknown>): Stored<PlatformUserRecord> {
  const role = userRoleFromData(uid, documents.get(`users/${uid}/system/config`));
  return { ...userRecordFromData(uid, structuredClone(row), 0, role), revision: FIXTURE_REVISION };
}

function userRecordRepository(
  documents: FixtureDocuments,
  write: Write,
  transactional: boolean,
): Partial<UserRepositories["records"]> {
  const path = (uid: string) => `users/${uid}`;
  const key = (uid: string): RecordKey => ({ aggregate: "builder", key: uid });
  const decodeRecord = (uid: string): Stored<PlatformUserRecord> | null => {
    const row = documents.get(path(uid));
    return row === undefined ? null : fixtureUserRecord(documents, uid, row);
  };
  const present = (uid: string): Stored<PlatformUserRecord> => {
    const record = decodeRecord(uid);
    if (record === null) throw new MissingRecordError(key(uid));
    return record;
  };
  const mismatch = (uid: string, field: string, expected: unknown, actual: unknown) => new FenceMismatchError(
    key(uid),
    expected === null || expected === undefined ? "absent" : "present",
    { [field]: expected },
    { [field]: actual },
  );
  const update = (uid: string, fields: Record<string, unknown>) => write(() => {
    const latest = documents.get(path(uid));
    if (latest === undefined) throw new MissingRecordError(key(uid));
    documents.set(path(uid), withDottedFields(latest, fields));
  });
  const assertUserFence = (uid: string, current: Stored<PlatformUserRecord>, fence: UserFence | undefined) => {
    if (fence?.gatewayId !== undefined && fence.gatewayId !== (current.gateway?.gatewayId ?? null)) {
      throw mismatch(uid, "gatewayId", fence.gatewayId, current.gateway?.gatewayId ?? null);
    }
    const status = current.provisioning.status ?? "absent";
    if (fence?.provisioningStatus !== undefined && fence.provisioningStatus !== status) {
      throw mismatch(uid, "provisioningStatus", fence.provisioningStatus, status);
    }
  };
  const assertLeaseFence = (uid: string, current: Stored<PlatformUserRecord>, fence: ActivationLeaseFence) => {
    const lease = current.activationLease;
    assertFenceEquals(key(uid), "leaseId", fence.leaseId, lease?.leaseId ?? null);
    assertFenceEquals(key(uid), "generation", fence.generation, lease?.generation ?? null);
    assertFenceOneOf(key(uid), "status", fence.status, lease?.status);
  };
  const all = () => documents.children("users").map(([uid]) => present(uid));
  return {
    get: async (uid) => decodeRecord(uid),
    getMany: async (uids) => new Map(uids.flatMap((uid) => {
      const record = decodeRecord(uid);
      return record === null ? [] : [[uid, record] as const];
    })),
    listAll: async () => all(),
    listAdmitted: async () => all()
      .filter((record) => record.admitted)
      .sort((a, b) => a.uid.localeCompare(b.uid)),
    list: async (page) => fixturePage(
      all().sort((a, b) =>
        Number(a.createdAt === null) - Number(b.createdAt === null) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
        b.uid.localeCompare(a.uid)),
      (record) => record.uid,
      page,
      (uid) => new MissingRecordError(key(uid)),
    ),
    listByGateway: async (gatewayId, filter = {}) => all()
      .filter((record) => record.gateway?.gatewayId === gatewayId &&
        (filter.openclawStatus === undefined || record.openclaw.status === filter.openclawStatus))
      .slice(0, filter.limit),
    listByAgentId: async (agentId, limit) => {
      const byAgentId = all().filter((record) => record.openclaw.agentId === agentId).slice(0, limit);
      const byRoster = all().filter((record) => record.agents.agentIds.includes(agentId)).slice(0, limit);
      return [...new Map([...byAgentId, ...byRoster].map((record) => [record.uid, record])).values()];
    },
    create: async (record) => {
      write(() => documents.set(path(record.uid), {
        ...documents.get(path(record.uid)),
        createdAt: resolveServerNow(record.createdAt),
      }));
    },
    admit: async (uid, input) => {
      const path = `users/${uid}`;
      const row = documents.get(path);
      const current = row === undefined ? null : fixtureUserRecord(documents, uid, row);
      const fence = (field: string, expected: unknown, actual: unknown) =>
        new FenceMismatchError({ aggregate: "builder", key: uid }, "absent", { [field]: expected }, { [field]: actual });
      if (current?.provisioning.status !== undefined) throw fence("provisioningStatus", null, current.provisioning.status);
      if (current !== null && current.slug !== null && current.slug !== input.slug) throw fence("slug", input.slug, current.slug);
      const persona = input.persona as { vibe?: unknown; timeZone?: unknown } | null;
      write(() => documents.set(path, withDottedFields(row ?? {}, {
        createdAt: row?.createdAt ?? resolveServerNow(input.createdAt),
        onboardingStep: ADMITTED_STEP,
        [SLUG_PATH]: current?.slug ?? input.slug,
        ...(persona?.vibe === undefined ? {} : { "onboarding.vibe": persona.vibe }),
        ...(persona?.timeZone === undefined ? {} : { "preferences.timeZone": persona.timeZone }),
        "provisioning.status": "in_progress",
        "provisioning.startedAt": resolveServerNow(input.provisioningStartedAt),
      })));
    },
    delete: async (uid) => {
      assertOutsideTransaction(transactional, "builders.records.delete");
      write(() => deleteTree(documents, path(uid)));
    },
    findBySlug: async (slug) => {
      const found = all().filter((record) => record.slug === slug);
      if (found.length > 1) throw new DuplicateRecordError("builder", "slug", slug, found.map((record) => record.uid));
      return found[0] ?? null;
    },
    findByMattermostUserId: async (mattermostUserId) => {
      const found = all().filter((record) => record.mattermostUserId === mattermostUserId);
      if (found.length > 1) {
        throw new DuplicateRecordError("builder", "mattermostUserId", mattermostUserId, found.map((record) => record.uid));
      }
      return found[0] ?? null;
    },
    addAgents: async (uid, agentIds) => {
      if (agentIds.length === 0) return;
      const current = present(uid).agents.agentIds;
      update(uid, { "provisioning.openclaw.agentIds": [...new Set([...current, ...agentIds])] });
    },
    removeAgents: async (uid, agentIds) => {
      const current = present(uid).agents.agentIds;
      update(uid, { "provisioning.openclaw.agentIds": current.filter((agentId) => !agentIds.includes(agentId)) });
    },
    setActivatedAgents: async (uid, activatedAgents) => {
      update(uid, { [ACTIVATED_AGENTS_PATH]: [...activatedAgents] });
    },
    findByVmInstanceId: async (instanceId) => {
      const found = documents.children("users")
        .filter(([, row]) => valueAt(row, ["provisioning", "computer", "instanceId"]) === instanceId)
        .map(([uid]) => present(uid));
      if (found.length > 1) {
        throw new DuplicateRecordError("builder", "vmInstanceId", instanceId, found.map((record) => record.uid));
      }
      return found[0] ?? null;
    },
    patch: async (uid, patch, fence) => {
      assertUserFence(uid, present(uid), fence);
      update(uid, userPatchPaths(patch));
      if (patch.role !== undefined) {
        const configPath = `users/${uid}/system/config`;
        write(() => documents.set(configPath, isClear(patch.role)
          ? Object.fromEntries(Object.entries(documents.get(configPath) ?? {}).filter(([field]) => field !== "role"))
          : { ...documents.get(configPath), role: patch.role }));
      }
    },
    setActivationLease: async (uid, lease, fence) => {
      assertLeaseFence(uid, present(uid), fence);
      update(uid, { [USER_ACTIVATION_LEASE_PATH]: lease });
    },
    setFence: async (uid, name, value, expected) => {
      const current = present(uid);
      if (expected !== undefined) {
        const actual = current.fences[name];
        const wanted = expected === "absent" ? undefined : expected;
        if (!isDeepStrictEqual(actual, wanted)) throw mismatch(uid, name, wanted ?? null, actual ?? null);
      }
      update(uid, { [USER_FENCE_PATHS[name]]: value });
    },
    setGatewayMirror: async (uid, mirror, fence) => {
      const current = present(uid);
      if (fence?.gatewayId !== undefined && fence.gatewayId !== (current.gateway?.gatewayId ?? null)) {
        throw mismatch(uid, "gatewayId", fence.gatewayId, current.gateway?.gatewayId ?? null);
      }
      const paths: Readonly<Record<string, string>> = USER_MIRROR_PATHS;
      update(uid, isClear(mirror)
        ? Object.fromEntries(Object.values(paths).map((field) => [field, mirror]))
        : Object.fromEntries(Object.entries(mirror).map(([field, value]) => [paths[field], value])));
    },
    patchActivationLease: async (uid, patch, fence) => {
      const lease = present(uid).activationLease;
      assertFenceEquals(key(uid), "leaseId", fence.leaseId, lease?.leaseId ?? null);
      assertFenceEquals(key(uid), "generation", fence.generation, lease?.generation ?? null);
      assertFenceOneOf(key(uid), "status", fence.status, lease?.status);
      if (lease === null) throw mismatch(uid, "activationLease", "present", null);
      update(uid, Object.fromEntries(Object.entries(patch).map(([field, value]) => [`${USER_ACTIVATION_LEASE_PATH}.${field}`, value])));
    },
  };
}

function fixtureAgentStoreRow(record: AgentStoreRecord): Record<string, unknown> {
  const common = {
    storeId: record.storeId,
    schema: record.schema,
    ...(record.gatewayId === null ? {} : { gatewayId: record.gatewayId }),
    ...(record.generation === null ? {} : { generation: record.generation }),
    ...(record.assignmentEpoch === null ? {} : { assignmentEpoch: record.assignmentEpoch }),
    recordedAt: record.recordedAt,
  };
  if (record.kind === "gateway-state") return { kind: "gateway-state", ...common };
  if (record.kind === "auxiliary") return { kind: "gateway-auxiliary", family: record.family, ...common };
  return { agentId: record.agentId, ...common };
}

function valueAt(row: Record<string, unknown>, path: readonly string[]): unknown {
  return path.reduce<unknown>((value, segment) => (isMap(value) ? value[segment] : undefined), row);
}

function userRepositories(documents: FixtureDocuments, write: Write, transactional: boolean): UserRepositories {
  const holding = (path: readonly string[], gatewayId: string) =>
    documents.children("users").flatMap(([uid, row]) =>
      valueAt(row, path) === gatewayId ? [fixtureUserRecord(documents, uid, row)] : []);
  const records = partialRepository<UserRepositories["records"]>("users.records", {
    ...userRecordRepository(documents, write, transactional),
    getRole: async (uid) => {
      const config = documents.get(`users/${uid}/system/config`);
      return config === undefined ? null : userRoleFromData(uid, structuredClone(config));
    },
    listGatewayFenceHolders: async (gatewayId): Promise<GatewayFenceHolders> => ({
      assigned: holding(["provisioning", "openclaw", "gatewayId"], gatewayId),
      sourceTransferSource: holding(["provisioning", "openclaw", "sourceTransferFence", "sourceGatewayId"], gatewayId),
      sourceTransferTarget: holding(["provisioning", "openclaw", "sourceTransferFence", "targetGatewayId"], gatewayId),
      computerRecovery: holding(["provisioning", "computerRecovery", "gatewayId"], gatewayId),
    }),
  });
  const receiptPath = (uid: string, receiptId: string) => `users/${uid}/placement_receipts/${receiptId}`;
  const placementReceipts = partialRepository<UserRepositories["placementReceipts"]>("users.placementReceipts", {
    get: async (uid, leaseId, generation, kind) => {
      const row = documents.get(receiptPath(uid, placementReceiptDocId(leaseId, generation, kind)));
      return row === undefined ? null : structuredClone(row) as unknown as PlacementReceipt;
    },
    create: async (uid, receipt) => {
      const receiptId = placementReceiptDocId(receipt.leaseId, receipt.generation, receipt.kind);
      if (documents.get(receiptPath(uid, receiptId)) !== undefined) {
        throw new AlreadyExistsError({ aggregate: "placement-receipt", key: `${uid}/${receiptId}` });
      }
      write(() => documents.set(receiptPath(uid, receiptId), structuredClone(receipt) as unknown as Record<string, unknown>));
    },
    list: async (uid, page) => fixturePage(
      documents.children(`users/${uid}/placement_receipts`)
        .map(([, row]) => structuredClone(row) as unknown as PlacementReceipt)
        .sort((a, b) => b.at - a.at),
      (receipt) => placementReceiptDocId(receipt.leaseId, receipt.generation, receipt.kind),
      page,
      (receiptId) => new MissingRecordError({ aggregate: "placement-receipt", key: `${uid}/${receiptId}` }),
    ),
  });
  const agentStores = partialRepository<UserRepositories["agentStores"]>("users.agentStores", {
    list: async (uid) => documents.children(`users/${uid}/agentStores`).map(([storeKey, row]) => ({
      ...agentStoreFromData(uid, storeKey, structuredClone(row)),
      revision: FIXTURE_REVISION,
    })),
    put: async (uid, record) => {
      const storeKey = agentStoreKeyOf(record);
      write(() => documents.set(`users/${uid}/agentStores/${storeKey}`, fixtureAgentStoreRow(record)));
    },
    delete: async (uid, storeKey) => {
      write(() => documents.delete(`users/${uid}/agentStores/${storeKey}`));
    },
  });
  const account = (uid: string, row: Record<string, unknown> | undefined): Stored<UserAccountRecord> | null => {
    if (row === undefined || typeof row.username !== "string") return null;
    const created = row.createdAt as { toMillis?: () => number } | number | undefined;
    const createdAt = typeof created === "number" ? created : created?.toMillis?.() ?? 0;
    const email = typeof row.email === "string" ? row.email : "";
    return { uid, name: row.username, email, createdAt, revision: FIXTURE_REVISION };
  };
  const accounts = partialRepository<UserRepositories["accounts"]>("users.accounts", {
    get: async (uid) => account(uid, documents.get(`users/${uid}`)),
    getMany: async (uids) => new Map(uids.flatMap((uid) => {
      const stored = account(uid, documents.get(`users/${uid}`));
      return stored === null ? [] : [[uid, stored] as const];
    })),
    listAll: async () => documents.children("users").flatMap(([uid, row]) => {
      const stored = account(uid, row);
      return stored === null ? [] : [stored];
    }),
  });
  const transferPath = (uid: string, migrationId: string) => `users/${uid}/${SCHEDULE_TRANSFERS_SUBCOLLECTION}/${migrationId}`;
  const storedTransfer = (row: Record<string, unknown>) =>
    ({ ...structuredClone(row), revision: FIXTURE_REVISION }) as unknown as Stored<ScheduleTransferDoc>;
  const scheduleTransfers = partialRepository<UserRepositories["scheduleTransfers"]>("users.scheduleTransfers", {
    get: async (uid, migrationId) => {
      const row = documents.get(transferPath(uid, migrationId));
      return row === undefined ? null : storedTransfer(row);
    },
    patch: async (uid, migrationId, patch) => {
      const path = transferPath(uid, migrationId);
      const row = documents.get(path);
      if (row === undefined) throw new MissingRecordError({ aggregate: "schedule-transfer", key: `${uid}/${migrationId}` });
      write(() => documents.set(path, applyPatch(row, structuredClone(patch))));
    },
    listUnrestored: async () => documents.group(SCHEDULE_TRANSFERS_SUBCOLLECTION)
      .flatMap(([path, row]) => (row.restoredTo === undefined ? [{ uid: path.split("/")[1], transfer: storedTransfer(row) }] : []))
      .sort((a, b) => a.transfer.snapshotAt - b.transfer.snapshotAt || a.uid.localeCompare(b.uid) ||
        a.transfer.migrationId.localeCompare(b.transfer.migrationId)),
  });
  return partialRepository<UserRepositories>("builders", { records, accounts, placementReceipts, scheduleTransfers, agentStores });
}

function workspaceChannelLocation(path: string): { scope: { workspaceSlug: string; projectSlug: string | null }; channelId: string } | null {
  const parts = path.split("/");
  if (parts[0] !== "workspaces") return null;
  if (parts.length === 4 && parts[2] === "channels") return { scope: { workspaceSlug: parts[1], projectSlug: null }, channelId: parts[3] };
  if (parts.length === 6 && parts[2] === "projects" && parts[4] === "channels") {
    return { scope: { workspaceSlug: parts[1], projectSlug: parts[3] }, channelId: parts[5] };
  }
  return null;
}

const WORKSPACE_STORED_PATHS: Readonly<Record<string, string>> = {
  mattermostTeamId: "mattermost.teamId",
  giteaOrgName: "gitea.orgName",
  giteaRepoName: "gitea.repoName",
};

const PROJECT_STORED_PATHS: Readonly<Record<string, string>> = {
  commercialLifecycleStatus: "commercialLifecycle.status",
};

function storedPatchFields(patch: object, paths: Readonly<Record<string, string>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).map(([field, value]) => [paths[field] ?? field, value]));
}

function presentFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined));
}

function projectMemberRepository(
  documents: FixtureDocuments,
  write: Write,
  mergeDocument: (path: string, fields: Record<string, unknown>) => void,
): WorkspaceRepositories["projectMembers"] {
  const membersPath = (workspaceSlug: string, projectSlug: string) => `workspaces/${workspaceSlug}/projects/${projectSlug}/members`;
  const decode = (workspaceSlug: string, projectSlug: string, uid: string, row: Record<string, unknown>) =>
    ({ ...workspaceProjectMemberFromData(workspaceSlug, projectSlug, uid, structuredClone(row)), revision: FIXTURE_REVISION });
  return partialRepository<WorkspaceRepositories["projectMembers"]>("workspaces.projectMembers", {
    get: async (workspaceSlug, projectSlug, uid) => {
      const row = documents.get(`${membersPath(workspaceSlug, projectSlug)}/${uid}`);
      return row === undefined ? null : decode(workspaceSlug, projectSlug, uid, row);
    },
    list: async (workspaceSlug, projectSlug) => documents.children(membersPath(workspaceSlug, projectSlug))
      .map(([uid, row]) => decode(workspaceSlug, projectSlug, uid, row)),
    listForUid: async (uid) => documents.group("members").flatMap(([path, row]) => {
      const parts = path.split("/");
      return parts[0] === "workspaces" && parts.length === 6 && parts[2] === "projects" && row.id === uid
        ? [decode(parts[1], parts[3], parts[5], row)]
        : [];
    }),
    put: async (input) => mergeDocument(`${membersPath(input.workspaceSlug, input.projectSlug)}/${input.uid}`, {
      id: input.uid,
      role: input.role,
      joinedAt: input.joinedAt,
    }),
    delete: async (workspaceSlug, projectSlug, uid) => {
      write(() => documents.delete(`${membersPath(workspaceSlug, projectSlug)}/${uid}`));
    },
  });
}

function workspaceRepositories(documents: FixtureDocuments, write: Write, transactional: boolean): WorkspaceRepositories {
  const channelsPath = (workspaceSlug: string, projectSlug: string | null) =>
    projectSlug === null ? `workspaces/${workspaceSlug}/channels` : `workspaces/${workspaceSlug}/projects/${projectSlug}/channels`;
  const channel = (scope: { workspaceSlug: string; projectSlug: string | null }, channelId: string, row: Record<string, unknown>) =>
    ({ ...workspaceChannelFromData(scope, channelId, structuredClone(row)), revision: FIXTURE_REVISION });
  const workspacePath = (slug: string) => `workspaces/${slug}`;
  const projectPath = (workspaceSlug: string, projectSlug: string) => `workspaces/${workspaceSlug}/projects/${projectSlug}`;
  const decodeWorkspace = (slug: string, row: Record<string, unknown>) =>
    ({ ...workspaceRecordFromData(slug, structuredClone(row)), revision: FIXTURE_REVISION });
  const decodeProject = (workspaceSlug: string, projectSlug: string, row: Record<string, unknown>) =>
    ({ ...workspaceProjectFromData(workspaceSlug, projectSlug, structuredClone(row)), revision: FIXTURE_REVISION });
  const member = (workspaceSlug: string, uid: string, row: Record<string, unknown>) =>
    ({ ...workspaceMemberFromData(workspaceSlug, uid, structuredClone(row)), revision: FIXTURE_REVISION });
  const updatePresent = (path: string, key: RecordKey, fields: Record<string, unknown>) => {
    if (documents.get(path) === undefined) throw new MissingRecordError(key);
    write(() => {
      const latest = documents.get(path);
      if (latest === undefined) throw new MissingRecordError(key);
      documents.set(path, withDottedFields(latest, fields));
    });
  };
  const mergeDocument = (path: string, fields: Record<string, unknown>) => write(() => {
    documents.set(path, withDottedFields(documents.get(path) ?? {}, resolveServerNow(presentFields(fields)) as Record<string, unknown>));
  });
  const workspaceProjects = () => documents.group("projects").flatMap(([path, row]) => {
    const [collection, workspaceSlug, , projectSlug] = path.split("/");
    return collection === "workspaces" && path.split("/").length === 4 ? [decodeProject(workspaceSlug, projectSlug, row)] : [];
  });
  return partialRepository<WorkspaceRepositories>("workspaces", {
    records: partialRepository<WorkspaceRepositories["records"]>("workspaces.records", {
      get: async (slug) => {
        const row = documents.get(workspacePath(slug));
        return row === undefined || isWorkspaceReservation(row) ? null : decodeWorkspace(slug, row);
      },
      listByOwner: async (ownerUid) => documents.children("workspaces").flatMap(([slug, row]) =>
        row.ownerUid === ownerUid ? [decodeWorkspace(slug, row)] : []),
      findByMattermostTeamId: async (mattermostTeamId) => {
        const found = documents.children("workspaces")
          .filter(([, row]) => valueAt(row, ["mattermost", "teamId"]) === mattermostTeamId);
        if (found.length > 1) {
          throw new DuplicateRecordError("workspace", "mattermostTeamId", mattermostTeamId, found.map(([slug]) => slug));
        }
        return found.length === 0 ? null : decodeWorkspace(found[0][0], found[0][1]);
      },
      put: async (input) => mergeDocument(workspacePath(input.slug), {
        id: input.id,
        slug: input.slug,
        ownerUid: input.ownerUid,
        ownerActive: input.ownerActive,
        "mattermost.teamId": input.mattermostTeamId,
        "gitea.orgName": input.giteaOrgName,
        "gitea.repoName": input.giteaRepoName,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      }),
      patch: async (slug, patch) =>
        updatePresent(workspacePath(slug), { aggregate: "workspace", key: slug }, resolveServerNow(storedPatchFields(patch, WORKSPACE_STORED_PATHS)) as Record<string, unknown>),
      delete: async (slug) => {
        assertOutsideTransaction(transactional, "workspaces.records.delete");
        write(() => deleteTree(documents, workspacePath(slug)));
      },
    }),
    members: partialRepository<WorkspaceRepositories["members"]>("workspaces.members", {
      get: async (workspaceSlug, uid) => {
        const row = documents.get(`workspaces/${workspaceSlug}/members/${uid}`);
        return row === undefined ? null : member(workspaceSlug, uid, row);
      },
      list: async (workspaceSlug) => documents.children(`workspaces/${workspaceSlug}/members`)
        .map(([uid, row]) => member(workspaceSlug, uid, row)),
      listForUid: async (uid) => documents.group("members").flatMap(([path, row]) => {
        const [collection, workspaceSlug, , memberUid] = path.split("/");
        return collection === "workspaces" && path.split("/").length === 4 && row.id === uid
          ? [member(workspaceSlug, memberUid, row)]
          : [];
      }),
      put: async (input) => mergeDocument(`workspaces/${input.workspaceSlug}/members/${input.uid}`, {
        id: input.uid,
        role: input.role,
        joinedAt: input.joinedAt,
        mattermostUserId: input.mattermostUserId,
        mattermostChannelId: input.mattermostChannelId,
        canonicalSource: input.canonicalSource,
        canonicalState: input.canonicalState,
      }),
      delete: async (workspaceSlug, uid) => {
        write(() => documents.delete(`workspaces/${workspaceSlug}/members/${uid}`));
      },
    }),
    projects: partialRepository<WorkspaceRepositories["projects"]>("workspaces.projects", {
      get: async (workspaceSlug, projectSlug) => {
        const row = documents.get(projectPath(workspaceSlug, projectSlug));
        return row === undefined ? null : decodeProject(workspaceSlug, projectSlug, row);
      },
      list: async (workspaceSlug) => documents.children(`workspaces/${workspaceSlug}/projects`)
        .map(([projectSlug, row]) => decodeProject(workspaceSlug, projectSlug, row)),
      listByOwner: async (ownerUid, workspaceSlug) => workspaceProjects().filter((project) =>
        project.ownerUid === ownerUid && (workspaceSlug === undefined || project.workspaceSlug === workspaceSlug)),
      listAll: async () => workspaceProjects(),
      put: async (input) => mergeDocument(projectPath(input.workspaceSlug, input.projectSlug), {
        id: input.projectSlug,
        slug: input.projectSlug,
        workspaceId: input.workspaceSlug,
        ownerUid: input.ownerUid,
        ownerActive: input.ownerActive,
        giteaRepoName: input.giteaRepoName,
        provisioningState: input.provisioningState,
        provisioningError: input.provisioningError,
        provisioningCleanup: input.provisioningCleanup,
        pendingVisibility: input.pendingVisibility,
        visibility: input.visibility,
        checkoutEnabled: input.checkoutEnabled,
        status: input.status,
        archived: input.archived,
        archivedAt: input.archivedAt,
        "commercialLifecycle.status": input.commercialLifecycleStatus,
        repoSource: input.repoSource,
        agent: input.agent,
        updatedAt: input.updatedAt,
      }),
      delete: async (workspaceSlug, projectSlug) => {
        write(() => documents.delete(projectPath(workspaceSlug, projectSlug)));
      },
      patch: async (workspaceSlug, projectSlug, patch, fence) => {
        const key: RecordKey = { aggregate: "workspace-project", key: `${workspaceSlug}/${projectSlug}` };
        if (documents.get(projectPath(workspaceSlug, projectSlug)) === undefined) throw new MissingRecordError(key);
        if (fence?.revision !== undefined && fence.revision !== FIXTURE_REVISION) {
          throw new FenceMismatchError(key, "revision", fence.revision, FIXTURE_REVISION);
        }
        updatePresent(projectPath(workspaceSlug, projectSlug), key,
          resolveServerNow(storedPatchFields(patch, PROJECT_STORED_PATHS)) as Record<string, unknown>);
      },
    }),
    projectMembers: projectMemberRepository(documents, write, mergeDocument),
    agentIdentities: partialRepository<WorkspaceRepositories["agentIdentities"]>("workspaces.agentIdentities", {
      get: async (uid) => {
        const row = documents.get(`agents/${uid}`);
        return row === undefined ? null : { ...agentIdentityFromData(uid, structuredClone(row)), revision: FIXTURE_REVISION };
      },
      put: async (identity) => mergeDocument(`agents/${identity.uid}`, {
        id: identity.uid,
        "mattermost.userId": identity.mattermostUserId,
        createdAt: identity.at,
        updatedAt: identity.at,
      }),
      delete: async (uid) => {
        write(() => documents.delete(`agents/${uid}`));
      },
    }),
    channels: partialRepository<WorkspaceRepositories["channels"]>("workspaces.channels", {
      get: async (scope, channelId) => {
        const row = documents.get(`${channelsPath(scope.workspaceSlug, scope.projectSlug)}/${channelId}`);
        return row === undefined ? null : channel(scope, channelId, row);
      },
      list: async (scope) => documents.children(channelsPath(scope.workspaceSlug, scope.projectSlug))
        .map(([channelId, row]) => channel(scope, channelId, row)),
      findByMattermostChannelId: async (mattermostChannelId) => {
        const found = documents.group("channels")
          .filter(([, row]) => valueAt(row, ["mattermost", "channelId"]) === mattermostChannelId);
        if (found.length > 1) {
          throw new DuplicateRecordError("workspace-channel", "mattermostChannelId", mattermostChannelId, found.map(([path]) => path));
        }
        const location = found.length === 0 ? null : workspaceChannelLocation(found[0][0]);
        return location === null ? null : channel(location.scope, location.channelId, found[0][1]);
      },
      put: async (input) => mergeDocument(`${channelsPath(input.scope.workspaceSlug, input.scope.projectSlug)}/${input.channelId}`, {
        id: input.channelId,
        kind: input.kind,
        "mattermost.channelId": input.mattermostChannelId,
        archivedAt: input.archivedAt,
        createdBy: input.createdBy,
        createdAt: input.createdAt,
      }),
      delete: async (scope, channelId) => {
        write(() => documents.delete(`${channelsPath(scope.workspaceSlug, scope.projectSlug)}/${channelId}`));
      },
      patch: async (scope, channelId, patch) => {
        const { mattermostChannelId, ...fields } = patch;
        const key: RecordKey = {
          aggregate: "workspace-channel",
          key: scope.projectSlug === null ? `${scope.workspaceSlug}/${channelId}` : `${scope.workspaceSlug}/${scope.projectSlug}/${channelId}`,
        };
        updatePresent(`${channelsPath(scope.workspaceSlug, scope.projectSlug)}/${channelId}`, key,
          resolveServerNow({ ...fields, "mattermost.channelId": mattermostChannelId }) as Record<string, unknown>);
      },
    }),
    activityReceipts: activityReceiptRepository(documents, write, channelsPath),
  });
}

function activityReceiptRepository(
  documents: FixtureDocuments,
  write: Write,
  channelsPath: (workspaceSlug: string, projectSlug: string | null) => string,
): WorkspaceRepositories["activityReceipts"] {
  const channelPath = (key: { scope: WorkspaceChannelScope; channelId: string }) =>
    `${channelsPath(key.scope.workspaceSlug, key.scope.projectSlug)}/${key.channelId}`;
  const receiptPath = (key: ActivityReceiptKey) => `${channelPath(key)}/activityWriteReceipts/${key.receiptId}`;
  return partialRepository<WorkspaceRepositories["activityReceipts"]>("workspaces.activityReceipts", {
    get: async (key) => {
      const row = documents.get(receiptPath(key));
      return row === undefined
        ? null
        : { scope: key.scope, channelId: key.channelId, receiptId: key.receiptId, receipt: structuredClone(row), revision: FIXTURE_REVISION };
    },
    put: async (receipt) => {
      if (documents.get(channelPath(receipt)) === undefined) {
        const { workspaceSlug, projectSlug } = receipt.scope;
        throw new MissingRecordError({
          aggregate: "workspace-channel",
          key: projectSlug === null ? `${workspaceSlug}/${receipt.channelId}` : `${workspaceSlug}/${projectSlug}/${receipt.channelId}`,
        });
      }
      write(() => documents.set(receiptPath(receipt), structuredClone(receipt.receipt) as Record<string, unknown>));
    },
  });
}

function assertNoReservedGrantKeys(operation: string, grant: object, reserved: readonly string[]): void {
  const collisions = Object.keys(grant).filter((key) => reserved.includes(key));
  if (collisions.length > 0) throw new TypeError(`${operation}: ${collisions.join(", ")} are typed fields and cannot appear in the opaque map`);
}

function accessRepositories(documents: FixtureDocuments, write: Write): AccessRepositories {
  const gatewayTicketPath = (ticketId: string) => `gatewayTickets/${ticketId}`;
  const controlTicketPath = (ticketHash: string) => `openclawControlTickets/${ticketHash}`;
  const controlSessionPath = (sessionHash: string) => `openclawControlSessions/${sessionHash}`;
  const modelBrokerTokenPath = (tokenHash: string) => `${MODEL_BROKER_TOKENS_COLLECTION}/${tokenHash}`;
  const modelBrokerPointerPath = (pointerKey: string) => `${MODEL_BROKER_GATEWAY_POINTERS_COLLECTION}/${pointerKey}`;
  const withRevision = <T>(record: T): Stored<T> => ({ ...record, revision: FIXTURE_REVISION });
  const getGatewayTicket = (ticketId: string) => {
    const row = documents.get(gatewayTicketPath(ticketId));
    return row === undefined ? null : withRevision(gatewayTicketFromData(ticketId, structuredClone(row)));
  };
  const getControlTicket = (ticketHash: string) => {
    const row = documents.get(controlTicketPath(ticketHash));
    return row === undefined ? null : withRevision(controlTicketFromData(ticketHash, structuredClone(row)));
  };
  const uidReferences = (uid: string) => [
    ["gatewayTickets", ["uid"]],
    ["gatewayTicketMintLog", ["uid"]],
    ["openclawControlTickets", ["uid"]],
    ["openclawControlSessions", ["uid"]],
    ["gatewayAccessAudit", ["ownerUid", "actorUid", "granteeUid"]],
  ].flatMap(([collection, fields]) => documents.children(collection as string)
    .filter(([, row]) => (fields as string[]).some((field) => row[field] === uid))
    .map(([id]) => `${collection as string}/${id}`));
  return partialRepository<AccessRepositories>("access", {
    listRecordsForUid: async (uid) => uidReferences(uid),
    eraseForUid: async (uid) => {
      write(() => { for (const path of uidReferences(uid)) documents.delete(path); });
    },
    gatewayTickets: partialRepository<AccessRepositories["gatewayTickets"]>("access.gatewayTickets", {
      get: async (ticketId) => getGatewayTicket(ticketId),
      create: async (ticket) => {
        assertNoReservedGrantKeys("access.gatewayTickets.create", ticket.grant, GATEWAY_TICKET_FIELDS);
        const key: RecordKey = { aggregate: "gateway-ticket", key: ticket.ticketId };
        if (documents.get(gatewayTicketPath(ticket.ticketId)) !== undefined) throw new AlreadyExistsError(key);
        write(() => documents.set(gatewayTicketPath(ticket.ticketId), {
          ...structuredClone(ticket.grant),
          uid: ticket.uid,
          gatewayId: ticket.gatewayId,
          expiresAt: ticket.expiresAt,
          expireAt: ticket.expiresAt,
        }));
      },
      countLive: async (uid, purpose, now) => documents.children("gatewayTickets")
        .filter(([, row]) => row.uid === uid && row.purpose === purpose && (row.expiresAt as number) > now).length,
      countMintsSince: async (uid, purpose, since) => documents.children("gatewayTicketMintLog")
        .filter(([, row]) => row.uid === uid && row.purpose === purpose && (row.mintedAt as number) > since).length,
      recordMint: async (mint) => {
        write(() => {
          const id = `mint-${documents.children("gatewayTicketMintLog").length + 1}`;
          documents.set(`gatewayTicketMintLog/${id}`, {
            uid: mint.uid,
            purpose: mint.purpose,
            mintedAt: mint.mintedAt,
            expireAt: mint.expiresAt,
          });
        });
      },
      patchGrant: async (ticketId, patch, fence) => {
        const key: RecordKey = { aggregate: "gateway-ticket", key: ticketId };
        assertNoReservedGrantKeys("access.gatewayTickets.patchGrant", patch, GATEWAY_TICKET_FIELDS);
        const current = getGatewayTicket(ticketId);
        if (current === null) throw new MissingRecordError(key);
        if (fence?.revision !== undefined && current.revision !== fence.revision) {
          throw new FenceMismatchError(key, "revision", fence.revision, current.revision);
        }
        write(() => documents.set(gatewayTicketPath(ticketId), { ...documents.get(gatewayTicketPath(ticketId))!, ...structuredClone(patch) }));
      },
      delete: async (ticketId, fence) => {
        const key: RecordKey = { aggregate: "gateway-ticket", key: ticketId };
        if (fence?.revision !== undefined) {
          const current = getGatewayTicket(ticketId);
          if (current === null) throw new MissingRecordError(key);
          if (current.revision !== fence.revision) throw new FenceMismatchError(key, "revision", fence.revision, current.revision);
        }
        write(() => documents.delete(gatewayTicketPath(ticketId)));
      },
    }),
    controlTickets: partialRepository<AccessRepositories["controlTickets"]>("access.controlTickets", {
      get: async (ticketHash) => getControlTicket(ticketHash),
      create: async (ticket) => {
        assertNoReservedGrantKeys("access.controlTickets.create", ticket.grant, CONTROL_TICKET_FIELDS);
        const key: RecordKey = { aggregate: "control-ticket", key: ticket.ticketHash };
        if (documents.get(controlTicketPath(ticket.ticketHash)) !== undefined) throw new AlreadyExistsError(key);
        write(() => documents.set(controlTicketPath(ticket.ticketHash), {
          ...structuredClone(ticket.grant),
          uid: ticket.uid,
          gatewayId: ticket.gatewayId,
          createdAt: resolveServerNow(ticket.createdAt),
          expiresAt: ticket.expiresAt,
          expireAt: ticket.expiresAt,
          ...(ticket.redeemedAt === null ? {} : { redeemedAt: ticket.redeemedAt }),
        }));
      },
      markRedeemed: async (ticketHash, redeemedAt, fence) => {
        const key: RecordKey = { aggregate: "control-ticket", key: ticketHash };
        const current = getControlTicket(ticketHash);
        if (current === null) throw new MissingRecordError(key);
        assertFenceEquals(key, "absent", fence.redeemedAt, current.redeemedAt);
        write(() => documents.set(controlTicketPath(ticketHash), { ...documents.get(controlTicketPath(ticketHash))!, redeemedAt }));
      },
    }),
    controlSessions: partialRepository<AccessRepositories["controlSessions"]>("access.controlSessions", {
      get: async (sessionHash) => {
        const row = documents.get(controlSessionPath(sessionHash));
        return row === undefined ? null : withRevision(controlSessionFromData(sessionHash, structuredClone(row)));
      },
      put: async (session) => {
        assertNoReservedGrantKeys("access.controlSessions.put", session.grant, CONTROL_SESSION_FIELDS);
        write(() => documents.set(controlSessionPath(session.sessionHash), {
          ...structuredClone(session.grant),
          uid: session.uid,
          gatewayId: session.gatewayId,
          ...(session.createdAt === null ? {} : { createdAt: session.createdAt }),
          ...(session.attachmentId === null ? {} : { mobileEnrollmentId: session.attachmentId }),
          expiresAt: session.expiresAt,
          expireAt: session.expiresAt,
        }));
      },
      delete: async (sessionHash) => {
        write(() => documents.delete(controlSessionPath(sessionHash)));
      },
    }),
    modelBrokerTokens: partialRepository<AccessRepositories["modelBrokerTokens"]>("access.modelBrokerTokens", {
      get: async (tokenHash) => {
        const row = documents.get(modelBrokerTokenPath(tokenHash));
        return row === undefined ? null : withRevision(modelBrokerTokenFromData(tokenHash, structuredClone(row)));
      },
      create: async (token) => {
        if (documents.get(modelBrokerTokenPath(token.tokenHash)) !== undefined) {
          throw new AlreadyExistsError({ aggregate: "model-broker-token", key: token.tokenHash });
        }
        write(() => documents.set(modelBrokerTokenPath(token.tokenHash), structuredClone(modelBrokerTokenDocument(token))));
      },
      listForOwner: async (ownerUid) => documents.children(MODEL_BROKER_TOKENS_COLLECTION).flatMap(([tokenHash, row]) =>
        row.ownerUid === ownerUid ? [withRevision(modelBrokerTokenFromData(tokenHash, structuredClone(row)))] : []),
      revoke: async (tokenHash, revokedAt) => {
        write(() => documents.set(modelBrokerTokenPath(tokenHash), {
          ...documents.get(modelBrokerTokenPath(tokenHash)),
          revoked: true,
          revokedAt,
        }));
      },
      delete: async (tokenHash) => {
        write(() => documents.delete(modelBrokerTokenPath(tokenHash)));
      },
    }),
    modelBrokerGatewayTokens: partialRepository<AccessRepositories["modelBrokerGatewayTokens"]>("access.modelBrokerGatewayTokens", {
      get: async (pointerKey) => {
        const row = documents.get(modelBrokerPointerPath(pointerKey));
        return row === undefined ? null : withRevision(modelBrokerGatewayTokenFromData(pointerKey, structuredClone(row)));
      },
      listForOwner: async (ownerUid) => documents.children(MODEL_BROKER_GATEWAY_POINTERS_COLLECTION).flatMap(([pointerKey, row]) =>
        row.ownerUid === ownerUid ? [withRevision(modelBrokerGatewayTokenFromData(pointerKey, structuredClone(row)))] : []),
      put: async ({ pointerKey, ...pointer }) => {
        write(() => documents.set(modelBrokerPointerPath(pointerKey), { ...pointer }));
      },
      delete: async (pointerKey) => {
        write(() => documents.delete(modelBrokerPointerPath(pointerKey)));
      },
    }),
    accessAudit: partialRepository<AccessRepositories["accessAudit"]>("access.accessAudit", {
      record: async (denial) => {
        const id = gatewayAccessDenialAuditId(denial.gatewayId, denial.uid ?? "", denial.reason, denial.at);
        write(() => documents.set(`gatewayAccessAudit/${id}`, {
          ...structuredClone(denial.detail),
          gatewayId: denial.gatewayId,
          granteeUid: denial.uid,
          event: "denied",
          reason: denial.reason,
          outcome: "denied",
          createdAt: Math.floor(denial.at / 60_000) * 60_000,
        }));
        return id;
      },
    }),
  });
}

function resolveServerNow(value: unknown): unknown {
  if (isServerNow(value)) return Date.now();
  if (Array.isArray(value)) return value.map(resolveServerNow);
  if (isMap(value)) return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, resolveServerNow(item)]));
  return value;
}

function secretsRepository(documents: FixtureDocuments, write: Write): SecretsRepository {
  const path = (uid: string, secretId: string) => `users/${uid}/secrets/${secretId}`;
  return partialRepository<SecretsRepository>("secrets", {
    get: async (uid, secretId) => {
      const row = documents.get(path(uid, secretId));
      return row === undefined ? null : { ...userSecretFromData(uid, secretId, structuredClone(row)), revision: FIXTURE_REVISION };
    },
    list: async (uid, kind) => documents.children(`users/${uid}/secrets`)
      .filter(([secretId]) => kind === undefined || secretKindOf(secretId) === kind)
      .map(([secretId, row]) => ({ ...userSecretFromData(uid, secretId, structuredClone(row)), revision: FIXTURE_REVISION })),
    put: async (uid, secret) => {
      const row = resolveServerNow(structuredClone(userSecretToData(secret))) as Record<string, unknown>;
      write(() => documents.set(path(uid, secret.secretId), row));
    },
    delete: async (uid, secretId) => {
      write(() => documents.delete(path(uid, secretId)));
    },
  });
}

function fleetRegistryRepository(documents: FixtureDocuments, write: Write): FleetRegistryRepository {
  const decodeRuntime = (gatewayId: string, row: Record<string, unknown> | undefined) => {
    if (row === undefined || row.docKind !== "runtime") return null;
    if (!isGatewayRuntimeDoc(row) || row.gatewayId !== gatewayId) {
      throw new MalformedRecordError({ aggregate: "fleet-registry", key: gatewayId }, "is not this gateway's runtime record");
    }
    const { docKind: _docKind, ...record } = structuredClone(row) as Record<string, unknown>;
    return { ...record, revision: FIXTURE_REVISION } as unknown as Stored<FleetRegistryRecord>;
  };
  const decodeInventoryRuntime = (gatewayId: string, row: Record<string, unknown>) => {
    try {
      return decodeRuntime(gatewayId, row);
    } catch (error) {
      if (error instanceof MalformedRecordError) return null;
      throw error;
    }
  };
  const registryKey = (gatewayId: string): RecordKey => ({ aggregate: "fleet-registry", key: gatewayId });
  return partialRepository<FleetRegistryRepository>("fleetRegistry", {
    get: async (gatewayId) => decodeRuntime(gatewayId, documents.get(`glmGateways/${gatewayId}`)),
    inventory: async (gatewayIds) => {
      const rows = gatewayIds === undefined
        ? documents.children("glmGateways")
        : gatewayIds.flatMap((gatewayId) => {
          const row = documents.get(`glmGateways/${gatewayId}`);
          return row === undefined ? [] : [[gatewayId, row] as const];
        });
      const records: Stored<FleetRegistryRecord>[] = [];
      const foreign: FleetRegistryForeignEntry[] = [];
      for (const [gatewayId, row] of rows) {
        const record = decodeInventoryRuntime(gatewayId, row);
        if (record === null) foreign.push({ gatewayId, fields: Object.keys(row).sort() });
        else records.push(record);
      }
      return { records, foreign };
    },
    findByVmInstanceId: async (instanceId) => {
      const found = documents.children("glmGateways").filter(([, row]) => {
        const vm = row.vm as { instanceId?: unknown } | null | undefined;
        return vm?.instanceId === instanceId;
      });
      if (found.length > 1) {
        throw new DuplicateRecordError("fleet-registry", "vm.instanceId", instanceId, found.map(([gatewayId]) => gatewayId));
      }
      return found.length === 0 ? null : decodeRuntime(found[0][0], found[0][1]);
    },
    upsert: async (gatewayId, initial, patch) => {
      if (initial.gatewayId !== gatewayId) {
        throw new MalformedRecordError(registryKey(gatewayId), `initial record names gateway ${JSON.stringify(initial.gatewayId)}`);
      }
      const path = `glmGateways/${gatewayId}`;
      const current = decodeRuntime(gatewayId, documents.get(path));
      write(() => documents.set(path, current === null
        ? { ...documents.get(path), docKind: "runtime", ...withoutIdentity(applyPatch(structuredClone(initial) as unknown as Record<string, unknown>, patch)) }
        : applyPatch(documents.get(path)!, structuredClone(patch))));
    },
    getMany: async (gatewayIds) => new Map(gatewayIds.flatMap((gatewayId) => {
      const record = decodeRuntime(gatewayId, documents.get(`glmGateways/${gatewayId}`));
      return record === null ? [] : [[gatewayId, record] as const];
    })),
    list: async (filter = {}) =>
      documents.children("glmGateways").flatMap(([gatewayId, row]) => {
        const record = decodeRuntime(gatewayId, row);
        return record !== null && (filter.runtime === undefined || record.runtime === filter.runtime) ? [record] : [];
      }),
    patch: async (gatewayId, patch, fence) => {
      const path = `glmGateways/${gatewayId}`;
      const current = decodeRuntime(gatewayId, documents.get(path));
      if (current === null) throw new MissingRecordError(registryKey(gatewayId));
      if (fence !== undefined) {
        assertFenceOneOf(registryKey(gatewayId), "status", fence.lifecycle, current.lifecycle);
        assertFenceEquals(registryKey(gatewayId), "present", fence.vmInstanceId, current.vm?.instanceId ?? null);
      }
      write(() => documents.set(path, applyPatch(documents.get(path)!, structuredClone(patch))));
    },
    recordHeartbeat: async (gatewayId, heartbeat) => {
      const path = `glmGateways/${gatewayId}`;
      write(() => {
        const row = documents.get(path) ?? {};
        const current = isMap(row.heartbeat) ? row.heartbeat : {};
        documents.set(path, { ...row, heartbeat: { ...current, ...structuredClone(heartbeat), lastHeartbeatAt: Date.now() } });
      });
    },
    delete: async (gatewayId) => {
      write(() => documents.delete(`glmGateways/${gatewayId}`));
    },
  });
}

const SCALER_STATE_PATH = "glmControllerState/sharedPoolScaler";

function controllerStateRepositories(documents: FixtureDocuments, write: Write): ControllerStateRepositories {
  const platformReleaseKey: RecordKey = { aggregate: "platform-release", key: "platformRelease" };
  const scalerState = (): Stored<SharedPoolScalerState> | null => {
    const row = documents.get(SCALER_STATE_PATH);
    return row === undefined ? null : { ...parseSharedPoolScalerState(structuredClone(row)), revision: FIXTURE_REVISION };
  };
  const assertScalerFence = (fence: SharedPoolScalerFence, current: Stored<SharedPoolScalerState> | null) => {
    if (current === null) throw new MissingRecordError(SCALER_KEY);
    assertFenceEquals(SCALER_KEY, "revision", fence.revision, current.revision);
    assertFenceEquals(SCALER_KEY, "actionSequence", fence.actionSequence, current.actionSequence);
  };
  return partialRepository<ControllerStateRepositories>("controllerState", {
    platformRelease: partialRepository<ControllerStateRepositories["platformRelease"]>("controllerState.platformRelease", {
      get: async () => {
        const row = documents.get(PLATFORM_RELEASE_RECORD_DOC_PATH);
        if (row === undefined) return null;
        const record = parsePlatformReleaseRecord(structuredClone(row));
        if (record === null) throw new MalformedRecordError(platformReleaseKey, "is not a platform release record");
        return { ...record, revision: FIXTURE_REVISION };
      },
      put: async (record) => {
        const parsed = parsePlatformReleaseRecord({ ...record });
        if (parsed === null) throw new MalformedRecordError(platformReleaseKey, "is not a platform release record");
        write(() => documents.set(PLATFORM_RELEASE_RECORD_DOC_PATH, structuredClone(parsed) as unknown as Record<string, unknown>));
      },
    }),
    sharedPoolScaler: {
      get: async () => scalerState(),
      put: async (state, fence) => {
        const current = scalerState();
        if (fence === "absent") assertAbsentFence(SCALER_KEY, current?.revision ?? null);
        else assertScalerFence(fence, current);
        const next = parseSharedPoolScalerState({ ...state });
        write(() => documents.set(SCALER_STATE_PATH, structuredClone(next) as unknown as Record<string, unknown>));
      },
      patch: async (patch, fence) => {
        const current = scalerState();
        if (fence !== undefined) assertScalerFence(fence, current);
        if (current === null) throw new MissingRecordError(SCALER_KEY);
        const { revision: _revision, ...fields } = current;
        const next = parseSharedPoolScalerState(applyPatch(fields, patch));
        write(() => documents.set(SCALER_STATE_PATH, structuredClone(next) as unknown as Record<string, unknown>));
      },
    },
  });
}

export const FIXTURE_SIZING_PROFILES: Record<string, GatewaySizingProfile> = {
  hobby: {
    isolation: "isolated",
    sizingTier: "s",
    computer: {
      runtime: "gce-vm",
      desktop: "x11",
      machineType: "e2-medium",
      provisioningModel: "STANDARD",
      bootDisk: { sizeGb: 80, type: "pd-balanced" },
      homeSizeGiB: 10,
    },
    fallbackStorageGb: 100,
  },
  pro: {
    isolation: "isolated",
    sizingTier: "m",
    computer: {
      runtime: "gce-vm",
      desktop: "omarchy",
      machineType: "e2-standard-2",
      provisioningModel: "STANDARD",
      bootDisk: { sizeGb: 80, type: "pd-ssd" },
      homeSizeGiB: 50,
    },
    fallbackStorageGb: 500,
  },
  team: {
    isolation: "isolated",
    sizingTier: "l",
    computer: {
      runtime: "gce-vm",
      desktop: "omarchy",
      machineType: "e2-standard-4",
      provisioningModel: "STANDARD",
      bootDisk: { sizeGb: 80, type: "pd-ssd" },
      homeSizeGiB: 100,
    },
    fallbackStorageGb: 1024,
  },
  enterprise: { isolation: "shared" },
};

export async function seedFixtureSizingProfiles(db: {
  doc(path: string): { set(data: Record<string, unknown>, options: { merge: boolean }): Promise<unknown> };
}): Promise<void> {
  await db.doc("config/orchestrator").set({ sizingProfiles: FIXTURE_SIZING_PROFILES }, { merge: true });
}

function orchestratorConfigRepository(documents: FixtureDocuments, write: Write): ConfigRepositories["orchestrator"] {
  const path = "config/orchestrator";
  return partialRepository<ConfigRepositories["orchestrator"]>("config.orchestrator", {
    get: async () => {
      const row = documents.get(path);
      return row === undefined
        ? null
        : { ...parseOrchestratorConfig(structuredClone(row)), revision: FIXTURE_REVISION } as Stored<OrchestratorConfig>;
    },
    getSizingProfile: async (sizingKey) => {
      const row = documents.get(path);
      const seeded = row === undefined ? {} : parseOrchestratorConfig(structuredClone(row)).sizingProfiles;
      return requireSizingProfile({ ...FIXTURE_SIZING_PROFILES, ...seeded }, sizingKey);
    },
    patch: async (patch) => {
      write(() => documents.set(path, applyPatch(documents.get(path) ?? {}, structuredClone(patch))));
    },
  });
}

function platformConfigRepository(documents: FixtureDocuments, write: Write): ConfigRepositories["platform"] {
  const path = (key: PlatformConfigKey) => `platformConfig/${key}`;
  return {
    get: async <K extends PlatformConfigKey>(key: K) => {
      const row = documents.get(path(key));
      return row === undefined
        ? null
        : { ...platformConfigEntryFromData(key, structuredClone(row)), revision: FIXTURE_REVISION } as Stored<PlatformConfigEntry<K>>;
    },
    put: async (key, value, updatedBy, updatedAt) => {
      const parsed = parsePlatformConfigValue(key, value);
      const at = typeof updatedAt === "number" ? updatedAt : Date.now();
      const row: Record<string, unknown> = { ...Object.fromEntries(Object.entries(structuredClone(parsed))), updatedAt: at, updatedBy };
      write(() => documents.set(path(key), row));
    },
    delete: async (key) => {
      write(() => documents.delete(path(key)));
    },
  };
}

const PRODUCT_CONTEXT_FIELDS = ["stripeCustomerIds", "stripeSubscriptionIds", "posthogErasure"];

function productContextFields(productContext: object): Record<string, unknown> {
  return Object.fromEntries(PRODUCT_CONTEXT_FIELDS.map((field) => [
    field,
    !isClear(productContext) && field in productContext ? structuredClone((productContext as Record<string, unknown>)[field]) : { clear: true },
  ]));
}

function deletionJobsRepository(documents: FixtureDocuments, write: Write): JobRepositories["deletions"] {
  const path = (deletionId: string) => `${USER_DELETION_JOBS_COLLECTION}/${deletionId}`;
  const key = (deletionId: string): RecordKey => ({ aggregate: "customer-deletion-job", key: deletionId });
  const statusOf = (stored: unknown): UserDeletionJobStatus =>
    stored === storedDeletionStatus("product_verification_pending")
      ? "product_verification_pending"
      : stored as UserDeletionJobStatus;
  return partialRepository<JobRepositories["deletions"]>("jobs.deletions", {
    get: async (deletionId) => {
      const row = documents.get(path(deletionId));
      if (row === undefined) return null;
      const productContext = Object.fromEntries(PRODUCT_CONTEXT_FIELDS.filter((field) => field in row).map((field) => [field, row[field]]));
      const fields = Object.fromEntries(Object.entries(structuredClone(row)).filter(([field]) => !PRODUCT_CONTEXT_FIELDS.includes(field)));
      return {
        ...fields,
        deletionId,
        status: statusOf(row.status),
        ...(Object.keys(productContext).length > 0 ? { productContext } : {}),
        revision: FIXTURE_REVISION,
      } as unknown as Stored<UserDeletionJob>;
    },
    create: async (job) => {
      if (documents.get(path(job.deletionId)) !== undefined) throw new AlreadyExistsError(key(job.deletionId));
      const { deletionId, productContext, status, ...fields } = job;
      write(() => documents.set(path(deletionId), withoutIdentity({ ...fields, ...productContext, status: storedDeletionStatus(status) })));
    },
    patch: async (deletionId, patch, fence) => {
      const current = documents.get(path(deletionId));
      if (current === undefined) throw new MissingRecordError(key(deletionId));
      assertFenceOneOf(key(deletionId), "status", fence?.status?.map(storedDeletionStatus), current.status as string);
      const { status, productContext, ...fields } = patch;
      write(() => documents.set(path(deletionId), applyPatch(current, {
        ...structuredClone(fields),
        ...(productContext === undefined ? {} : productContextFields(productContext)),
        ...(status === undefined ? {} : { status: storedDeletionStatus(status) }),
      })));
    },
    recordRetiredGatewayProof: async (deletionId, gatewayId, proof) => {
      if (documents.get(path(deletionId)) === undefined) throw new MissingRecordError(key(deletionId));
      write(() => {
        const latest = documents.get(path(deletionId));
        if (latest === undefined) throw new MissingRecordError(key(deletionId));
        documents.set(path(deletionId), withDottedFields(latest, { [`retiredGatewayProofs.${gatewayId}`]: proof }));
      });
    },
  });
}

function agentImportsRepository(documents: FixtureDocuments, write: Write): JobRepositories["agentImports"] {
  const path = (uid: string, importId: string) => `users/${uid}/agentImports/${importId}`;
  const pointerPath = (uid: string, pointer: string) => `users/${uid}/agentImportState/${pointer}`;
  const decodeImport = (uid: string, importId: string, row: Record<string, unknown>) =>
    ({ ...agentImportRecordFromData(uid, importId, structuredClone(row)), revision: FIXTURE_REVISION });
  return partialRepository<JobRepositories["agentImports"]>("jobs.agentImports", {
    get: async (uid, importId) => {
      const row = documents.get(path(uid, importId));
      return row === undefined ? null : decodeImport(uid, importId, row);
    },
    listForUid: async (uid) => documents.children(`users/${uid}/agentImports`).map(([importId, row]) => decodeImport(uid, importId, row)),
    put: async (record) => {
      const document = structuredClone(agentImportDocument(record));
      write(() => documents.set(path(record.uid, record.importId), document));
    },
    delete: async (uid, importId) => {
      write(() => documents.delete(path(uid, importId)));
    },
    getPointer: async (uid, pointer) => {
      const row = documents.get(pointerPath(uid, pointer));
      return row === undefined ? null : { ...agentImportPointerFromData(uid, pointer, structuredClone(row)), revision: FIXTURE_REVISION };
    },
    putPointer: async (uid, pointer, value) => {
      write(() => documents.set(pointerPath(uid, pointer), agentImportPointerDocument(uid, value)));
    },
    deletePointer: async (uid, pointer) => {
      write(() => documents.delete(pointerPath(uid, pointer)));
    },
  });
}

function migrationTasksRepository(documents: FixtureDocuments, write: Write): MigrationTasksRepository {
  const path = (taskId: string) => `glmMigrationTransferTasks/${taskId}`;
  const key = (taskId: string): RecordKey => ({ aggregate: "migration-transfer-task", key: taskId });
  const read = (taskId: string) => {
    const row = documents.get(path(taskId));
    return row === undefined ? null : migrationTransferTaskFromData(taskId, structuredClone(row), FIXTURE_REVISION);
  };
  return partialRepository<MigrationTasksRepository>("migrationTasks", {
    get: async (taskId) => read(taskId),
    listByStatus: async (statuses) =>
      documents.children("glmMigrationTransferTasks").flatMap(([id, row]) =>
        statuses.includes(row.status as never) ? [stored<MigrationTransferTask>(id, row)] : []),
    claim: async (task, expected) => {
      const existing = read(task.id);
      if (expected === "absent") assertAbsentFence(key(task.id), existing?.revision ?? null);
      else if (existing === null) throw new MissingRecordError(key(task.id));
      const { id: _id, ...row } = structuredClone(task);
      write(() => documents.set(path(task.id), Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null))));
    },
    finish: async (taskId, claim, completedAt, error) => {
      const current = read(taskId);
      if (current === null) throw new MissingRecordError(key(taskId));
      assertFenceOneOf(key(taskId), "status", ["running"], current.status);
      assertFenceEquals(key(taskId), "attemptId", claim, {
        attempt: current.attempt,
        attemptId: current.attemptId,
        leaseOwner: current.leaseOwner,
      });
      write(() => {
        const {
          leaseOwner: _leaseOwner,
          leasePod: _leasePod,
          leaseRestartCount: _leaseRestartCount,
          leaseExpiresAt: _leaseExpiresAt,
          error: _error,
          ...row
        } = documents.get(path(taskId))!;
        documents.set(path(taskId), {
          ...row,
          status: error === null ? "succeeded" : "failed",
          completedAt,
          updatedAt: completedAt,
          ...(error === null ? {} : { error }),
        });
      });
    },
  });
}

function fixtureRepositories(rows: JournalRows, write: Write, transactional: boolean, documents?: FixtureDocuments): object {
  const journal = journalRepositories(rows, write, documents);
  if (documents === undefined) return { journal };
  return {
    journal,
    gateways: gatewayRepositories(documents, write),
    users: userRepositories(documents, write, transactional),
    workspaces: workspaceRepositories(documents, write, transactional),
    secrets: secretsRepository(documents, write),
    access: accessRepositories(documents, write),
    fleetRegistry: fleetRegistryRepository(documents, write),
    controllerState: controllerStateRepositories(documents, write),
    migrationTasks: migrationTasksRepository(documents, write),
    config: partialRepository<ConfigRepositories>("config", {
      orchestrator: orchestratorConfigRepository(documents, write),
      platform: platformConfigRepository(documents, write),
    }),
    jobs: partialRepository<JobRepositories>("jobs", {
      deletions: deletionJobsRepository(documents, write),
      agentImports: agentImportsRepository(documents, write),
      archives: partialRepository<JobRepositories["archives"]>("jobs.archives", {
        create: async (archive) => {
          if ("archivedAt" in archive.record) throw new TypeError("jobs.archives.create: archivedAt is a typed field and cannot appear in the record");
          const id = `archive-${documents.children("anonymousOperationalArchives").length + 1}`;
          write(() => documents.set(`anonymousOperationalArchives/${id}`, { ...structuredClone(archive.record), archivedAt: archive.archivedAt }));
          return id;
        },
        merge: async (archiveId, record) => {
          if ("archivedAt" in record) throw new TypeError("jobs.archives.merge: archivedAt is a typed field and cannot appear in the record");
          const path = `anonymousOperationalArchives/${archiveId}`;
          write(() => documents.set(path, { ...documents.get(path), ...structuredClone(record) }));
        },
        list: async (page) => fixturePage(
          documents.children("anonymousOperationalArchives")
            .map(([id, row]) => anonymousArchiveFromData(id, structuredClone(row)))
            .sort((a, b) => b.archivedAt - a.archivedAt),
          (archive) => archive.id,
          page,
          (id) => new MissingRecordError({ aggregate: "anonymous-operational-archive", key: id }),
        ),
      }),
    }),
  };
}

function onlyImplemented<T extends object>(repositories: object, extra: T): T {
  return new Proxy({ ...extra, ...repositories } as T, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      if (typeof property === "symbol" || property === "then") return undefined;
      return unimplemented(String(property));
    },
  });
}

export interface JournalFixtureOptions {
  readonly transactionFailure?: Error;
  readonly documents?: FixtureDocuments;
  readonly beforeTransaction?: (label: string) => void;
  readonly serializeTransactions?: boolean;
}

export function createDocumentFixtureStore(
  records: FixtureDocumentRecords,
  options: Omit<JournalFixtureOptions, "documents"> = {},
): PlatformStateStore {
  return createJournalFixtureStore(journalRowsAtPaths(records), { ...options, documents: fixtureDocumentsAt(records) });
}

export function createJournalFixtureStore(rows: JournalRows, options: JournalFixtureOptions = {}): PlatformStateStore {
  let committed: Promise<unknown> = Promise.resolve();
  const run = async <T>(
    transactionOptions: { label: string; readOnly?: boolean },
    body: (transaction: PlatformStateTransaction) => Promise<T>,
  ): Promise<T> => {
    if (options.transactionFailure !== undefined) throw options.transactionFailure;
    options.beforeTransaction?.(transactionOptions.label);
    const writes: Array<() => void> = [];
    const transaction = onlyImplemented(fixtureRepositories(rows, (apply) => writes.push(apply), true, options.documents), {
      label: transactionOptions.label,
      readOnly: transactionOptions.readOnly === true,
      attempt: 1,
    }) as unknown as PlatformStateTransaction;
    const result = await body(transaction);
    for (const apply of writes) apply();
    return result;
  };
  return onlyImplemented(fixtureRepositories(rows, (apply) => apply(), false, options.documents), {
    transaction<T>(
      transactionOptions: { label: string; readOnly?: boolean },
      body: (transaction: PlatformStateTransaction) => Promise<T>,
    ): Promise<T> {
      if (options.serializeTransactions !== true) return run(transactionOptions, body);
      const execution = committed.then(() => run(transactionOptions, body));
      committed = execution.then(() => undefined, () => undefined);
      return execution;
    },
  }) as unknown as PlatformStateStore;
}
