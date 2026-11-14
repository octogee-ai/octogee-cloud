import { randomInt } from "node:crypto";
import {
  isOperationAuditRecord,
  type GlmOperationRecord,
  type OperationKind,
  type OperationStatus,
} from "@octogee/shared/types/glm";
import { MalformedRecordError, MissingRecordError, type RecordKey } from "../errors.js";
import type {
  GatewayRecoveryReceipt,
  GatewayRecoveryReceiptsRepository,
  JournalRepositories,
  OperationAuditRow,
  OperationAuditsRepository,
  OperationRecord,
  OperationsRepository,
} from "../operations.js";
import type { Page, PageRequest, Stored } from "../store.js";
import { GATEWAY_RECOVERY_RECEIPTS_TABLE, OPERATION_AUDITS_TABLE, OPERATIONS_TABLE } from "./journal-tables.js";
import { operationForStore, operationInputForStore, operationInputFromStored } from "./previous-release-operation-input.js";
import {
  deleteRecord,
  equalsFence,
  insertRecord,
  oneOfFence,
  revisionFence,
  selectByKey,
  selectRecords,
  updateRecord,
} from "./records.js";
import type { PostgresSession } from "./session.js";
import { SqlParameters, type Row } from "./sql.js";
import { columnFor, decodeStored, isClearField } from "./values.js";

const AUTO_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const AUTO_ID_LENGTH = 20;
const AUDIT_ID_PREFIX = "audit-";

export function mintOperationId(): string {
  let id = "";
  for (let index = 0; index < AUTO_ID_LENGTH; index += 1) id += AUTO_ID_ALPHABET[randomInt(AUTO_ID_ALPHABET.length)];
  return id;
}

const operationKey = (operationId: string): RecordKey => ({ aggregate: "operation", key: operationId });

const STATUS = columnFor(OPERATIONS_TABLE, operationKey(""), "status");
const STARTED_AT = columnFor(OPERATIONS_TABLE, operationKey(""), "startedAt");
const AUDIT_STATUS = columnFor(OPERATION_AUDITS_TABLE, operationKey(""), "status");
const ACTION_CLAIM_ID = columnFor(OPERATION_AUDITS_TABLE, operationKey(""), "actionClaimId");
const ACTION_STARTED_AT = columnFor(OPERATION_AUDITS_TABLE, operationKey(""), "actionStartedAt");

export function decodeOperation(row: Row): Stored<OperationRecord> {
  const operation = decodeStored<OperationRecord>(OPERATIONS_TABLE, row);
  return { ...operation, input: operationInputFromStored(operation.input) };
}

export function decodeOperationAudit(row: Row): Stored<OperationAuditRow> {
  const audit = decodeStored<OperationAuditRow>(OPERATION_AUDITS_TABLE, row);
  if (!isOperationAuditRecord(audit)) {
    throw new MalformedRecordError({ aggregate: "operation-audit", key: String(row.id) }, "fails the operation audit schema");
  }
  return audit;
}

function patchForStore<T extends { input?: unknown }>(patch: T): T {
  return patch.input !== null && typeof patch.input === "object" && !Array.isArray(patch.input)
    ? { ...patch, input: operationInputForStore(patch.input as Record<string, unknown>) }
    : patch;
}

function decodeRecoveryReceipt(row: Row): Stored<GatewayRecoveryReceipt> {
  return decodeStored<GatewayRecoveryReceipt>(GATEWAY_RECOVERY_RECEIPTS_TABLE, row);
}

