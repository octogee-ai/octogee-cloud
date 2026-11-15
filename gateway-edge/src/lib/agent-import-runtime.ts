import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { acquireSystemConfigMutationLease } from "@octogee/core/system-config-mutation-lease";
import { attachUpstreamRpcClient } from "../chat-proxy/openclaw/bridge-upstream-rpc.js";
import { openAuthenticatedUpstream } from "../chat-proxy/openclaw/authenticated-upstream.js";
import type { AgentImportAuthorizationIntent } from "@octogee/shared/types/agent-import";
import { agentImportBrokerBaseUrlFromEnv, createAgentImportStore } from "./agent-import-store.js";
import {
  agentImportRepositoryApplied,
  applyAgentImportRepository,
  compareAgentImportWorkspaces,
  inspectAgentImportRepository,
  rollbackAgentImportRepository,
} from "./agent-import-git.js";
import { cloneGithubAgentImportSource, extractLocalAgentImportArchive } from "./agent-import-source.js";
import {
  workspaceGitCommandArgs,
  workspaceGitEnvironment,
} from "@octogee/core/workspace/workspace-git";
import {
  AgentImportService,
  type AgentImportDoctorResult,
} from "./agent-import-service.js";

type JsonObject = Record<string, unknown>;

interface DoctorClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function doctorResult(value: unknown): AgentImportDoctorResult {
  const result = object(value);
  const outcomes = new Set(["unchanged", "migrated", "unsupported", "failed"]);
  if (
    !result || typeof result.outcome !== "string" || !outcomes.has(result.outcome) ||
    typeof result.doctorVersion !== "string" || !Array.isArray(result.changedPaths) ||
    !result.changedPaths.every((item) => typeof item === "string") ||
    !Array.isArray(result.diagnostics) || !result.diagnostics.every((item) => typeof item === "string") ||
    (result.repairedCandidate !== undefined && !object(result.repairedCandidate))
  ) {
    throw new Error("agent import doctor returned an invalid result");
  }
  return result as unknown as AgentImportDoctorResult;
}

export function createAgentImportDoctorClient(options: DoctorClientOptions) {
  const url = new URL("/agent-import/doctor", options.baseUrl).toString();
  return async (candidate: JsonObject): Promise<AgentImportDoctorResult> => {
    if (!options.token) throw new Error("OPENCLAW_GATEWAY_TOKEN is required for agent import doctor");
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ candidate }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`agent import doctor rejected candidate (${response.status})`);
    return doctorResult(await response.json());
  };
}

function git(targetDir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/git", workspaceGitCommandArgs(targetDir, args), {
      cwd: targetDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: workspaceGitEnvironment(process.env, targetDir),
    });
    const output: Buffer[] = [];
    let size = 0;
    let failure: Error | null = null;
    const timer = setTimeout(() => {
      failure = new Error("workspace git inspection timed out");
      child.kill("SIGKILL");
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        failure = new Error("workspace git inspection output exceeded limit");
        child.kill("SIGKILL");
      } else {
        output.push(chunk);
      }
    });
    child.on("error", (error) => { failure = error; });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (failure || status !== 0) {
        reject(new Error(`workspace git inspection failed (exit ${String(status)})`));
        return;
      }
      resolve(Buffer.concat(output).toString("utf8").trim());
    });
  });
}

export async function readAgentImportWorkspaceState(
  slug: string,
  options: { usersRoot?: string; targetDir?: string } = {},
): Promise<{ targetDir: string; head: string; clean: boolean }> {
  const targetDir = options.targetDir ?? path.join(
    options.usersRoot ?? process.env.CUSTOMERS_DIR ?? "/home/node/.openclaw/customers",
    slug,
  );
  const branch = await git(targetDir, ["symbolic-ref", "--short", "HEAD"]);
  if (branch !== "main") throw new Error("workspace import requires the main branch");
  return {
    targetDir,
    head: await git(targetDir, ["rev-parse", "HEAD"]),
    clean: await git(targetDir, ["status", "--porcelain", "--untracked-files=all"]) === "",
  };
}

