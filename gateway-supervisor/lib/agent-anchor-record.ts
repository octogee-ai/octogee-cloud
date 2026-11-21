import { publishAnchor } from "./postgres-anchor-file.js";
import { readLocalAuxiliaryAnchors } from "./user-auxiliary-anchors.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assertTargetIdentityCustody, type MigrationTargetIdentityCustody } from "@octogee/core/migration-activation-manifest";
import { queryAgentStore, readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import type { FleetBrokerAgentAnchor, FleetBrokerAgentAnchorMigration, FleetBrokerGatewayStateAnchor, FleetBrokerAuxiliaryAnchor } from "@octogee/shared/types/fleet-broker";
import { localStateStorePath } from "./openclaw-state-store.js";
import type { FleetBrokerClient } from "./fleet-broker-client.js";

const AGENT_STORE_BASENAME = "openclaw-agent.sqlite";
const STORE_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SCHEMA_SHAPE = /^[a-z_][a-z0-9_]{0,62}$/u;
const AGENT_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,127}$/u;

export function isAgentAnchor(value: unknown): value is FleetBrokerAgentAnchor {
  const anchor = value as Partial<FleetBrokerAgentAnchor> | null;
  return typeof anchor?.agentId === "string" && AGENT_ID_SHAPE.test(anchor.agentId) &&
    typeof anchor.storeId === "string" && STORE_ID_SHAPE.test(anchor.storeId) &&
    typeof anchor.schema === "string" && SCHEMA_SHAPE.test(anchor.schema);
}

export function agentStorePath(stateDir: string, agentId: string): string {
  return path.join(stateDir, "agents", agentId, "agent", AGENT_STORE_BASENAME);
}

export async function readLocalAgentAnchors(stateDir: string, agentIds: readonly string[]): Promise<FleetBrokerAgentAnchor[]> {
  const anchors: FleetBrokerAgentAnchor[] = [];
  for (const agentId of [...new Set(agentIds)].sort()) {
    if (!AGENT_ID_SHAPE.test(agentId)) continue;
    const anchor = readPostgresAgentAnchor(agentStorePath(stateDir, agentId));
    if (anchor) anchors.push({ agentId, storeId: anchor.storeId, schema: anchor.schema });
  }
  return anchors;
}

export function readLocalGatewayStateAnchor(stateDir: string): FleetBrokerGatewayStateAnchor | null {
  const anchor = readPostgresAgentAnchor(localStateStorePath(stateDir));
  return anchor ? { storeId: anchor.storeId, schema: anchor.schema } : null;
}

export type AgentAnchorVerifier = (anchor: FleetBrokerAgentAnchor) => Promise<void>;
type AgentStoreQuery = (anchor: FleetBrokerAgentAnchor, query: string) => Promise<Record<string, unknown>[]>;

const UNDEFINED_TABLE = "42P01";

function missingSchemaError(anchor: FleetBrokerAgentAnchor): Error {
  return new Error(`PostgreSQL schema ${anchor.schema} for ${anchor.agentId} is missing; refusing to land an anchor that would open an empty store`);
}

async function anchorSchemaRows(query: AgentStoreQuery, anchor: FleetBrokerAgentAnchor, sql: string): Promise<Record<string, unknown>[]> {
  try {
    return await query(anchor, sql);
  } catch (error) {
    if ((error as { code?: unknown }).code === UNDEFINED_TABLE) throw missingSchemaError(anchor);
    throw error;
  }
}

