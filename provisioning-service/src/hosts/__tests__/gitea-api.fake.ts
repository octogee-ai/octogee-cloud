export interface FakeGiteaKey {
  id: number;
  title: string;
  key: string;
}

interface Fault {
  method: string;
  path: RegExp;
  status: number;
  times: number;
}

export interface FakeGiteaRequest {
  method: string;
  path: string;
}

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const message = (status: number, text: string) => json(status, { message: text });

export class FakeGiteaApi {
  readonly apiBaseUrl = "https://git.invalid/api/v1";
  readonly accounts = new Map<string, { email: string; visibility: string }>();
  readonly organizations = new Set<string>();
  readonly teams = new Map<number, { org: string; name: string; members: Set<string> }>();
  readonly repositories = new Map<string, { private: boolean; description: string }>();
  readonly keys = new Map<string, FakeGiteaKey[]>();
  readonly requests: FakeGiteaRequest[] = [];
  racingDuplicateCreates = 0;
  private readonly faults: Fault[] = [];
  private nextId = 1;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    await new Promise((resolve) => setTimeout(resolve, 0));
    init?.signal?.throwIfAborted();
    const path = url.pathname.replace(/^\/api\/v1/, "");
    this.requests.push({ method, path: `${path}${url.search}` });
    const fault = this.faults.find((candidate) => candidate.times > 0 && candidate.method === method && candidate.path.test(path));
    if (fault) {
      fault.times -= 1;
      if (fault.status === 0) throw new TypeError("fetch failed");
      return message(fault.status, "host echoed request content");
    }
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    return this.route(method, path, url.searchParams, body);
  };

  fail(method: string, path: RegExp, status: number, times = 1): void {
    this.faults.push({ method, path, status, times });
  }

  addAccount(username: string): void {
    this.accounts.set(username, { email: `${username}@example.com`, visibility: "private" });
  }

  addKey(username: string, title: string, key: string): FakeGiteaKey {
    const record = { id: this.nextId++, title, key };
    this.keys.set(username, [...(this.keys.get(username) ?? []), record]);
    return record;
  }

  count(method: string, path: RegExp): number {
    return this.requests.filter((request) => request.method === method && path.test(request.path)).length;
  }

  private duplicate(status: number, text: string): Response {
    if (this.racingDuplicateCreates === 0) return message(status, text);
    this.racingDuplicateCreates -= 1;
    return message(500, "unique constraint violated");
  }

  private repository(owner: string, name: string) {
    return {
      name,
      full_name: `${owner}/${name}`,
      clone_url: `https://git.invalid/${owner}/${name}.git`,
      ssh_url: `ssh://git@git.invalid/${owner}/${name}.git`,
    };
  }

  private route(method: string, path: string, query: URLSearchParams, body: Record<string, unknown>): Response {
    let match: RegExpMatchArray | null;
    if (method === "POST" && path === "/admin/users") {
      const username = String(body.username);
      if (this.accounts.has(username)) return this.duplicate(422, "user already exists");
      this.accounts.set(username, { email: String(body.email), visibility: String(body.visibility) });
      return json(201, { login: username });
    }
    if (method === "POST" && path === "/orgs") {
      const org = String(body.username);
      if (this.organizations.has(org)) return this.duplicate(422, "user already exists");
      this.organizations.add(org);
      return json(201, { username: org });
    }
    if ((match = path.match(/^\/orgs\/([^/]+)$/)) && method === "GET") {
      return this.organizations.has(match[1]) ? json(200, { username: match[1] }) : message(404, "not found");
    }
    if ((match = path.match(/^\/orgs\/([^/]+)\/teams$/))) {
      const org = match[1];
      if (!this.organizations.has(org)) return message(404, "not found");
      const teams = [...this.teams.entries()].filter(([, team]) => team.org === org);
      if (method === "GET") return json(200, teams.map(([id, team]) => ({ id, name: team.name })));
      if (teams.some(([, team]) => team.name === body.name)) return message(422, "team already exists");
      const id = this.nextId++;
      this.teams.set(id, { org, name: String(body.name), members: new Set() });
      return json(201, { id, name: body.name });
    }
    if ((match = path.match(/^\/teams\/(\d+)\/members\/([^/]+)$/)) && method === "PUT") {
      const team = this.teams.get(Number(match[1]));
      if (!team || !this.accounts.has(match[2])) return message(404, "not found");
      team.members.add(match[2]);
      return json(204, null);
    }
    if ((match = path.match(/^\/orgs\/([^/]+)\/repos$/)) && method === "POST") {
      const key = `${match[1]}/${String(body.name)}`;
      if (!this.organizations.has(match[1])) return message(404, "not found");
      if (this.repositories.has(key)) return this.duplicate(409, "repository already exists");
      this.repositories.set(key, { private: body.private === true, description: String(body.description) });
      return json(201, this.repository(match[1], String(body.name)));
    }
    if ((match = path.match(/^\/repos\/([^/]+)\/([^/]+)$/)) && method === "GET") {
      return this.repositories.has(`${match[1]}/${match[2]}`) ? json(200, this.repository(match[1], match[2])) : message(404, "not found");
    }
    if ((match = path.match(/^\/users\/([^/]+)\/keys$/)) && method === "GET") {
      if (!this.accounts.has(match[1])) return message(404, "not found");
      const limit = Number(query.get("limit") ?? 50);
      const page = Number(query.get("page") ?? 1);
      return json(200, (this.keys.get(match[1]) ?? []).slice((page - 1) * limit, page * limit));
    }
    if ((match = path.match(/^\/users\/([^/]+)$/)) && method === "GET") {
      return this.accounts.has(match[1]) ? json(200, { login: match[1] }) : message(404, "not found");
    }
    if ((match = path.match(/^\/admin\/users\/([^/]+)\/keys$/)) && method === "POST") {
      if (!this.accounts.has(match[1])) return message(404, "not found");
      const identity = String(body.key).trim().split(/\s+/u).slice(0, 2).join(" ");
      const taken = [...this.keys.values()].flat().some((key) => key.key.trim().split(/\s+/u).slice(0, 2).join(" ") === identity);
      if (taken) return message(422, "Key content has been used as non-deploy key");
      return json(201, this.addKey(match[1], String(body.title), String(body.key)));
    }
    if ((match = path.match(/^\/admin\/users\/([^/]+)\/keys\/(\d+)$/)) && method === "DELETE") {
      const keys = this.keys.get(match[1]) ?? [];
      const remaining = keys.filter((key) => key.id !== Number(match![2]));
      if (remaining.length === keys.length) return message(404, "not found");
      this.keys.set(match[1], remaining);
      return json(204, null);
    }
    return message(501, `fake.unrouted ${method} ${path}`);
  }
}
