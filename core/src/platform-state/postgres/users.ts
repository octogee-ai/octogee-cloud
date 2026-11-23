import type { UserAuxiliaryFamily } from "@octogee/shared/types/fleet-broker";
import type { ScheduleTransferDoc } from "@octogee/shared/types/fleet-controller";
import { placementReceiptDocId, type PlacementReceipt } from "@octogee/shared/types/placement-receipts";
import type {
  AgentModelSelectionRecord,
  AgentModelSelectionsRepository,
  AgentStoreRecord,
  AgentStoresRepository,
  ConnectFlowRecord,
  ConnectFlowsRepository,
  ConnectorIntegrationRecord,
  ConnectorIntegrationsRepository,
  ModelCredentialRecord,
  ModelCredentialsRepository,
  PlacementReceiptsRepository,
  ScheduleTransfersRepository,
  SessionModelAuditRecord,
  SessionModelAuditRepository,
  SubscriptionFlowRecord,
  SubscriptionFlowsRepository,
  SubscriptionLinkRecord,
  SubscriptionLinksRepository,
  UserAccountRecord,
  UserAccountsRepository,
  UserRepositories,
} from "../users.js";
import { MalformedRecordError, MissingRecordError, type RecordKey } from "../errors.js";
import type { Page, Stored } from "../store.js";
import { createPostgresUserRecordsRepository } from "./user-records.js";
import { deleteRecord, insertRecord, selectByKey, selectRecords, updateRecord } from "./records.js";
import type { PostgresRepositoryFactory, PostgresSession } from "./session.js";
import { SqlParameters, type Row } from "./sql.js";
import { column, decodeRecord, decodeStored, revisionOf, type TableSpec } from "./values.js";

const NULLABLE = { nullAs: "null" } as const;
const GATEWAY_STATE_STORE_KEY = "_gateway-state";
const AUXILIARY_STORE_KEY_PREFIX = "_gateway-";
const RESERVED_STORE_KEY_PREFIX = "_";

const PLACEMENT_RECEIPTS_TABLE: TableSpec = {
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

const SCHEDULE_TRANSFERS_TABLE: TableSpec = {
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
    column("nativeExport", "jsonb"),
    column("restoreAttemptedTo", "text"),
    column("restoreAttemptedAt", "bigint"),
    column("restoredTo", "text"),
    column("restoredAt", "bigint"),
    column("restoreFailures", "jsonb"),
  ],
};

const USER_ACCOUNTS_TABLE: TableSpec = {
  table: "user_accounts",
  aggregate: "user-account",
  keyColumns: ["uid"],
  columns: [column("uid", "text"), column("name", "text"), column("email", "text"), column("createdAt", "bigint")],
};

