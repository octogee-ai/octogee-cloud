import { readFile } from "node:fs/promises";
import { isValidUsername } from "@octogee/shared/types/identity";
import { userClaimSlug } from "@octogee/shared/server/user-claim";

interface PersistenceClientDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  readToken: (path: string) => Promise<string>;
}
const defaults: PersistenceClientDeps = {
  env: process.env, fetch, readToken: path => readFile(path, "utf8"),
};

export async function persistUserProjects(slug: string, deps: PersistenceClientDeps = defaults): Promise<void> {
  if (!isValidUsername(slug) || userClaimSlug(deps.env) !== slug) throw new Error("project flush requires this user's slug");
  return persistUserFiles(slug, deps);
}

export async function persistSharedUserFiles(slug: string, deps: PersistenceClientDeps = defaults): Promise<void> {
  if (deps.env.GATEWAY_CLASS !== "shared" || !isValidUsername(slug)) throw new Error("Shared checkpoint requires its gateway identity and user slug");
  return persistUserFiles(slug, deps);
}

async function persistUserFiles(slug: string, deps: PersistenceClientDeps): Promise<void> {
  const token = (await deps.readToken(deps.env.OCTOGEE_API_SA_TOKEN_PATH || "/var/run/secrets/octogee-gateway-broker/token")).trim();
  if (!token) throw new Error("project flush has no gateway credential");
  const response = await deps.fetch(`${(deps.env.GATEWAY_EDGE_INTERNAL_URL || "http://127.0.0.1:3001").replace(/\/$/u, "")}/internal/projects/flush`, {
    method: "POST", headers: { "content-type": "application/json", "x-k8s-sa-token": token },
    body: JSON.stringify({ slug }), signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) throw new Error(`project remote save failed: HTTP ${response.status}; retain local work`);
  const result = await response.json() as { projects?: unknown };
  if (!Number.isSafeInteger(result.projects) || Number(result.projects) < 0) throw new Error("project remote save acknowledgement is invalid");
}

export async function persistAssignedSharedUsers(deps: {
  readUsers: () => Promise<readonly { slug: string }[]>;
  persist: (slug: string) => Promise<void>;
  log: (message: string) => void;
}): Promise<void> {
  for (const user of await deps.readUsers()) {
    try { await deps.persist(user.slug); }
    catch (error) { deps.log(`[project-autosave:${user.slug}] ${String(error)}; local work retained`); }
  }
}

export function startProjectAutosave(deps: {
  save: () => Promise<void>;
  log: (message: string) => void;
  startImmediately?: boolean;
}, intervalMs = 30_000) {
  let closed = false;
  let pending = false;
  let running = false;
  async function saveOnce() {
    if (closed) return;
    pending = true;
    if (running) return;
    running = true;
    try {
      while (pending && !closed) {
        pending = false;
        try { await deps.save(); }
        catch (error) { deps.log(`[project-autosave] ${String(error)}; local work retained`); }
      }
    } finally {
      running = false;
    }
  }
  const timer = setInterval(saveOnce, intervalMs);
  timer.unref();
  if (deps.startImmediately) void saveOnce();
  return {
    wake: () => { void saveOnce(); },
    close: () => { closed = true; clearInterval(timer); },
  };
}