export async function verifyAgentAnchorInPostgres(
  anchor: FleetBrokerAgentAnchor,
  query: AgentStoreQuery = (target, sql) => queryAgentStore(target, sql),
): Promise<void> {
  const [store] = await anchorSchemaRows(query, anchor, "SELECT store_id FROM $schema.openclaw_schema_meta WHERE store = 'agent'");
  if (!store) throw missingSchemaError(anchor);
  if (store.store_id !== anchor.storeId) {
    throw new Error(`PostgreSQL schema ${anchor.schema} holds store ${String(store.store_id)}, not ${anchor.storeId} recorded for ${anchor.agentId}`);
  }
  const [primary] = await anchorSchemaRows(query, anchor, "SELECT agent_id FROM $schema.schema_meta WHERE meta_key = 'primary'");
  if (primary?.agent_id !== anchor.agentId) {
    throw new Error(`PostgreSQL schema ${anchor.schema} belongs to ${String(primary?.agent_id)}, not ${anchor.agentId}`);
  }
}

export async function landAgentAnchors(
  stateDir: string,
  anchors: readonly FleetBrokerAgentAnchor[],
  verify?: AgentAnchorVerifier,
): Promise<{ landed: string[]; preserved: string[] }> {
  for (const anchor of anchors) {
    if (!isAgentAnchor(anchor)) throw new Error(`agent anchor identity is invalid: ${JSON.stringify(anchor)}`);
  }
  const missing: FleetBrokerAgentAnchor[] = [];
  const preserved: string[] = [];
  for (const anchor of anchors) {
    if (await fs.stat(agentStorePath(stateDir, anchor.agentId)).then(() => true, () => false)) preserved.push(anchor.agentId);
    else missing.push(anchor);
  }
  for (const anchor of missing) await verify?.(anchor);
  const landed: string[] = [];
  for (const anchor of missing) {
    if (await publishAnchor(agentStorePath(stateDir, anchor.agentId), anchor)) landed.push(anchor.agentId);
    else preserved.push(anchor.agentId);
  }
  return { landed, preserved };
}

interface SharedUserAgentAnchorsInput {
  stateDir: string;
  uid?: string;
  migrationId?: string;
  slug: string;
  agentIds: readonly string[];
  allowQuiescingExisting?: boolean;
  sharedToSharedWorkspace?: MigrationTargetIdentityCustody | null;
  broker: Pick<FleetBrokerClient, "readAgentAnchors" | "reportAgentAnchors">;
}

function sharedAnchorReadRequest(input: SharedUserAgentAnchorsInput) {
  return { ...(input.uid ? { uid: input.uid } : {}), slug: input.slug, ...(input.migrationId ? { migrationId: input.migrationId } : {}) };
}

async function readSharedAnchorAuthority(input: SharedUserAgentAnchorsInput) {
  const { slug, broker } = input;
  const recorded = await broker.readAgentAnchors(sharedAnchorReadRequest(input));
  const uid = input.uid ?? recorded.assignment?.uid;
  if (!uid || (input.migrationId && recorded.migration?.migrationId !== input.migrationId)) throw new Error(`Shared migration anchor authority is missing for ${slug}`);
  const assignment = recorded.assignment;
  if (assignment?.uid !== uid ||
      (assignment.state !== "serving" && (assignment.state !== "quiescing" || input.allowQuiescingExisting !== true && !input.migrationId)) ||
      !Number.isSafeInteger(assignment.epoch) || assignment.epoch < 0) {
    throw new Error(`Shared agent anchor attach requires a current serving assignment for ${slug}`);
  }
  return { recorded, uid, assignment: { ...assignment, state: assignment.state } };
}

function assertRetainedSharedWorkspace(
  witness: MigrationTargetIdentityCustody | null | undefined,
  uid: string,
  migrationId: string | undefined,
  recordedMigration: FleetBrokerAgentAnchorMigration | undefined,
  assignmentEpoch: number,
): void {
  if (!witness) throw new Error("Shared target workspace identity capture is missing");
  const gatewayId = process.env.GATEWAY_ID?.trim();
  const podUid = process.env.POD_UID?.trim();
  if (!migrationId || recordedMigration?.migrationId !== migrationId ||
      recordedMigration.sourceEpoch !== assignmentEpoch || !gatewayId || !podUid ||
      recordedMigration.sourceGatewayId === gatewayId) {
    throw new Error("Shared retained roster custody changed");
  }
  assertTargetIdentityCustody(witness, { migrationId, uid, gatewayId, podUid });
}

