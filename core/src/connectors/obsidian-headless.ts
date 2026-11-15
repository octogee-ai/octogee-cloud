import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

const moduleRequire = createRequire(import.meta.url);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_AUTH_TOKEN_CHARS = 4096;
const MAX_VAULT_SELECTOR_CHARS = 200;
const VAULT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OBSIDIAN_SYNC_HOST_RE = /^(?:[a-z0-9-]+\.)+obsidian\.md$/u;
const ENCRYPTION_KEY_RE = /^[A-Za-z0-9+/]{43}=$/u;
const RUNTIME_FAILED = "runtime-failed";
const ALLOWED_CHILD_ENV = new Set(["HOME", "OBSIDIAN_AUTH_TOKEN", "TMPDIR", "XDG_CONFIG_HOME"]);

export interface ObsidianRemoteVault {
  id: string;
  name: string;
  region: string;
  shared: boolean;
}

export interface ObsidianConnectionConfig {
  schemaVersion: 1;
  vaultId: string;
  vaultName: string;
  headlessConfig: Record<string, unknown>;
}

export interface ObsidianCommandOptions {
  env: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface ObsidianCommandResult {
  stdout: string;
  stderr: string;
}

export type ObsidianCommandRunner = (
  args: readonly string[],
  options: ObsidianCommandOptions,
) => Promise<ObsidianCommandResult>;

export class ObsidianHeadlessError extends Error {
  constructor(
    message: string,
    readonly code: "invalid-input" | "provider-rejected" | "runtime-failed",
  ) {
    super(message);
    this.name = "ObsidianHeadlessError";
  }
}

function cliPath(): string {
  try {
    return join(dirname(moduleRequire.resolve("obsidian-headless/package.json")), "cli.js");
  } catch {
    const runtimeRequire = createRequire(join(process.cwd(), "package.json"));
    return join(dirname(runtimeRequire.resolve("obsidian-headless/package.json")), "cli.js");
  }
}

export function obsidianHeadlessEnvironment(
  overrides: Record<string, string>,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {
    HOME: "/nonexistent",
    XDG_CONFIG_HOME: "/nonexistent",
  };
  for (const name of ["LANG", "LC_ALL", "NODE_EXTRA_CA_CERTS", "PATH", "TMPDIR", "TZ"]) {
    const value = inherited[name];
    if (typeof value === "string") environment[name] = value;
  }
  for (const name of Object.keys(overrides)) {
    if (!ALLOWED_CHILD_ENV.has(name)) throw new Error(`Unsupported Obsidian child environment variable: ${name}`);
  }
  return { ...environment, ...overrides };
}

export const runObsidianHeadless: ObsidianCommandRunner = (args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath(), ...args], {
      env: obsidianHeadlessEnvironment(options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      outcome();
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new ObsidianHeadlessError("Obsidian Headless output exceeded the limit", RUNTIME_FAILED)));
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new ObsidianHeadlessError("Obsidian Headless timed out", RUNTIME_FAILED)));
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", () => {
      finish(() => reject(new ObsidianHeadlessError("Obsidian Headless could not start", RUNTIME_FAILED)));
    });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new ObsidianHeadlessError("Obsidian rejected the connection", "provider-rejected"));
      });
    });
    child.stdin.end(options.stdin ?? "");
  });

function requiredSecret(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new ObsidianHeadlessError(`${label} is invalid`, "invalid-input");
  }
  return value.trim();
}

function parsedRecord(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new ObsidianHeadlessError("Obsidian returned invalid data", RUNTIME_FAILED);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ObsidianHeadlessError("Obsidian returned invalid data", RUNTIME_FAILED);
  }
  return parsed as Record<string, unknown>;
}

function remoteVaultLine(line: string, shared: boolean): ObsidianRemoteVault | null {
  const match = /^\s{2}([A-Za-z0-9_-]{1,128})\s+"(.+)"\s+\(([^()]*)\)$/.exec(line);
  if (!match || match[2].length > MAX_VAULT_SELECTOR_CHARS) return null;
  return { id: match[1], name: match[2], region: match[3], shared };
}

