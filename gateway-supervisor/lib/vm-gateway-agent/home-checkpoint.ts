import {
  VM_HOME_CHECKPOINT_CONTENT_TYPE,
  VM_HOME_CHECKPOINT_MAX_BYTES,
  VM_HOME_CHECKPOINT_NAME_RE,
  isDisposableHomeCheckpoint,
  sameHomeCheckpoint,
  type GatewayVmHomeCheckpoint,
  type GatewayVmRuntimeBundle,
} from "@octogee/shared/types/glm";
import type {
  FleetBrokerVmHomeCheckpointCommit,
  FleetBrokerVmHomeCheckpointUrl,
  FleetBrokerVmHomeDownload,
  FleetBrokerVmHomePruneResult,
} from "@octogee/shared/types/fleet-broker";
import type { LogContext } from "@octogee/shared/server/service-logger";
import { dirname } from "node:path";
import { brokerFailure, brokerPost, type BrokerClientDeps } from "./broker.js";
import { bundleUserIdentity, volumeHostPath } from "./plan.js";
import type { DesktopControl } from "./desktop-control.js";

export const HOME_VOLUME_NAME = "data";
export const HOME_CHECKPOINT_INTERVAL_MS = 30 * 60_000;
export const HOME_TOOLCHAIN_CACHE = ".octogee/toolchains/npm-cache";
const SOURCE_DOCTOR_DIAGNOSTICS_HOME_PATH = ".octogee-source-doctor-diagnostics";
const CARRIED_AGENT_DIAGNOSTICS_HOME_PATH = ".octogee-carried-agent-diagnostics";
export const HOME_CHECKPOINT_MARKER = "home-checkpoint.marker";
export const HOME_RESTORE_PENDING = "home-restore.pending";
export const HOME_RESTORE_GATE = "home-restore.gate";
export const HOME_RESTORE_TEMP_PREFIX = "octogee-home-restore-";
export const HOME_REPLACE_STAGING_PREFIX = ".octogee-restore-";
export const HOME_METADATA_AUTHORIZATION = [".ssh/authorized_keys", ".ssh/authorized_keys.metadata"] as const;
export const DESKTOP_HOME_PATHS = [".config/octogee-chromium", ".config/hypr", ".config/omarchy", ".config/octogee", "Documents"] as const;
export const HOME_DESKTOP_TOOL_PATHS = [".local/share/mise", ".cache/mise", ".npm"] as const;
export const HOME_DESKTOP_RUNTIME_PATHS = [
  ...HOME_DESKTOP_TOOL_PATHS,
  ".config/octogee-chromium/Default/Cache",
  ".config/octogee-chromium/SingletonLock",
  ".config/octogee-chromium/SingletonCookie",
  ".config/octogee-chromium/SingletonSocket",
  ".config/octogee-chromium/DevToolsActivePort",
] as const;
const SHA256_RE = /^[a-f0-9]{64}$/u;

export interface HomeShell {
  run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface HomeFs {
  listDir(path: string): Promise<string[]>;
  freeBytes(path: string): Promise<number>;
  exists(path: string): Promise<boolean>;
  fileSize(path: string): Promise<number>;
  sha256(path: string): Promise<string>;
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string): Promise<void>;
  touch(path: string, atMs: number): Promise<void>;
  uploadBody(path: string): Promise<BodyInit>;
  saveResponse(response: Response, path: string): Promise<void>;
  mkdir(path: string, mode?: number): Promise<void>;
  replaceDirectory(source: string, target: string): Promise<void>;
  retainToolStorage?(source: string, target: string): Promise<void>;
  replaceDirectoryContents(source: string, target: string, preserved?: readonly string[], metadataPreserved?: readonly string[]): Promise<void>;
}

export interface HomeCheckpointDeps extends BrokerClientDeps {
  stateRoot: string;
  shell: HomeShell;
  fs: HomeFs;
  now: () => number;
  log: (msg: string, fields?: LogContext) => void;
  logError: (msg: string, fields?: LogContext) => void;
  desktop: DesktopControl;
  snapshot(work: () => Promise<void>): Promise<void>;
  captureSnapshot(): Promise<void>;
  discardSnapshot(): Promise<void>;
}

