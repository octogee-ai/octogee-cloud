import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("builder-toolchain-hydrator");
import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  DEVELOPER_TOOLCHAIN_STATUS_SCHEMA_VERSION,
  isDeveloperToolchainStatus,
  parseDeveloperToolchainStatusArtifact,
  type DeveloperToolchainStatus,
  type DeveloperToolchainStatusArtifact,
} from "@octogee/shared/types/developer-toolchain";
import type { FleetBrokerNpmRegistryCredentials } from "@octogee/shared/types/fleet-broker";
import {
  enabledNpmPackages,
  parseIsolatedToolGroups,
  type IsolatedToolGroups,
} from "./isolated-tool-groups.js";
import { resolveUserChromiumExecutable } from "./isolated-toolchain-chromium.js";

export const ISOLATED_TOOLCHAIN_COMMANDS = ["claude", "codex", "chromium"] as const;
export const DEFAULT_ISOLATED_NPM_FALLBACK_REGISTRY = "https://registry.npmjs.org/";
export const ISOLATED_TOOLCHAIN_RUNTIME_RETIRED = "runtime-retired";

export type IsolatedToolchainCommand = typeof ISOLATED_TOOLCHAIN_COMMANDS[number];

export interface IsolatedToolchainLock {
  schemaVersion: 1;
  id: "npm-lock-sha256";
  commands: Record<IsolatedToolchainCommand, string>;
  versions: Record<IsolatedToolchainCommand, string>;
  packages: Record<string, string>;
}

export interface InstalledIsolatedToolchainLock {
  schemaVersion: 1;
  lockSha256: string;
  groupsSha256: string;
  bundleSha256: string;
  commands: Record<IsolatedToolchainCommand, string>;
}

export type IsolatedToolchainStatus = DeveloperToolchainStatusArtifact;

export interface IsolatedToolchainDetail {
  schemaVersion: 1;
  status: DeveloperToolchainStatus;
  toolchainId?: string;
  lockSha256?: string;
  groupsSha256?: string;
  bundleSha256?: string;
  attempt?: number;
  reasonCode?: string;
  diagnostic?: string;
  nextRetryAt?: string;
}

export interface InstallIsolatedToolchainOptions {
  cachePath: string;
  registryUrl: string;
  authToken?: string;
  npmExecutable?: string;
  signal?: AbortSignal;
}

export interface HydrateIsolatedToolchainOptions {
  root: string;
  preinstalledRoot?: string;
  cachePath?: string;
  packageJsonPath: string;
  packageLockPath: string;
  packageLockSha256: string;
  groupsPath: string;
  groupsSha256: string;
  fallbackRegistryUrl?: string;
  registryCredentialsProvider?: () => Promise<FleetBrokerNpmRegistryCredentials>;
  installDependencies?: (
    destination: string,
    options: InstallIsolatedToolchainOptions,
  ) => Promise<void>;
  attempt?: number;
  publishStatus?: (status: IsolatedToolchainStatus) => Promise<void>;
  log?: (message: string) => void;
  now?: () => Date;
  nowMs?: () => number;
  lockStaleMs?: number;
  signal?: AbortSignal;
}

export interface RunIsolatedToolchainHydrationLoopOptions {
  probeInteractiveReadiness: () => Promise<boolean>;
  hydrate: (attempt: number) => Promise<IsolatedToolchainStatus>;
  ensureReadyPublished?: (status: IsolatedToolchainStatus) => Promise<void>;
  writeStatus: (status: DeveloperToolchainStatus) => Promise<void>;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  waitForShutdown?: () => Promise<void>;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  shouldStop?: () => boolean;
}

export class IsolatedToolchainHydrationError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, options?: { cause?: unknown }) {
    super(`Isolated toolchain hydration failed: ${reasonCode}`, options);
    this.name = "IsolatedToolchainHydrationError";
    this.reasonCode = reasonCode;
  }
}

const STATUS_FILE = "status.json";
const DETAIL_FILE = "detail.json";
const INSTALLED_LOCK_FILE = ".toolchain-lock.json";
const DEFAULT_LOCK_STALE_MS = 60 * 60 * 1_000;
const MAX_LOCK_BYTES = 8 * 1_024 * 1_024;
const MAX_GROUPS_BYTES = 256 * 1_024;
const MAX_DIAGNOSTIC_OUTPUT_CHARS = 240;
const NPM_EXECUTABLE = "/usr/local/bin/npm";
const INVALID_TOOLCHAIN_LOCK = "invalid-toolchain-lock";
export const ISOLATED_TOOLCHAIN_COMMAND_PATHS: Record<IsolatedToolchainCommand, string> = {
  claude: "node_modules/.bin/claude",
  codex: "node_modules/.bin/codex",
  chromium: "node_modules/@sparticuz/chromium/build/index.js",
};
const DEPENDENCY_PACKAGES: Record<IsolatedToolchainCommand, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  chromium: "@sparticuz/chromium",
};
const ALLOWED_INSTALL_SCRIPTS = {
  "@anthropic-ai/claude-code@2.1.322": true,
  "esbuild@0.28.2": true,
  "pnpm@12.18.0": true,
  "protobufjs@7.6.6": true,
  "re2@1.27.0": true,
};

function hydrationError(reasonCode: string, cause?: unknown): IsolatedToolchainHydrationError {
  return new IsolatedToolchainHydrationError(reasonCode, cause === undefined ? undefined : { cause });
}