const AGENT_STORES_TABLE: TableSpec = {
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

const AGENT_MODELS_TABLE: TableSpec = {
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

const SESSION_MODEL_AUDIT_TABLE: TableSpec = {
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

const MODEL_CREDENTIALS_TABLE: TableSpec = {
  table: "user_model_credentials",
  aggregate: "model-credential",
  keyColumns: ["uid"],
  columns: [
    column("uid", "text"),
    column("active", "boolean"),
    column("provider", "text"),
    column("mode", "text"),
    column("status", "text"),
    column("reasonCode", "text"),
    column("secretName", "text"),
    column("fingerprint", "text", { nullAs: "null" }),
    column("keyHash", "text", { nullAs: "null" }),
    column("baseUrl", "text", { nullAs: "null" }),
    column("model", "text", { nullAs: "null" }),
    column("addedAt", "bigint"),
    column("lastUsedAt", "bigint", { nullAs: "null" }),
  ],
};

const SUBSCRIPTION_LINKS_TABLE: TableSpec = {
  table: "user_subscription_links",
  aggregate: "subscription-link",
  keyColumns: ["uid", "provider"],
  columns: [
    column("uid", "text"),
    column("provider", "text"),
    column("modelCredentialProvider", "text"),
    column("status", "text"),
    column("gatewayId", "text", { nullAs: "null" }),
    column("flowId", "text", { nullAs: "null" }),
    column("reason", "text", { nullAs: "null" }),
    column("updatedAt", "bigint"),
  ],
};

const SUBSCRIPTION_FLOWS_TABLE: TableSpec = {
  table: "subscription_flows",
  aggregate: "subscription-flow",
  keyColumns: ["flow_id"],
  immutableFields: ["uid", "gatewayId", "agentId", "provider", "modelCredentialProvider", "createdAt", "expireAt"],
  columns: [
    column("flowId", "text"),
    column("uid", "text"),
    column("gatewayId", "text"),
    column("agentId", "text"),
    column("provider", "text"),
    column("modelCredentialProvider", "text", { nullAs: "null" }),
    column("createdAt", "bigint"),
    column("expireAt", "bigint"),
    column("consumedAt", "bigint", { nullAs: "null" }),
    column("captureClaimId", "text", { nullAs: "null" }),
    column("captureClaimedAt", "bigint", { nullAs: "null" }),
    column("modelPinnedAt", "bigint", { nullAs: "null" }),
  ],
};

const CONNECTOR_INTEGRATIONS_TABLE: TableSpec = {
  table: "user_connector_integrations",
  aggregate: "connector-integration",
  keyColumns: ["uid", "connector_id"],
  columns: [
    column("uid", "text"),
    column("connectorId", "text"),
    column("status", "text"),
    column("accountLabel", "text", NULLABLE),
    column("scopes", "jsonb"),
    column("captureMethod", "text", NULLABLE),
    column("error", "text", NULLABLE),
    column("detail", "jsonb"),
    column("connectedAt", "bigint", NULLABLE),
    column("verifiedAt", "bigint", NULLABLE),
    column("updatedAt", "bigint"),
  ],
};

const CONNECT_FLOWS_TABLE: TableSpec = {
  table: "connect_flows",
  aggregate: "connect-flow",
  keyColumns: ["flow_id"],
  immutableFields: ["uid", "connectorId", "kind", "requestedScopes", "codeVerifier", "encryptedDeviceCode", "createdAt", "expireAt"],
  columns: [
    column("flowId", "text"),
    column("uid", "text"),
    column("connectorId", "text"),
    column("kind", "text"),
    column("requestedScopes", "jsonb"),
    column("codeVerifier", "text", NULLABLE),
    column("encryptedDeviceCode", "text", NULLABLE),
    column("createdAt", "bigint"),
    column("expireAt", "bigint"),
    column("consumedAt", "bigint", NULLABLE),
    column("outcome", "text", NULLABLE),
  ],
};

function withoutKeys<T>(record: Readonly<Record<string, unknown>>, keys: readonly string[]): T {
  return Object.fromEntries(Object.entries(record).filter(([field]) => !keys.includes(field))) as T;
}

function decodePlacementReceipt(row: Row): PlacementReceipt {
  return withoutKeys<PlacementReceipt>(decodeRecord(PLACEMENT_RECEIPTS_TABLE, row), ["uid", "receiptId"]);
}

function createPlacementReceiptsRepository(session: PostgresSession): PlacementReceiptsRepository {
  return {
    async get(uid, leaseId, generation, kind) {
      const row = await selectByKey(session, "builders.placementReceipts.get", {
        table: PLACEMENT_RECEIPTS_TABLE,
        key: [uid, placementReceiptDocId(leaseId, generation, kind)],
      });
      return row === null ? null : decodePlacementReceipt(row);
    },

    async list(uid, page): Promise<Page<PlacementReceipt>> {
      const name = "builders.placementReceipts.list";
      const parameters = new SqlParameters();
      const conditions = [`uid = ${parameters.add(uid, "text")}`];
      if (page.after !== undefined) {
        const anchor = await selectByKey(session, name, { table: PLACEMENT_RECEIPTS_TABLE, key: [uid, page.after] });
        if (anchor === null) throw new MissingRecordError({ aggregate: "placement-receipt", key: `${uid}/${page.after}` });
        conditions.push(`(at, receipt_id) < (${parameters.add(anchor.at, "bigint")}, ${parameters.add(page.after, "text")})`);
      }
      const rows = await selectRecords(
        session,
        name,
        `SELECT * FROM $schema.placement_receipts WHERE ${conditions.join(" AND ")}
          ORDER BY at DESC, receipt_id DESC LIMIT ${parameters.add(page.limit + 1, "integer")}`,
        parameters.values,
      );
      const pageRows = rows.slice(0, page.limit);
      return {
        items: pageRows.map(decodePlacementReceipt),
        next: rows.length > page.limit ? (pageRows[pageRows.length - 1].receipt_id as string) : null,
      };
    },

    async create(uid, receipt) {
      const receiptId = placementReceiptDocId(receipt.leaseId, receipt.generation, receipt.kind);
      await insertRecord(session, "builders.placementReceipts.create", PLACEMENT_RECEIPTS_TABLE, { ...receipt, uid, receiptId }, "create");
    },
  };
}

function createScheduleTransfersRepository(session: PostgresSession): ScheduleTransfersRepository {
  return {
    async get(uid, migrationId) {
      const row = await selectByKey(session, "builders.scheduleTransfers.get", { table: SCHEDULE_TRANSFERS_TABLE, key: [uid, migrationId] });
      if (row === null) return null;
      return withoutKeys<Stored<ScheduleTransferDoc>>(decodeStored(SCHEDULE_TRANSFERS_TABLE, row), ["uid"]);
    },

    async put(uid, transfer) {
      await insertRecord(session, "builders.scheduleTransfers.put", SCHEDULE_TRANSFERS_TABLE, { ...transfer, uid }, "put");
    },

    async patch(uid, migrationId, patch) {
      await updateRecord(session, "builders.scheduleTransfers.patch", { table: SCHEDULE_TRANSFERS_TABLE, key: [uid, migrationId] }, patch, []);
    },

    async listUnrestored() {
      const rows = await selectRecords(
        session,
        "builders.scheduleTransfers.listUnrestored",
        "SELECT * FROM $schema.schedule_transfers WHERE restored_to IS NULL AND native_export IS NULL ORDER BY snapshot_at, uid, migration_id",
      );
      return rows.map((row) => ({
        uid: row.uid as string,
        transfer: withoutKeys<Stored<ScheduleTransferDoc>>(decodeStored(SCHEDULE_TRANSFERS_TABLE, row), ["uid"]),
      }));
    },
  };
}

export function agentStoreKeyOf(record: AgentStoreRecord): string {
  if (record.kind === "gateway-state") return GATEWAY_STATE_STORE_KEY;
  if (record.kind === "auxiliary") return `${AUXILIARY_STORE_KEY_PREFIX}${record.family}`;
  if (record.agentId.startsWith(RESERVED_STORE_KEY_PREFIX)) {
    throw new TypeError(`agent store id ${record.agentId} collides with the reserved gateway store keys`);
  }
  return record.agentId;
}

function agentStoreRow(uid: string, record: AgentStoreRecord): Readonly<Record<string, unknown>> {
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

function decodeAgentStore(row: Row): Stored<AgentStoreRecord> {
  const storeKey = row.store_key as string;
  const record: RecordKey = { aggregate: "agent-store", key: `${row.uid as string}/${storeKey}` };
  const common = {
    storeId: row.store_id as string,
    schema: row.schema as string,
    gatewayId: (row.gateway_id as string | null) ?? null,
    generation: (row.generation as number | null) ?? null,
    assignmentEpoch: (row.assignment_epoch as number | null) ?? null,
    recordedAt: row.recorded_at as number,
    revision: revisionOf(row),
  };
  if (row.store_kind === "gateway-state") return { kind: "gateway-state", ...common };
  if (row.store_kind === "auxiliary") {
    const family = row.family as UserAuxiliaryFamily;
    if (storeKey !== `${AUXILIARY_STORE_KEY_PREFIX}${family}`) {
      throw new MalformedRecordError(record, `family ${family} does not name the ${storeKey} auxiliary store`);
    }
    return { kind: "auxiliary", family, ...common };
  }
  return { kind: "agent", agentId: storeKey, ...common };
}

function createAgentStoresRepository(session: PostgresSession): AgentStoresRepository {
  return {
    async list(uid) {
      const rows = await selectRecords(
        session,
        "builders.agentStores.list",
        "SELECT * FROM $schema.agent_stores WHERE uid = $1::text ORDER BY store_key",
        [uid],
      );
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

function decodeUserAccount(row: Row): Stored<UserAccountRecord> {
  return decodeStored<UserAccountRecord>(USER_ACCOUNTS_TABLE, row);
}

function createUserAccountsRepository(session: PostgresSession): UserAccountsRepository {
  return {
    async get(uid) {
      const row = await selectByKey(session, "users.accounts.get", { table: USER_ACCOUNTS_TABLE, key: [uid] });
      return row === null ? null : decodeUserAccount(row);
    },

    async getMany(uids) {
      const unique = [...new Set(uids)];
      if (unique.length === 0) return new Map();
      const rows = await selectRecords(
        session,
        "users.accounts.getMany",
        "SELECT * FROM $schema.user_accounts WHERE uid = ANY($1::text[]) ORDER BY uid",
        [unique],
      );
      return new Map(rows.map((row) => [row.uid as string, decodeUserAccount(row)]));
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

function createAgentModelSelectionsRepository(session: PostgresSession): AgentModelSelectionsRepository {
  return {
    async list(uid) {
      const rows = await selectRecords(
        session,
        "users.agentModels.list",
        "SELECT * FROM $schema.user_agent_models WHERE uid = $1::text ORDER BY agent_id",
        [uid],
      );
      return rows.map((row) => decodeStored<AgentModelSelectionRecord>(AGENT_MODELS_TABLE, row));
    },

    async put(selection) {
      await insertRecord(session, "users.agentModels.put", AGENT_MODELS_TABLE, selection, "put");
    },

    async delete(uid, agentId) {
      await deleteRecord(session, "users.agentModels.delete", { table: AGENT_MODELS_TABLE, key: [uid, agentId] });
    },
  };
}

function createSessionModelAuditRepository(session: PostgresSession): SessionModelAuditRepository {
  return {
    async get(auditId) {
      const row = await selectByKey(session, "users.sessionModelAudit.get", { table: SESSION_MODEL_AUDIT_TABLE, key: [auditId] });
      return row === null ? null : decodeStored<SessionModelAuditRecord>(SESSION_MODEL_AUDIT_TABLE, row);
    },

    async create(entry) {
      await insertRecord(
        session,
        "users.sessionModelAudit.create",
        SESSION_MODEL_AUDIT_TABLE,
        { ...entry, outcome: "pending", commandPostId: null, replyPostId: null, resultingModel: null, completedAt: null },
        "create",
      );
    },

    async complete(auditId, completion) {
      await updateRecord(session, "users.sessionModelAudit.complete", { table: SESSION_MODEL_AUDIT_TABLE, key: [auditId] }, completion, []);
    },
  };
}

function createModelCredentialsRepository(session: PostgresSession): ModelCredentialsRepository {
  return {
    async get(uid) {
      const row = await selectByKey(session, "users.modelCredentials.get", { table: MODEL_CREDENTIALS_TABLE, key: [uid] });
      return row === null ? null : decodeStored<ModelCredentialRecord>(MODEL_CREDENTIALS_TABLE, row);
    },

    async put(credential) {
      await insertRecord(session, "users.modelCredentials.put", MODEL_CREDENTIALS_TABLE, credential, "put");
    },

    async delete(uid) {
      await deleteRecord(session, "users.modelCredentials.delete", { table: MODEL_CREDENTIALS_TABLE, key: [uid] });
    },
  };
}

function createSubscriptionLinksRepository(session: PostgresSession): SubscriptionLinksRepository {
  return {
    async list(uid) {
      const rows = await selectRecords(
        session,
        "users.subscriptionLinks.list",
        "SELECT * FROM $schema.user_subscription_links WHERE uid = $1::text ORDER BY provider",
        [uid],
      );
      return rows.map((row) => decodeStored<SubscriptionLinkRecord>(SUBSCRIPTION_LINKS_TABLE, row));
    },

    async put(link) {
      await insertRecord(session, "users.subscriptionLinks.put", SUBSCRIPTION_LINKS_TABLE, link, "put");
    },
  };
}

function createSubscriptionFlowsRepository(session: PostgresSession): SubscriptionFlowsRepository {
  return {
    async get(flowId) {
      const row = await selectByKey(session, "users.subscriptionFlows.get", { table: SUBSCRIPTION_FLOWS_TABLE, key: [flowId] });
      return row === null ? null : decodeStored<SubscriptionFlowRecord>(SUBSCRIPTION_FLOWS_TABLE, row);
    },

    async create(flow) {
      await insertRecord(
        session,
        "users.subscriptionFlows.create",
        SUBSCRIPTION_FLOWS_TABLE,
        { ...flow, consumedAt: null, captureClaimId: null, captureClaimedAt: null, modelPinnedAt: null },
        "create",
      );
    },

    async update(flowId, progress) {
      await updateRecord(session, "users.subscriptionFlows.update", { table: SUBSCRIPTION_FLOWS_TABLE, key: [flowId] }, progress, []);
    },
  };
}

function createConnectorIntegrationsRepository(session: PostgresSession): ConnectorIntegrationsRepository {
  return {
    async get(uid, connectorId) {
      const row = await selectByKey(session, "users.connectorIntegrations.get", {
        table: CONNECTOR_INTEGRATIONS_TABLE,
        key: [uid, connectorId],
      });
      return row === null ? null : decodeStored<ConnectorIntegrationRecord>(CONNECTOR_INTEGRATIONS_TABLE, row);
    },

    async list(uid) {
      const rows = await selectRecords(
        session,
        "users.connectorIntegrations.list",
        "SELECT * FROM $schema.user_connector_integrations WHERE uid = $1::text ORDER BY connector_id",
        [uid],
      );
      return rows.map((row) => decodeStored<ConnectorIntegrationRecord>(CONNECTOR_INTEGRATIONS_TABLE, row));
    },

    async put(integration) {
      await insertRecord(session, "users.connectorIntegrations.put", CONNECTOR_INTEGRATIONS_TABLE, integration, "put");
    },
  };
}

function createConnectFlowsRepository(session: PostgresSession): ConnectFlowsRepository {
  return {
    async get(flowId) {
      const row = await selectByKey(session, "users.connectFlows.get", { table: CONNECT_FLOWS_TABLE, key: [flowId] });
      return row === null ? null : decodeStored<ConnectFlowRecord>(CONNECT_FLOWS_TABLE, row);
    },

    async create(flow) {
      await insertRecord(
        session,
        "users.connectFlows.create",
        CONNECT_FLOWS_TABLE,
        { ...flow, consumedAt: null, outcome: null },
        "create",
      );
    },

    async update(flowId, progress) {
      await updateRecord(session, "users.connectFlows.update", { table: CONNECT_FLOWS_TABLE, key: [flowId] }, progress, []);
    },

    async deleteForUser(uid) {
      await session.write(
        "users.connectFlows.deleteForUser",
        { aggregate: "connect-flow", key: uid },
        "DELETE FROM $schema.connect_flows WHERE uid = $1::text",
        [uid],
      );
    },
  };
}

export const createPostgresUserRepositories: PostgresRepositoryFactory<UserRepositories> = (session) => ({
  records: createPostgresUserRecordsRepository(session),
  accounts: createUserAccountsRepository(session),
  placementReceipts: createPlacementReceiptsRepository(session),
  scheduleTransfers: createScheduleTransfersRepository(session),
  agentStores: createAgentStoresRepository(session),
  agentModels: createAgentModelSelectionsRepository(session),
  sessionModelAudit: createSessionModelAuditRepository(session),
  modelCredentials: createModelCredentialsRepository(session),
  subscriptionLinks: createSubscriptionLinksRepository(session),
  subscriptionFlows: createSubscriptionFlowsRepository(session),
  connectorIntegrations: createConnectorIntegrationsRepository(session),
  connectFlows: createConnectFlowsRepository(session),
});