export interface HomeScope {
  slug: string;
  dataDir: string;
  marker: string;
  desktopDir: string;
  restorePending: string;
  restoreGate: string;
  restoreCheckpoint?: GatewayVmHomeCheckpoint;
  hostToolInventory: boolean;
  desktopToolsRebuildable?: boolean;
}

export type HomeCheckpointResult =
  | { status: "clean" }
  | { status: "uploaded"; name: string; size: number; pruned: number | null };

export type HomeRestoreResult =
  | { status: "preserved" }
  | { status: "none" }
  | { status: "restored"; name: string; size: number };

function homePhaseTimer(deps: HomeCheckpointDeps, context: LogContext) {
  return async function time<T>(phase: string, work: () => Promise<T>, fields?: LogContext): Promise<T> {
    const event = { ...context, ...fields, phase };
    const startedAt = deps.now();
    deps.log(`[vm-agent] ${context.category} ${phase} running`, { ...event, status: "running" });
    let status: "done" | "failed" = "failed";
    try {
      const result = await work();
      status = "done";
      return result;
    } finally {
      (status === "failed" ? deps.logError : deps.log)(`[vm-agent] ${context.category} ${phase} ${status}`, {
        ...event, status, durationMs: Math.max(0, deps.now() - startedAt),
      });
    }
  };
}

export function homeScope(stateRoot: string, bundle: GatewayVmRuntimeBundle): HomeScope | null {
  const volume = bundle.volumes.find((candidate) => candidate.name === HOME_VOLUME_NAME && candidate.kind === "emptyDir");
  const slug = bundleUserIdentity(bundle)?.builderSlug;
  if (!volume || !slug) return null;
  return {
    slug, dataDir: volumeHostPath(stateRoot, volume), marker: `${stateRoot}/${HOME_CHECKPOINT_MARKER}`,
    desktopDir: `${stateRoot}/desktop-home`, restorePending: `${stateRoot}/${HOME_RESTORE_PENDING}`, restoreGate: `${stateRoot}/${HOME_RESTORE_GATE}`,
    hostToolInventory: bundle.desktop !== "x11",
    ...(bundle.homeRestoreCheckpoint ? { restoreCheckpoint: bundle.homeRestoreCheckpoint } : {}),
  };
}

export function tarCreateArgs(archive: string, scope: HomeScope): string[] {
  return [
    "--create",
    "--gzip",
    "--numeric-owner",
    `--file=${archive}`,
    "--anchored",
    ...HOME_DESKTOP_RUNTIME_PATHS.filter(path => path !== ".local/share/mise" || scope.desktopToolsRebuildable).map((path) => `--exclude=desktop-home/${path}`),
    `--exclude=data/${HOME_TOOLCHAIN_CACHE}`,
    `--exclude=data/${SOURCE_DOCTOR_DIAGNOSTICS_HOME_PATH}`,
    `--exclude=data/${CARRIED_AGENT_DIAGNOSTICS_HOME_PATH}`,
    ...HOME_METADATA_AUTHORIZATION.map((path) => `--exclude=desktop-home/${path}`),
    "-C", `${scope.dataDir}/..`, "data",
    "-C", `${scope.desktopDir}/..`,
    "desktop-home",
  ];
}

export function tarExtractArgs(archive: string, dataDir: string): string[] {
  return ["--extract", "--gzip", "--numeric-owner", "--same-owner", "--same-permissions", "--anchored",
    ...HOME_DESKTOP_TOOL_PATHS.filter(path => path !== ".local/share/mise").map(path => `--exclude=desktop-home/${path}`),
    `--exclude=data/${SOURCE_DOCTOR_DIAGNOSTICS_HOME_PATH}`,
    `--exclude=data/${CARRIED_AGENT_DIAGNOSTICS_HOME_PATH}`,
    `--file=${archive}`, `--directory=${dataDir}`];
}

