import fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as os from "node:os";
import { OpenClawCommandError, type OpenClawCommand } from "./openclaw-cli.js";

export const SOURCE_DOCTOR_DIAGNOSTICS_DIRECTORY = ".octogee-source-doctor-diagnostics";
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const METADATA_LIMIT = 32 * 1024;
const SLOT_LIMIT = 8;
const FILE_LIMITS: Record<string, number> = { "stdout.bin": OUTPUT_LIMIT, "stderr.bin": OUTPUT_LIMIT,
  "metadata.json": METADATA_LIMIT, "metadata.pending": METADATA_LIMIT };
export type SourceDoctorPhase = "descriptor" | "pre-metadata" | "bootstrap" | "copy-anchors" |
  "postgres-doctor" | "post-metadata" | "serving-projection" | "source-scheduler-doctor" | "scheduler-post-metadata" | "private-cleanup";
export interface SourceDoctorDiagnosticContext { requestId: string; releaseKey: string; log: (message: string) => void }

async function privateDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 ||
      await fs.realpath(directory) !== path.resolve(directory)) throw new Error("source Doctor diagnostics directory is unsafe");
}

async function writePrivate(file: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
      throw new Error("source Doctor diagnostics file is unsafe");
    }
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function resolveExistingParents(file: string): Promise<string> {
  try { return await fs.realpath(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await resolveExistingParents(parent), path.basename(file));
  }
}

async function validateRetainedEvidence(root: string): Promise<void> {
  let retainedBytes = 0;
  for (const slot of await fs.readdir(root)) {
    if (!/^slot-[0-7]$/.test(slot)) throw new Error("source Doctor diagnostics contains unknown entries");
    const directory = path.join(root, slot);
    await privateDirectory(directory);
    for (const entry of await fs.readdir(directory)) {
      const limit = Object.hasOwn(FILE_LIMITS, entry) ? FILE_LIMITS[entry] : undefined, stat = await fs.lstat(path.join(directory, entry));
      if (limit === undefined || !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() ||
          (stat.mode & 0o777) !== 0o600 || stat.size > limit) throw new Error("source Doctor diagnostics contains unsafe evidence");
      retainedBytes += stat.size;
    }
  }
  if (retainedBytes > 33 * 1024 * 1024) throw new Error("source Doctor diagnostics capacity exceeded");
}

