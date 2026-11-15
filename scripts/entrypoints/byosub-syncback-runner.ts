import "../src/main.js";
import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("byosub-syncback-runner");


import * as fs from "fs";
import { pathToFileURL } from "node:url";
import { parseAgentId } from "@octogee/shared/types/identity";
import { readAuthProfileStore, sharedAuthStoreUsable } from "../lib/auth-profile-store.js";
import {
  agentIdsFromConfig,
  codexAgentDir,
  isSafeAgentId,
  sharedAuthAgentDir,
} from "../lib/byosub-restore.js";
import {
  syncBackSweep,
  type AuthFingerprint,
  type SyncBackResult,
  type SyncBackTarget,
} from "../lib/byosub-syncback.js";
import { brokerPushByosubCred } from "../lib/byot-sync-runtime.js";
import { buildCodexAuthJsonFromStore } from "../lib/model-credential-materializer.js";
import { openClawConfigPath, openClawDir } from "../lib/openclaw-config-path.js";

const OPENCLAW_DIR = openClawDir();
const CONFIG_PATH = openClawConfigPath();
const INTERVAL_MS = Number(process.env.BYOSUB_SYNCBACK_INTERVAL_MS) || 300_000;

const log = runtimeLogger.info;

async function loadTargets(): Promise<SyncBackTarget[]> {
  if ((process.env.GATEWAY_CLASS ?? "") === "shared") return [];

  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return [];
  }
  const agentIds = agentIdsFromConfig(config).filter(isSafeAgentId);
  if (await sharedAuthStoreUsable(OPENCLAW_DIR)) {
    const sharedDir = sharedAuthAgentDir(OPENCLAW_DIR);
    return agentIds
      .filter((agentId) => parseAgentId(agentId).kind === "coach")
      .map((agentId) => ({ agentId, readCredential: async () => await codexCredentialIn(sharedDir) }));
  }
  return agentIds.map((agentId) => ({
    agentId,
    readCredential: async () => await codexCredentialIn(codexAgentDir(OPENCLAW_DIR, agentId)),
  }));
}

async function codexCredentialIn(agentDir: string): Promise<string | null> {
  const store = await readAuthProfileStore(agentDir);
  return store === null ? null : buildCodexAuthJsonFromStore(JSON.stringify(store));
}

export async function sweepOnce(
  prev: Map<string, AuthFingerprint | null>,
): Promise<SyncBackResult> {
  const targets = await loadTargets();
  if (!targets.length) return { pushed: 0, observed: 0, failed: 0, prev };
  return syncBackSweep({
    targets,
    prev,
    mode: "active",
    pushCredential: async (agentId, payload) => {
      const r = await brokerPushByosubCred(agentId, "openai", payload);
      if (r.changed) log(`pushed ${agentId}: destroyed ${r.destroyed} superseded version(s)`);
    },
    logFn: log,
  });
}

async function main(): Promise<void> {
  log(`starting (mode=active interval=${INTERVAL_MS}ms)`);
  let prev = new Map<string, AuthFingerprint | null>();
  const tick = async (): Promise<void> => {
    try {
      const r = await sweepOnce(prev);
      prev = r.prev;
      if (r.failed) log(`sweep: ${r.failed} push(es) failed; retrying next tick`);
    } catch (e) {
      log(`WARN: sweep tick error — ${(e as Error).message}`);
    }
  };
  await tick();
  setInterval(() => void tick(), INTERVAL_MS);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    runtimeLogger.error(`[byosub-syncback] fatal: ${err.message}`);
    process.exit(0);
  });
}

export { loadTargets };
