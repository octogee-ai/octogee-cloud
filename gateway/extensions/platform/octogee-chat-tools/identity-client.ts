import { constants } from "node:fs";
import { lstat, open, readFile, realpath, stat, type FileHandle } from "node:fs/promises";
import * as path from "node:path";

export const IDENTITY_PATH = "/internal/fleet/agent/set-coach-identity";
export const DEFAULT_TOKEN_PATH = "/var/run/secrets/octogee-gateway-broker/token";
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const BAD_AVATAR_PATH = "bad-avatar-path" as const;

type IdentityToolErrorCode =
  | "no-agent"
  | "not-coach"
  | "auth-unavailable"
  | typeof BAD_AVATAR_PATH
  | "avatar-too-large"
  | "avatar-unreadable"
  | "bad-params"
  | "control-error"
  | "bad-response";

export class IdentityToolError extends Error {
  constructor(
    public readonly code: IdentityToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IdentityToolError";
  }
}

export interface SetDefaultAgentIdentityInput {
  workspaceSlug: string;
  agentId: string;
  name?: string;
  vibe?: string;
  emoji?: string;
  avatarBase64?: string;
}

export interface SetDefaultAgentIdentityResult {
  updated: string[];
}

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

export interface IdentityClientOptions {
  brokerUrl?: string;
  fetchImpl?: FetchLike;
  tokenPath?: string;
  tokenProvider?: () => Promise<string | null>;
}

export interface IdentityClient {
  setDefaultAgentIdentity(input: SetDefaultAgentIdentityInput): Promise<SetDefaultAgentIdentityResult>;
}

const MANAGED_AGENT_ID_RE = /^octogee-([a-z0-9][a-z0-9-]{0,62})-coach$/;

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

export function defaultBrokerUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FLEET_BROKER_URL) return stripTrailingSlashes(env.FLEET_BROKER_URL);
  if (env.OCTOGEE_API_URL) return stripTrailingSlashes(env.OCTOGEE_API_URL);
  const namespace = env.K8S_NAMESPACE || "octogee";
  return `http://octogee-api.${namespace}.svc.cluster.local:3001`;
}

export function resolveIdentityLane(agentId: unknown): { slug: string; project: string | null } {
  if (typeof agentId !== "string" || !agentId) throw new IdentityToolError("no-agent", "No agent identity in tool context");
  const match = MANAGED_AGENT_ID_RE.exec(agentId);
  if (!match) throw new IdentityToolError("not-coach", "Invalid agent identity");
  const parts = match[1].split("-proj-");
  if (parts.length > 2 || (parts.length === 2 && !/^[a-z0-9]{1,16}$/.test(parts[1]))) {
    throw new IdentityToolError("not-coach", "Invalid project identity");
  }
  return { slug: parts[0], project: parts[1] ?? null };
}

export function resolveIdentitySlug(agentId: unknown): string {
  return resolveIdentityLane(agentId).slug;
}

