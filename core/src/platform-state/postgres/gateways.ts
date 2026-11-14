import { isReleasePayload, upgradeReleasePayloadSchema } from "@octogee/shared/types/gateway-releases";
import type { IsolatedGatewayAllocation } from "@octogee/shared/types/gateway-mutable-config";
import { dualReadGatewayClassValue, isGatewayVmRuntimeBundle, type GatewayVmRuntimeBundle } from "@octogee/shared/types/glm";
import { parseAssignmentDoc } from "../../assignment-doc.js";
import { DuplicateRecordError, MalformedRecordError, type RecordKey } from "../errors.js";
import type {
  GatewayAssignment,
  GatewayAssignmentFence,
  GatewayAssignmentsRepository,
  GatewayRelease,
  GatewayReleasesRepository,
  GatewayRepositories,
  GatewayRoot,
  GatewayRootFence,
  GatewayRootsRepository,
  GatewayVmRuntimeRepository,
} from "../gateways.js";
import type { Stored, WatchFilters } from "../store.js";
import {
  deleteRecord,
  equalsFence,
  insertRecord,
  oneOfFence,
  revisionFence,
  selectByKey,
  selectRecords,
  updateRecord,
  type FenceCheck,
} from "./records.js";
import { currentAssignmentSource, gatewayClassesStoredAs } from "./legacy-stored-names.js";
import type { PostgresSession } from "./session.js";
import { SqlParameters, type Row } from "./sql.js";
import { storedGatewayClassValue } from "./stored-gateway-class.js";
import { column, columnFor, decodeRecord, decodeStored, isClearField, revisionOf, type TableSpec } from "./values.js";
import type { FilterKeys, PostgresWatchSource } from "./watch-sources.js";

const ALLOCATION_KIND = "disposable-builder";
const ALLOCATION_SCHEMA_VERSION = 1;

export const GATEWAYS_TABLE: TableSpec = {
  table: "gateways",
  aggregate: "gateway",
  keyColumns: ["gateway_id"],
  columns: [
    column("gatewayId", "text"),
    column("createdAt", "bigint"),
    column("createdBy", "text"),
    column("updatedAt", "bigint"),
    column("updatedBy", "text"),
    column("latestRelease", "integer"),
    column("desiredRelease", "integer"),
    column("liveRelease", "integer", { nullAs: "null" }),
    column("desiredStatus", "text"),
    column("retireAfter", "bigint"),
    column("retirementVersion", "integer"),
    column("retirementClaim", "jsonb"),
    column("runtimeRestartFence", "jsonb"),
    column("configSchemaVersion", "integer"),
    column("profile", "text", { nullAs: "null" }),
    column("gatewayClass", "text"),
    column("imageProfile", "text"),
    column("sizingTier", "text", { nullAs: "null" }),
    column("sizingProfile", "text"),
    column("gcpProject", "text", { nullAs: "null" }),
    column("gatewayContainerSecurityContext", "jsonb", { nullAs: "null" }),
    column("serviceAccountName", "text", { nullAs: "null" }),
    column("serviceAccount", "jsonb", { nullAs: "null" }),
    column("builderAccess", "jsonb", { column: "user_access", nullAs: "null" }),
    column("ownerUid", "text", { nullAs: "null" }),
    column("builderSlug", "text", { column: "user_slug", nullAs: "null" }),
    column("modelBrokerLimits", "jsonb", { nullAs: "null" }),
    column("allocationLeaseId", "text"),
    column("allocationGeneration", "integer"),
    column("allocationClaimedByUid", "text"),
    column("lastError", "jsonb"),
    column("lastPreStopFlush", "jsonb"),
    column("configBackfill", "jsonb"),
  ],
  immutableFields: ["gatewayId", "createdAt", "createdBy", "latestRelease"],
};

const RELEASE_APPEND_TABLE: TableSpec = { ...GATEWAYS_TABLE, immutableFields: ["gatewayId", "createdAt", "createdBy"] };