function sharedRecordedAnchors(
  slug: string,
  agentIds: readonly string[],
  anchors: readonly FleetBrokerAgentAnchor[],
): FleetBrokerAgentAnchor[] {
  const expected = anchors.filter(anchor => agentIds.includes(anchor.agentId));
  if (expected.some(anchor => !isAgentAnchor(anchor)) ||
      new Set(expected.map(anchor => anchor.agentId)).size !== expected.length) {
    throw new Error(`Recorded Shared agent anchors are invalid for ${slug}`);
  }
  return expected;
}

export async function prepareSharedUserAgentAnchors(input: SharedUserAgentAnchorsInput): Promise<{
  report: () => Promise<void>;
  retainedSharedRoster?: FleetBrokerAgentAnchor[];
}> {
  const { stateDir, slug, broker } = input;
  const agentIds = [...new Set(input.agentIds)].sort();
  const { recorded, uid, assignment } = await readSharedAnchorAuthority(input);
  const assignmentState = assignment.state;
  const migrationImport = input.migrationId !== undefined && recorded.migration?.migrationId === input.migrationId;
  const quiescingExisting = assignmentState === "quiescing" && !migrationImport;
  const assignmentEpoch = assignment.epoch;
  const retainedSharedRoster = input.sharedToSharedWorkspace !== undefined && recorded.sharedToShared === true;
  if (retainedSharedRoster) {
    assertRetainedSharedWorkspace(input.sharedToSharedWorkspace, uid, input.migrationId, recorded.migration, assignmentEpoch);
  }
  const expected = sharedRecordedAnchors(slug, agentIds, recorded.anchors);
  const sameIdentity = (left: FleetBrokerAgentAnchor, right: FleetBrokerAgentAnchor) =>
    left.storeId === right.storeId && left.schema === right.schema;
  const assertRecordedIdentities = async () => {
    const local = await readLocalAgentAnchors(stateDir, agentIds);
    for (const anchor of expected) {
      const current = local.find((candidate) => candidate.agentId === anchor.agentId);
      const exists = await fs.stat(agentStorePath(stateDir, anchor.agentId)).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (exists && (!current || !sameIdentity(current, anchor))) {
        throw new Error(`Local agent ${anchor.agentId} has a different identity from its recorded PostgreSQL store`);
      }
    }
    return local;
  };
  const local = await assertRecordedIdentities();
  if (quiescingExisting && (expected.length !== agentIds.length || local.length !== agentIds.length)) {
    throw new Error(`Shared quiescing resume requires existing local and recorded identities for ${slug}`);
  }
  if (migrationImport && expected.length !== agentIds.length) {
    throw new Error(`Shared migration import requires every recorded agent identity for ${slug}`);
  }
  for (const anchor of new Map([...local, ...expected].map((anchor) => [anchor.agentId, anchor])).values()) {
    await verifyAgentAnchorInPostgres(anchor);
  }
  if (!quiescingExisting) await landAgentAnchors(stateDir, expected);
  await assertRecordedIdentities();
  const report = async () => {
    const anchors = await assertRecordedIdentities();
    if (anchors.length !== agentIds.length) throw new Error(`Shared agent anchors are incomplete for ${slug}`);
    for (const anchor of anchors) await verifyAgentAnchorInPostgres(anchor);
    await broker.reportAgentAnchors({ uid, slug, assignmentEpoch, assignmentState, anchors, configuredAgentIds: agentIds, ...(recorded.migration ? { migration: recorded.migration } : {}) });
  };
  return { report, ...(retainedSharedRoster ? { retainedSharedRoster: expected } : {}) };
}

export type GatewayStateAnchorVerifier = (anchor: FleetBrokerGatewayStateAnchor) => Promise<void>;

