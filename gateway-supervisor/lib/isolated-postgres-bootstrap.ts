import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { queryAgentStore, readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { applyAgentStoreDatabasePatch } from "../entrypoints/pre-boot-config.js";
import { buildSafeDefaultAgent, SAFE_DEFAULT_AGENT_ID } from "./openclaw-config-users.js";
import { localStateStorePath } from "./openclaw-state-store.js";
import { assertUserStorePath, publishAnchor } from "./postgres-anchor-file.js";
import { uninitializedUserState } from "./uninitialized-user-state.js";
import { AUXILIARY_FAMILIES, auxiliaryStorePath } from "./user-auxiliary-anchors.js";

interface BootstrapAnchor {
  storeId: string;
  schema: string;
}

interface BootstrapOptions {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  noRecordedAnchors: boolean;
  noRecordedHostAnchors?: boolean;
}

const execute = promisify(execFile);

function expectedAnchor(storeId: string): BootstrapAnchor {
  return { storeId, schema: `octogee_state_${storeId.replaceAll("-", "").slice(0, 16)}` };
}

async function readPreparation(file: string): Promise<BootstrapAnchor | null> {
  try {
    await using handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 128) throw new Error("Invalid Native state preparation receipt");
    const bytes = Buffer.alloc(129);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const storeId = bytes.subarray(0, bytesRead).toString("utf8");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(storeId)) {
      throw new Error("Invalid Native state preparation identity");
    }
    return expectedAnchor(storeId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function publishPreparation(file: string, anchor: BootstrapAnchor): Promise<void> {
  const staged = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(staged, anchor.storeId, { flag: "wx", mode: 0o600 });
    await fs.rename(staged, file);
  } finally {
    await fs.rm(staged, { force: true });
  }
}

async function prepareJournal({ stateDir, env }: BootstrapOptions, anchor: BootstrapAnchor): Promise<void> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "octogee-state-bootstrap-"));
  try {
    const configPath = path.join(temporary, "openclaw.json");
    const { id: _id, ...entry } = buildSafeDefaultAgent({ OPENCLAW_DIR: stateDir });
    const config = {
      agents: { ownership: "explicit", entries: { [SAFE_DEFAULT_AGENT_ID]: entry } },
      plugins: { enabled: false, allow: [] },
      gateway: { mode: "local" },
    };
    applyAgentStoreDatabasePatch(config, env, "absent");
    await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const { stdout } = await execute("/usr/local/bin/openclaw", [
      "database", "prepare-state", "--expected-store-id", anchor.storeId, "--expected-namespace", anchor.schema, "--json",
    ], {
      timeout: 60_000,
      killSignal: "SIGKILL",
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: env.HOME,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_AGENT_STORE_DSN: env.OPENCLAW_AGENT_STORE_DSN,
      },
    });
    const receipt = JSON.parse(stdout);
    if (receipt.ok !== true || !["prepared", "ready"].includes(receipt.status) ||
      receipt.storeId !== anchor.storeId || receipt.namespace !== anchor.schema ||
      receipt.path !== localStateStorePath(stateDir)) {
      throw new Error("Native PostgreSQL state preparation returned a different anchor");
    }
    await queryAgentStore(anchor, "SELECT agent_id FROM $schema.agent_deletion_journal LIMIT 1");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function isFreshNativeLayout(stateDir: string): Promise<boolean> {
  if (!uninitializedUserState(stateDir, [], {})) return false;
  for (const family of AUXILIARY_FAMILIES) {
    const store = auxiliaryStorePath(stateDir, family);
    for (const suffix of ["", "-wal", "-shm", "-journal", ".seal"]) {
      try {
        await fs.lstat(store + suffix);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return true;
}

function disklessClusterRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.GATEWAY_RUNTIME_KIND === "cluster" && env.GATEWAY_EPHEMERAL_HOME === "true";
}

function supportedFreshRuntime(env: NodeJS.ProcessEnv): boolean {
  if (env.GATEWAY_CLASS !== "isolated" || !env.OPENCLAW_AGENT_STORE_DSN?.trim()) return false;
  if (env.GATEWAY_RUNTIME_KIND === "gce-vm" || disklessClusterRuntime(env)) return true;
  return env.GATEWAY_RUNTIME_KIND === "cluster" && Boolean(env.OCTOGEE_CHECKPOINT_SLOT_ID) &&
    env.OCTOGEE_CHECKPOINT_SLOT_ID === env.GATEWAY_ID;
}

async function fileStat(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function matchesAnchor(file: string, expected: BootstrapAnchor): boolean {
  const actual = readPostgresAgentAnchor(file);
  return actual?.storeId === expected.storeId && actual.schema === expected.schema;
}

async function removeInterruptedStage(file: string, staged: string, anchor: BootstrapAnchor): Promise<void> {
  const stage = await fileStat(staged);
  if (!stage) return;
  if (!stage.isFile()) throw new Error("Invalid Native PostgreSQL anchor staging file");
  const target = await fileStat(file);
  if (!target && stage.nlink === 1) {
    await fs.unlink(staged);
    return;
  }
  if (!target?.isFile() || target.dev !== stage.dev || target.ino !== stage.ino ||
    target.nlink !== 2 || !matchesAnchor(file, anchor)) {
    throw new Error("Interrupted Native PostgreSQL anchor publication does not prove one matching hard link");
  }
  await fs.unlink(staged);
}

async function prepareAnchor(stateDir: string, stateFile: string, anchor: BootstrapAnchor): Promise<void> {
  const staged = path.join(stateDir, `.native-postgres-anchor-${anchor.storeId}.tmp`);
  await assertUserStorePath(stateDir, path.dirname(stateFile));
  await removeInterruptedStage(stateFile, staged, anchor);
  await fs.rm(`${staged}-journal`, { force: true });
  await assertUserStorePath(stateDir, stateFile);
  if (!await fileStat(stateFile)) {
    if (!await isFreshNativeLayout(stateDir)) throw new Error("Local history appeared during pending PostgreSQL preparation");
    await publishAnchor(stateFile, anchor, staged);
  }
  if (!matchesAnchor(stateFile, anchor)) {
    throw new Error("Pending PostgreSQL preparation must preserve the existing state anchor");
  }
}

export async function prepareFreshIsolatedPostgresState(
  options: BootstrapOptions,
  run: (options: BootstrapOptions, anchor: BootstrapAnchor) => Promise<void> = prepareJournal,
): Promise<boolean> {
  const { stateDir, env, noRecordedAnchors } = options;
  if (!supportedFreshRuntime(env)) return false;
  const canPrepare = noRecordedAnchors || (disklessClusterRuntime(env) && options.noRecordedHostAnchors === true);
  const pendingPath = path.join(stateDir, ".native-postgres-prepare");
  const stateFile = localStateStorePath(stateDir);
  if (await fs.realpath(stateDir) !== stateDir) return false;
  let anchor = await readPreparation(pendingPath);
  if (!anchor) {
    if (!canPrepare || !await isFreshNativeLayout(stateDir)) return false;
    await assertUserStorePath(stateDir, stateFile);
    anchor = expectedAnchor(randomUUID());
    await publishPreparation(pendingPath, anchor);
  } else if (!canPrepare) {
    throw new Error("Recorded Native state appeared during pending PostgreSQL preparation");
  }
  await prepareAnchor(stateDir, stateFile, anchor);
  await run(options, anchor);
  await fs.unlink(pendingPath);
  return true;
}
