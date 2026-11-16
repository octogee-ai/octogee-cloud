import { AsyncLocalStorage } from "node:async_hooks";

import type { GitRepoRole, ManagedGitHost } from "@octogee/core/git-host";
import { MIGRATION_QUIESCE_TIMEOUT_MS } from "@octogee/shared/types/fleet-controller";

import { log } from "./config.js";
import { internalFetch } from "./internal-fetch.js";
import { clearServiceGitKeyHolder, serviceGitKeyHolder } from "./service-git-key-holder.js";

export type BrokeredGitHost = Pick<
  ManagedGitHost,
  "registerKey" | "listKeys" | "releaseKey" | "ensureOwner" | "ensureRepo" | "repoExists" | "archiveRepo"
>;

function baseUrl(): string {
  if (process.env.GITEA_ADMIN_BROKER_URL) return process.env.GITEA_ADMIN_BROKER_URL;
  return process.env.GATEWAY_EDGE_INTERNAL_URL || "http://127.0.0.1:3001";
}

async function postVoid(path: string, body: unknown): Promise<void> {
  const resp = await internalFetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = (await resp.text().catch(() => "")).slice(0, 300);
    throw new Error(`gitea-broker POST ${path} → ${resp.status} ${text}`);
  }
}

export const SERVICE_HELD_KEY_WAIT_MS = MIGRATION_QUIESCE_TIMEOUT_MS / 2;
const SERVICE_HELD_KEY_POLL_MIN_MS = 1_000;
const SERVICE_HELD_KEY_POLL_MAX_MS = 15_000;
const SERVICE_HELD_KEY_DEFAULT_RETRY_MS = 5_000;

interface ServiceHeldKeyAnswer {
  error: unknown;
  reason: string;
  retryAfterMs: number;
}

async function notRegisteredAnswer(resp: Response): Promise<ServiceHeldKeyAnswer> {
  const text = await resp.text().catch(() => "");
  let body: { error?: unknown; reason?: unknown } | null;
  try {
    body = JSON.parse(text) as { error?: unknown; reason?: unknown } | null;
  } catch {
    body = null;
  }
  const seconds = Number(resp.headers.get("retry-after"));
  return {
    error: body?.error,
    reason: typeof body?.reason === "string" && body.reason ? body.reason : `${resp.status} without a reason: ${text.slice(0, 300)}`,
    retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : SERVICE_HELD_KEY_DEFAULT_RETRY_MS,
  };
}

function failRegistration(message: string, cause?: unknown): never {
  log(message, { status: "failed" });
  throw new Error(message, cause === undefined ? undefined : { cause });
}

export class KeyRegistrationRefused extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = "KeyRegistrationRefused";
  }
}

const refusalsLoggedByCaller = new AsyncLocalStorage<true>();

export function withQuietRefusals<T>(work: () => Promise<T>): Promise<T> {
  return refusalsLoggedByCaller.run(true, work);
}

function refuseRegistration(slug: string, reason: string): never {
  const refusal = new KeyRegistrationRefused(`[git] ${slug}: the platform refused to register this pod's key (reason ${reason}); no retry can finish it`, reason);
  if (refusalsLoggedByCaller.getStore() !== true) log(refusal.message, { status: "failed" });
  throw refusal;
}

