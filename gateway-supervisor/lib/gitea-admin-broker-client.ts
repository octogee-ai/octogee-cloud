import type { GitRepoRole, ManagedGitHost } from "@octogee/core/git-host";
import { SERVICE_GIT_KEY_WAIT_MS } from "@octogee/core/user-lifecycle";

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

const SERVICE_HELD_KEY_POLL_MIN_MS = 1_000;
const SERVICE_HELD_KEY_POLL_MAX_MS = 15_000;
const SERVICE_HELD_KEY_DEFAULT_RETRY_MS = 5_000;

async function pendingAnswer(resp: Response): Promise<{ reason: string; retryAfterMs: number }> {
  const text = await resp.text().catch(() => "");
  let reason: unknown;
  try {
    reason = (JSON.parse(text) as { reason?: unknown } | null)?.reason;
  } catch {
    reason = undefined;
  }
  const seconds = Number(resp.headers.get("retry-after"));
  return {
    reason: typeof reason === "string" && reason ? reason : `503 without a reason: ${text.slice(0, 300)}`,
    retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : SERVICE_HELD_KEY_DEFAULT_RETRY_MS,
  };
}

async function postServiceHeldKey(body: { slug: string; pubKey: string; serviceHolder: string }): Promise<{ registeredOn?: unknown }> {
  const path = "/internal/gitea/ensure-user";
  const startedAt = Date.now();
  for (let round = 0; ; round += 1) {
    const resp = await internalFetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (resp.ok) return resp.status === 204 ? {} : (await resp.json()) as { registeredOn?: unknown };
    if (resp.status !== 503) {
      const text = (await resp.text().catch(() => "")).slice(0, 300);
      throw new Error(`gitea-broker POST ${path} → ${resp.status} ${text}`);
    }
    const { reason, retryAfterMs } = await pendingAnswer(resp);
    const waited = Date.now() - startedAt;
    const backoff = SERVICE_HELD_KEY_POLL_MIN_MS * 2 ** Math.min(round, 4);
    const delay = Math.min(Math.max(retryAfterMs, backoff), SERVICE_HELD_KEY_POLL_MAX_MS);
    if (waited + delay > SERVICE_GIT_KEY_WAIT_MS) {
      const message = `[git] ${body.slug}: gave up waiting for the platform to register this pod's key after ${waited}ms (bound ${SERVICE_GIT_KEY_WAIT_MS}ms, last reason ${reason})`;
      log(message, { status: "failed" });
      throw new Error(message);
    }
    log(`[git] ${body.slug}: waiting for the platform to register this pod's key (reason ${reason}, next check in ${delay}ms, waited ${waited}ms)`);
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