const GATEWAY_RELEASES_TABLE: TableSpec = {
  table: "gateway_releases",
  aggregate: "gateway-release",
  keyColumns: ["gateway_id", "release"],
  columns: [
    column("gatewayId", "text"),
    column("release", "integer"),
    column("createdAt", "bigint"),
    column("createdBy", "text"),
    column("sourceRelease", "integer", { nullAs: "null" }),
    column("note", "text", { nullAs: "null" }),
    column("payloadHash", "text"),
    column("payload", "jsonb"),
  ],
};

const GATEWAY_ASSIGNMENTS_TABLE: TableSpec = {
  table: "gateway_assignments",
  aggregate: "gateway-assignment",
  keyColumns: ["gateway_id", "uid"],
  columns: [
    column("gatewayId", "text"),
    column("uid", "text"),
    column("slug", "text"),
    column("source", "text"),
    column("state", "text"),
    column("epoch", "integer"),
    column("createdAt", "bigint"),
    column("updatedAt", "bigint"),
    column("updatedByOperationId", "text", { nullAs: "null" }),
    column("handoffProgress", "jsonb"),
    column("sharedSurgeForwardRecovery", "jsonb"),
  ],
  immutableFields: ["gatewayId", "uid", "createdAt"],
};

const GATEWAY_VM_RUNTIME_TABLE: TableSpec = {
  table: "gateway_vm_runtime",
  aggregate: "gateway-vm-runtime",
  keyColumns: ["gateway_id"],
  columns: [column("gatewayId", "text"), column("bundle", "jsonb")],
};

const rootKey = (gatewayId: string): RecordKey => ({ aggregate: "gateway", key: gatewayId });
const assignmentKey = (gatewayId: string, uid: string): RecordKey => ({ aggregate: "gateway-assignment", key: `${gatewayId}/${uid}` });
const vmRuntimeKey = (gatewayId: string): RecordKey => ({ aggregate: "gateway-vm-runtime", key: gatewayId });

const UPDATED_AT = columnFor(GATEWAYS_TABLE, rootKey(""), "updatedAt");
const LATEST_RELEASE = columnFor(GATEWAYS_TABLE, rootKey(""), "latestRelease");
const RETIREMENT_VERSION = columnFor(GATEWAYS_TABLE, rootKey(""), "retirementVersion");
const DESIRED_STATUS = columnFor(GATEWAYS_TABLE, rootKey(""), "desiredStatus");
const ALLOCATION_GENERATION = columnFor(GATEWAYS_TABLE, rootKey(""), "allocationGeneration");
const RUNTIME_RESTART_FENCE = columnFor(GATEWAYS_TABLE, rootKey(""), "runtimeRestartFence");
const LAST_ERROR_SLUG = column("lastErrorSlug", "text", { column: "last_error_slug" });
const ASSIGNMENT_EPOCH = columnFor(GATEWAY_ASSIGNMENTS_TABLE, assignmentKey("", ""), "epoch");
const ASSIGNMENT_UPDATED_AT = columnFor(GATEWAY_ASSIGNMENTS_TABLE, assignmentKey("", ""), "updatedAt");
const ASSIGNMENT_STATE = columnFor(GATEWAY_ASSIGNMENTS_TABLE, assignmentKey("", ""), "state");

type Fields = Record<string, unknown>;

function allocationColumns(gatewayId: string, allocation: unknown): Fields {
  if (allocation === null || isClearField(allocation)) {
    return { allocationLeaseId: null, allocationGeneration: null, allocationClaimedByUid: null };
  }
  const value = allocation as IsolatedGatewayAllocation;
  if (value.kind !== ALLOCATION_KIND || value.schemaVersion !== ALLOCATION_SCHEMA_VERSION) {
    throw new MalformedRecordError(rootKey(gatewayId), `allocation ${JSON.stringify(allocation)} is not a disposable isolated allocation`);
  }
  return { allocationLeaseId: value.leaseId, allocationGeneration: value.generation, allocationClaimedByUid: value.claimedByUid };
}

function storedClassColumns(fields: Fields): Fields {
  const stored = { ...fields };
  for (const name of ["profile", "gatewayClass", "imageProfile"]) {
    if (Object.hasOwn(stored, name)) stored[name] = storedGatewayClassValue(stored[name]);
  }
  return stored;
}