function isRuntimeRetired(error: unknown): boolean {
  return error instanceof IsolatedToolchainHydrationError &&
    error.reasonCode === ISOLATED_TOOLCHAIN_RUNTIME_RETIRED;
}

function isNodeError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isExactVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function isIntegrity(value: unknown): value is string {
  return typeof value === "string" && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function packageNameFromLockPath(lockPath: string): string | null {
  const marker = "node_modules/";
  const index = lockPath.lastIndexOf(marker);
  if (index < 0) return null;
  const packageName = lockPath.slice(index + marker.length);
  return packageName && !packageName.includes("node_modules/") ? packageName : null;
}

function platformListAllows(value: unknown, target: string): boolean {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return true;
  const entries = value as string[];
  if (entries.includes(`!${target}`)) return false;
  const positive = entries.filter((entry) => !entry.startsWith("!"));
  return positive.length === 0 || positive.includes(target);
}

function parseLockPackages(
  value: unknown,
  manifest: IsolatedToolGroups,
): {
  packages: Record<string, unknown>;
  dependencies: Record<string, unknown>;
  packagesByVersion: Record<string, string>;
} {
  const lock = objectRecord(value);
  const packages = objectRecord(lock?.packages);
  const root = objectRecord(packages?.[""]);
  const dependencies = objectRecord(root?.dependencies);
  const packagesByVersion = enabledNpmPackages(manifest);
  if (!lock || lock.lockfileVersion !== 3 || !packages || !root || !dependencies) {
    throw hydrationError(INVALID_TOOLCHAIN_LOCK);
  }
  if (!exactKeys(dependencies, Object.keys(packagesByVersion))) {
    throw hydrationError(INVALID_TOOLCHAIN_LOCK);
  }
  return { packages, dependencies, packagesByVersion };
}

function validateLockedPackages(
  packages: Record<string, unknown>,
  dependencies: Record<string, unknown>,
  packagesByVersion: Record<string, string>,
): void {
  for (const [packageName, requestedVersion] of Object.entries(packagesByVersion)) {
    const requested = dependencies[packageName];
    const installed = objectRecord(packages[`node_modules/${packageName}`]);
    const valid = requested === requestedVersion && isExactVersion(requested) &&
      installed?.version === requested && isIntegrity(installed.integrity);
    if (!valid) throw hydrationError(INVALID_TOOLCHAIN_LOCK);
  }
}

function lockedInstallScripts(packages: Record<string, unknown>): string[] {
  return Object.entries(packages).flatMap(([lockPath, value]) => {
    const installed = objectRecord(value);
    const packageName = packageNameFromLockPath(lockPath);
    const supportsUser = platformListAllows(installed?.os, "linux") &&
      platformListAllows(installed?.cpu, "x64");
    return installed?.hasInstallScript === true && supportsUser && packageName &&
      isExactVersion(installed.version)
      ? [`${packageName}@${installed.version}`]
      : [];
  });
}

function lockedCommandVersions(
  packagesByVersion: Record<string, string>,
): Record<IsolatedToolchainCommand, string> {
  const versions = Object.fromEntries(ISOLATED_TOOLCHAIN_COMMANDS.map((command) => [
    command,
    packagesByVersion[DEPENDENCY_PACKAGES[command]],
  ])) as Record<IsolatedToolchainCommand, string>;
  if (Object.values(versions).some((version) => !version)) {
    throw hydrationError(INVALID_TOOLCHAIN_LOCK);
  }
  return versions;
}

export function parseIsolatedToolchainLock(
  value: unknown,
  manifest: IsolatedToolGroups,
): IsolatedToolchainLock {
  const { packages, dependencies, packagesByVersion } = parseLockPackages(value, manifest);
  validateLockedPackages(packages, dependencies, packagesByVersion);
  const commands = new Set(Object.keys(packagesByVersion).flatMap((name) => {
    const bin = objectRecord(objectRecord(packages[`node_modules/${name}`])?.bin);
    return bin ? Object.keys(bin) : [];
  }));
  for (const command of npmGroupCommands(manifest)) {
    if (!commands.has(command)) throw hydrationError(`missing-command:${command}`);
  }
  const scriptedPackages = lockedInstallScripts(packages);
  if (!exactKeys(
    Object.fromEntries(scriptedPackages.map((approval) => [approval, true])),
    Object.keys(ALLOWED_INSTALL_SCRIPTS),
  )) {
    throw hydrationError(INVALID_TOOLCHAIN_LOCK);
  }

  return {
    schemaVersion: 1,
    id: "npm-lock-sha256",
    commands: { ...ISOLATED_TOOLCHAIN_COMMAND_PATHS },
    versions: lockedCommandVersions(packagesByVersion),
    packages: packagesByVersion,
  };
}

function parsePackageJson(value: unknown, expected: IsolatedToolchainLock): void {
  const packageJson = objectRecord(value);
  const dependencies = objectRecord(packageJson?.dependencies);
  const allowScripts = objectRecord(packageJson?.allowScripts);
  if (
    !packageJson || packageJson.private !== true || !dependencies || !allowScripts ||
    !exactKeys(allowScripts, Object.keys(ALLOWED_INSTALL_SCRIPTS)) ||
    Object.keys(ALLOWED_INSTALL_SCRIPTS).some((approval) => allowScripts[approval] !== true)
  ) {
    throw hydrationError("invalid-toolchain-package");
  }
  const expectedPackages = Object.keys(expected.packages);
  if (!exactKeys(dependencies, expectedPackages)) {
    throw hydrationError("invalid-toolchain-package");
  }
  for (const [packageName, version] of Object.entries(expected.packages)) {
    if (dependencies[packageName] !== version) {
      throw hydrationError("invalid-toolchain-package");
    }
  }
}

function validatedRegistryUrl(raw: string, allowInternalProxy = false): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw hydrationError("invalid-registry-url");
  }
  const internalProxy = allowInternalProxy && url.protocol === "http:" &&
    /^octogee-npm-cache-proxy\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.svc\.cluster\.local$/u
      .test(url.hostname) &&
    url.port === "3005" && url.pathname === "/";
  const allowedTarget = allowInternalProxy ? internalProxy : url.protocol === "https:";
  if (
    !allowedTarget || url.username || url.password ||
    url.search || url.hash
  ) {
    throw hydrationError("invalid-registry-url");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function digestBytes(value: Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

async function readPinnedToolchain(options: HydrateIsolatedToolchainOptions): Promise<{
  descriptor: IsolatedToolchainLock;
  lockBytes: Buffer;
  groupsBytes: Buffer;
  manifest: IsolatedToolGroups;
  bundleSha256: string;
}> {
  if (!isSha256(options.packageLockSha256) || !isSha256(options.groupsSha256)) {
    throw hydrationError("invalid-toolchain-lock-pin");
  }
  const [lockBytes, packageBytes, groupsBytes] = await Promise.all([
    fs.readFile(options.packageLockPath).catch(() => {
      throw hydrationError("toolchain-lock-unavailable");
    }),
    fs.readFile(options.packageJsonPath).catch(() => {
      throw hydrationError("toolchain-package-unavailable");
    }),
    fs.readFile(options.groupsPath).catch(() => {
      throw hydrationError("toolchain-groups-unavailable");
    }),
  ]);
  if (lockBytes.byteLength > MAX_LOCK_BYTES || groupsBytes.byteLength > MAX_GROUPS_BYTES) {
    throw hydrationError(INVALID_TOOLCHAIN_LOCK);
  }
  if (!timingSafeEqual(digestBytes(lockBytes), Buffer.from(options.packageLockSha256, "hex"))) {
    throw hydrationError("toolchain-lock-digest-mismatch");
  }
  if (!timingSafeEqual(digestBytes(groupsBytes), Buffer.from(options.groupsSha256, "hex"))) {
    throw hydrationError("toolchain-groups-digest-mismatch");
  }
  let lockValue: unknown;
  let packageValue: unknown;
  let groupsValue: unknown;
  try {
    lockValue = JSON.parse(lockBytes.toString("utf8"));
    packageValue = JSON.parse(packageBytes.toString("utf8"));
    groupsValue = JSON.parse(groupsBytes.toString("utf8"));
  } catch {
    throw hydrationError(INVALID_TOOLCHAIN_LOCK);
  }
  let manifest: IsolatedToolGroups;
  try {
    manifest = parseIsolatedToolGroups(groupsValue);
  } catch {
    throw hydrationError("invalid-toolchain-groups");
  }
  const descriptor = parseIsolatedToolchainLock(lockValue, manifest);
  parsePackageJson(packageValue, descriptor);
  const bundleSha256 = createHash("sha256").update(lockBytes).update(groupsBytes).digest("hex");
  return { descriptor, lockBytes, groupsBytes, manifest, bundleSha256 };
}

function statusFor(status: DeveloperToolchainStatus, now: Date): IsolatedToolchainStatus {
  return {
    schemaVersion: DEVELOPER_TOOLCHAIN_STATUS_SCHEMA_VERSION,
    status,
    updatedAt: now.toISOString(),
  };
}

function detailFor(
  status: DeveloperToolchainStatus,
  fields: Omit<IsolatedToolchainDetail, "schemaVersion" | "status"> = {},
): IsolatedToolchainDetail {
  return { schemaVersion: 1, status, ...fields };
}

async function writeAtomicJson(root: string, fileName: string, value: unknown): Promise<void> {
  const destination = path.join(root, fileName);
  const temporary = path.join(root, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, destination);
}

export async function writeToolchainStatus(
  root: string,
  status: IsolatedToolchainStatus,
  options: {
    publishStatus?: (status: IsolatedToolchainStatus) => Promise<void>;
    log?: (message: string) => void;
  } = {},
): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (!parseDeveloperToolchainStatusArtifact(status)) {
    throw new Error("invalid developer toolchain status artifact");
  }
  await writeAtomicJson(root, STATUS_FILE, status);
  if (options.publishStatus) {
    try {
      await options.publishStatus(status);
    } catch (error) {
      const type = error instanceof Error ? error.name : typeof error;
      (options.log ?? runtimeLogger.info)(
        `[isolated-toolchain] status publication failed (${type}) status=${status.status} error=${errorMessage(error)}`,
      );
    }
  }
}

export async function readToolchainStatus(root: string): Promise<IsolatedToolchainStatus | null> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(root, STATUS_FILE), "utf8")) as unknown;
    return parseDeveloperToolchainStatusArtifact(value);
  } catch (error) {
    if (isNodeError(error, "ENOENT") || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeToolchainDetail(root: string, detail: IsolatedToolchainDetail): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await writeAtomicJson(root, DETAIL_FILE, detail);
}

export async function readToolchainDetail(root: string): Promise<IsolatedToolchainDetail | null> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(root, DETAIL_FILE), "utf8")) as unknown;
    const detail = objectRecord(value) as unknown as IsolatedToolchainDetail | null;
    if (!detail || detail.schemaVersion !== 1 || !isDeveloperToolchainStatus(detail.status)) return null;
    return detail;
  } catch (error) {
    if (isNodeError(error, "ENOENT") || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function acquireHydrationLock(
  root: string,
  staleMs: number,
): Promise<{ acquired: boolean; release: () => Promise<void> }> {
  const lockPath = path.join(root, ".hydrate.lock");
  const ownerPath = path.join(lockPath, "owner.json");
  const ownerToken = randomUUID();
  const attempt = async (): Promise<boolean> => {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(ownerPath, JSON.stringify({ pid: process.pid, ownerToken }), { mode: 0o600 });
      return true;
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return false;
      throw error;
    }
  };
  const release = async (): Promise<void> => {
    const owner = await fs.readFile(ownerPath, "utf8").then(
      (raw) => JSON.parse(raw) as { ownerToken?: unknown },
      () => null,
    );
    if (owner?.ownerToken === ownerToken) {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  };
  if (await attempt()) return { acquired: true, release };
  const stat = await fs.stat(lockPath).catch(() => null);
  if (stat && Date.now() - stat.mtimeMs > staleMs) {
    await fs.rm(lockPath, { recursive: true, force: true });
    if (await attempt()) return { acquired: true, release };
  }
  return { acquired: false, release: async () => {} };
}

function npmAuthKey(registryUrl: string): string {
  const url = new URL(registryUrl);
  return `//${url.host}${url.pathname}:_authToken`;
}

export async function installIsolatedToolchainDependencies(
  destination: string,
  options: InstallIsolatedToolchainOptions,
): Promise<void> {
  const npmrcPath = path.join(destination, ".npmrc.hydration");
  const npmrc = [
    `registry=${options.registryUrl}`,
    "replace-registry-host=always",
    "audit=false",
    "fund=false",
    ...(options.authToken ? [`${npmAuthKey(options.registryUrl)}=\${NODE_AUTH_TOKEN}`] : []),
    "",
  ].join("\n");
  await fs.writeFile(npmrcPath, npmrc, { mode: 0o600 });
  try {
    const childEnv = { ...process.env };
    delete childEnv.NODE_AUTH_TOKEN;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(options.npmExecutable ?? NPM_EXECUTABLE, [
        "ci",
        "--omit=dev",
        "--include=optional",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
      ], {
        cwd: destination,
        env: {
          ...childEnv,
          NPM_CONFIG_CACHE: options.cachePath,
          NPM_CONFIG_USERCONFIG: npmrcPath,
          ...(options.authToken ? { NODE_AUTH_TOKEN: options.authToken } : {}),
        },
        signal: options.signal,
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`npm ci exited ${code ?? signal ?? "unknown"}`));
      });
    });
  } finally {
    await fs.rm(npmrcPath, { force: true });
  }
}

