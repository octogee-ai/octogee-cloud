import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RequestHandler } from "express";
import { replaceFileAtomically } from "./atomic-file.js";

type JsonObject = Record<string, unknown>;

export interface AgentImportDoctorCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface AgentImportDoctorResult {
  outcome: "migrated" | "unchanged" | "unsupported" | "failed";
  doctorVersion: string;
  changedPaths: string[];
  diagnostics: string[];
  repairedCandidate?: JsonObject;
}

interface AgentImportDoctorOptions {
  command?: string;
  tmpRoot?: string;
  env?: NodeJS.ProcessEnv;
  run?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
  ) => Promise<AgentImportDoctorCommandResult>;
}

const CREDENTIAL_KEYS = new Set([
  "apikey", "authkey", "cookie", "credential", "credentials", "env", "key", "oauth",
  "passphrase", "password", "privatekey", "secret", "secrets", "sharedkey", "token",
]);

function registryEntryIdentifier(path: readonly string[]): boolean {
  return path.length === 2 && path[1] === "entries" &&
    (path[0] === "plugins" || path[0] === "skills");
}

function credentialKey(key: string, path: readonly string[]): boolean {
  if (registryEntryIdentifier(path)) return false;
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return CREDENTIAL_KEYS.has(normalized) ||
    /(?:token|secret|password|passwd|credential|credentials|cookie|authorization|authheader|oauth|bearer|auth)$/.test(normalized) ||
    /(?:apikey|privatekey|accesskey|signingkey|encryptionkey|clientkey|webhookkey)$/.test(normalized);
}

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function assertSecretFree(value: unknown, path: readonly string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => assertSecretFree(entry, path));
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const [key, entry] of Object.entries(object)) {
    if (credentialKey(key, path)) {
      throw new Error("agent import doctor candidate contains a credential-bearing path");
    }
    assertSecretFree(entry, [...path, key]);
  }
}

function defaultRun(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
): Promise<AgentImportDoctorCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let error: Error | undefined;
    const limit = 2 * 1024 * 1024;
    const timer = setTimeout(() => {
      error = new Error("agent import doctor command timed out");
      child.kill("SIGKILL");
    }, 60_000);
    const collect = (target: Buffer[], chunk: Buffer, size: number) => {
      if (size > limit) {
        error = new Error("agent import doctor output exceeded limit");
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      collect(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      collect(stderr, chunk, stderrBytes);
    });
    child.on("error", (spawnError) => { error = spawnError; });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(error ? { error } : {}),
      });
    });
  });
}

function changedPaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const left = record(before);
  const right = record(after);
  if (!left || !right || Array.isArray(before) || Array.isArray(after)) return [prefix || "root"];
  const paths: string[] = [];
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    const next = prefix ? `${prefix}.${key}` : key;
    paths.push(...changedPaths(left[key], right[key], next));
  }
  return paths;
}

function isolatedEnvironment(
  stateDir: string,
  configPath: string,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: source.LANG ?? "C.UTF-8",
    LC_ALL: source.LC_ALL ?? "C.UTF-8",
    HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DOCTOR_MODE: "run",
    NO_COLOR: "1",
  };
}

function versionFrom(result: AgentImportDoctorCommandResult): string {
  if (result.status !== 0) return "unknown";
  const firstLine = result.stdout.trim().split(/\r?\n/, 1)[0] ?? "";
  return firstLine.replace(/^OpenClaw\s+/i, "").trim() || "unknown";
}

export async function runAgentImportDoctor(
  candidate: unknown,
  options: AgentImportDoctorOptions = {},
): Promise<AgentImportDoctorResult> {
  const source = record(candidate);
  if (!source) throw new Error("agent import doctor candidate must be an object");
  assertSecretFree(source);
  const run = options.run ?? defaultRun;
  const command = options.command ?? "openclaw";
  const stateDir = fs.mkdtempSync(path.join(options.tmpRoot ?? os.tmpdir(), "octogee-agent-import-doctor-"));
  fs.chmodSync(stateDir, 0o700);
  const configPath = path.join(stateDir, "openclaw.json");
  try {
    replaceFileAtomically(configPath, `${JSON.stringify(source, null, 2)}\n`);
    const env = isolatedEnvironment(stateDir, configPath, options.env ?? process.env);
    const version = versionFrom(await run(command, ["--version"], { env }));
    const doctor = await run(command, ["doctor", "--fix", "--non-interactive"], { env });
    if (doctor.error) {
      return {
        outcome: "failed",
        doctorVersion: version,
        changedPaths: [],
        diagnostics: ["doctor_spawn_failed"],
      };
    }
    if (doctor.status !== 0) {
      return {
        outcome: "unsupported",
        doctorVersion: version,
        changedPaths: [],
        diagnostics: [`doctor_exit_${String(doctor.status)}`],
      };
    }
    const validate = await run(command, ["config", "validate"], { env });
    if (validate.error) {
      return {
        outcome: "failed",
        doctorVersion: version,
        changedPaths: [],
        diagnostics: ["validate_spawn_failed"],
      };
    }
    if (validate.status !== 0) {
      return {
        outcome: "unsupported",
        doctorVersion: version,
        changedPaths: [],
        diagnostics: [`validate_exit_${String(validate.status)}`],
      };
    }
    let repaired: unknown;
    try {
      repaired = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      return {
        outcome: "failed",
        doctorVersion: version,
        changedPaths: [],
        diagnostics: ["doctor_output_invalid"],
      };
    }
    const repairedObject = record(repaired);
    if (!repairedObject) {
      return {
        outcome: "failed",
        doctorVersion: version,
        changedPaths: [],
        diagnostics: ["doctor_output_invalid"],
      };
    }
    assertSecretFree(repairedObject);
    const changes = changedPaths(source, repairedObject);
    return {
      outcome: changes.length > 0 ? "migrated" : "unchanged",
      doctorVersion: version,
      changedPaths: changes,
      diagnostics: [],
      repairedCandidate: repairedObject,
    };
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function bearer(req: Parameters<RequestHandler>[0]): string | null {
  const authorization = req.headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
}

function safeEqual(left: string | null, right: string): boolean {
  if (!left || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function createAgentImportDoctorHandler(options: {
  token: string;
  runDoctor?: (candidate: unknown) => Promise<AgentImportDoctorResult>;
}): RequestHandler {
  if (!options.token) throw new Error("agent import doctor token is required");
  const doctor = options.runDoctor ?? ((candidate) => runAgentImportDoctor(candidate));
  return async (req, res) => {
    if (!safeEqual(bearer(req), options.token)) {
      res.status(401).json({ error: "agent import doctor authentication failed" });
      return;
    }
    const body = record(req.body);
    if (!body || !record(body.candidate)) {
      res.status(400).json({ error: "agent import doctor candidate is required" });
      return;
    }
    try {
      res.json(await doctor(body.candidate));
    } catch (error) {
      res.status(422).json({
        error: "agent import doctor rejected the candidate",
        code: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
