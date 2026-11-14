import { placementReceiptDocId } from "@octogee/shared/types/placement-receipts";
import { MalformedRecordError, MissingRecordError } from "../errors.js";
import { createPostgresUserRecordsRepository } from "./user-records.js";
import { deleteRecord, insertRecord, selectByKey, selectRecords, updateRecord } from "./records.js";
import { SqlParameters } from "./sql.js";
import { column, decodeRecord, decodeStored, revisionOf } from "./values.js";
const NULLABLE = { nullAs: "null" };
const GATEWAY_STATE_STORE_KEY = "_gateway-state";
const AUXILIARY_STORE_KEY_PREFIX = "_gateway-";
const RESERVED_STORE_KEY_PREFIX = "_";
const PLACEMENT_RECEIPTS_TABLE = {
    table: "placement_receipts",
    aggregate: "placement-receipt",
    keyColumns: ["uid", "receipt_id"],
    columns: [
        column("uid", "text"),
        column("receiptId", "text"),
        column("schemaVersion", "integer"),
        column("kind", "text"),
        column("at", "bigint"),
        column("builderSlug", "text", { ...NULLABLE, column: "user_slug" }),
        column("leaseId", "text"),
        column("generation", "integer"),
        column("cause", "text", NULLABLE),
        column("sizingTier", "text", NULLABLE),
        column("entitlementTier", "text", NULLABLE),
        column("gatewayId", "text"),
        column("sharedGatewayId", "text", NULLABLE),
        column("requestedAt", "bigint", NULLABLE),
        column("wakeDurationMs", "bigint", NULLABLE),
        column("activeDurationMs", "bigint", NULLABLE),
        column("operationId", "text", NULLABLE),
        column("retirementOperationId", "text", NULLABLE),
        column("operatorTerminated", "boolean"),
        column("error", "text", NULLABLE),
    ],
};
const SCHEDULE_TRANSFERS_TABLE = {
    table: "schedule_transfers",
    aggregate: "schedule-transfer",
    keyColumns: ["uid", "migration_id"],
    columns: [
        column("uid", "text"),
        column("migrationId", "text"),
        column("slug", "text"),
        column("sourceGatewayId", "text"),
        column("targetGatewayId", "text"),
        column("records", "jsonb"),
        column("skipped", "jsonb"),
        column("snapshotAt", "bigint"),
        column("restoreAttemptedTo", "text"),
        column("restoreAttemptedAt", "bigint"),
        column("restoredTo", "text"),
        column("restoredAt", "bigint"),
        column("restoreFailures", "jsonb"),
    ],
};
const USER_ACCOUNTS_TABLE = {
    table: "user_accounts",
    aggregate: "user-account",
    keyColumns: ["uid"],
    columns: [column("uid", "text"), column("name", "text"), column("email", "text"), column("createdAt", "bigint")],
};
const AGENT_STORES_TABLE = {
    table: "agent_stores",
    aggregate: "agent-store",
    keyColumns: ["uid", "store_key"],
    columns: [
        column("uid", "text"),
        column("storeKey", "text"),
        column("storeId", "text"),
        column("agentId", "text"),
        column("family", "text"),
        column("schema", "text"),
        column("gatewayId", "text"),
        column("generation", "integer"),
        column("assignmentEpoch", "integer"),
        column("recordedAt", "bigint"),
    ],
};
const AGENT_MODELS_TABLE = {
    table: "user_agent_models",
    aggregate: "agent-model-selection",
    keyColumns: ["uid", "agent_id"],
    columns: [
        column("uid", "text"),
        column("agentId", "text"),
        column("primary", "text", { column: "primary_model" }),
        column("fallbacks", "jsonb", { column: "fallback_models" }),
        column("updatedAt", "bigint"),
    ],
};
const SESSION_MODEL_AUDIT_TABLE = {
    table: "session_model_audit",
    aggregate: "session-model-audit",
    keyColumns: ["audit_id"],
    immutableFields: ["actorUid", "channelId", "workspaceSlug", "projectId", "agentId", "operation", "requestedModel", "createdAt"],
    columns: [
        column("auditId", "text"),
        column("actorUid", "text"),
        column("channelId", "text"),
        column("workspaceSlug", "text"),
        column("projectId", "text", { nullAs: "null" }),
        column("agentId", "text"),
        column("operation", "text"),
        column("requestedModel", "text", { nullAs: "null" }),
        column("outcome", "text"),
        column("commandPostId", "text", { nullAs: "null" }),
        column("replyPostId", "text", { nullAs: "null" }),
        column("resultingModel", "text", { nullAs: "null" }),
        column("createdAt", "bigint"),
        column("completedAt", "bigint", { nullAs: "null" }),
    ],
};
function withoutKeys(record, keys) {
    return Object.fromEntries(Object.entries(record).filter(([field]) => !keys.includes(field)));
}
function decodePlacementReceipt(row) {
    return withoutKeys(decodeRecord(PLACEMENT_RECEIPTS_TABLE, row), ["uid", "receiptId"]);
}
function createPlacementReceiptsRepository(session) {
    return {
        async get(uid, leaseId, generation, kind) {
            const row = await selectByKey(session, "builders.placementReceipts.get", {
                table: PLACEMENT_RECEIPTS_TABLE,
                key: [uid, placementReceiptDocId(leaseId, generation, kind)],
            });
            return row === null ? null : decodePlacementReceipt(row);
        },
        async list(uid, page) {
            const name = "builders.placementReceipts.list";
            const parameters = new SqlParameters();
            const conditions = [`uid = ${parameters.add(uid, "text")}`];
            if (page.after !== undefined) {
                const anchor = await selectByKey(session, name, { table: PLACEMENT_RECEIPTS_TABLE, key: [uid, page.after] });
                if (anchor === null)
                    throw new MissingRecordError({ aggregate: "placement-receipt", key: `${uid}/${page.after}` });
                conditions.push(`(at, receipt_id) < (${parameters.add(anchor.at, "bigint")}, ${parameters.add(page.after, "text")})`);
            }
            const rows = await selectRecords(session, name, `SELECT * FROM $schema.placement_receipts WHERE ${conditions.join(" AND ")}
          ORDER BY at DESC, receipt_id DESC LIMIT ${parameters.add(page.limit + 1, "integer")}`, parameters.values);
            const pageRows = rows.slice(0, page.limit);
            return {
                items: pageRows.map(decodePlacementReceipt),
                next: rows.length > page.limit ? pageRows[pageRows.length - 1].receipt_id : null,
            };
        },
        async create(uid, receipt) {
            const receiptId = placementReceiptDocId(receipt.leaseId, receipt.generation, receipt.kind);
            await insertRecord(session, "builders.placementReceipts.create", PLACEMENT_RECEIPTS_TABLE, { ...receipt, uid, receiptId }, "create");
        },
    };
}
function createScheduleTransfersRepository(session) {
    return {
        async get(uid, migrationId) {
            const row = await selectByKey(session, "builders.scheduleTransfers.get", { table: SCHEDULE_TRANSFERS_TABLE, key: [uid, migrationId] });
            if (row === null)
                return null;
            return withoutKeys(decodeStored(SCHEDULE_TRANSFERS_TABLE, row), ["uid"]);
        },
        async put(uid, transfer) {
            await insertRecord(session, "builders.scheduleTransfers.put", SCHEDULE_TRANSFERS_TABLE, { ...transfer, uid }, "put");
        },
        async patch(uid, migrationId, patch) {
            await updateRecord(session, "builders.scheduleTransfers.patch", { table: SCHEDULE_TRANSFERS_TABLE, key: [uid, migrationId] }, patch, []);
        },
        async listUnrestored() {
            const rows = await selectRecords(session, "builders.scheduleTransfers.listUnrestored", "SELECT * FROM $schema.schedule_transfers WHERE restored_to IS NULL ORDER BY snapshot_at, uid, migration_id");
            return rows.map((row) => ({
                uid: row.uid,
                transfer: withoutKeys(decodeStored(SCHEDULE_TRANSFERS_TABLE, row), ["uid"]),
            }));
        },
    };
}
export function agentStoreKeyOf(record) {
    if (record.kind === "gateway-state")
        return GATEWAY_STATE_STORE_KEY;
    if (record.kind === "auxiliary")
        return `${AUXILIARY_STORE_KEY_PREFIX}${record.family}`;
    if (record.agentId.startsWith(RESERVED_STORE_KEY_PREFIX)) {
        throw new TypeError(`agent store id ${record.agentId} collides with the reserved gateway store keys`);
    }
    return record.agentId;
}
function agentStoreRow(uid, record) {
    return {
        uid,
        storeKey: agentStoreKeyOf(record),
        storeId: record.storeId,
        agentId: record.kind === "agent" ? record.agentId : null,
        family: record.kind === "auxiliary" ? record.family : null,
        schema: record.schema,
        gatewayId: record.gatewayId,
        generation: record.generation,
        assignmentEpoch: record.assignmentEpoch,
        recordedAt: record.recordedAt,
    };
}
function decodeAgentStore(row) {
    const storeKey = row.store_key;
    const record = { aggregate: "agent-store", key: `${row.uid}/${storeKey}` };
    const common = {
        storeId: row.store_id,
        schema: row.schema,
        gatewayId: row.gateway_id ?? null,
        generation: row.generation ?? null,
        assignmentEpoch: row.assignment_epoch ?? null,
        recordedAt: row.recorded_at,
        revision: revisionOf(row),
    };
    if (row.store_kind === "gateway-state")
        return { kind: "gateway-state", ...common };
    if (row.store_kind === "auxiliary") {
        const family = row.family;
        if (storeKey !== `${AUXILIARY_STORE_KEY_PREFIX}${family}`) {
            throw new MalformedRecordError(record, `family ${family} does not name the ${storeKey} auxiliary store`);
        }
        return { kind: "auxiliary", family, ...common };
    }
    return { kind: "agent", agentId: storeKey, ...common };
}
function createAgentStoresRepository(session) {
    return {
        async list(uid) {
            const rows = await selectRecords(session, "builders.agentStores.list", "SELECT * FROM $schema.agent_stores WHERE uid = $1::text ORDER BY store_key", [uid]);
            return rows.map(decodeAgentStore);
        },
        async put(uid, record) {
            await insertRecord(session, "builders.agentStores.put", AGENT_STORES_TABLE, agentStoreRow(uid, record), "put");
        },
        async delete(uid, storeKey) {
            await deleteRecord(session, "builders.agentStores.delete", { table: AGENT_STORES_TABLE, key: [uid, storeKey] });
        },
    };
}
function decodeUserAccount(row) {
    return decodeStored(USER_ACCOUNTS_TABLE, row);
}
function createUserAccountsRepository(session) {
    return {
        async get(uid) {
            const row = await selectByKey(session, "users.accounts.get", { table: USER_ACCOUNTS_TABLE, key: [uid] });
            return row === null ? null : decodeUserAccount(row);
        },
        async getMany(uids) {
            const unique = [...new Set(uids)];
            if (unique.length === 0)
                return new Map();
            const rows = await selectRecords(session, "users.accounts.getMany", "SELECT * FROM $schema.user_accounts WHERE uid = ANY($1::text[]) ORDER BY uid", [unique]);
            return new Map(rows.map((row) => [row.uid, decodeUserAccount(row)]));
        },
        async listAll() {
            const rows = await selectRecords(session, "users.accounts.listAll", "SELECT * FROM $schema.user_accounts ORDER BY uid");
            return rows.map(decodeUserAccount);
        },
        async create(account) {
            await insertRecord(session, "users.accounts.create", USER_ACCOUNTS_TABLE, account, "create");
        },
    };
}
function createAgentModelSelectionsRepository(session) {
    return {
        async list(uid) {
            const rows = await selectRecords(session, "users.agentModels.list", "SELECT * FROM $schema.user_agent_models WHERE uid = $1::text ORDER BY agent_id", [uid]);
            return rows.map((row) => decodeStored(AGENT_MODELS_TABLE, row));
        },
        async put(selection) {
            await insertRecord(session, "users.agentModels.put", AGENT_MODELS_TABLE, selection, "put");
        },
        async delete(uid, agentId) {
            await deleteRecord(session, "users.agentModels.delete", { table: AGENT_MODELS_TABLE, key: [uid, agentId] });
        },
    };
}
function createSessionModelAuditRepository(session) {
    return {
        async get(auditId) {
            const row = await selectByKey(session, "users.sessionModelAudit.get", { table: SESSION_MODEL_AUDIT_TABLE, key: [auditId] });
            return row === null ? null : decodeStored(SESSION_MODEL_AUDIT_TABLE, row);
        },
        async create(entry) {
            await insertRecord(session, "users.sessionModelAudit.create", SESSION_MODEL_AUDIT_TABLE, { ...entry, outcome: "pending", commandPostId: null, replyPostId: null, resultingModel: null, completedAt: null }, "create");
        },
        async complete(auditId, completion) {
            await updateRecord(session, "users.sessionModelAudit.complete", { table: SESSION_MODEL_AUDIT_TABLE, key: [auditId] }, completion, []);
        },
    };
}
export const createPostgresUserRepositories = (session) => ({
    records: createPostgresUserRecordsRepository(session),
    accounts: createUserAccountsRepository(session),
    placementReceipts: createPlacementReceiptsRepository(session),
    scheduleTransfers: createScheduleTransfersRepository(session),
    agentStores: createAgentStoresRepository(session),
    agentModels: createAgentModelSelectionsRepository(session),
    sessionModelAudit: createSessionModelAuditRepository(session),
});