interface HydrationRuntime {
  fallbackRegistryUrl: string;
  installDependencies: NonNullable<HydrateIsolatedToolchainOptions["installDependencies"]>;
  lockStaleMs: number;
  log: (message: string) => void;
  now: () => Date;
  nowMs: () => number;
}

function resolveHydrationRuntime(options: HydrateIsolatedToolchainOptions): HydrationRuntime {
  return {
    fallbackRegistryUrl: validatedRegistryUrl(
      options.fallbackRegistryUrl ?? DEFAULT_ISOLATED_NPM_FALLBACK_REGISTRY,
    ),
    installDependencies: options.installDependencies ?? installIsolatedToolchainDependencies,
    lockStaleMs: options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
    log: options.log ?? runtimeLogger.info,
    now: options.now ?? (() => new Date()),
    nowMs: options.nowMs ?? Date.now,
  };
}

async function validateCommandFiles(objectPath: string): Promise<void> {
  const realRoot = await fs.realpath(objectPath);
  for (const command of ISOLATED_TOOLCHAIN_COMMANDS) {
    const commandPath = path.join(objectPath, ISOLATED_TOOLCHAIN_COMMAND_PATHS[command]);
    const stat = await fs.lstat(commandPath).catch(() => null);
    if (!stat || (!stat.isFile() && !stat.isSymbolicLink())) {
      throw hydrationError(`missing-command:${command}`);
    }
    const realCommand = await fs.realpath(commandPath);
    if (!realCommand.startsWith(`${realRoot}${path.sep}`)) {
      throw hydrationError("unsafe-command-path");
    }
    await fs.access(
      realCommand,
      command === "chromium" ? fsConstants.R_OK : fsConstants.X_OK,
    );
  }
}