export function findDirtyArgs(dataDir: string, marker: string, toolchainCache: boolean = false, desktopToolsRebuildable = false): string[] {
  const excluded = toolchainCache ? [`${dataDir}/${HOME_TOOLCHAIN_CACHE}`, `${dataDir}/${SOURCE_DOCTOR_DIAGNOSTICS_HOME_PATH}`, `${dataDir}/${CARRIED_AGENT_DIAGNOSTICS_HOME_PATH}`]
    : [...HOME_DESKTOP_RUNTIME_PATHS.filter(path => path !== ".local/share/mise" || desktopToolsRebuildable), ...HOME_METADATA_AUTHORIZATION].map((path) => `${dataDir}/${path}`);
  const prune = excluded.flatMap((path, index) => index === 0 ? ["-path", path] : ["-o", "-path", path]);
  return [dataDir, "(", ...prune, ")", "-prune", "-o", "-newer", marker, "-print", "-quit"];
}

async function sh(deps: HomeCheckpointDeps, command: string, args: string[], okCodes: readonly number[]): Promise<string> {
  const result = await deps.shell.run(command, args);
  if (!okCodes.includes(result.code)) {
    throw new Error(`${command} ${args[0] ?? ""} exited ${result.code}: ${result.stderr.trim().slice(-300)}`);
  }
  return result.stdout;
}

export async function homeIsDirty(deps: HomeCheckpointDeps, scope: HomeScope): Promise<boolean> {
  if (!(await deps.fs.exists(scope.marker))) return true;
  const changed = await sh(deps, "find", findDirtyArgs(scope.dataDir, scope.marker, true), [0]);
  if (changed.trim().length > 0) return true;
  if (await deps.fs.exists(scope.desktopDir) && (await sh(deps, "find", findDirtyArgs(scope.desktopDir, scope.marker, false, scope.desktopToolsRebuildable), [0])).trim()) return true;
  return false;
}

async function post<T>(deps: HomeCheckpointDeps, path: string, body: Record<string, unknown>, label: string): Promise<T> {
  const res = await brokerPost(deps, `computer-home/${path}`, body);
  if (!res.ok) throw await brokerFailure(label, res);
  return (await res.json()) as T;
}