function rootColumns(gatewayId: string, input: object): Fields {
  const { allocation, preemption, ...fields } = input as Fields;
  if (preemption !== undefined && preemption !== null && !isClearField(preemption)) {
    throw new MalformedRecordError(rootKey(gatewayId), `preemption ${JSON.stringify(preemption)} is not null`);
  }
  const columns = storedClassColumns(fields);
  return allocation === undefined ? columns : { ...columns, ...allocationColumns(gatewayId, allocation) };
}

export function decodeGatewayRoot(row: Row): Stored<GatewayRoot> {
  const { allocationLeaseId, allocationGeneration, allocationClaimedByUid, ...stored } = decodeStored<Fields>(GATEWAYS_TABLE, row);
  const root = {
    ...stored,
    profile: dualReadGatewayClassValue(stored.profile),
    gatewayClass: dualReadGatewayClassValue(stored.gatewayClass),
    imageProfile: dualReadGatewayClassValue(stored.imageProfile),
  };
  if (allocationLeaseId === undefined) return root as unknown as Stored<GatewayRoot>;
  const allocation: IsolatedGatewayAllocation = {
    kind: ALLOCATION_KIND,
    schemaVersion: ALLOCATION_SCHEMA_VERSION,
    leaseId: allocationLeaseId as string,
    generation: allocationGeneration as number,
    claimedByUid: allocationClaimedByUid as string,
  };
  return { ...root, allocation } as unknown as Stored<GatewayRoot>;
}

function decodeRelease(row: Row): GatewayRelease {
  const release = decodeRecord<GatewayRelease>(GATEWAY_RELEASES_TABLE, row);
  if (isReleasePayload(release.payload)) return release;
  const upgrade = upgradeReleasePayloadSchema(release.payload, release.payloadHash);
  if (upgrade.status === "unsupported") {
    throw new MalformedRecordError(
      { aggregate: "gateway-release", key: `${release.gatewayId}/${release.release}` },
      `payload is unreadable: ${upgrade.reason}`,
    );
  }
  return { ...release, payload: upgrade.payload, payloadHash: upgrade.payloadHash };
}

export function decodeGatewayAssignment(row: Row): Stored<GatewayAssignment> {
  const stored = decodeRecord<Fields>(GATEWAY_ASSIGNMENTS_TABLE, row);
  const uid = stored.uid as string;
  const key = assignmentKey(stored.gatewayId as string, uid);
  let assignment: GatewayAssignment | null;
  try {
    assignment = parseAssignmentDoc(uid, { ...stored, source: currentAssignmentSource(stored.source) });
  } catch (error) {
    throw new MalformedRecordError(key, error instanceof Error ? error.message : String(error));
  }
  if (assignment === null) throw new MalformedRecordError(key, "is not a complete assignment");
  return { ...assignment, revision: revisionOf(row) };
}

function decodeVmRuntime(row: Row): Stored<GatewayVmRuntimeBundle> {
  const { gatewayId, bundle } = decodeRecord<{ gatewayId: string; bundle: unknown }>(GATEWAY_VM_RUNTIME_TABLE, row);
  if (!isGatewayVmRuntimeBundle(bundle) || bundle.gatewayId !== gatewayId) {
    throw new MalformedRecordError(vmRuntimeKey(gatewayId), "is not this gateway's VM runtime bundle");
  }
  return { ...bundle, revision: revisionOf(row) };
}

function rootFences(fence: GatewayRootFence | undefined): FenceCheck[] {
  return [
    ...revisionFence(fence?.revision),
    ...equalsFence("updatedAt", UPDATED_AT, fence?.updatedAt),
    ...equalsFence("latestRelease", LATEST_RELEASE, fence?.latestRelease),
    ...equalsFence("retirementVersion", RETIREMENT_VERSION, fence?.retirementVersion),
    ...oneOfFence("status", DESIRED_STATUS, fence?.desiredStatus),
    ...equalsFence("generation", ALLOCATION_GENERATION, fence?.allocationGeneration),
    ...equalsFence("present", LAST_ERROR_SLUG, fence?.lastErrorSlug),
  ];
}

