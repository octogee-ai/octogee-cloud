export type GuardedHost = "chat" | "git";

export interface RefusedCreate {
  kind: string;
  name: string;
  exists: () => Promise<boolean>;
}

export interface GuardedWrite {
  method: string;
  path: string;
  create: RefusedCreate | null;
}

export interface WriteGuard {
  readonly fetch: typeof fetch;
  readonly writes: GuardedWrite[];
}

export const REFUSED_ERROR_ID = "readonly.refused";

const API_PREFIX = /^\/api\/v\d+/;

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") return new URL(input);
  return new URL(input instanceof URL ? input.href : input.url);
}

function bodyFields(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(init.body);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

interface CreateRoute {
  method: string;
  path: RegExp;
  kind: string;
  name: (fields: Record<string, unknown>) => string;
  probe: (match: RegExpMatchArray, name: string, fields: Record<string, unknown>) => string;
  present?: (json: unknown, name: string) => boolean;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

const CREATE_ROUTES: Record<GuardedHost, CreateRoute[]> = {
  chat: [
    { method: "POST", path: /^\/users$/, kind: "chat account", name: (f) => text(f.username), probe: (_m, name) => `/users/username/${encodeURIComponent(name)}` },
    { method: "POST", path: /^\/bots$/, kind: "chat agent bot", name: (f) => text(f.username), probe: (_m, name) => `/users/username/${encodeURIComponent(name)}` },
    { method: "POST", path: /^\/teams$/, kind: "chat team", name: (f) => text(f.name), probe: (_m, name) => `/teams/name/${encodeURIComponent(name)}` },
    {
      method: "POST",
      path: /^\/channels$/,
      kind: "chat channel",
      name: (f) => text(f.name),
      probe: (_m, name, f) => `/teams/${encodeURIComponent(text(f.team_id))}/channels/name/${encodeURIComponent(name)}?include_deleted=true`,
    },
  ],
  git: [
    { method: "POST", path: /^\/admin\/users$/, kind: "git account", name: (f) => text(f.username), probe: (_m, name) => `/users/${encodeURIComponent(name)}` },
    { method: "POST", path: /^\/orgs$/, kind: "git owner", name: (f) => text(f.username), probe: (_m, name) => `/orgs/${encodeURIComponent(name)}` },
    {
      method: "POST",
      path: /^\/orgs\/([^/]+)\/teams$/,
      kind: "git owner team",
      name: (f) => text(f.name),
      probe: (m) => `/orgs/${m[1]}/teams`,
      present: (json, name) => Array.isArray(json) && json.some((team: { name?: unknown }) => team?.name === name),
    },
    { method: "POST", path: /^\/orgs\/([^/]+)\/repos$/, kind: "git repository", name: (f) => text(f.name), probe: (m, name) => `/repos/${m[1]}/${encodeURIComponent(name)}` },
  ],
};

export function createWriteGuard(base: typeof fetch, host: GuardedHost): WriteGuard {
  const writes: GuardedWrite[] = [];
  const refusalStatus = host === "chat" ? 400 : 422;

  const guarded: typeof fetch = async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") return base(input, init);
    const url = requestUrl(input);
    const prefix = url.pathname.match(API_PREFIX)?.[0] ?? "";
    const path = url.pathname.slice(prefix.length);
    const fields = bodyFields(init);
    const route = CREATE_ROUTES[host].find((candidate) => candidate.method === method && candidate.path.test(path));
    let create: RefusedCreate | null = null;
    if (route) {
      const match = path.match(route.path)!;
      const name = route.name(fields);
      const probeUrl = `${url.origin}${prefix}${route.probe(match, name, fields)}`;
      create = {
        kind: route.kind,
        name,
        async exists() {
          const response = await base(probeUrl, { method: "GET", headers: init?.headers, redirect: "error" });
          if (response.status === 404) return false;
          if (!response.ok) throw new Error(`probe for ${route.kind} ${name}: ${response.status}`);
          return route.present ? route.present(await response.json(), name) : true;
        },
      };
    }
    writes.push({ method, path, create });
    if (create) {
      return new Response(JSON.stringify({ id: REFUSED_ERROR_ID, message: "read-only verification refused a create" }), {
        status: refusalStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(null, { status: 204 });
  };

  return { fetch: guarded, writes };
}
