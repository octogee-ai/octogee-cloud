import { parsePlatformConnectConfig, parsePlatformFreeConfig, parsePlatformModelConfig } from "@octogee/shared/types/platform-config";
import { parseSharedGatewayAutoscalingConfig } from "@octogee/shared/types/shared-gateway-pool";
import { isGatewaySizingProfile, type GatewaySizingProfile } from "@octogee/shared/types/sizing-profile";
import {
  type ConfigRecord,
  type ConfigRepositories,
  type MattermostAdminIdentity,
  type OrchestratorConfig,
  type OrchestratorConfigPatch,
  type PlatformConfigEntry,
  type PlatformConfigKey,
  type PlatformConfigValues,
} from "../config.js";
import { MalformedRecordError, MissingRecordError, type RecordKey } from "../errors.js";
import type { OpaqueMap, Revision, Stored } from "../store.js";
import { upsertRecord } from "./fleet-registry.js";
import { deleteRecord, insertRecord, revisionFence, selectByKey, updateRecord } from "./records.js";
import type { PostgresSession } from "./session.js";
import type { Row } from "./sql.js";
import { castOf, column, decodeStored, type TableSpec } from "./values.js";
import type { PostgresWatchSource } from "./watch-sources.js";

const ORCHESTRATOR_ID = "orchestrator";
const WRITER_QUIESCENCE_ID = "platformMigrationWriterQuiescence";
const MATTERMOST_ADMIN_ID = "mattermostAdmin";

const ORCHESTRATOR_TABLE: TableSpec = {
  table: "orchestrator_config",
  aggregate: "orchestrator-config",
  keyColumns: ["id"],
  columns: [
    column("id", "text"),
    column("sharedAutoscalingEnabled", "boolean"),
    column("sharedUsersPerGateway", "integer", { column: "shared_users_per_gateway" }),
    column("defaultGatewayId", "text", { nullAs: "null" }),
    column("disposableGatewayIdleMs", "bigint", { nullAs: "null" }),
    column("placementUpdatedAt", "bigint", { nullAs: "null" }),
    column("placementUpdatedBy", "text", { nullAs: "null" }),
    column("sizingProfiles", "jsonb"),
  ],
  immutableFields: ["id"],
};

const PLATFORM_CONFIG_TABLE: TableSpec = {
  table: "platform_config",
  aggregate: "platform-config",
  keyColumns: ["key"],
  columns: [
    column("key", "text"),
    column("value", "jsonb"),
    column("updatedAt", "bigint", { nullAs: "null" }),
    column("updatedBy", "text", { nullAs: "null" }),
  ],
};

const WRITER_QUIESCENCE_TABLE: TableSpec = {
  table: "writer_quiescence",
  aggregate: "writer-quiescence",
  keyColumns: ["id"],
  columns: [column("id", "text"), column("record", "jsonb")],
};

const MATTERMOST_ADMIN_TABLE: TableSpec = {
  table: "channel_host_admin",
  aggregate: "mattermost-admin",
  keyColumns: ["id"],
  columns: [column("id", "text"), column("userId", "text"), column("proxyUrl", "text", { nullAs: "null" }), column("updatedAt", "bigint")],
};

const PLATFORM_CONFIG_PARSERS: { readonly [K in PlatformConfigKey]: (value: unknown) => PlatformConfigValues[K] | null } = {
  models: parsePlatformModelConfig,
  free: parsePlatformFreeConfig,
  connect: parsePlatformConnectConfig,
};

const ORCHESTRATOR_KEY: RecordKey = { aggregate: "orchestrator-config", key: ORCHESTRATOR_ID };
const platformKey = (key: PlatformConfigKey): RecordKey => ({ aggregate: "platform-config", key });
const ORCHESTRATOR_TARGET = { table: ORCHESTRATOR_TABLE, key: [ORCHESTRATOR_ID] };
const WRITER_QUIESCENCE_TARGET = { table: WRITER_QUIESCENCE_TABLE, key: [WRITER_QUIESCENCE_ID] };
const MATTERMOST_ADMIN_TARGET = { table: MATTERMOST_ADMIN_TABLE, key: [MATTERMOST_ADMIN_ID] };

type Fields = Record<string, unknown>;