function assignmentFences(fence: GatewayAssignmentFence | undefined): FenceCheck[] {
  return [
    ...revisionFence(fence?.revision),
    ...equalsFence("epoch", ASSIGNMENT_EPOCH, fence?.epoch),
    ...equalsFence("updatedAt", ASSIGNMENT_UPDATED_AT, fence?.updatedAt),
    ...oneOfFence("status", ASSIGNMENT_STATE, fence?.state),
  ];
}

function limitClause(limit: number | undefined, parameters: SqlParameters): string {
  return limit === undefined ? "" : ` LIMIT ${parameters.add(limit, "integer")}`;
}

function createRootsRepository(session: PostgresSession): GatewayRootsRepository {
  const list = async (operation: string, where: string, values: readonly unknown[]) =>
    (await selectRecords(session, operation, `SELECT * FROM $schema.gateways ${where} ORDER BY gateway_id`, values)).map(decodeGatewayRoot);
  const target = (gatewayId: string) => ({ table: GATEWAYS_TABLE, key: [gatewayId] });

  return {
    async get(gatewayId) {
      const row = await selectByKey(session, "gateways.roots.get", target(gatewayId));
      return row === null ? null : decodeGatewayRoot(row);
    },

    async getMany(gatewayIds) {
      const roots = await list("gateways.roots.getMany", "WHERE gateway_id = ANY($1::text[])", [[...gatewayIds]]);
      return new Map(roots.map((root) => [root.gatewayId, root]));
    },

    list(filter = {}) {
      const parameters = new SqlParameters();
      const conditions: string[] = [];
      if (filter.gatewayClass !== undefined) {
        conditions.push(`gateway_class = ANY(${parameters.add(gatewayClassesStoredAs(filter.gatewayClass), "text[]")})`);
      }
      if (filter.ownerUid !== undefined) conditions.push(`owner_uid = ${parameters.add(filter.ownerUid, "text")}`);
      return list("gateways.roots.list", conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`, parameters.values);
    },

    async findByServiceAccountName(serviceAccountName) {
      const rows = await selectRecords(
        session,
        "gateways.roots.findByServiceAccountName",
        "SELECT * FROM $schema.gateways WHERE service_account_name = $1::text ORDER BY gateway_id LIMIT 2",
        [serviceAccountName],
      );
      if (rows.length > 1) {
        throw new DuplicateRecordError("gateway", "serviceAccountName", serviceAccountName, rows.map((row) => row.gateway_id as string));
      }
      return rows.length === 0 ? null : decodeGatewayRoot(rows[0]);
    },

    async create(root) {
      await insertRecord(session, "gateways.roots.create", GATEWAYS_TABLE, rootColumns(root.gatewayId, root), "create");
    },

    async patch(gatewayId, patch, fence) {
      await updateRecord(session, "gateways.roots.patch", target(gatewayId), rootColumns(gatewayId, patch), rootFences(fence));
    },

    async compareAndSetRuntimeRestartFence(gatewayId, expected, next) {
      await updateRecord(
        session,
        "gateways.roots.compareAndSetRuntimeRestartFence",
        target(gatewayId),
        { runtimeRestartFence: next ?? { clear: true } },
        equalsFence("runtimeRestartFence", RUNTIME_RESTART_FENCE, expected),
      );
    },

    async deleteChildren(gatewayId) {
      const parameters = new SqlParameters();
      const gateway = parameters.add(gatewayId, "text");
      await session.execute(`DELETE FROM $schema.gateway_releases WHERE gateway_id = ${gateway}`, parameters.values);
    },

    async delete(gatewayId, fence) {
      await deleteRecord(session, "gateways.roots.delete", target(gatewayId), rootFences(fence));
    },
  };
}

function createReleasesRepository(session: PostgresSession): GatewayReleasesRepository {
  return {
    async get(gatewayId, release) {
      const row = await selectByKey(session, "gateways.releases.get", { table: GATEWAY_RELEASES_TABLE, key: [gatewayId, release] });
      return row === null ? null : decodeRelease(row);
    },

    async list(gatewayId, order, limit) {
      const parameters = new SqlParameters();
      const gateway = parameters.add(gatewayId, "text");
      const direction = order === "asc" ? "ASC" : "DESC";
      const rows = await selectRecords(
        session,
        "gateways.releases.list",
        `SELECT * FROM $schema.gateway_releases WHERE gateway_id = ${gateway} ORDER BY release ${direction}${limitClause(limit, parameters)}`,
        parameters.values,
      );
      return rows.map(decodeRelease);
    },

    async append(input) {
      const name = "gateways.releases.append";
      const release = input.expectedLatestRelease + 1;
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
      const rootPatch = {
        latestRelease: release,
        ...(input.activate ? { desiredRelease: release } : {}),
        updatedAt: input.createdAt,
        updatedBy: input.updatedBy,
      };
      return session.atomically(name, async (fenced) => {
        await updateRecord(
          fenced,
          name,
          { table: RELEASE_APPEND_TABLE, key: [input.gatewayId] },
          rootPatch,
          equalsFence("latestRelease", LATEST_RELEASE, input.expectedLatestRelease),
        );
        await insertRecord(fenced, name, GATEWAY_RELEASES_TABLE, document, "create");
        return release;
      });
    },

    async createInitial(release) {
      await insertRecord(session, "gateways.releases.createInitial", GATEWAY_RELEASES_TABLE, release, "create");
    },

    async replace(release) {
      await insertRecord(session, "gateways.releases.replace", GATEWAY_RELEASES_TABLE, release, "put");
    },
  };
}

function createAssignmentsRepository(session: PostgresSession): GatewayAssignmentsRepository {
  const list = async (operation: string, text: string, values: readonly unknown[]) =>
    (await selectRecords(session, operation, text, values)).map(decodeGatewayAssignment);
  const target = (gatewayId: string, uid: string) => ({ table: GATEWAY_ASSIGNMENTS_TABLE, key: [gatewayId, uid] });

  return {
    async get(gatewayId, uid) {
      const row = await selectByKey(session, "gateways.assignments.get", target(gatewayId, uid));
      return row === null ? null : decodeGatewayAssignment(row);
    },

    list(gatewayId, limit) {
      const parameters = new SqlParameters();
      const gateway = parameters.add(gatewayId, "text");
      return list(
        "gateways.assignments.list",
        `SELECT * FROM $schema.gateway_assignments WHERE gateway_id = ${gateway} ORDER BY uid${limitClause(limit, parameters)}`,
        parameters.values,
      );
    },

    async isEmpty(gatewayId) {
      const rows = await selectRecords(
        session,
        "gateways.assignments.isEmpty",
        "SELECT 1 AS present FROM $schema.gateway_assignments WHERE gateway_id = $1::text LIMIT 1",
        [gatewayId],
      );
      return rows.length === 0;
    },

    async findBySlug(gatewayId, slug) {
      const rows = await selectRecords(
        session,
        "gateways.assignments.findBySlug",
        "SELECT * FROM $schema.gateway_assignments WHERE gateway_id = $1::text AND slug = $2::text",
        [gatewayId, slug],
      );
      return rows.length === 0 ? null : decodeGatewayAssignment(rows[0]);
    },

    listForUid(uid) {
      return list("gateways.assignments.listForUid", "SELECT * FROM $schema.gateway_assignments WHERE uid = $1::text ORDER BY gateway_id", [
        uid,
      ]);
    },

    listForSlug(slug) {
      return list(
        "gateways.assignments.listForSlug",
        "SELECT * FROM $schema.gateway_assignments WHERE slug = $1::text ORDER BY gateway_id, uid",
        [slug],
      );
    },

    listAll() {
      return list("gateways.assignments.listAll", "SELECT * FROM $schema.gateway_assignments ORDER BY gateway_id, uid", []);
    },

    async create(assignment) {
      await insertRecord(session, "gateways.assignments.create", GATEWAY_ASSIGNMENTS_TABLE, assignment, "create");
    },

    async put(assignment) {
      await insertRecord(session, "gateways.assignments.put", GATEWAY_ASSIGNMENTS_TABLE, assignment, "put");
    },

    async patch(gatewayId, uid, patch, fence) {
      await updateRecord(session, "gateways.assignments.patch", target(gatewayId, uid), patch, assignmentFences(fence));
    },

    async delete(gatewayId, uid, fence) {
      await deleteRecord(session, "gateways.assignments.delete", target(gatewayId, uid), assignmentFences(fence));
    },
  };
}

function createVmRuntimeRepository(session: PostgresSession): GatewayVmRuntimeRepository {
  const target = (gatewayId: string) => ({ table: GATEWAY_VM_RUNTIME_TABLE, key: [gatewayId] });

  return {
    async get(gatewayId) {
      const row = await selectByKey(session, "gateways.vmRuntime.get", target(gatewayId));
      return row === null ? null : decodeVmRuntime(row);
    },

    async put(gatewayId, bundle) {
      if (bundle.gatewayId !== gatewayId) {
        throw new MalformedRecordError(vmRuntimeKey(gatewayId), `bundle names gateway ${JSON.stringify(bundle.gatewayId)}`);
      }
      const { revision: _revision, ...stored } = bundle as GatewayVmRuntimeBundle & { readonly revision?: unknown };
      await insertRecord(session, "gateways.vmRuntime.put", GATEWAY_VM_RUNTIME_TABLE, { gatewayId, bundle: stored }, "put");
    },

    async delete(gatewayId) {
      await deleteRecord(session, "gateways.vmRuntime.delete", target(gatewayId));
    },
  };
}

export function createPostgresGatewayRepositories(session: PostgresSession): GatewayRepositories {
  return {
    roots: createRootsRepository(session),
    releases: createReleasesRepository(session),
    assignments: createAssignmentsRepository(session),
    vmRuntime: createVmRuntimeRepository(session),
  };
}

export function gatewayFilterMatches(gatewayId: string | undefined, filterKeys: FilterKeys): boolean {
  return gatewayId === undefined || filterKeys.gateway_id === undefined || filterKeys.gateway_id.includes(gatewayId);
}

export function gatewayCondition(gatewayId: string | undefined, parameters: SqlParameters): string {
  return gatewayId === undefined ? "" : ` AND gateway_id = ${parameters.add(gatewayId, "text")}`;
}

export function postgresGatewaysWatchSource(filter: WatchFilters["gateways"]): PostgresWatchSource<"gateways"> {
  return {
    aggregate: "gateways",
    operation: "watch gateways",
    selectAll: (parameters) =>
      `SELECT * FROM $schema.gateways WHERE true${gatewayCondition(filter.gatewayId, parameters)} ORDER BY gateway_id`,
    selectKeys: (keys, parameters) =>
      `SELECT * FROM $schema.gateways
        WHERE gateway_id = ANY(${parameters.add([...keys], "text[]")})${gatewayCondition(filter.gatewayId, parameters)}`,
    keyOf: (row) => row.gateway_id as string,
    decode: decodeGatewayRoot,
    mayMatch: (filterKeys) => gatewayFilterMatches(filter.gatewayId, filterKeys),
  };
}

export function postgresAssignmentsWatchSource(filter: WatchFilters["assignments"]): PostgresWatchSource<"assignments"> {
  return {
    aggregate: "assignments",
    operation: "watch assignments",
    selectAll: (parameters) =>
      `SELECT * FROM $schema.gateway_assignments WHERE true${gatewayCondition(filter.gatewayId, parameters)} ORDER BY gateway_id, uid`,
    selectKeys: (keys, parameters) =>
      `SELECT * FROM $schema.gateway_assignments
        WHERE gateway_id || '/' || uid = ANY(${parameters.add([...keys], "text[]")})${gatewayCondition(filter.gatewayId, parameters)}`,
    keyOf: (row) => `${row.gateway_id as string}/${row.uid as string}`,
    decode: decodeGatewayAssignment,
    mayMatch: (filterKeys) => gatewayFilterMatches(filter.gatewayId, filterKeys),
  };
}