function commandReportsPinnedVersion(
  command: IsolatedToolchainCommand,
  output: string,
  version: string,
): boolean {
  if (command !== "chromium") {
    return output.split(/[^0-9A-Za-z.-]+/u).includes(version);
  }
  const major = version.split(".")[0];
  const reportedMajor = output.match(/\b(?:Chromium|HeadlessChrome)\s+(\d+)\./u)?.[1];
  return major !== undefined && reportedMajor === major;
}

interface VersionCommandResult {
  exit: string;
  stdout: string;
  stderr: string;
}

function diagnosticOutput(value: string): string {
  const flattened = value.replace(/\s+/gu, " ").trim();
  return flattened.length > MAX_DIAGNOSTIC_OUTPUT_CHARS
    ? `${flattened.slice(0, MAX_DIAGNOSTIC_OUTPUT_CHARS)}…`
    : flattened;
}

function expectedVersionLabel(command: IsolatedToolchainCommand, version: string): string {
  return command === "chromium" ? `${version.split(".")[0]}.x` : version;
}

function commandVersionError(
  command: IsolatedToolchainCommand,
  version: string,
  subject: string,
  detail: string,
): IsolatedToolchainHydrationError {
  return hydrationError(
    `invalid-command-version:${command}`,
    new Error(`${subject} expected ${expectedVersionLabel(command, version)}: ${detail}`),
  );
}