export async function listObsidianRemoteVaults(
  authTokenValue: unknown,
  runner: ObsidianCommandRunner = runObsidianHeadless,
): Promise<ObsidianRemoteVault[]> {
  const authToken = requiredSecret(authTokenValue, "Auth token", MAX_AUTH_TOKEN_CHARS);
  const result = await runner(["sync-list-remote"], {
    env: { OBSIDIAN_AUTH_TOKEN: authToken },
  });
  const vaults: ObsidianRemoteVault[] = [];
  let shared = false;
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (line === "Vaults:") {
      shared = false;
      continue;
    }
    if (line === "Shared vaults:") {
      shared = true;
      continue;
    }
    if (!line.startsWith("  ")) continue;
    const parsed = remoteVaultLine(line, shared);
    if (!parsed) {
      throw new ObsidianHeadlessError("Obsidian returned an invalid vault list", RUNTIME_FAILED);
    }
    vaults.push(parsed);
  }
  return vaults;
}

function vaultIdentity(value: unknown): { vaultId: string; vaultName: string; config: unknown } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  if (typeof record.vaultId !== "string" || !VAULT_ID_RE.test(record.vaultId)) return null;
  if (typeof record.vaultName !== "string") return null;
  if (record.vaultName.length === 0 || record.vaultName.length > MAX_VAULT_SELECTOR_CHARS) return null;
  return { vaultId: record.vaultId, vaultName: record.vaultName, config: record.headlessConfig };
}

function validEncryptionConfig(config: Record<string, unknown>): boolean {
  if (config.encryptionVersion !== 2 && config.encryptionVersion !== 3) return false;
  if (typeof config.encryptionKey !== "string" || !ENCRYPTION_KEY_RE.test(config.encryptionKey)) return false;
  if (Buffer.from(config.encryptionKey, "base64").length !== 32) return false;
  if (typeof config.encryptionSalt !== "string") return false;
  if (config.encryptionSalt.length === 0 || config.encryptionSalt.length > 512) return false;
  return config.conflictStrategy === "merge";
}

function normalizedHeadlessConfig(identity: ReturnType<typeof vaultIdentity>): Record<string, unknown> | null {
  if (!identity || !identity.config || typeof identity.config !== "object" || Array.isArray(identity.config)) return null;
  const config = identity.config as Record<string, unknown>;
  if (config.vaultId !== identity.vaultId || config.vaultName !== identity.vaultName) return null;
  if (typeof config.host !== "string" || !OBSIDIAN_SYNC_HOST_RE.test(config.host)) return null;
  if (!validEncryptionConfig(config)) return null;
  return {
    vaultId: identity.vaultId,
    vaultName: identity.vaultName,
    host: config.host,
    encryptionVersion: config.encryptionVersion,
    encryptionKey: config.encryptionKey,
    encryptionSalt: config.encryptionSalt,
    conflictStrategy: "merge",
  };
}

function connectionConfig(value: unknown): ObsidianConnectionConfig {
  const identity = vaultIdentity(value);
  const headlessConfig = normalizedHeadlessConfig(identity);
  if (!identity || !headlessConfig) {
    throw new ObsidianHeadlessError("Stored Obsidian connection is invalid", RUNTIME_FAILED);
  }
  return {
    schemaVersion: 1,
    vaultId: identity.vaultId,
    vaultName: identity.vaultName,
    headlessConfig,
  };
}

export function parseObsidianConnectionConfig(value: unknown): ObsidianConnectionConfig {
  if (typeof value !== "string" || value.length === 0 || value.length > 32_000) {
    throw new ObsidianHeadlessError("Stored Obsidian connection is invalid", RUNTIME_FAILED);
  }
  return connectionConfig(parsedRecord(value));
}

export async function verifyObsidianConnection(
  fields: Record<string, string>,
  runner: ObsidianCommandRunner = runObsidianHeadless,
): Promise<{ accountLabel: string; connection: ObsidianConnectionConfig }> {
  const connection = parseObsidianConnectionConfig(fields.connection);
  const vaults = await listObsidianRemoteVaults(fields.authToken, runner);
  if (!vaults.some((vault) => vault.id === connection.vaultId)) {
    throw new ObsidianHeadlessError("The connected vault is no longer available", "provider-rejected");
  }
  return { accountLabel: connection.vaultName, connection };
}
