import * as fs from "node:fs";
import * as os from "node:os";
import { queryAgentStore, readPostgresAgentAnchor, type PostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { podBelongsToGateway } from "@octogee/core/gateway-live-release";
import { clientCredentialStorePath, clusterIsolatedGateway, localStateStorePath, openclawStateRoot } from "./openclaw-state-store.js";

export const GATEWAY_OWNER_RELEASE_WAIT_MS = 4 * 60_000;
const GATEWAY_OWNER_POLL_MS = 5_000;

export type StateStoreQuery = (anchor: PostgresAgentAnchor, sql: string, values?: unknown[]) => Promise<Record<string, unknown>[]>;

const SELECT_GATEWAY_OWNER =
  "SELECT payload_json FROM $schema.state_leases WHERE scope = 'gateway-owner' AND lease_key = 'global'";

interface GatewayOwnerLease {
  host: string | null;
}

function holderHost(payload: unknown): string | null {
  try {
    const owner = (JSON.parse(String(payload)) as { owner?: { host?: unknown } }).owner;
    return typeof owner?.host === "string" ? owner.host : null;
  } catch {
    return null;
  }
}

async function readGatewayOwner(query: StateStoreQuery, anchor: PostgresAgentAnchor): Promise<GatewayOwnerLease | null> {
  const [row] = await query(anchor, SELECT_GATEWAY_OWNER);
  if (!row) return null;
  return { host: holderHost(row.payload_json) };
}

export async function waitForGatewayOwnerRelease(input: {
  anchor: PostgresAgentAnchor;
  gatewayId: string;
  hostname: string;
  log: (message: string) => void;
  query?: StateStoreQuery;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<"absent" | "this-pod"> {
  const query = input.query ?? ((anchor, sql, values) => queryAgentStore(anchor, sql, values));
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + GATEWAY_OWNER_RELEASE_WAIT_MS;
  let waiting = false;
  for (;;) {
    const lease = await readGatewayOwner(query, input.anchor);
    if (!lease) return "absent";
    if (lease.host === input.hostname) return "this-pod";
    if (!lease.host || !podBelongsToGateway(input.gatewayId, lease.host)) {
      throw new Error(`state owner ${lease.host ?? "<unreadable>"} is not a pod of gateway ${input.gatewayId}; refusing foreign state ownership`);
    }
    if (!waiting) {
      input.log(`[state-store] waiting for the state owner lease of pod ${lease.host} to be released normally`);
      waiting = true;
    }
    if (now() >= deadline) {
      throw new Error(`state owner ${lease.host} has not released its lease; recovery requires independent physical-stop proof, then inspect with openclaw gateway recover-lock --json and explicitly confirm the reviewed selection with --confirm`);
    }
    await sleep(Math.min(GATEWAY_OWNER_POLL_MS, deadline - now()));
  }
}

export async function prepareGatewayStateStore(input: {
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  hostname?: string;
  waitForOwner?: typeof waitForGatewayOwnerRelease;
}): Promise<void> {
  const env = input.env ?? process.env;
  if (!clusterIsolatedGateway(env)) return;
  const stateRoot = openclawStateRoot(env);
  const anchor = readPostgresAgentAnchor(localStateStorePath(stateRoot));
  if (!anchor) return;
  const ownerInput = {
    anchor,
    gatewayId: env.GATEWAY_ID?.trim() ?? "",
    hostname: input.hostname ?? os.hostname(),
    log: input.log,
  };
  const waitForOwner = input.waitForOwner ?? waitForGatewayOwnerRelease;
  await waitForOwner(ownerInput);
  if (fs.existsSync(clientCredentialStorePath(stateRoot))) return;
  input.log("[state-store] local client credentials are missing; OpenClaw prepares new local client identities at startup");
}
