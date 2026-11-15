import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { queryAgentStore, readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { buildSafeDefaultAgent, SAFE_DEFAULT_AGENT_ID } from "./openclaw-config-users.js";
import { applyAgentStoreDatabasePatch } from "../entrypoints/pre-boot-config.js";
import { recordIsolatedNativeInitialState } from "./isolated-native-initial-state.js";
import { uninitializedUserState } from "./uninitialized-user-state.js";

const NATIVE_STOP_GRACE_MS = 60_000;
const NATIVE_HOST_DIRECTORIES = ["state", "client", "agents"];

async function entryNames(directory: string): Promise<Set<string> | null> {
  try {
    return new Set(await fs.readdir(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function bootRestoringHostLayout(stateDir: string, boot: () => Promise<void>): Promise<void> {
  const directories = NATIVE_HOST_DIRECTORIES.map((name) => path.join(stateDir, name));
  const before = await Promise.all(directories.map(entryNames));
  try {
    await boot();
  } catch (error) {
    await Promise.all(directories.map(async (directory, index) => {
      const existing = before[index];
      if (!existing) return fs.rm(directory, { recursive: true, force: true });
      for (const name of await entryNames(directory) ?? []) {
        if (!existing.has(name)) await fs.rm(path.join(directory, name), { recursive: true, force: true });
      }
    }));
    throw error;
  }
}

async function journalAvailable(databasePath: string): Promise<boolean> {
  const anchor = readPostgresAgentAnchor(databasePath);
  if (anchor) {
    await queryAgentStore(anchor, "SELECT agent_id FROM $schema.agent_deletion_journal LIMIT 1");
    return true;
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare("PRAGMA table_info(agent_deletion_journal)").all()
      .some((column) => column.name === "agent_id");
  } finally {
    db.close();
  }
}

export async function bootFreshUserHost(stateDir: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "octogee-native-bootstrap-"));
  const configPath = path.join(temporary, "openclaw.json");
  const { id: _id, ...entry } = buildSafeDefaultAgent({ OPENCLAW_DIR: stateDir });
  const config = {
    agents: { ownership: "explicit", entries: { [SAFE_DEFAULT_AGENT_ID]: entry } },
    plugins: { enabled: false, allow: [] },
    discovery: { mdns: { mode: "off" } },
    gateway: {
      mode: "local", bind: "loopback", port: 18791,
      auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
    },
  };
  applyAgentStoreDatabasePatch(config, env, "absent");
  await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const child = spawn("/usr/local/bin/openclaw", ["gateway", "run", "--bind", "loopback", "--port", "18791"], {
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: env.HOME,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: randomUUID(),
      OPENCLAW_NO_RESPAWN: "1",
      ...(env.OPENCLAW_AGENT_STORE_DSN ? { OPENCLAW_AGENT_STORE_DSN: env.OPENCLAW_AGENT_STORE_DSN } : {}),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let ended = false;
  let failure: Error | undefined;
  const closed = new Promise<void>((resolve) => {
    child.once("error", (error) => { failure = error; });
    child.once("close", (code, signal) => {
      ended = true;
      if (code !== 0 || signal) failure ??= new Error(`native initialization exited ${code ?? signal}`);
      resolve();
    });
  });
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const signal = (value: NodeJS.Signals) => {
    if (!ended) child.kill(value);
  };
  try {
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (ended || failure) throw failure ?? new Error("native initialization stopped");
      try {
        const response = await fetch("http://127.0.0.1:18791/readyz", { signal: AbortSignal.timeout(1_000) });
        if (response.ok) break;
      } catch {
        if (failure) throw failure;
      }
      if (Date.now() >= deadline) throw new Error("native initialization readiness timed out");
      await wait(250);
    }
  } finally {
    signal("SIGTERM");
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([closed, new Promise<void>((resolve) => { grace = setTimeout(resolve, NATIVE_STOP_GRACE_MS); })]);
    clearTimeout(grace);
    signal("SIGKILL");
    await closed;
    await fs.rm(temporary, { recursive: true, force: true });
  }
  if (failure) throw failure;
}

export async function initializeIsolatedNativeState(
  stateDir: string,
  boot?: (stateDir: string) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  try {
    await fs.stat(databasePath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const initialStateWasEmpty = uninitializedUserState(stateDir, [], {});
  await bootRestoringHostLayout(stateDir, () => (boot ?? ((root) => bootFreshUserHost(root, env)))(stateDir));
  if (!await journalAvailable(databasePath)) {
    throw new Error("User native deletion journal unavailable; preserve existing history and use explicit native Doctor recovery before importing agents");
  }
  if (initialStateWasEmpty && !readPostgresAgentAnchor(databasePath)) recordIsolatedNativeInitialState(stateDir, env.POD_UID);
}