async function reserveSlot(root: string): Promise<string> {
  let directory = "";
  for (let slot = 0; slot < SLOT_LIMIT; slot++) {
    const candidate = path.join(root, `slot-${slot}`);
    try { await fs.mkdir(candidate, { mode: 0o700 }); directory = candidate; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (!directory) throw new Error("source Doctor diagnostics is full; collect retained evidence before retrying");
  await privateDirectory(directory);
  return directory;
}

export async function createSourceDoctorDiagnostics(input: {
  home: string; excludedRoots: string[]; context: SourceDoctorDiagnosticContext;
}) {
  const home = path.resolve(input.home), homeStat = await fs.lstat(home);
  if (!homeStat.isDirectory() || homeStat.uid !== process.getuid?.() || (homeStat.mode & 0o022) !== 0 || await fs.realpath(home) !== home) {
    throw new Error("source Doctor diagnostics HOME is unsafe");
  }
  const root = path.join(home, SOURCE_DOCTOR_DIAGNOSTICS_DIRECTORY);
  for (const selected of input.excludedRoots) {
    const resolved = await resolveExistingParents(path.resolve(selected));
    if (root === resolved || root.startsWith(resolved + path.sep) || resolved.startsWith(root + path.sep)) {
      throw new Error("source Doctor diagnostics overlaps exported state");
    }
  }
  await fs.mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  await privateDirectory(root);
  await validateRetainedEvidence(root);
  const directory = await reserveSlot(root);
  const identity = createHash("sha256").update(JSON.stringify([input.context.requestId, input.context.releaseKey])).digest("hex");
  const phases: Array<{ phase: SourceDoctorPhase; elapsedMs: number; status: "passed" | "failed" }> = [];
  let sealed = false;
  const metadata = async (status: "running" | "failed" | "passed") => {
    const bytes = Buffer.from(JSON.stringify({ version: 1, identity, status, sealed, phases }));
    if (bytes.length > METADATA_LIMIT) throw new Error("source Doctor diagnostics metadata exceeds its bound");
    await writePrivate(path.join(directory, "metadata.pending"), bytes);
    await fs.rename(path.join(directory, "metadata.pending"), path.join(directory, "metadata.json"));
    await syncDirectory(directory);
  };
  await metadata("running");
  await syncDirectory(root);
  return {
    async phase<T>(phase: SourceDoctorPhase, run: () => Promise<T>): Promise<T> {
      const started = performance.now();
      let status: "passed" | "failed" = "failed";
      try { const result = await run(); status = "passed"; return result; }
      finally {
        const elapsedMs = Math.round(performance.now() - started);
        phases.push({ phase, elapsedMs, status });
        input.context.log(`[openclaw-boot] source Doctor phase=${phase} status=${status} elapsedMs=${elapsedMs}`);
      }
    },
    async seal(output: { stdout: string | Buffer; stderr?: string | Buffer }): Promise<void> {
      if (sealed) return;
      const stdout = Buffer.from(output.stdout), stderr = Buffer.from(output.stderr ?? "");
      if (stdout.length > OUTPUT_LIMIT || stderr.length > OUTPUT_LIMIT) throw new Error("source Doctor diagnostics output exceeds its bound");
      await writePrivate(path.join(directory, "stdout.bin"), stdout);
      await writePrivate(path.join(directory, "stderr.bin"), stderr);
      sealed = true;
      await metadata("running");
    },
    async finish(status: "failed" | "passed"): Promise<void> { await metadata(status); },
  };
}


interface SourceDoctorRun {
  root: string;
  run: OpenClawCommand;
  phase: <T>(phase: SourceDoctorPhase, action: () => Promise<T>) => Promise<T>;
  seal: (output: { stdout: string | Buffer; stderr?: string | Buffer }) => Promise<void>;
}

export async function runWithSourceDoctorDiagnostics(input: {
  home: string; excludedRoots: string[]; context?: SourceDoctorDiagnosticContext; run: OpenClawCommand;
}, action: (session: SourceDoctorRun) => Promise<void>): Promise<void> {
  const diagnostics = input.context ? await createSourceDoctorDiagnostics({ ...input, context: input.context }) : undefined;
  const phase: SourceDoctorRun["phase"] = (name, operation) => diagnostics ? diagnostics.phase(name, operation) : operation();
  const seal: SourceDoctorRun["seal"] = async output => { await diagnostics?.seal(output); };
  let output: Parameters<SourceDoctorRun["seal"]>[0] = { stdout: "", stderr: "" };
  const run: OpenClawCommand = async (args, options) => {
    try { const result = await input.run(args, options); output = result; return result; }
    catch (error) {
      if (error instanceof OpenClawCommandError) output = error.readOutput();
      throw error;
    }
  };
  let root = "";
  const failures: unknown[] = [];
  try {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "source-doctor-postgres-")));
    await action({ root, run, phase, seal });
  } catch (error) {
    failures.push(error);
    try { await seal(output); }
    catch { failures.push(new Error("source Doctor private evidence capture failed")); }
  } finally {
    try { if (root) await phase("private-cleanup", () => fs.rm(root, { recursive: true, force: true })); }
    catch { failures.push(new Error("source Doctor private cleanup failed")); }
    try { await diagnostics?.finish(failures.length ? "failed" : "passed"); }
    catch { failures.push(new Error("source Doctor private evidence finalization failed")); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "source Doctor failed; source remains fenced");
}
