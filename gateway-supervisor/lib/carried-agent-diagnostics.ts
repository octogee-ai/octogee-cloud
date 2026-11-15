import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { OpenClawCommandResult } from "./openclaw-cli.js";

export const CARRIED_AGENT_DIAGNOSTICS_DIRECTORY = ".octogee-carried-agent-diagnostics";
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const FILE_LIMITS: Record<string, number> = { "stdout.bin": OUTPUT_LIMIT, "stderr.bin": OUTPUT_LIMIT, "metadata.json": 4096 };
export interface CarriedAgentDiagnosticIdentity { migrationId: string; slug: string; targetPodUid: string }

async function privateDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 ||
      await fs.realpath(directory) !== directory) throw new Error("carried-agent diagnostics directory is unsafe");
}

async function writePrivate(file: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
      throw new Error("carried-agent diagnostics file is unsafe");
    }
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function diagnosticRoot(env: NodeJS.ProcessEnv): Promise<string> {
  const home = env.HOME, state = env.OPENCLAW_STATE_DIR;
  if (!home || !state || !path.isAbsolute(home) || !path.isAbsolute(state)) throw new Error("carried-agent diagnostics HOME is missing");
  const homeStat = await fs.lstat(home);
  if (!homeStat.isDirectory() || homeStat.uid !== process.getuid?.() || (homeStat.mode & 0o022) !== 0 || await fs.realpath(home) !== home) {
    throw new Error("carried-agent diagnostics HOME is unsafe");
  }
  const root = path.join(home, CARRIED_AGENT_DIAGNOSTICS_DIRECTORY), stateRoot = await fs.realpath(state);
  if (root === stateRoot || root.startsWith(stateRoot + path.sep) || stateRoot.startsWith(root + path.sep)) {
    throw new Error("carried-agent diagnostics overlaps imported state");
  }
  await fs.mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  await privateDirectory(root);
  return root;
}

async function validateRetainedEvidence(root: string): Promise<void> {
  for (const slot of await fs.readdir(root)) {
    if (!/^slot-[0-3]$/.test(slot)) throw new Error("carried-agent diagnostics contains unknown entries");
    const directory = path.join(root, slot);
    await privateDirectory(directory);
    for (const name of await fs.readdir(directory)) {
      const limit = Object.hasOwn(FILE_LIMITS, name) ? FILE_LIMITS[name] : undefined, stat = await fs.lstat(path.join(directory, name));
      if (limit === undefined || !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() ||
          (stat.mode & 0o777) !== 0o600 || stat.size > limit) throw new Error("carried-agent diagnostics contains unsafe evidence");
    }
  }
}

async function reserveSlot(root: string): Promise<string> {
  let selected: string | undefined;
  for (let slot = 0; slot < 4; slot++) {
    const candidate = path.join(root, `slot-${slot}`);
    try { await fs.mkdir(candidate, { mode: 0o700 }); selected = candidate; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (!selected) throw new Error("carried-agent diagnostics is full; collect retained evidence before retrying");
  await privateDirectory(selected);
  return selected;
}

export async function captureCarriedAgentRosterFailure(input: {
  env: NodeJS.ProcessEnv; identity?: CarriedAgentDiagnosticIdentity; result: OpenClawCommandResult;
}): Promise<{ slot: string; identity: string }> {
  const stdout = Buffer.from(input.result.stdout), stderr = Buffer.from(input.result.stderr ?? "");
  if (stdout.length > OUTPUT_LIMIT || stderr.length > OUTPUT_LIMIT) throw new Error("carried-agent diagnostics output exceeds its bound");
  if (!input.identity || [input.identity.migrationId, input.identity.slug, input.identity.targetPodUid]
    .some(value => typeof value !== "string" || !value.trim() || value.length > 1024)) {
    throw new Error("carried-agent diagnostics identity is missing");
  }
  const root = await diagnosticRoot(input.env);
  await validateRetainedEvidence(root);
  const selected = await reserveSlot(root);
  const identity = createHash("sha256").update(JSON.stringify([
    input.identity.migrationId, input.identity.slug, input.identity.targetPodUid,
  ])).digest("hex");
  const output = (bytes: Buffer) => ({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  await writePrivate(path.join(selected, "stdout.bin"), stdout);
  await writePrivate(path.join(selected, "stderr.bin"), stderr);
  await writePrivate(path.join(selected, "metadata.json"), Buffer.from(JSON.stringify({ version: 1, identity,
    exitCode: input.result.code, stdout: output(stdout), stderr: output(stderr) })));
  await syncDirectory(selected);
  await syncDirectory(root);
  return { slot: path.basename(selected), identity };
}
