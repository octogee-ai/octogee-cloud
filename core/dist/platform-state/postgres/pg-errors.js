import { AlreadyExistsError, DuplicateRecordError, MissingRecordError, } from "../errors.js";
const SERIALIZATION_FAILURE = "40001";
const DEADLOCK_DETECTED = "40P01";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CONNECTION_EXCEPTION_CLASS = "08";
const SERVER_SHUTDOWN_CODES = new Set(["57P01", "57P02", "57P03"]);
const SOCKET_ERROR_CODES = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EPIPE",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
]);
export const TABLE_AGGREGATES = {
    operations: "operation",
    operation_audits: "operation-audit",
    gateway_recovery_receipts: "gateway-recovery-receipt",
    gateways: "gateway",
    gateway_releases: "gateway-release",
    gateway_assignments: "gateway-assignment",
    gateway_vm_runtime: "gateway-vm-runtime",
    fleet_registry: "fleet-registry",
    shared_pool_scaler_state: "shared-pool-scaler",
    platform_release_record: "platform-release",
    migration_transfer_tasks: "migration-transfer-task",
    orchestrator_config: "orchestrator-config",
    writer_quiescence: "writer-quiescence",
    channel_host_admin: "mattermost-admin",
    channel_identities: "channel-identity",
    platform_config: "platform-config",
    users: "builder",
    user_agents: "builder-agent",
    placement_receipts: "placement-receipt",
    schedule_transfers: "schedule-transfer",
    agent_stores: "agent-store",
    user_accounts: "user-account",
    user_agent_models: "agent-model-selection",
    session_model_audit: "session-model-audit",
    user_model_credentials: "model-credential",
    user_subscription_links: "subscription-link",
    subscription_flows: "subscription-flow",
    user_connector_integrations: "connector-integration",
    connect_flows: "connect-flow",
    workspaces: "workspace",
    workspace_members: "workspace-member",
    workspace_projects: "workspace-project",
    workspace_channels: "workspace-channel",
    activity_receipts: "activity-receipt",
    user_agent_identities: "builder-agent-identity",
    user_secrets: "builder-secret",
    gateway_tickets: "gateway-ticket",
    control_tickets: "control-ticket",
    control_sessions: "control-session",
    model_broker_tokens: "model-broker-token",
    model_broker_gateway_tokens: "model-broker-gateway-token",
    gateway_access_audit: "gateway-access-audit",
    user_deletion_jobs: "customer-deletion-job",
    anonymous_operational_archives: "anonymous-operational-archive",
    agent_imports: "agent-import",
    agent_import_pointers: "agent-import-pointer",
};
const IDENTITY_UNIQUE_CONSTRAINTS = new Set(["operation_audits_idempotency_key_key"]);
function fields(error) {
    return error !== null && typeof error === "object" ? error : {};
}
function text(value) {
    return typeof value === "string" ? value : undefined;
}
export function sqlState(error) {
    const code = text(fields(error).code);
    return code !== undefined && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}
export function isContention(error) {
    const code = sqlState(error);
    return code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED;
}
export function isConnectionLoss(error) {
    const code = text(fields(error).code);
    if (code !== undefined && SOCKET_ERROR_CODES.has(code))
        return true;
    const state = sqlState(error);
    if (state !== undefined && (state.startsWith(CONNECTION_EXCEPTION_CLASS) || SERVER_SHUTDOWN_CODES.has(state)))
        return true;
    const message = text(fields(error).message) ?? "";
    return /Connection terminated|connection is closed|Client has encountered a connection error/i.test(message);
}
const UNIQUE_DETAIL = /^Key \((.+)\)=\((.*)\) already exists\.$/s;
const MISSING_PARENT_DETAIL = /^Key \((.+)\)=\((.*)\) is not present in table "([^"]+)"\.$/s;
function parseDetail(detail, pattern) {
    const match = detail === undefined ? null : pattern.exec(detail);
    if (match === null)
        return undefined;
    return { columns: match[1], values: match[2], referencedTable: match[3] };
}
function compositeKey(values) {
    return values.split(", ").join("/");
}
function translateUniqueViolation(error, record) {
    const { constraint, table, detail } = fields(error);
    const constraintName = text(constraint) ?? "";
    if (constraintName.endsWith("_pkey") || IDENTITY_UNIQUE_CONSTRAINTS.has(constraintName)) {
        return new AlreadyExistsError(record, { cause: error });
    }
    const parsed = parseDetail(text(detail), UNIQUE_DETAIL);
    const aggregate = TABLE_AGGREGATES[text(table) ?? ""] ?? record.aggregate;
    return new DuplicateRecordError(aggregate, parsed?.columns ?? constraintName, parsed?.values ?? "", [record.key]);
}
function translateForeignKeyViolation(error) {
    const parsed = parseDetail(text(fields(error).detail), MISSING_PARENT_DETAIL);
    const parentAggregate = parsed?.referencedTable === undefined ? undefined : TABLE_AGGREGATES[parsed.referencedTable];
    if (parsed === undefined || parentAggregate === undefined)
        return error;
    return new MissingRecordError({ aggregate: parentAggregate, key: compositeKey(parsed.values) }, { cause: error });
}
export function translateWriteError(error, record) {
    const state = sqlState(error);
    if (state === UNIQUE_VIOLATION)
        return translateUniqueViolation(error, record);
    if (state === FOREIGN_KEY_VIOLATION)
        return translateForeignKeyViolation(error);
    return error;
}