async function pruneCheckpoints(deps: HomeCheckpointDeps, slug: string): Promise<number | null> {
  try {
    const pruned = await post<FleetBrokerVmHomePruneResult>(deps, "prune", { slug }, "vm-home prune");
    return pruned.deleted;
  } catch (err) {
    deps.log(`[vm-agent] home checkpoint prune failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function createAndUploadCheckpoint(
  deps: HomeCheckpointDeps,
  scope: HomeScope,
  input: { requestedAt: number | null; archive: string; startedAt: number; time: ReturnType<typeof homePhaseTimer> },
): Promise<HomeCheckpointResult> {
  const { requestedAt, archive, startedAt, time } = input;
  await deps.discardSnapshot();
  let desktopToolsRebuildable = scope.desktopToolsRebuildable;
  await time("snapshot", () => deps.snapshot(async () => {
    desktopToolsRebuildable = await recordDesktopTools(deps, scope, time, "inventory-in-snapshot");
    await deps.captureSnapshot();
  }));
  const snapshotRoot = `${deps.stateRoot}/.home-checkpoint/snapshot`;
  const capturedScope = {
    ...scope,
    desktopToolsRebuildable,
    dataDir: `${snapshotRoot}/volumes/data`,
    desktopDir: `${snapshotRoot}/desktop-home`,
  };
  if (!(await deps.fs.exists(capturedScope.desktopDir))) throw new Error("home snapshot has no complete desktop home");
  const size = await time("archive", async () => {
    await sh(deps, "tar", tarCreateArgs(archive, capturedScope), [0]);
    const size = await deps.fs.fileSize(archive);
    if (size <= 0) throw new Error("home checkpoint archive is empty");
    if (size > VM_HOME_CHECKPOINT_MAX_BYTES) {
      throw new Error(`home checkpoint archive is ${size} bytes, over the ${VM_HOME_CHECKPOINT_MAX_BYTES} byte cap`);
    }
    return size;
  });
  const sha256 = await time("hash", () => deps.fs.sha256(archive));
  const signed = await post<FleetBrokerVmHomeCheckpointUrl>(deps, "checkpoint-url", { slug: scope.slug, size }, "vm-home checkpoint-url");
  if (!VM_HOME_CHECKPOINT_NAME_RE.test(signed.name)) throw new Error(`vm-home checkpoint-url returned an invalid name ${signed.name}`);
  const checkpoint = { checkpointName: signed.name, sizeBytes: size };
  await time("upload", async () => {
    const upload = await deps.fetchImpl(signed.upload.url, {
      method: signed.upload.method,
      signal: AbortSignal.timeout(10 * 60_000),
      headers: { "content-type": VM_HOME_CHECKPOINT_CONTENT_TYPE, ...signed.upload.requiredHeaders },
      body: await deps.fs.uploadBody(archive),
    });
    if (!upload.ok) throw await brokerFailure("vm-home upload", upload);
  }, checkpoint);
  const committed = await time("commit", () => post<FleetBrokerVmHomeCheckpointCommit>(
    deps,
    "commit",
    { slug: scope.slug, name: signed.name, size, sha256, requestedAt, coverage: "builder-home-v2", writerProtocol: 2 },
    "vm-home commit",
  ), checkpoint);
  await deps.fs.touch(scope.marker, startedAt);
  const pruned = await pruneCheckpoints(deps, scope.slug);
  return { status: "uploaded", name: committed.name, size, pruned };
}

async function recordDesktopTools(
  deps: HomeCheckpointDeps,
  scope: HomeScope,
  time: ReturnType<typeof homePhaseTimer>,
  phase: "inventory-before-snapshot" | "inventory-in-snapshot",
): Promise<boolean> {
  if (!scope.hostToolInventory || !deps.desktop.tools) return false;
  const record = deps.desktop.tools.bind(deps.desktop);
  try { return (await time(phase, record))?.rebuildable ?? false; }
  catch (error) {
    deps.log(`optional native tool inventory unavailable (${error instanceof Error ? error.name : typeof error}); retaining tool storage`);
    return false;
  }
}

export async function checkpointHome(deps: HomeCheckpointDeps, scope: HomeScope, opts: { force: boolean; requestedAt?: number | null }): Promise<HomeCheckpointResult> {
  const context = {
    gatewayId: deps.gatewayId, builderSlug: scope.slug, category: "home-checkpoint",
    ...(opts.requestedAt != null ? { requestedAt: opts.requestedAt } : {}),
  };
  const time = homePhaseTimer(deps, context);
  scope.desktopToolsRebuildable = await recordDesktopTools(deps, scope, time, "inventory-before-snapshot");
  if (!opts.force && !(await homeIsDirty(deps, scope))) {
    deps.log("[vm-agent] home checkpoint skipped: home unchanged", { ...context, phase: "check-home", status: "skipped", reason: "home-unchanged" });
    return { status: "clean" };
  }
  const startedAt = deps.now();
  const tempDir = await deps.fs.mkdtemp("octogee-home-checkpoint-");
  const [checkpoint] = await Promise.allSettled([
    createAndUploadCheckpoint(deps, scope, { requestedAt: opts.requestedAt ?? null, archive: `${tempDir}/home.tar.gz`, startedAt, time }),
  ]);
  const cleanup = await Promise.allSettled([deps.discardSnapshot(), deps.fs.rm(tempDir)]);
  const cleanupFailures = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (cleanupFailures.length) {
    const failures = checkpoint.status === "rejected" ? [checkpoint.reason, ...cleanupFailures] : cleanupFailures;
    throw new AggregateError(failures, `home checkpoint failed: ${failures.map(String).join("; ")}`);
  }
  if (checkpoint.status === "rejected") throw checkpoint.reason;
  return checkpoint.value;
}

function validateHomeDownload(current: FleetBrokerVmHomeDownload): void {
  if (!VM_HOME_CHECKPOINT_NAME_RE.test(current.name) || !SHA256_RE.test(current.sha256) || !Number.isSafeInteger(current.size) || current.size <= 0) {
    throw new Error("vm-home download-url returned an invalid checkpoint record");
  }
}

async function fetchHomeRestoreDownload(deps: HomeCheckpointDeps, scope: HomeScope, pending: boolean): Promise<FleetBrokerVmHomeDownload | null> {
  const expected = scope.restoreCheckpoint;
  const res = await brokerPost(deps, "computer-home/download-url", { slug: scope.slug });
  if (res.status === 404) {
    if (pending || expected) throw new Error("required home checkpoint is unavailable");
    return null;
  }
  if (!res.ok) throw await brokerFailure("vm-home download-url", res);
  const current = (await res.json()) as FleetBrokerVmHomeDownload;
  validateHomeDownload(current);
  if (expected && !sameHomeCheckpoint(expected, current as GatewayVmHomeCheckpoint)) throw new Error("vm-home download does not match the required checkpoint");
  return current;
}

async function homeRestoreInstalled(deps: HomeCheckpointDeps, scope: HomeScope, receipt: string | null, pending: boolean): Promise<boolean> {
  return !pending && (!receipt || await deps.fs.exists(receipt)) && (await deps.fs.listDir(scope.dataDir)).length > 0;
}

async function installHomeRestore(deps: HomeCheckpointDeps, scope: HomeScope, current: FleetBrokerVmHomeDownload, staged: string, receipt: string | null): Promise<void> {
  if (!(await deps.fs.exists(`${staged}/data`))) throw new Error("home checkpoint has no gateway data directory");
  if (current.coverage === "builder-home-v2" && !(await deps.fs.exists(`${staged}/desktop-home`))) throw new Error("home checkpoint has no full desktop home");
  await deps.desktop.run(current.coverage === "builder-home-v2" ? "stop-home" : "stop");
  await deps.fs.touch(scope.restorePending, deps.now());
  await deps.fs.replaceDirectory(`${staged}/data`, scope.dataDir);
  if (current.coverage === "builder-home-v2") {
    if (!deps.fs.retainToolStorage) throw new Error("native tool preservation is unavailable");
    await deps.fs.retainToolStorage(`${staged}/desktop-home/.local/share/mise`, `${staged}/desktop-home/.config/octogee/mise-retained`);
    await deps.fs.replaceDirectoryContents(`${staged}/desktop-home`, scope.desktopDir, [...HOME_METADATA_AUTHORIZATION, ...HOME_DESKTOP_TOOL_PATHS], HOME_METADATA_AUTHORIZATION);
  } else {
    for (const path of DESKTOP_HOME_PATHS) {
      const source = `${staged}/desktop-home/${path}`;
      if (await deps.fs.exists(source)) await deps.fs.replaceDirectory(source, `${scope.desktopDir}/${path}`);
    }
  }
  try { await deps.desktop.run("reconcile-tools"); }
  catch (error) {
    deps.log(`optional restored native tools could not be rebuilt (${error instanceof Error ? error.name : typeof error}); preserving declarations for retry`);
  }
  await sh(deps, "sync", ["-f", deps.stateRoot], [0]);
  await deps.fs.touch(scope.marker, deps.now());
  if (receipt) await deps.fs.touch(receipt, deps.now());
  await deps.fs.rm(scope.restorePending);
}

export async function admitHome(deps: HomeCheckpointDeps, scope: HomeScope): Promise<void> {
  if (!(await deps.fs.exists(scope.restoreGate))) {
    await deps.desktop.run("start");
    return;
  }
  const time = homePhaseTimer(deps, { gatewayId: deps.gatewayId, builderSlug: scope.slug, category: "home-restore" });
  await time("admit", async () => {
    await deps.fs.rm(scope.restoreGate);
    await sh(deps, "sync", ["-f", deps.stateRoot], [0]);
    await deps.desktop.run("start");
  });
}

function replaceStagingParents(scope: HomeScope): string[] {
  const nested = [...HOME_METADATA_AUTHORIZATION, ...HOME_DESKTOP_TOOL_PATHS, ...DESKTOP_HOME_PATHS].flatMap((path) => {
    const parts = path.split("/");
    return parts.slice(1).map((_, index) => `${scope.desktopDir}/${parts.slice(0, index + 1).join("/")}`);
  });
  return [...new Set([dirname(scope.dataDir), scope.desktopDir, ...nested])];
}

async function sweepInterruptedRestore(deps: HomeCheckpointDeps, scope: HomeScope, context: LogContext): Promise<void> {
  const tmp = `${deps.stateRoot}/tmp`;
  const leftovers = (await deps.fs.listDir(tmp)).filter((entry) => entry.startsWith(HOME_RESTORE_TEMP_PREFIX)).map((entry) => `${tmp}/${entry}`);
  for (const parent of replaceStagingParents(scope)) {
    leftovers.push(...(await deps.fs.listDir(parent)).filter((entry) => entry.startsWith(HOME_REPLACE_STAGING_PREFIX)).map((entry) => `${parent}/${entry}`));
  }
  if (!leftovers.length) return;
  for (const path of leftovers) await deps.fs.rm(path);
  deps.log(`[vm-agent] home restore swept ${leftovers.length} staging path(s) an interrupted restore left on the home disk`, {
    ...context, phase: "sweep", status: "done", sweptPaths: leftovers.length,
  });
}

async function assertRestoreSpace(deps: HomeCheckpointDeps, current: FleetBrokerVmHomeDownload, context: LogContext): Promise<void> {
  const requiredBytes = 2 * current.size;
  const freeBytes = await deps.fs.freeBytes(deps.stateRoot);
  if (freeBytes >= requiredBytes) return;
  const message = `home checkpoint ${current.name} needs ${requiredBytes} bytes free on ${deps.stateRoot}, has ${freeBytes}`;
  deps.logError(`[vm-agent] home restore check-space failed: ${message}`, {
    ...context, phase: "check-space", status: "failed", reason: "insufficient-space", checkpointName: current.name, freeBytes, requiredBytes,
  });
  throw new Error(message);
}

export async function restoreHome(deps: HomeCheckpointDeps, scope: HomeScope): Promise<HomeRestoreResult> {
  const expected = scope.restoreCheckpoint;
  if (expected !== undefined && !isDisposableHomeCheckpoint(expected)) throw new Error("required home checkpoint is invalid");
  const receipt = expected ? `${deps.stateRoot}/home-restored-${expected.name}-${expected.generation}-${expected.sha256}.marker` : null;
  const context = { gatewayId: deps.gatewayId, builderSlug: scope.slug, category: "home-restore" };
  if (await deps.fs.exists(scope.restoreGate)) await sweepInterruptedRestore(deps, scope, context);
  const pending = await deps.fs.exists(scope.restorePending);
  if (await homeRestoreInstalled(deps, scope, receipt, pending)) {
    deps.log("[vm-agent] home restore skipped: existing home preserved", {
      ...context, phase: "select-checkpoint", status: "skipped", reason: "home-preserved",
      ...(expected ? { checkpointName: expected.name } : {}),
    });
    return { status: "preserved" };
  }
  let current: FleetBrokerVmHomeDownload | null;
  try {
    current = await fetchHomeRestoreDownload(deps, scope, pending);
  } catch (error) {
    deps.logError(`[vm-agent] home restore select-checkpoint failed: ${error instanceof Error ? error.message : String(error)}`, {
      ...context, phase: "select-checkpoint", status: "failed", ...(expected ? { checkpointName: expected.name } : {}),
    });
    throw error;
  }
  if (!current) {
    deps.log("[vm-agent] home restore none: no checkpoint for this user yet", {
      ...context, phase: "select-checkpoint", status: "skipped", reason: "no-checkpoint",
    });
    return { status: "none" };
  }
  await assertRestoreSpace(deps, current, context);
  const time = homePhaseTimer(deps, { ...context, checkpointName: current.name, sizeBytes: current.size });
  const tempDir = await deps.fs.mkdtemp(HOME_RESTORE_TEMP_PREFIX);
  const archive = `${tempDir}/home.tar.gz`;
  const staged = `${tempDir}/staged`;
  try {
    const size = await time("download", async () => {
      const download = await deps.fetchImpl(current.download.url, { method: current.download.method, signal: AbortSignal.timeout(10 * 60_000) });
      if (!download.ok) throw await brokerFailure("vm-home download", download);
      await deps.fs.saveResponse(download, archive);
      const size = await deps.fs.fileSize(archive);
      if (size !== current.size) throw new Error(`home checkpoint ${current.name} downloaded ${size} bytes, expected ${current.size}`);
      return size;
    });
    await time("hash", async () => {
      const sha256 = await deps.fs.sha256(archive);
      if (sha256 !== current.sha256) throw new Error(`home checkpoint ${current.name} sha256 mismatch`);
    });
    await deps.fs.mkdir(staged);
    await time("extract", () => sh(deps, "tar", tarExtractArgs(archive, staged), [0]));
    await deps.fs.rm(archive);
    await time("install", () => installHomeRestore(deps, scope, current, staged, receipt));
    return { status: "restored", name: current.name, size };
  } finally {
    await deps.fs.rm(tempDir);
  }
}
