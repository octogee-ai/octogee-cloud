import { randomBytes } from "node:crypto";

import { createGiteaGitHost, giteaNaming, type GiteaGitHost, type GitRepoRole } from "@octogee/core/git-host";
import { gatewayKeyTitle, giteaUsername, isManagedGatewayKeyTitle, publicKeyIdentity } from "@octogee/core/gitea-naming";
import { placeholderEmail } from "@octogee/core/placeholder-email";
import type { GitRepositoryOutput } from "@octogee/shared/types/provisioning-service";

import type { AuthorizedGitKey, GitHost, GitRepositoryKind } from "./git-host.js";
import { HostError, hostErrorKindForStatus } from "./host-error.js";
import type { HostLog } from "./chat-host-mattermost.js";

export interface GiteaGitHostAdapterConfig {
  apiBaseUrl: string;
  adminToken: string;
  log: HostLog;
  fetch?: typeof fetch;
}

const KEY_PAGE_SIZE = 50;

interface HostResponse {
  status: number;
  json: unknown;
}

interface CallObserver {
  lastStatus: number | null;
  unreachable: boolean;
}

function repoRole(kind: GitRepositoryKind): GitRepoRole {
  return { kind };
}

function failure(operation: string, { status }: HostResponse): HostError {
  return new HostError(hostErrorKindForStatus(status), `${operation}: ${status} from git host`);
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

const KEY_CONTENT_IN_USE = /\b422 Key content has been used\b/u;

export function createGiteaGitHostAdapter(config: GiteaGitHostAdapterConfig): GitHost {
  const baseFetch = config.fetch ?? fetch;

  function observedFetch(observer: CallObserver, signal: AbortSignal): typeof fetch {
    return async (input, init) => {
      let response: Response;
      try {
        response = await baseFetch(input, { ...init, signal, redirect: "error" });
      } catch (error) {
        observer.unreachable = true;
        throw error;
      }
      observer.lastStatus = response.status;
      return response;
    };
  }

  async function withCoreHost<T>(operation: string, signal: AbortSignal, body: (host: GiteaGitHost) => Promise<T>): Promise<T> {
    const observer: CallObserver = { lastStatus: null, unreachable: false };
    const host = createGiteaGitHost({
      apiBaseUrl: config.apiBaseUrl,
      token: () => config.adminToken,
      fetch: observedFetch(observer, signal),
    });
    try {
      return await body(host);
    } catch (error) {
      if (error instanceof HostError) throw error;
      if (observer.unreachable) throw new HostError("transient", `${operation}: git host unreachable`, { cause: error });
      const status = observer.lastStatus ?? 500;
      throw new HostError(hostErrorKindForStatus(status), `${operation}: ${status} from git host`, { cause: error });
    }
  }

  async function request(operation: string, method: string, path: string, signal: AbortSignal, body?: unknown): Promise<HostResponse> {
    let response: Response;
    try {
      response = await baseFetch(`${config.apiBaseUrl}${path}`, {
        method,
        signal,
        redirect: "error",
        headers: {
          Authorization: `token ${config.adminToken}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new HostError("transient", `${operation}: git host unreachable`, { cause: error });
    }
    const json = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, json };
  }

  async function exists(operation: string, path: string, signal: AbortSignal): Promise<HostResponse | null> {
    const response = await request(operation, "GET", path, signal);
    if (response.status === 404) return null;
    if (response.status !== 200) throw failure(operation, response);
    return response;
  }

  async function ensureAccount(slug: string, signal: AbortSignal): Promise<void> {
    const username = giteaUsername(slug);
    const path = `/users/${encodeURIComponent(username)}`;
    if (await exists("find git account", path, signal)) return;
    const created = await request("create git account", "POST", "/admin/users", signal, {
      username,
      email: placeholderEmail(slug),
      password: randomBytes(32).toString("hex"),
      must_change_password: false,
      visibility: "private",
    });
    if (isSuccess(created.status)) {
      config.log.info("[provisioning] git account created", { owner: slug });
      return;
    }
    if (await exists("find git account", path, signal)) return;
    throw failure("create git account", created);
  }

  async function ensureOrganization(owner: string, signal: AbortSignal): Promise<void> {
    try {
      await withCoreHost("ensure git owner", signal, (host) => host.ensureOwner(owner));
    } catch (error) {
      if (!(await exists("find git owner", `/orgs/${encodeURIComponent(owner)}`, signal))) throw error;
      await withCoreHost("ensure git owner", signal, (host) => host.ensureOwner(owner));
    }
  }

  async function readRepository(owner: string, repo: string, signal: AbortSignal): Promise<GitRepositoryOutput | null> {
    const found = await exists("find git repository", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, signal);
    if (!found) return null;
    const { clone_url: cloneUrl, ssh_url: sshUrl } = (found.json ?? {}) as { clone_url?: unknown; ssh_url?: unknown };
    if (typeof cloneUrl !== "string" || typeof sshUrl !== "string") {
      throw new HostError("transient", `find git repository: git host returned no clone urls for ${owner}/${repo}`);
    }
    return { cloneUrl, sshUrl };
  }

  async function readKeys(owner: string, signal: AbortSignal): Promise<{ id: unknown; key: string; title: string }[]> {
    const username = encodeURIComponent(giteaUsername(owner));
    const keys: { id: unknown; key: string; title: string }[] = [];
    for (let page = 1; ; page += 1) {
      const response = await request("list git keys", "GET", `/users/${username}/keys?limit=${KEY_PAGE_SIZE}&page=${page}`, signal);
      if (page === 1 && response.status === 404) return [];
      if (response.status !== 200) throw failure("list git keys", response);
      if (!Array.isArray(response.json)) throw new HostError("transient", "list git keys: git host returned an invalid list");
      for (const entry of response.json as { id?: unknown; key?: unknown; title?: unknown }[]) {
        if (typeof entry?.key === "string" && typeof entry.title === "string") keys.push({ id: entry.id, key: entry.key, title: entry.title });
      }
      if (response.json.length < KEY_PAGE_SIZE) return keys;
    }
  }

  return {
    async ensureOwner({ slug }, signal) {
      const owner = giteaNaming.owner(slug);
      await ensureAccount(slug, signal);
      await ensureOrganization(owner, signal);
      return { owner };
    },

    async ensureRepository({ owner, kind }, signal) {
      const role = repoRole(kind);
      const repo = giteaNaming.repo(role);
      const existing = await readRepository(owner, repo, signal);
      if (existing) return existing;
      let createError: unknown = null;
      try {
        await withCoreHost("create git repository", signal, (host) => host.ensureRepo(owner, role));
      } catch (error) {
        createError = error;
      }
      const created = await readRepository(owner, repo, signal);
      if (created) return created;
      throw createError ?? new HostError("transient", `create git repository: ${owner}/${repo} is missing after create`);
    },

    async listKeys({ owner, holders }, signal): Promise<AuthorizedGitKey[]> {
      const byTitle = new Map(holders.map((holder) => [gatewayKeyTitle(holder), holder]));
      return (await readKeys(owner, signal))
        .filter((key) => isManagedGatewayKeyTitle(key.title))
        .map((key) => ({ publicKey: key.key.trim(), holder: byTitle.get(key.title) ?? null }));
    },

    async registerKey({ owner, publicKey, holder }, signal) {
      try {
        await withCoreHost("register git key", signal, (host) => host.registerKey(owner, publicKey, holder));
      } catch (error) {
        if (error instanceof HostError && error.cause instanceof Error && KEY_CONTENT_IN_USE.test(error.cause.message)) {
          throw new HostError("terminal", `${error.message}: the key is held on another account or under a title this service does not manage`, { cause: error, code: "key-held-elsewhere" });
        }
        throw error;
      }
    },

    async releaseKey({ owner, publicKey, holder }, signal) {
      const title = gatewayKeyTitle(holder);
      const identity = publicKeyIdentity(publicKey);
      const username = encodeURIComponent(giteaUsername(owner));
      for (const key of await readKeys(owner, signal)) {
        if (key.title !== title || publicKeyIdentity(key.key) !== identity) continue;
        if (typeof key.id !== "number") throw new HostError("transient", "release git key: git host listed the key without its id");
        const deleted = await request("release git key", "DELETE", `/admin/users/${username}/keys/${key.id}`, signal);
        if (deleted.status !== 404 && !isSuccess(deleted.status)) throw failure("release git key", deleted);
      }
    },
  };
}