function runVersionCommand(
  executable: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<VersionCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version"], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, exitSignal) => {
      resolve({ exit: String(code ?? exitSignal ?? "unknown"), stdout, stderr });
    });
  });
}

async function versionExecutable(
  command: IsolatedToolchainCommand,
  commandPath: string,
  version: string,
): Promise<string> {
  if (command !== "chromium") return commandPath;
  try {
    return await resolveUserChromiumExecutable(commandPath);
  } catch (error) {
    throw commandVersionError(
      command,
      version,
      "chromium executable",
      `unresolved (${errorMessage(error)})`,
    );
  }
}

async function validateCommandVersion(
  objectPath: string,
  command: IsolatedToolchainCommand,
  version: string,
  signal?: AbortSignal,
): Promise<void> {
  const commandPath = path.join(objectPath, ISOLATED_TOOLCHAIN_COMMAND_PATHS[command]);
  const executable = await versionExecutable(command, commandPath, version);
  const subject = `${command} --version`;
  let result: VersionCommandResult;
  try {
    result = await runVersionCommand(executable, objectPath, signal);
  } catch (error) {
    throw commandVersionError(command, version, subject, `failed to start (${errorMessage(error)})`);
  }
  const reported = result.exit === "0" &&
    commandReportsPinnedVersion(command, `${result.stdout}\n${result.stderr}`, version);
  if (!reported) {
    throw commandVersionError(
      command,
      version,
      subject,
      `exited ${result.exit} stdout=${JSON.stringify(diagnosticOutput(result.stdout))} ` +
        `stderr=${JSON.stringify(diagnosticOutput(result.stderr))}`,
    );
  }
}

async function validateCommandVersions(
  objectPath: string,
  descriptor: IsolatedToolchainLock,
  signal?: AbortSignal,
): Promise<void> {
  await validateCommandFiles(objectPath);
  for (const command of ISOLATED_TOOLCHAIN_COMMANDS) {
    await validateCommandVersion(objectPath, command, descriptor.versions[command], signal);
  }
}

function npmGroupCommands(manifest: IsolatedToolGroups): string[] {
  return manifest.groups
    .filter((group) => group.enabled && group.delivery === "npm")
    .flatMap((group) => group.commands ?? [])
    .filter((command) => command !== "chromium");
}

async function activateNpmCommands(
  objectPath: string,
  manifest: IsolatedToolGroups,
): Promise<void> {
  const source = path.join(objectPath, "node_modules", ".bin");
  const destination = path.join(objectPath, "bin");
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const command of npmGroupCommands(manifest)) {
    const executable = path.join(source, command);
    const stat = await fs.lstat(executable).catch(() => null);
    if (!stat || (!stat.isFile() && !stat.isSymbolicLink())) {
      throw hydrationError(`missing-command:${command}`);
    }
    const link = path.join(destination, command);
    await fs.rm(link, { force: true });
    await fs.symlink(path.relative(destination, executable), link);
  }
}

async function validateNpmCommands(
  objectPath: string,
  manifest: IsolatedToolGroups,
): Promise<void> {
  const realRoot = await fs.realpath(objectPath);
  for (const command of npmGroupCommands(manifest)) {
    const executable = await fs.realpath(path.join(objectPath, "bin", command)).catch(() => "");
    if (!executable.startsWith(`${realRoot}${path.sep}`)) throw hydrationError("unsafe-command-path");
    await fs.access(executable, fsConstants.X_OK);
  }
}

function installedDescriptor(
  lockSha256: string,
  groupsSha256: string,
  bundleSha256: string,
): InstalledIsolatedToolchainLock {
  return {
    schemaVersion: 1,
    lockSha256,
    groupsSha256,
    bundleSha256,
    commands: { ...ISOLATED_TOOLCHAIN_COMMAND_PATHS },
  };
}

interface InstalledObjectValidation {
  objectPath: string;
  expected: InstalledIsolatedToolchainLock;
  descriptor: IsolatedToolchainLock;
  manifest: IsolatedToolGroups;
  signal?: AbortSignal;
}

async function validateInstalledObject(input: InstalledObjectValidation): Promise<boolean> {
  try {
    const installed = JSON.parse(
      await fs.readFile(path.join(input.objectPath, INSTALLED_LOCK_FILE), "utf8"),
    ) as InstalledIsolatedToolchainLock;
    if (
      installed.schemaVersion !== input.expected.schemaVersion ||
      installed.lockSha256 !== input.expected.lockSha256 ||
      installed.groupsSha256 !== input.expected.groupsSha256 ||
      installed.bundleSha256 !== input.expected.bundleSha256 ||
      JSON.stringify(installed.commands) !== JSON.stringify(ISOLATED_TOOLCHAIN_COMMAND_PATHS)
    ) return false;
    await validateCommandVersions(input.objectPath, input.descriptor, input.signal);
    await validateNpmCommands(input.objectPath, input.manifest);
    return true;
  } catch {
    return false;
  }
}