function escapeLike(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function createOperationsRepository(session: PostgresSession): OperationsRepository {
  const list = async (operation: string, where: string, values: readonly unknown[], order = "id") =>
    (await selectRecords(session, operation, `SELECT * FROM $schema.operations WHERE ${where} ORDER BY ${order}`, values)).map(
      decodeOperation,
    );

  return {
    async get(operationId) {
      const row = await selectByKey(session, "journal.operations.get", { table: OPERATIONS_TABLE, key: [operationId] });
      return row === null ? null : decodeOperation(row);
    },

    async getMany(operationIds) {
      const rows = await selectRecords(session, "journal.operations.getMany", "SELECT * FROM $schema.operations WHERE id = ANY($1::text[])", [
        [...operationIds],
      ]);
      return new Map(rows.map((row) => [row.id as string, decodeOperation(row)]));
    },

    listByStatus(statuses) {
      return list("journal.operations.listByStatus", "status = ANY($1::text[])", [[...statuses]]);
    },

    listUnreleasedSchedulerHandoffs(statuses) {
      return list(
        "journal.operations.listUnreleasedSchedulerHandoffs",
        "status = ANY($1::text[]) AND scheduler_handoff_released = false",
        [[...statuses]],
      );
    },

    async listByGateway(gatewayId, limit) {
      const parameters = new SqlParameters();
      const gateway = parameters.add(gatewayId, "text");
      const bound = limit === undefined ? "" : ` LIMIT ${parameters.add(limit, "integer")}`;
      const rows = await selectRecords(
        session,
        "journal.operations.listByGateway",
        `SELECT * FROM $schema.operations WHERE gateway_id = ${gateway} ORDER BY created_at DESC, id${bound}`,
        parameters.values,
      );
      return rows.map(decodeOperation);
    },

    listByInputGateway(gatewayId) {
      return list("journal.operations.listByInputGateway", "input_gateway_id = $1::text", [gatewayId]);
    },

    listForUid(uid, filter) {
      const parameters = new SqlParameters();
      const conditions = [`input_uid = ${parameters.add(uid, "text")}`];
      if (filter.statuses !== undefined) conditions.push(`status = ANY(${parameters.add([...filter.statuses], "text[]")})`);
      if (filter.kind !== undefined) conditions.push(`kind = ${parameters.add(filter.kind, "text")}`);
      return list("journal.operations.listForUid", conditions.join(" AND "), parameters.values);
    },

    listByKind(kind: OperationKind, statuses?: readonly OperationStatus[]) {
      if (statuses === undefined) return list("journal.operations.listByKind", "kind = $1::text", [kind]);
      return list("journal.operations.listByKind", "kind = $1::text AND status = ANY($2::text[])", [kind, [...statuses]]);
    },

    listReferencingUid(uid) {
      return list(
        "journal.operations.listReferencingUid",
        "input_uid = $1::text OR input_uid_raw = $1::text OR created_by = $1::text",
        [uid],
      );
    },

    listByInputUserSlugPrefix(prefix) {
      return list(
        "journal.operations.listByInputUserSlugPrefix",
        "input_user_slug LIKE $1::text ESCAPE '\\'",
        [`${escapeLike(prefix)}%`],
        "input_user_slug, id",
      );
    },

    async enqueue(operation) {
      const id = mintOperationId();
      await insertRecord(session, "journal.operations.enqueue", OPERATIONS_TABLE, operationForStore({ ...operation, id }), "create");
      return id;
    },

    async create(operation) {
      await insertRecord(session, "journal.operations.create", OPERATIONS_TABLE, operationForStore(operation), "create");
    },

    async put(operation) {
      await insertRecord(session, "journal.operations.put", OPERATIONS_TABLE, operationForStore(operation), "put");
    },

    async patch(operationId, patch, fence) {
      const table = isClearField(patch.createdBy)
        ? { ...OPERATIONS_TABLE, immutableFields: ["id", "kind", "createdAt"] }
        : OPERATIONS_TABLE;
      await updateRecord(session, "journal.operations.patch", { table, key: [operationId] }, patchForStore(patch), [
        ...revisionFence(fence?.revision),
        ...oneOfFence("status", STATUS, fence?.status),
        ...equalsFence("startedAt", STARTED_AT, fence?.startedAt),
      ]);
    },

    async delete(operationId) {
      await deleteRecord(session, "journal.operations.delete", { table: OPERATIONS_TABLE, key: [operationId] });
    },
  };
}

function createOperationAuditsRepository(session: PostgresSession): OperationAuditsRepository {
  return {
    async get(auditId) {
      const row = await selectByKey(session, "journal.audits.get", { table: OPERATION_AUDITS_TABLE, key: [auditId] });
      return row === null ? null : decodeOperationAudit(row);
    },

    async getByIdempotencyKey(idempotencyKey) {
      const rows = await selectRecords(
        session,
        "journal.audits.getByIdempotencyKey",
        "SELECT * FROM $schema.operation_audits WHERE idempotency_key = $1::text",
        [idempotencyKey],
      );
      return rows.length === 0 ? null : decodeOperationAudit(rows[0]);
    },

    async create(audit) {
      await insertRecord(session, "journal.audits.create", OPERATION_AUDITS_TABLE, audit, "create");
    },

    async patch(auditId, patch, fence) {
      await updateRecord(session, "journal.audits.patch", { table: OPERATION_AUDITS_TABLE, key: [auditId] }, patch, [
        ...revisionFence(fence?.revision),
        ...oneOfFence("status", AUDIT_STATUS, fence?.status),
        ...equalsFence("actionClaimId", ACTION_CLAIM_ID, fence?.actionClaimId),
        ...equalsFence("actionStartedAt", ACTION_STARTED_AT, fence?.actionStartedAt),
      ]);
    },

    async delete(auditId) {
      await deleteRecord(session, "journal.audits.delete", { table: OPERATION_AUDITS_TABLE, key: [auditId] });
    },
  };
}

function createRecoveryReceiptsRepository(session: PostgresSession): GatewayRecoveryReceiptsRepository {
  return {
    async get(receiptId) {
      const row = await selectByKey(session, "journal.recoveryReceipts.get", { table: GATEWAY_RECOVERY_RECEIPTS_TABLE, key: [receiptId] });
      return row === null ? null : decodeRecoveryReceipt(row);
    },

    async listReferencingUid(uid) {
      const rows = await selectRecords(
        session,
        "journal.recoveryReceipts.listReferencingUid",
        "SELECT * FROM $schema.gateway_recovery_receipts WHERE input_uid = $1::text OR input_uid_raw = $1::text ORDER BY id",
        [uid],
      );
      return rows.map(decodeRecoveryReceipt);
    },

    async create(receipt) {
      await insertRecord(session, "journal.recoveryReceipts.create", GATEWAY_RECOVERY_RECEIPTS_TABLE, receipt, "create");
    },

    async patch(receiptId, patch, fence) {
      await updateRecord(
        session,
        "journal.recoveryReceipts.patch",
        { table: GATEWAY_RECOVERY_RECEIPTS_TABLE, key: [receiptId] },
        patch,
        revisionFence(fence?.revision),
      );
    },

    async delete(receiptId) {
      await deleteRecord(session, "journal.recoveryReceipts.delete", { table: GATEWAY_RECOVERY_RECEIPTS_TABLE, key: [receiptId] });
    },
  };
}

function isAuditId(recordId: string): boolean {
  return recordId.startsWith(AUDIT_ID_PREFIX);
}

async function getJournalRecord(session: PostgresSession, operation: string, recordId: string): Promise<Stored<GlmOperationRecord> | null> {
  if (isAuditId(recordId)) {
    const row = await selectByKey(session, operation, { table: OPERATION_AUDITS_TABLE, key: [recordId] });
    return row === null ? null : decodeOperationAudit(row);
  }
  const row = await selectByKey(session, operation, { table: OPERATIONS_TABLE, key: [recordId] });
  return row === null ? null : decodeOperation(row);
}

const JOURNAL_ENTRIES = `SELECT id, created_at FROM $schema.operations UNION ALL SELECT id, created_at FROM $schema.operation_audits`;

async function listRecentJournalRecords(session: PostgresSession, page: PageRequest): Promise<Page<Stored<GlmOperationRecord>>> {
  const name = "journal.listRecent";
  const parameters = new SqlParameters();
  const limit = parameters.add(page.limit + 1, "integer");
  let after = "";
  if (page.after !== undefined) {
    const anchors = await selectRecords(session, name, `SELECT created_at FROM (${JOURNAL_ENTRIES}) entries WHERE id = $1::text`, [page.after]);
    if (anchors.length === 0) {
      throw new MissingRecordError({ aggregate: isAuditId(page.after) ? "operation-audit" : "operation", key: page.after });
    }
    after = `WHERE (created_at, id) < (${parameters.add(anchors[0].created_at, "bigint")}, ${parameters.add(page.after, "text")})`;
  }
  const entries = await selectRecords(
    session,
    name,
    `SELECT id FROM (${JOURNAL_ENTRIES}) entries ${after} ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
    parameters.values,
  );
  const ids = entries.slice(0, page.limit).map((entry) => entry.id as string);
  const auditIds = ids.filter(isAuditId);
  const operationIds = ids.filter((id) => !isAuditId(id));
  const audits =
    auditIds.length === 0
      ? []
      : await selectRecords(session, name, "SELECT * FROM $schema.operation_audits WHERE id = ANY($1::text[])", [auditIds]);
  const operations =
    operationIds.length === 0
      ? []
      : await selectRecords(session, name, "SELECT * FROM $schema.operations WHERE id = ANY($1::text[])", [operationIds]);
  const records = new Map<string, Stored<GlmOperationRecord>>();
  for (const row of audits) records.set(row.id as string, decodeOperationAudit(row));
  for (const row of operations) records.set(row.id as string, decodeOperation(row));
  const items = ids.map((id) => records.get(id)).filter((record): record is Stored<GlmOperationRecord> => record !== undefined);
  return { items, next: entries.length > page.limit ? ids[ids.length - 1] : null };
}

export function createPostgresJournalRepositories(session: PostgresSession): JournalRepositories {
  return {
    operations: createOperationsRepository(session),
    audits: createOperationAuditsRepository(session),
    recoveryReceipts: createRecoveryReceiptsRepository(session),
    getRecord(recordId) {
      return getJournalRecord(session, "journal.getRecord", recordId);
    },
    listRecent(page) {
      return listRecentJournalRecords(session, page);
    },
  };
}
