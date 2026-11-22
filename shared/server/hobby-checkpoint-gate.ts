import { randomUUID } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { isValidGatewayId } from "../types/glm.js";
import { isValidUsername } from "../types/identity.js";
import { isUserOwnerUid } from "../types/user-identity.js";

const CLAIM_PATH = "/var/run/octogee/checkpoint-claim/claim.json";
const LIVE_OWNER_PATH = "/var/run/octogee/checkpoint-owner/owner.json";
const RESTORED_ENV_PATH = "/proc/gvisor/spec_environ";
const POD_UID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SNAPSHOT_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

interface HobbyCheckpointOwner {
  slotId: string;
  gatewayId: string;
  podUid: string;
  uid: string;
  slug: string;
  assignmentEpoch: 0;
}

export interface HobbyCheckpointClaim extends HobbyCheckpointOwner {
  version: 1;
  snapshotName: string;
}

export interface HobbyLiveStandbyClaim extends HobbyCheckpointOwner {
  version: 2;
  mode: "live";
  namespace: string;
}

type HobbyPodClaim = HobbyCheckpointClaim | HobbyLiveStandbyClaim;

function validClaimOwner(claim: Partial<HobbyCheckpointOwner>): boolean {
  return claim.assignmentEpoch === 0 && isValidGatewayId(claim.gatewayId) && claim.slotId === claim.gatewayId &&
    typeof claim.podUid === "string" && POD_UID.test(claim.podUid) && isUserOwnerUid(claim.uid) && isValidUsername(claim.slug);
}

function parseClaim(value: unknown): HobbyPodClaim | null {
  if (!value || typeof value !== "object") return null;
  const claim = value as Partial<HobbyCheckpointOwner> & Record<string, unknown>;
  if (!validClaimOwner(claim)) return null;
  if (claim.version === 1 && claim.mode === undefined &&
    typeof claim.snapshotName === "string" && SNAPSHOT_NAME.test(claim.snapshotName)) return claim as unknown as HobbyCheckpointClaim;
  if (claim.version === 2 && claim.mode === "live" && claim.snapshotName === undefined &&
    typeof claim.namespace === "string" && SNAPSHOT_NAME.test(claim.namespace)) return claim as unknown as HobbyLiveStandbyClaim;
  return null;
}

export function readCheckpointRestore(
  boot: NodeJS.ProcessEnv, fresh: NodeJS.ProcessEnv, receipt: unknown,
): HobbyCheckpointClaim | null {
  const claim = parseClaim(receipt);
  if (claim?.version !== 1 || boot.OCTOGEE_CHECKPOINT_SNAPSHOT || !boot.POD_UID ||
    !POD_UID.test(boot.POD_UID) || boot.POD_UID === fresh.POD_UID ||
    !boot.K8S_NAMESPACE || boot.K8S_NAMESPACE !== fresh.K8S_NAMESPACE) return null;
  if (boot.GATEWAY_ID !== claim.gatewayId || fresh.GATEWAY_ID !== claim.gatewayId ||
    boot.OCTOGEE_CHECKPOINT_SLOT_ID !== claim.slotId || fresh.OCTOGEE_CHECKPOINT_SLOT_ID !== claim.slotId ||
    fresh.OCTOGEE_CHECKPOINT_SNAPSHOT !== claim.snapshotName || fresh.POD_UID !== claim.podUid) return null;
  return claim;
}

function restoreEnvironment(body: string): NodeJS.ProcessEnv {
  return Object.fromEntries(body.split("\0").filter(line => line.includes("=")).map(line => {
    const delimiter = line.indexOf("=");
    return [line.slice(0, delimiter), line.slice(delimiter + 1)];
  }));
}