export async function verifyGatewayStateAnchorInPostgres(
  anchor: FleetBrokerGatewayStateAnchor,
  query: (target: FleetBrokerGatewayStateAnchor, sql: string) => Promise<Record<string, unknown>[]> = (target, sql) => queryAgentStore(target, sql),
): Promise<void> {
  let rows: Record<string, unknown>[];
  try {
    rows = await query(anchor, "SELECT store_id FROM $schema.openclaw_schema_meta WHERE store = 'state'");
  } catch (error) {
    if ((error as { code?: unknown }).code !== UNDEFINED_TABLE) throw error;
    rows = [];
  }
  const [store] = rows;
  if (!store) throw new Error(`PostgreSQL state schema ${anchor.schema} is missing; refusing to land an anchor that would open an empty store`);
  if (store.store_id !== anchor.storeId) {
    throw new Error(`PostgreSQL schema ${anchor.schema} holds state store ${String(store.store_id)}, not ${anchor.storeId}`);
  }
}

export async function landGatewayStateAnchor(
  stateDir: string,
  anchor: FleetBrokerGatewayStateAnchor,
  verify: GatewayStateAnchorVerifier = verifyGatewayStateAnchorInPostgres,
): Promise<"landed" | "preserved"> {
  if (!STORE_ID_SHAPE.test(anchor.storeId) || !SCHEMA_SHAPE.test(anchor.schema)) {
    throw new Error(`gateway state anchor identity is invalid: ${JSON.stringify(anchor)}`);
  }
  const file = localStateStorePath(stateDir);
  if (await fs.stat(file).then(() => true, () => false)) return "preserved";
  await verify(anchor);
  return await publishAnchor(file, anchor) ? "landed" : "preserved";
}

function anchorFingerprint(anchors: readonly FleetBrokerAgentAnchor[]): string {
  return JSON.stringify(anchors.map((anchor) => [anchor.agentId, anchor.storeId, anchor.schema]));
}

export function createAgentAnchorReporter(input: {
  stateDir: string;
  slug: string;
  broker: Pick<FleetBrokerClient, "reportAgentAnchors">;
  readAgentIds: () => readonly string[];
  log: (message: string) => void;
}): () => Promise<void> {
  let recorded: string | null = null;
  let lastFailure: string | null = null;
  const fail = (message: string) => {
    if (message === lastFailure) return;
    lastFailure = message;
    input.log(`⚠ [agent-anchors] ${message}`);
  };
  return async () => {
    let anchors: FleetBrokerAgentAnchor[];
    let configuredAgentIds: string[];
    let state: FleetBrokerGatewayStateAnchor | null;
    let auxiliary: FleetBrokerAuxiliaryAnchor[];
    try {
      configuredAgentIds = [...new Set(input.readAgentIds())].sort();
      anchors = await readLocalAgentAnchors(input.stateDir, configuredAgentIds);
      state = readLocalGatewayStateAnchor(input.stateDir);
      auxiliary = await readLocalAuxiliaryAnchors(input.stateDir);
    } catch (error) {
      fail(`reading local agent anchors for ${input.slug} failed: ${String(error)}`);
      return;
    }
    if (anchors.length === 0) {
      fail(`no configured agent of ${input.slug} has a local PostgreSQL anchor; nothing recorded`);
      return;
    }
    const fingerprint = JSON.stringify([anchorFingerprint(anchors), configuredAgentIds, state, auxiliary]);
    if (fingerprint === recorded) return;
    try {
      await input.broker.reportAgentAnchors({ slug: input.slug, anchors, configuredAgentIds, ...(state ? { state } : {}), ...(auxiliary.length ? { auxiliary } : {}) });
    } catch (error) {
      fail(`recording ${anchors.length} agent anchor(s) for ${input.slug} failed: ${String(error)}`);
      return;
    }
    recorded = fingerprint;
    lastFailure = null;
    input.log(`[agent-anchors] recorded ${anchors.length} agent anchor(s)${state ? " and the gateway state anchor" : ""} and ${auxiliary.length} auxiliary anchor(s) for ${input.slug}`);
  };
}