async function requestServiceHeldKey(path: string, body: { slug: string }, timeoutMs: number): Promise<Response> {
  try {
    return await internalFetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, { timeoutMs });
  } catch (error) {
    return failRegistration(
      `[git] ${body.slug}: the request to register this pod's key failed inside its ${SERVICE_HELD_KEY_WAIT_MS}ms bound: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

async function postServiceHeldKey(body: { slug: string; pubKey: string; serviceHolder: string }): Promise<{ registeredOn?: unknown }> {
  const path = "/internal/gitea/ensure-user";
  const startedAt = Date.now();
  for (let round = 0; ; round += 1) {
    const resp = await requestServiceHeldKey(path, body, SERVICE_HELD_KEY_WAIT_MS - (Date.now() - startedAt));
    if (resp.ok) return resp.status === 204 ? {} : (await resp.json()) as { registeredOn?: unknown };
    if (resp.status !== 503 && resp.status !== 422) {
      const text = (await resp.text().catch(() => "")).slice(0, 300);
      throw new Error(`gitea-broker POST ${path} → ${resp.status} ${text}`);
    }
    const answer = await notRegisteredAnswer(resp);
    if (resp.status === 422) {
      if (answer.error !== "provisioning_refused") throw new Error(`gitea-broker POST ${path} → 422 ${answer.reason}`);
      return refuseRegistration(body.slug, answer.reason);
    }
    const waited = Date.now() - startedAt;
    const backoff = SERVICE_HELD_KEY_POLL_MIN_MS * 2 ** Math.min(round, 4);
    const delay = Math.min(Math.max(answer.retryAfterMs, backoff), SERVICE_HELD_KEY_POLL_MAX_MS);
    if (waited + delay >= SERVICE_HELD_KEY_WAIT_MS) {
      return failRegistration(
        `[git] ${body.slug}: gave up waiting for the platform to register this pod's key after ${waited}ms (bound ${SERVICE_HELD_KEY_WAIT_MS}ms, last reason ${answer.reason})`,
      );
    }
    log(`[git] ${body.slug}: waiting for the platform to register this pod's key (reason ${answer.reason}, next check in ${delay}ms, waited ${waited}ms)`);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}

async function getJson(path: string): Promise<unknown> {
  const resp = await internalFetch(`${baseUrl()}${path}`, { method: "GET" });
  if (!resp.ok) {
    const text = (await resp.text().catch(() => "")).slice(0, 300);
    throw new Error(`gitea-broker GET ${path} → ${resp.status} ${text}`);
  }
  return resp.json();
}

function ensureRepoRequest(slug: string, role: GitRepoRole): { path: string; body: Record<string, string> } {
  switch (role.kind) {
    case "workspace":
      return { path: "/internal/gitea/ensure-workspace-repo", body: { slug } };
    case "system-config":
      return { path: "/internal/gitea/ensure-system-config-repo", body: { slug } };
    case "project-coaches":
      return { path: "/internal/gitea/ensure-project-coach-repo", body: { slug } };
    case "project":
      return { path: "/internal/gitea/ensure-project-repo", body: { slug, projectName: role.projectSlug } };
  }
}

export const brokeredGitHost: BrokeredGitHost = {
  async registerKey(slug, pubKey) {
    const serviceHolder = serviceGitKeyHolder(slug);
    if (serviceHolder === null) {
      await postVoid("/internal/gitea/ensure-user", { slug, pubKey });
      return;
    }
    const answer = await postServiceHeldKey({ slug, pubKey, serviceHolder });
    if (answer.registeredOn === "git-host") {
      clearServiceGitKeyHolder(slug);
      log(`[git] ${slug}: the platform registered the key on the git host, so the service no longer holds it here; dropped the marker`);
    }
  },

  releaseKey: (slug, pubKey) => postVoid("/internal/gitea/release-user-key", { slug, pubKey }),

  async listKeys(slug) {
    const data = (await getJson(
      `/internal/gitea/user-pubkeys?slug=${encodeURIComponent(slug)}`,
    )) as { pubKeys: string[] };
    return data.pubKeys;
  },

  ensureOwner: (slug) => postVoid("/internal/gitea/ensure-org", { slug }),

  ensureRepo(slug, role) {
    const { path, body } = ensureRepoRequest(slug, role);
    return postVoid(path, body);
  },

  async repoExists({ owner, repo }) {
    const data = (await getJson(
      `/internal/gitea/repo-exists?org=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
    )) as { exists: boolean };
    return data.exists;
  },

  archiveRepo: ({ owner, repo }) => postVoid("/internal/gitea/archive-repo", { org: owner, repo }),
};