function isPlainMap(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertSizingProfiles(value: unknown): Record<string, GatewaySizingProfile> {
  if (!isPlainMap(value)) throw new MalformedRecordError(ORCHESTRATOR_KEY, "sizingProfiles is not a map");
  for (const [sizingKey, profile] of Object.entries(value)) {
    if (!isGatewaySizingProfile(profile)) {
      throw new MalformedRecordError(ORCHESTRATOR_KEY, `sizingProfiles.${sizingKey} is not a gateway sizing profile`);
    }
  }
  return value as Record<string, GatewaySizingProfile>;
}

function orchestratorColumns(patch: OrchestratorConfigPatch): Fields {
  const { sharedGatewayAutoscaling: autoscaling, ...fields } = patch;
  if (autoscaling !== undefined) {
    const parsed = parseSharedGatewayAutoscalingConfig(autoscaling);
    if (parsed === null || parsed.enabled !== autoscaling.enabled || parsed.buildersPerGateway !== autoscaling.buildersPerGateway) {
      throw new MalformedRecordError(ORCHESTRATOR_KEY, `sharedGatewayAutoscaling ${JSON.stringify(autoscaling)} is invalid`);
    }
  }
  if (fields.sizingProfiles !== undefined) assertSizingProfiles(fields.sizingProfiles);
  const idleMs = fields.disposableGatewayIdleMs;
  if (typeof idleMs === "number" && !isNonNegativeSafeInteger(idleMs)) {
    throw new MalformedRecordError(ORCHESTRATOR_KEY, `disposableGatewayIdleMs ${idleMs} is not a nonnegative safe integer`);
  }
  if (autoscaling === undefined) return fields;
  return { ...fields, sharedAutoscalingEnabled: autoscaling.enabled, sharedUsersPerGateway: autoscaling.buildersPerGateway };
}

function decodeOrchestratorConfig(row: Row): Stored<OrchestratorConfig> {
  const { id: _id, sharedAutoscalingEnabled, sharedUsersPerGateway, sizingProfiles, ...fields } = decodeStored<Fields>(ORCHESTRATOR_TABLE, row);
  const stored = sharedAutoscalingEnabled === undefined ? undefined : { enabled: sharedAutoscalingEnabled, buildersPerGateway: sharedUsersPerGateway };
  const sharedGatewayAutoscaling = parseSharedGatewayAutoscalingConfig(stored);
  if (sharedGatewayAutoscaling === null) {
    throw new MalformedRecordError(ORCHESTRATOR_KEY, `sharedGatewayAutoscaling ${JSON.stringify(stored)} is invalid`);
  }
  return { ...fields, sharedGatewayAutoscaling, sizingProfiles: assertSizingProfiles(sizingProfiles) } as Stored<OrchestratorConfig>;
}

function decodePlatformConfig<K extends PlatformConfigKey>(row: Row): Stored<PlatformConfigEntry<K>> {
  const entry = decodeStored<{ key: K; value: unknown; updatedAt: number | null; updatedBy: string | null }>(PLATFORM_CONFIG_TABLE, row);
  const value = PLATFORM_CONFIG_PARSERS[entry.key](entry.value);
  if (value === null) throw new MalformedRecordError(platformKey(entry.key), "does not parse");
  return { ...entry, value: value as PlatformConfigValues[K] };
}

function decodeMattermostAdmin(row: Row): Stored<MattermostAdminIdentity> {
  const { id: _id, ...identity } = decodeStored<MattermostAdminIdentity & { readonly id: string }>(MATTERMOST_ADMIN_TABLE, row);
  return identity;
}

function decodeWriterQuiescence(row: Row): Stored<OpaqueMap> {
  const { record, revision } = decodeStored<{ record: OpaqueMap }>(WRITER_QUIESCENCE_TABLE, row);
  return { ...record, revision };
}

function createOrchestratorRepository(session: PostgresSession): ConfigRepositories["orchestrator"] {
  return {
    async get() {
      const row = await selectByKey(session, "config.orchestrator.get", ORCHESTRATOR_TARGET);
      return row === null ? null : decodeOrchestratorConfig(row);
    },

    async getSizingProfile(sizingKey) {
      const row = await selectByKey(session, "config.orchestrator.getSizingProfile", ORCHESTRATOR_TARGET);
      const profile = row === null ? undefined : decodeOrchestratorConfig(row).sizingProfiles[sizingKey];
      if (profile === undefined) {
        throw new MissingRecordError({ aggregate: "orchestrator-config", key: `${ORCHESTRATOR_ID}/sizingProfiles/${sizingKey}` });
      }
      return profile;
    },

    async patch(patch, fence) {
      const name = "config.orchestrator.patch";
      const fields = orchestratorColumns(patch);
      if (fence?.revision !== undefined) {
        await updateRecord(session, name, ORCHESTRATOR_TARGET, fields, revisionFence(fence.revision));
        return;
      }
      await upsertRecord(session, name, ORCHESTRATOR_TABLE, { id: ORCHESTRATOR_ID }, fields);
    },
  };
}

function createPlatformConfigRepository(session: PostgresSession): ConfigRepositories["platform"] {
  return {
    async get<K extends PlatformConfigKey>(key: K) {
      const row = await selectByKey(session, "config.platform.get", { table: PLATFORM_CONFIG_TABLE, key: [key] });
      return row === null ? null : decodePlatformConfig<K>(row);
    },

    async put(key, value, updatedBy, updatedAt) {
      const parsed = PLATFORM_CONFIG_PARSERS[key](value);
      if (parsed === null) throw new MalformedRecordError(platformKey(key), "value does not parse");
      await insertRecord(session, "config.platform.put", PLATFORM_CONFIG_TABLE, { key, value: parsed, updatedAt, updatedBy }, "put");
    },

    async delete(key) {
      await deleteRecord(session, "config.platform.delete", { table: PLATFORM_CONFIG_TABLE, key: [key] });
    },
  };
}

export function createPostgresConfigRepositories(session: PostgresSession): ConfigRepositories {
  return {
    orchestrator: createOrchestratorRepository(session),
    platform: createPlatformConfigRepository(session),

    writerQuiescence: {
      async get() {
        const row = await selectByKey(session, "config.writerQuiescence.get", WRITER_QUIESCENCE_TARGET);
        return row === null ? null : decodeWriterQuiescence(row);
      },

      async put(record) {
        const { revision: _revision, ...stored } = record as OpaqueMap & { readonly revision?: Revision };
        await insertRecord(session, "config.writerQuiescence.put", WRITER_QUIESCENCE_TABLE, { id: WRITER_QUIESCENCE_ID, record: stored }, "put");
      },

      async delete() {
        await deleteRecord(session, "config.writerQuiescence.delete", WRITER_QUIESCENCE_TARGET);
      },
    },

    mattermostAdmin: {
      async get() {
        const row = await selectByKey(session, "config.mattermostAdmin.get", MATTERMOST_ADMIN_TARGET);
        return row === null ? null : decodeMattermostAdmin(row);
      },

      async put(identity) {
        const { userId, proxyUrl, updatedAt } = identity;
        await insertRecord(session, "config.mattermostAdmin.put", MATTERMOST_ADMIN_TABLE, { id: MATTERMOST_ADMIN_ID, userId, proxyUrl, updatedAt }, "put");
      },
    },
  };
}

const CONFIG_WATCH_COLUMNS = [...ORCHESTRATOR_TABLE.columns, ...PLATFORM_CONFIG_TABLE.columns];

function configSelect(table: TableSpec, alias: string, watchKey: string): string {
  const own = new Set(table.columns);
  const columns = CONFIG_WATCH_COLUMNS.map((spec) => (own.has(spec) ? `${alias}.${spec.column}` : `NULL::${castOf(spec)} AS ${spec.column}`));
  return `SELECT ${watchKey} AS watch_key, ${alias}.revision, ${columns.join(", ")} FROM $schema.${table.table} ${alias}`;
}

const ORCHESTRATOR_WATCH_KEY = `'${ORCHESTRATOR_ID}'::text`;
const CONFIG_RECORDS = `${configSelect(ORCHESTRATOR_TABLE, "o", ORCHESTRATOR_WATCH_KEY)}
  UNION ALL ${configSelect(PLATFORM_CONFIG_TABLE, "p", "p.watch_key")}`;

function decodeConfigRecord(row: Row): Stored<ConfigRecord> {
  if (row.watch_key === ORCHESTRATOR_ID) {
    const { revision, ...value } = decodeOrchestratorConfig(row);
    return { kind: "orchestrator", value, revision };
  }
  const { revision, ...entry } = decodePlatformConfig(row);
  return { kind: "platform", entry, revision };
}

export function postgresConfigWatchSource(): PostgresWatchSource<"config"> {
  return {
    aggregate: "config",
    operation: "watch config",
    selectAll: () => `SELECT * FROM (${CONFIG_RECORDS}) config ORDER BY watch_key`,
    selectKeys: (keys, parameters) => `SELECT * FROM (${CONFIG_RECORDS}) config WHERE watch_key = ANY(${parameters.add([...keys], "text[]")})`,
    keyOf: (row) => row.watch_key as string,
    decode: decodeConfigRecord,
    mayMatch: () => true,
  };
}