async function activateObject(root: string, objectPath: string): Promise<void> {
  const activePath = path.join(root, "active");
  const existing = await fs.lstat(activePath).catch(() => null);
  if (existing && !existing.isSymbolicLink()) throw hydrationError("invalid-active-path");
  const relativeTarget = path.relative(await fs.realpath(root), await fs.realpath(objectPath));
  const temporaryLink = path.join(root, `.active.${process.pid}.${randomUUID()}.tmp`);
  await fs.symlink(relativeTarget, temporaryLink, "dir");
  try {
    await fs.rename(temporaryLink, activePath);
  } finally {
    await fs.rm(temporaryLink, { force: true });
  }
}

async function installWithRegistryFallback(input: {
  destination: string;
  cachePath: string;
  fallbackRegistryUrl: string;
  registryCredentialsProvider?: () => Promise<FleetBrokerNpmRegistryCredentials>;
  installDependencies: (
    destination: string,
    options: InstallIsolatedToolchainOptions,
  ) => Promise<void>;
  signal?: AbortSignal;
  log: (message: string) => void;
  nowMs: () => number;
}): Promise<void> {
  const run = async (kind: "proxy" | "direct", registryUrl: string, authToken?: string) => {
    const startedAt = input.nowMs();
    try {
      await input.installDependencies(input.destination, {
        cachePath: input.cachePath,
        registryUrl,
        ...(authToken ? { authToken } : {}),
        signal: input.signal,
      });
      input.log(
        `[isolated-toolchain] npm install registry=${kind} outcome=ready durationMs=${input.nowMs() - startedAt}`,
      );
    } catch (error) {
      input.log(
        `[isolated-toolchain] npm install registry=${kind} outcome=failed durationMs=${input.nowMs() - startedAt}`,
      );
      throw error;
    }
  };

  if (!input.registryCredentialsProvider) {
    input.log("[isolated-toolchain] npm proxy credentials provider unavailable; waiting for assignment");
    throw hydrationError("npm-proxy-credentials-unavailable");
  }

  let credentials: FleetBrokerNpmRegistryCredentials;
  try {
    const candidate = await input.registryCredentialsProvider();
    const expiresAtMs = Date.parse(candidate.expiresAt);
    if (
      !/^[A-Za-z0-9_-]{43,128}$/u.test(candidate.token) ||
      !Number.isFinite(expiresAtMs) || expiresAtMs <= input.nowMs()
    ) {
      throw new Error("invalid npm proxy capability");
    }
    credentials = {
      registryUrl: validatedRegistryUrl(candidate.registryUrl, true),
      token: candidate.token,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  } catch (error) {
    if (isRuntimeRetired(error)) throw error;
    input.log("[isolated-toolchain] npm proxy credentials unavailable; waiting for assignment");
    throw hydrationError("npm-proxy-credentials-unavailable");
  }

  try {
    await run("proxy", credentials.registryUrl, credentials.token);
    return;
  } catch {
    input.log("[isolated-toolchain] npm proxy install failed; falling back to direct npm");
  }
  try {
    await run("direct", input.fallbackRegistryUrl);
  } catch (error) {
    throw hydrationError("npm-install-failed", error);
  }
}

type ToolchainStatusPersister = (
  status: IsolatedToolchainStatus,
  detail: IsolatedToolchainDetail,
) => Promise<IsolatedToolchainStatus>;

async function persistHydrationFailure(input: {
  error: unknown;
  toolchainId?: string;
  lockSha256?: string;
  groupsSha256?: string;
  bundleSha256?: string;
  attempt?: number;
  now: () => Date;
  persist: ToolchainStatusPersister;
}): Promise<never> {
  const error = input.error;
  if (isRuntimeRetired(error)) throw error;
  const knownError = error instanceof IsolatedToolchainHydrationError;
  const reasonCode = knownError ? error.reasonCode : "internal-error";
  const cause = knownError ? error.cause : error;
  const failureStatus = reasonCode === "npm-proxy-credentials-unavailable" ? "pending" : "failed";
  await input.persist(statusFor(failureStatus, input.now()), detailFor(failureStatus, {
    ...(input.toolchainId ? { toolchainId: input.toolchainId } : {}),
    ...(input.lockSha256 ? { lockSha256: input.lockSha256 } : {}),
    ...(input.groupsSha256 ? { groupsSha256: input.groupsSha256 } : {}),
    ...(input.bundleSha256 ? { bundleSha256: input.bundleSha256 } : {}),
    attempt: input.attempt,
    reasonCode,
    ...(cause === undefined ? {} : { diagnostic: errorMessage(cause) }),
  }));
  if (knownError) throw error;
  throw hydrationError(reasonCode, error);
}

export async function hydrateIsolatedToolchain(
  options: HydrateIsolatedToolchainOptions,
): Promise<IsolatedToolchainStatus> {
  const runtime = resolveHydrationRuntime(options);
  await fs.mkdir(options.root, { recursive: true, mode: 0o700 });
  const lock = await acquireHydrationLock(options.root, runtime.lockStaleMs);
  const persist = async (
    status: IsolatedToolchainStatus,
    detail: IsolatedToolchainDetail,
  ): Promise<IsolatedToolchainStatus> => {
    await writeToolchainDetail(options.root, detail);
    await writeToolchainStatus(options.root, status, {
      publishStatus: options.publishStatus,
      log: runtime.log,
    });
    return status;
  };
  if (!lock.acquired) {
    return persist(statusFor("pending", runtime.now()), detailFor("pending", {
      attempt: options.attempt,
      reasonCode: "hydration-in-progress",
    }));
  }

  let lockSha256: string | undefined;
  let groupsSha256: string | undefined;
  let bundleSha256: string | undefined;
  let toolchainId: string | undefined;
  const stagingPath = path.join(options.root, "staging", `${process.pid}-${randomUUID()}`);
  try {
    const pinned = await readPinnedToolchain(options);
    lockSha256 = options.packageLockSha256;
    groupsSha256 = options.groupsSha256;
    bundleSha256 = pinned.bundleSha256;
    toolchainId = `builder-tools-${bundleSha256}`;
    const objectPath = path.join(options.root, "objects", `sha256-${bundleSha256}`);
    const expectedInstalled = installedDescriptor(lockSha256, groupsSha256, bundleSha256);
    if (options.preinstalledRoot) {
      const imageObject = await fs.realpath(options.preinstalledRoot).catch(() => null);
      if (!imageObject || !(await validateInstalledObject({ objectPath: imageObject, expected: expectedInstalled,
        descriptor: pinned.descriptor, manifest: pinned.manifest, signal: options.signal }))) {
        throw hydrationError("invalid-preinstalled-toolchain");
      }
      await activateObject(options.root, imageObject);
      return persist(statusFor("ready", runtime.now()), detailFor("ready", {
        toolchainId, lockSha256, groupsSha256, bundleSha256, attempt: options.attempt,
      }));
    }
    if (await validateInstalledObject({
      objectPath,
      expected: expectedInstalled,
      descriptor: pinned.descriptor,
      manifest: pinned.manifest,
      signal: options.signal,
    })) {
      await activateObject(options.root, objectPath);
      return persist(statusFor("ready", runtime.now()), detailFor("ready", {
        toolchainId,
        lockSha256,
        groupsSha256,
        bundleSha256,
        attempt: options.attempt,
      }));
    }
    await fs.rm(objectPath, { recursive: true, force: true });

    await persist(statusFor("downloading", runtime.now()), detailFor("downloading", {
      toolchainId,
      lockSha256,
      groupsSha256,
      bundleSha256,
      attempt: options.attempt,
    }));
    await fs.mkdir(stagingPath, { recursive: true, mode: 0o700 });
    await Promise.all([
      fs.copyFile(options.packageJsonPath, path.join(stagingPath, "package.json")),
      fs.writeFile(path.join(stagingPath, "package-lock.json"), pinned.lockBytes, { mode: 0o600 }),
      fs.writeFile(path.join(stagingPath, "groups.json"), pinned.groupsBytes, { mode: 0o600 }),
    ]);
    await installWithRegistryFallback({
      destination: stagingPath,
      cachePath: options.cachePath ?? path.join(options.root, "npm-cache"),
      fallbackRegistryUrl: runtime.fallbackRegistryUrl,
      registryCredentialsProvider: options.registryCredentialsProvider,
      installDependencies: runtime.installDependencies,
      signal: options.signal,
      log: runtime.log,
      nowMs: runtime.nowMs,
    });
    await activateNpmCommands(stagingPath, pinned.manifest);

    await persist(statusFor("verifying", runtime.now()), detailFor("verifying", {
      toolchainId,
      lockSha256,
      groupsSha256,
      bundleSha256,
      attempt: options.attempt,
    }));
    await validateCommandVersions(stagingPath, pinned.descriptor, options.signal);
    await validateNpmCommands(stagingPath, pinned.manifest);
    await fs.writeFile(
      path.join(stagingPath, INSTALLED_LOCK_FILE),
      `${JSON.stringify(expectedInstalled)}\n`,
      { mode: 0o600 },
    );
    await fs.mkdir(path.dirname(objectPath), { recursive: true, mode: 0o700 });
    if (await fs.lstat(objectPath).catch(() => null)) {
      if (!(await validateInstalledObject({
        objectPath,
        expected: expectedInstalled,
        descriptor: pinned.descriptor,
        manifest: pinned.manifest,
        signal: options.signal,
      }))) {
        throw hydrationError("invalid-existing-object");
      }
      await fs.rm(stagingPath, { recursive: true, force: true });
    } else {
      await fs.rename(stagingPath, objectPath);
    }
    await activateObject(options.root, objectPath);
    return persist(statusFor("ready", runtime.now()), detailFor("ready", {
      toolchainId,
      lockSha256,
      groupsSha256,
      bundleSha256,
      attempt: options.attempt,
    }));
  } catch (error) {
    return await persistHydrationFailure({
      error,
      toolchainId,
      lockSha256,
      groupsSha256,
      bundleSha256,
      attempt: options.attempt,
      now: runtime.now,
      persist,
    });
  } finally {
    await fs.rm(stagingPath, { recursive: true, force: true });
    await lock.release();
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitForever = (): Promise<void> => new Promise(() => {});

type HydrationLoopSleep = (ms: number) => Promise<void>;
type HydrationFailureKind = "retry" | "assignment" | "terminal" | "retired";

interface HydrationAttemptResult {
  status?: IsolatedToolchainStatus;
  stopped: boolean;
  failure?: HydrationFailureKind;
}

const DETERMINISTIC_VERIFICATION_FAILURE = /^(?:invalid-command-version:|missing-command:|unsafe-command-path$|invalid-preinstalled-toolchain$)/u;

async function waitForInteractiveReadiness(
  options: RunIsolatedToolchainHydrationLoopOptions,
  sleep: HydrationLoopSleep,
  shouldStop: () => boolean,
): Promise<boolean> {
  let pendingWritten = false;
  while (!shouldStop()) {
    if (await options.probeInteractiveReadiness()) return true;
    if (!pendingWritten) {
      await options.writeStatus("pending");
      pendingWritten = true;
    }
    await sleep(1_000);
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hydrationFailureReason(error: unknown): string {
  if (!(error instanceof IsolatedToolchainHydrationError)) {
    return `reason=internal-error error=${errorMessage(error)}`;
  }
  if (error.cause === undefined) return `reason=${error.reasonCode}`;
  return `reason=${error.reasonCode} error=${errorMessage(error.cause)}`;
}

function classifyHydrationFailure(error: unknown): HydrationFailureKind {
  if (!(error instanceof IsolatedToolchainHydrationError)) return "retry";
  if (error.reasonCode === ISOLATED_TOOLCHAIN_RUNTIME_RETIRED) return "retired";
  if (DETERMINISTIC_VERIFICATION_FAILURE.test(error.reasonCode)) return "terminal";
  return error.reasonCode === "npm-proxy-credentials-unavailable" ? "assignment" : "retry";
}

function describeHydrationFailure(
  attempt: number,
  error: unknown,
  failure: HydrationFailureKind,
): string {
  if (failure === "retired") {
    return "[isolated-toolchain] runtime retired; hydration stopped until the gateway restarts";
  }
  const next = failure === "terminal" ? "not retrying until the gateway restarts" : "retrying";
  return `[isolated-toolchain] hydration attempt ${attempt} failed ${hydrationFailureReason(error)}; ${next}`;
}

function resolveHydrationLoopRuntime(options: RunIsolatedToolchainHydrationLoopOptions): {
  sleep: HydrationLoopSleep;
  initialBackoffMs: number;
  maxBackoffMs: number;
  shouldStop: () => boolean;
  log: (message: string) => void;
  waitForShutdown: () => Promise<void>;
} {
  return {
    sleep: options.sleep ?? defaultSleep,
    initialBackoffMs: options.initialBackoffMs ?? 5_000,
    maxBackoffMs: options.maxBackoffMs ?? 5 * 60_000,
    shouldStop: options.shouldStop ?? (() => false),
    log: options.log ?? runtimeLogger.info,
    waitForShutdown: options.waitForShutdown ?? waitForever,
  };
}

async function runHydrationAttempt(
  hydrate: RunIsolatedToolchainHydrationLoopOptions["hydrate"],
  attempt: number,
  shouldStop: () => boolean,
  log: (message: string) => void,
): Promise<HydrationAttemptResult> {
  try {
    return { status: await hydrate(attempt), stopped: false };
  } catch (error) {
    const stopped = shouldStop();
    const failure = classifyHydrationFailure(error);
    if (!stopped) log(describeHydrationFailure(attempt, error, failure));
    return { stopped, failure };
  }
}

async function publishReadyUntilAccepted(
  status: IsolatedToolchainStatus,
  publish: RunIsolatedToolchainHydrationLoopOptions["ensureReadyPublished"],
  sleep: HydrationLoopSleep,
  retryMs: number,
  shouldStop: () => boolean,
): Promise<boolean> {
  while (!shouldStop() && publish) {
    try {
      await publish(status);
      break;
    } catch (error) {
      if (shouldStop() || isRuntimeRetired(error)) break;
      await sleep(retryMs);
    }
  }
  return !shouldStop();
}

function nextBackoffMs(
  failure: HydrationFailureKind | undefined,
  backoffMs: number,
  runtime: { initialBackoffMs: number; maxBackoffMs: number },
): number {
  return failure === "assignment"
    ? runtime.initialBackoffMs
    : Math.min(backoffMs * 2, runtime.maxBackoffMs);
}

export async function runIsolatedToolchainHydrationLoop(
  options: RunIsolatedToolchainHydrationLoopOptions,
): Promise<void> {
  const runtime = resolveHydrationLoopRuntime(options);
  const { sleep, initialBackoffMs, shouldStop, log } = runtime;
  if (!(await waitForInteractiveReadiness(options, sleep, shouldStop)) || shouldStop()) return;

  let attempt = 0;
  let backoffMs = initialBackoffMs;
  while (!shouldStop()) {
    attempt += 1;
    const result = await runHydrationAttempt(options.hydrate, attempt, shouldStop, log);
    if (result.stopped) return;
    if (result.failure === "terminal" || result.failure === "retired") {
      await runtime.waitForShutdown();
      return;
    }
    if (result.status?.status === "ready") {
      const published = await publishReadyUntilAccepted(
        result.status,
        options.ensureReadyPublished,
        sleep,
        initialBackoffMs,
        shouldStop,
      );
      if (published) await runtime.waitForShutdown();
      return;
    }

    await sleep(result.failure === "assignment" ? initialBackoffMs : backoffMs);
    backoffMs = nextBackoffMs(result.failure, backoffMs, runtime);
  }
}