export async function readMountedCheckpointClaim(): Promise<HobbyPodClaim | null> {
  try {
    const claim = parseClaim(JSON.parse(await readFile(CLAIM_PATH, "utf8")) as unknown);
    if (!claim) throw new Error("Invalid gateway checkpoint claim projection");
    return claim;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function rememberLiveOwner(claim: HobbyLiveStandbyClaim): Promise<void> {
  const staged = `${LIVE_OWNER_PATH}.${randomUUID()}`;
  const owner = JSON.stringify([claim.uid, claim.slug, claim.assignmentEpoch, claim.slotId, claim.podUid, claim.namespace]);
  await writeFile(staged, owner, { mode: 0o600, flag: "wx" });
  try {
    await link(staged, LIVE_OWNER_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(LIVE_OWNER_PATH, "utf8") !== owner) throw new Error("Live standby is already bound to another owner");
  } finally {
    await unlink(staged);
  }
}

function assertLiveCheckpointClaim(boot: NodeJS.ProcessEnv, claim: HobbyPodClaim): asserts claim is HobbyLiveStandbyClaim {
  if (claim.version !== 2 || claim.namespace !== boot.K8S_NAMESPACE || claim.podUid !== boot.POD_UID ||
    claim.gatewayId !== boot.GATEWAY_ID || claim.slotId !== boot.OCTOGEE_CHECKPOINT_SLOT_ID) {
    throw new Error("Gateway live standby does not match this exact claimed pod");
  }
}

export async function waitForCheckpointClaim(role: "gateway" | "edge"): Promise<HobbyPodClaim> {
  const boot = process.env;
  const prefix = `/tmp/octogee-hobby-checkpoint-${role}`;
  const live = boot.OCTOGEE_CHECKPOINT_MODE === "live";
  if (live && boot.OCTOGEE_CHECKPOINT_SNAPSHOT) throw new Error("Live standby cannot restore a snapshot");
  if (boot.OCTOGEE_CHECKPOINT_SNAPSHOT) {
    return resumeClaimedCheckpoint(boot, prefix);
  }
  const podUid = boot.POD_UID;
  if (!boot.OCTOGEE_CHECKPOINT_SLOT_ID || boot.OCTOGEE_CHECKPOINT_SLOT_ID !== boot.GATEWAY_ID ||
    !podUid || !POD_UID.test(podUid)) throw new Error("Expected the original unclaimed gateway checkpoint process");
  await writeFile(`${prefix}-prepared`, podUid, { mode: 0o600 });
  for (;;) {
    const receipt = await readMountedCheckpointClaim();
    if (receipt !== null) {
      if (live) {
        assertLiveCheckpointClaim(boot, receipt);
        await rememberLiveOwner(receipt);
        await checkpointGatewayCredentials();
        return receipt;
      }
      const current = restoreEnvironment(await readFile(RESTORED_ENV_PATH, "utf8"));
      const claim = readCheckpointRestore(boot, current, receipt);
      if (!claim) throw new Error("Gateway checkpoint does not match this restored slot and pod");
      await checkpointGatewayCredentials();
      await writeFile(`${prefix}-restored`, claim.podUid, { mode: 0o600 });
      return claim;
    }
    await setTimeout(500);
  }
}

export function matchesRestartedCheckpoint(
  env: NodeJS.ProcessEnv, claim: HobbyPodClaim | null, restoredPodUid: string,
): claim is HobbyCheckpointClaim {
  return claim?.version === 1 && env.POD_UID === claim.podUid && restoredPodUid === claim.podUid &&
    env.GATEWAY_ID === claim.gatewayId && env.OCTOGEE_CHECKPOINT_SLOT_ID === claim.slotId &&
    env.OCTOGEE_CHECKPOINT_SNAPSHOT === claim.snapshotName;
}

async function resumeClaimedCheckpoint(env: NodeJS.ProcessEnv, prefix: string): Promise<HobbyCheckpointClaim> {
  const claim = await readMountedCheckpointClaim();
  const restoredPodUid = await readFile(`${prefix}-restored`, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (!matchesRestartedCheckpoint(env, claim, restoredPodUid)) {
    throw new Error("Expected previous checkpoint restoration in the same admitted pod");
  }
  await checkpointGatewayCredentials();
  return claim;
}

async function readCheckpointCredentials() {
  const [token, agentStoreDsn] = await Promise.all([
    readFile("/var/run/octogee/checkpoint-credentials/token", "utf8"),
    readFile("/var/run/octogee/checkpoint-credentials/agent-store-dsn", "utf8"),
  ]);
  return { token, agentStoreDsn };
}

export async function checkpointGatewayCredentials(
  read = readCheckpointCredentials,
  wait: () => Promise<void> = () => setTimeout(500),
): Promise<{ token: string; agentStoreDsn: string }> {
  for (;;) {
    try {
      const credentials = await read();
      const token = credentials.token.trim();
      const agentStoreDsn = credentials.agentStoreDsn.trim();
      if (!token || !agentStoreDsn) {
        throw new Error("Gateway checkpoint credentials are unavailable");
      }
      return { token, agentStoreDsn };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await wait();
  }
}

export async function initializeCheckpointEdge(isSidecar: boolean): Promise<void> {
  const env = process.env;
  if (!env.OCTOGEE_CHECKPOINT_SLOT_ID) return;
  if (!isSidecar) throw new Error("A gateway checkpoint requires a private edge sidecar");
  const claim = await waitForCheckpointClaim("edge");
  const credentials = await checkpointGatewayCredentials();
  env.POD_UID = claim.podUid;
  env.OPENCLAW_GATEWAY_TOKEN = credentials.token;
  env.OPENCLAW_AGENT_STORE_DSN = credentials.agentStoreDsn;
  process.stderr.write("[hobby-checkpoint] edge claim and credentials ready\n");
}