async function readProjectedToken(tokenPath: string): Promise<string | null> {
  try {
    const token = (await readFile(tokenPath, "utf8")).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function createIdentityClient(opts: IdentityClientOptions = {}): IdentityClient {
  const base = stripTrailingSlashes(opts.brokerUrl || defaultBrokerUrl());
  const doFetch: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const tokenPath = opts.tokenPath || process.env.OCTOGEE_API_SA_TOKEN_PATH || DEFAULT_TOKEN_PATH;
  const tokenProvider = opts.tokenProvider ?? (() => readProjectedToken(tokenPath));

  async function setDefaultAgentIdentity(input: SetDefaultAgentIdentityInput): Promise<SetDefaultAgentIdentityResult> {
    const token = await tokenProvider();
    if (!token) {
      throw new IdentityToolError(
        "auth-unavailable",
        `projected gateway service-account token unavailable at ${tokenPath}`,
      );
    }

    let resp: Awaited<ReturnType<FetchLike>>;
    try {
      resp = await doFetch(`${base}${resolveIdentityLane(input.agentId).project ? "/internal/agent-projects/identity" : IDENTITY_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-K8s-Sa-Token": token,
        },
        body: JSON.stringify(input),
      });
    } catch (err) {
      throw new IdentityToolError(
        "control-error",
        `fleet broker unreachable at ${base}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = await resp.json().catch(() => undefined);
    if (!resp.ok) {
      const fallback = resp.text ? (await resp.text().catch(() => "")).slice(0, 300) : "";
      const message = strField(parsed, "error") ?? fallback;
      throw new IdentityToolError(
        "control-error",
        message || `set-coach-identity failed (${resp.status})`,
      );
    }

    const updated = stringArrayField(parsed, "updated");
    if (!updated) {
      throw new IdentityToolError("bad-response", "set-coach-identity returned an incomplete response");
    }
    return { updated };
  }

  return { setDefaultAgentIdentity };
}

export function resolveAvatarPath(usersRoot: string, workspaceSlug: string, relativePath: string): string {
  if (
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(workspaceSlug) ||
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0")
  ) {
    throw new IdentityToolError(BAD_AVATAR_PATH, "avatar path must be relative to the workspace root");
  }
  const workspaceRoot = path.resolve(usersRoot, workspaceSlug);
  const resolved = path.resolve(workspaceRoot, relativePath);
  const rel = path.relative(workspaceRoot, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new IdentityToolError(BAD_AVATAR_PATH, "avatar path escapes the workspace root");
  }
  return resolved;
}

export async function readWorkspaceAvatarBase64(
  usersRoot: string,
  workspaceSlug: string,
  relativePath: string,
  ops: AvatarFileOps = DEFAULT_AVATAR_FILE_OPS,
): Promise<string> {
  const filePath = resolveAvatarPath(usersRoot, workspaceSlug, relativePath);
  const workspaceRoot = path.resolve(usersRoot, workspaceSlug);
  const components = path.relative(workspaceRoot, filePath).split(path.sep);
  let handle: FileHandle | undefined;
  try {
    await assertNoSymlinks(workspaceRoot, components, ops);
    const canonicalRoot = await ops.realpath(workspaceRoot);
    const canonicalFile = await ops.realpath(filePath);
    assertContained(canonicalRoot, canonicalFile);
    handle = await ops.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new IdentityToolError(BAD_AVATAR_PATH, "avatar path is not a file");
    }
    if (info.size > MAX_AVATAR_BYTES) {
      throw new IdentityToolError("avatar-too-large", "avatar exceeds 2MB");
    }
    const canonicalAfterOpen = await ops.realpath(filePath);
    assertContained(canonicalRoot, canonicalAfterOpen);
    if (canonicalAfterOpen !== canonicalFile) {
      throw new IdentityToolError(BAD_AVATAR_PATH, "avatar path changed during validation");
    }
    const pathInfo = await ops.stat(canonicalAfterOpen);
    if (pathInfo.dev !== info.dev || pathInfo.ino !== info.ino) {
      throw new IdentityToolError(BAD_AVATAR_PATH, "avatar inode changed during validation");
    }
    await assertNoSymlinks(workspaceRoot, components, ops);
    const bytes = await handle.readFile();
    if (bytes.length > MAX_AVATAR_BYTES) {
      throw new IdentityToolError("avatar-too-large", "avatar exceeds 2MB");
    }
    return bytes.toString("base64");
  } catch (err) {
    if (err instanceof IdentityToolError) throw err;
    throw new IdentityToolError(
      "avatar-unreadable",
      `avatar file could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface AvatarFileOps {
  lstat(filePath: string): ReturnType<typeof lstat>;
  realpath(filePath: string): ReturnType<typeof realpath>;
  stat(filePath: string): ReturnType<typeof stat>;
  open(filePath: string, flags: number): Promise<FileHandle>;
}

const DEFAULT_AVATAR_FILE_OPS: AvatarFileOps = { lstat, realpath, stat, open };

async function assertNoSymlinks(
  workspaceRoot: string,
  components: string[],
  ops: AvatarFileOps,
): Promise<void> {
  let current = workspaceRoot;
  const rootInfo = await ops.lstat(current);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new IdentityToolError(BAD_AVATAR_PATH, "workspace root is not a real directory");
  }
  for (const component of components) {
    current = path.join(current, component);
    if ((await ops.lstat(current)).isSymbolicLink()) {
      throw new IdentityToolError(BAD_AVATAR_PATH, "avatar path contains a symbolic link");
    }
  }
}

function assertContained(root: string, filePath: string): void {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new IdentityToolError(BAD_AVATAR_PATH, "avatar path escapes the workspace root");
  }
}

function strField(source: unknown, key: string): string | undefined {
  const value = (source as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
}

function stringArrayField(source: unknown, key: string): string[] | null {
  const value = (source as Record<string, unknown> | null | undefined)?.[key];
  if (!Array.isArray(value)) return null;
  return value.every((item): item is string => typeof item === "string") ? value : null;
}