export interface AgentImportOpenClawDeps {
  gatewayId(): string;
  gatewayUrl(): string;
  openAuthenticatedUpstream: typeof openAuthenticatedUpstream;
  attachRpcClient: typeof attachUpstreamRpcClient;
}

const agentImportOpenClawDeps: AgentImportOpenClawDeps = {
  gatewayId: () => process.env.GATEWAY_ID ?? "",
  gatewayUrl: () => process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789",
  openAuthenticatedUpstream,
  attachRpcClient: attachUpstreamRpcClient,
};

export async function invokeLocalOpenClaw(
  method: string,
  params: JsonObject,
  deps: AgentImportOpenClawDeps = agentImportOpenClawDeps,
): Promise<unknown> {
  const ws = await deps.openAuthenticatedUpstream({
    gatewayId: deps.gatewayId(),
    url: deps.gatewayUrl(),
  });
  const rpc = deps.attachRpcClient(ws, { timeoutMs: 30_000 });
  try {
    const result = await rpc.call(method, params);
    if (!result.ok) throw new Error(`agent import ${method} failed: ${result.reason}`);
    return result.result;
  } finally {
    rpc.dispose();
    ws.close();
  }
}

async function withConfigLock<T>(work: () => Promise<T>): Promise<T> {
  const lease = await acquireSystemConfigMutationLease({
    openclawDir: process.env.OPENCLAW_DIR ?? "/home/node/.openclaw",
  });
  if (!lease.ok) throw new Error("system config writer lock is busy");
  try {
    return await work();
  } finally {
    await lease.lease.release();
  }
}

export function createAgentImportRuntime(options: {
  authorization: string;
  gatewayId: string;
  brokerBaseUrl?: string;
  tokenPath?: string;
  fetchImpl?: typeof fetch;
}) {
  const store = createAgentImportStore({
    baseUrl: options.brokerBaseUrl ?? agentImportBrokerBaseUrlFromEnv(),
    authorization: options.authorization,
    gatewayId: options.gatewayId,
    tokenPath: options.tokenPath,
    fetchImpl: options.fetchImpl,
  });
  const runDoctor = createAgentImportDoctorClient({
    baseUrl: `http://127.0.0.1:${process.env.FLEET_CONTROLLER_PORT ?? "3003"}`,
    token: process.env.OPENCLAW_GATEWAY_TOKEN ?? "",
  });
  const service = new AgentImportService({
    newId: randomUUID,
    now: () => new Date(),
    ...store,
    readGithubToken: () => store.readGithubToken(),
    readGithubRepoSize: (owner, repo) => store.readGithubRepoSize(owner, repo),
    cloneGithubSource: cloneGithubAgentImportSource,
    extractLocalSource: extractLocalAgentImportArchive,
    inspectSource: inspectAgentImportRepository,
    compareWorkspaces: compareAgentImportWorkspaces,
    workspaceState: (slug) => readAgentImportWorkspaceState(slug),
    runDoctor,
    applyRepository: (input) => applyAgentImportRepository({
      ...input,
      storeBlob: (filePath, contents, mimeType) =>
        store.storeBlob(input.importId, filePath, contents, mimeType),
      cleanupBlobs: () => store.deleteImportBlobs(input.importId),
    }),
    rollbackRepository: rollbackAgentImportRepository,
    readIdentity: () => store.readIdentity(),
    syncIdentity: (_uid, identity) => store.syncIdentity(identity),
    replaceIdentity: (_uid, identity) => store.replaceIdentity(identity),
    deleteImportBlobs: (id) => store.deleteImportBlobs(id),
    hasRepositoryImport: ({ targetDir, importId }) => agentImportRepositoryApplied(targetDir, importId),
    withConfigLock,
    invokeOpenClaw: invokeLocalOpenClaw,
  });
  return {
    service,
    authorize: (intent: AgentImportAuthorizationIntent) => store.authorize(intent),
    listGithubSources: () => store.listGithubSources(),
  };
}
