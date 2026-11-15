import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { internalFetch } from "./internal-fetch.js";
import { userClaimSlug } from "@octogee/shared/server/user-claim";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

const execFile = promisify(execFileCallback);
const GITHUB_HOST = "github.com";
const DEFAULT_TOKEN_PATH = "/var/run/secrets/octogee-gateway-broker/token";

export type GithubCliAuthResult = "hydrated" | "unchanged" | "cleared" | "skipped";

export class GithubCliAuthError extends Error {
  override name = "GithubCliAuthError";
}

interface GithubCliAuthDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  setupGit?: (env: NodeJS.ProcessEnv) => Promise<void>;
}

function ghConfigDir(env: NodeJS.ProcessEnv): string {
  return env.GH_CONFIG_DIR?.trim()
    || path.join(env.XDG_CONFIG_HOME?.trim() || path.join(env.HOME || "/home/node", ".config"), "gh");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readHosts(file: string): Promise<Record<string, unknown>> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let hosts: unknown;
  try {
    hosts = parse(contents);
  } catch {
    throw new GithubCliAuthError("GitHub CLI hosts configuration is invalid YAML");
  }
  if (hosts == null) return {};
  if (!isRecord(hosts)) throw new GithubCliAuthError("GitHub CLI hosts configuration must be a mapping");
  return hosts;
}

async function writeHosts(file: string, hosts: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, stringify(hosts), { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function setupGithubGit(env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await execFile("gh", ["auth", "setup-git", "--hostname", GITHUB_HOST], {
      env: { ...env, GH_PROMPT_DISABLED: "1" },
      timeout: 10_000,
    });
  } catch {
    throw new GithubCliAuthError("GitHub CLI credential helper setup failed");
  }
}

function isDisconnected(response: Response, body: unknown): boolean {
  if (response.status === 401 || response.status === 403) return true;
  return (response.status === 404 || response.status === 409)
    && isRecord(body) && body.status === "disconnected" && body.connectorId === "github";
}

function connectedToken(response: Response, body: unknown): string {
  if (!response.ok) throw new GithubCliAuthError(`GitHub materialization failed: HTTP ${response.status}`);
  if (
    !isRecord(body) || body.status !== "connected" || body.connectorId !== "github"
    || typeof body.accessToken !== "string" || !body.accessToken.trim()
  ) throw new GithubCliAuthError("GitHub materialization returned an invalid response");
  return body.accessToken;
}

async function githubAccount(accessToken: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "octogee-github-cli-auth",
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new GithubCliAuthError("GitHub account lookup request failed");
  });
  if (!response.ok) throw new GithubCliAuthError(`GitHub account lookup failed: HTTP ${response.status}`);
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body) || typeof body.login !== "string" || !/^[a-z\d][a-z\d-]{0,38}$/i.test(body.login)) {
    throw new GithubCliAuthError("GitHub account lookup returned an invalid response");
  }
  return body.login;
}

async function readMaterializedGithubToken(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<string | null> {
  const baseUrl = (env.GATEWAY_EDGE_INTERNAL_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
  const response = await internalFetch(`${baseUrl}/internal/connectors/github/materialize`, {
    method: "GET", redirect: "error",
  }, {
    tokenPath: env.OCTOGEE_API_SA_TOKEN_PATH || DEFAULT_TOKEN_PATH,
    requireProjectedToken: true,
    timeoutMs: 10_000,
    fetchImpl,
  }).catch((error: unknown) => {
    const reason = error instanceof Error && error.message === "projected service-account token unavailable"
      ? error.message : "GitHub materialization request failed";
    throw new GithubCliAuthError(reason);
  });
  const body: unknown = await response.json().catch(() => null);
  return isDisconnected(response, body) ? null : connectedToken(response, body);
}

export async function hydrateGithubCliAuth(deps: GithubCliAuthDeps = {}): Promise<GithubCliAuthResult> {
  const env = deps.env ?? process.env;
  if (!isIsolatedGatewayClassValue(env.GATEWAY_CLASS)) return "skipped";
  if (!userClaimSlug(env)) throw new GithubCliAuthError("User identity is required for GitHub authentication");
  const accessToken = await readMaterializedGithubToken(env, deps.fetchImpl);
  const configDir = ghConfigDir(env);
  const file = path.join(configDir, "hosts.yml");
  const hosts = await readHosts(file);
  if (accessToken === null) {
    if (Object.hasOwn(hosts, GITHUB_HOST)) {
      delete hosts[GITHUB_HOST];
      await writeHosts(file, hosts);
    }
    return "cleared";
  }
  const existing = hosts[GITHUB_HOST];
  const account = isRecord(existing) && existing.oauth_token === accessToken && typeof existing.user === "string"
    ? existing.user
    : await githubAccount(accessToken, deps.fetchImpl ?? fetch);
  const github = {
    git_protocol: "https", user: account, oauth_token: accessToken,
    users: { [account]: { oauth_token: accessToken } },
  };
  const changed = JSON.stringify(existing) !== JSON.stringify(github);
  if (changed) {
    hosts[GITHUB_HOST] = github;
    await writeHosts(file, hosts);
  } else {
    await chmod(file, 0o600);
  }
  await (deps.setupGit ?? setupGithubGit)({ ...env, GH_CONFIG_DIR: configDir });
  return changed ? "hydrated" : "unchanged";
}
