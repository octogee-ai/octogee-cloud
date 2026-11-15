import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  ProvisioningAttempt,
  ProvisioningErrorBody,
  UserProvisioning,
  UserProvisioningSpec,
  UserProvisioningStatus,
} from "@octogee/shared/types/provisioning-service";

export interface FakeProvisioningRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly authorization: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly body: unknown;
}

export interface FakeProvisioningService {
  readonly url: string;
  readonly requests: FakeProvisioningRequest[];
  readonly resources: Map<string, UserProvisioning>;
  acceptedTokens: Set<string>;
  failNext(status: number, count?: number, retryAfterSeconds?: number): void;
  expireBefore(resourceVersion: number): void;
  setStatus(uid: string, status: Partial<UserProvisioningStatus>): UserProvisioning;
  setEvents(uid: string, items: ProvisioningAttempt[]): void;
  close(): Promise<void>;
}

const FAKE_BASE = "https://provisioning-service.fake";

const IDLE_STATUS: UserProvisioningStatus = {
  observedGeneration: 0,
  conditions: [],
  outputs: { credentials: [] },
  work: { state: "queued", attempts: 0, nextAttemptAt: null, lastAttemptAt: null },
};

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function fail(res: ServerResponse, status: number, code: ProvisioningErrorBody["code"], error: string): void {
  send(res, status, { code, error } satisfies ProvisioningErrorBody);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
}

export async function startFakeProvisioningService(options: { tokens?: string[] } = {}): Promise<FakeProvisioningService> {
  const requests: FakeProvisioningRequest[] = [];
  const resources = new Map<string, UserProvisioning>();
  const changedAt = new Map<string, number>();
  const events = new Map<string, ProvisioningAttempt[]>();
  const retries = new Map<string, unknown>();
  const failures: Array<{ status: number; retryAfterSeconds?: number }> = [];
  const waiters = new Set<() => void>();
  let counter = 0;
  let oldestRetained = 0;
  const service = { acceptedTokens: new Set(options.tokens ?? ["token"]) };

  function bump(uid: string, resource: UserProvisioning): UserProvisioning {
    counter += 1;
    const next = { ...resource, resourceVersion: String(counter) };
    resources.set(uid, next);
    changedAt.set(uid, counter);
    for (const wake of [...waiters]) wake();
    return next;
  }

  function changedAfter(version: number): UserProvisioning[] {
    return [...resources.entries()]
      .filter(([uid]) => (changedAt.get(uid) ?? 0) > version)
      .map(([, resource]) => resource);
  }

  function record(req: IncomingMessage, url: URL, body: unknown): FakeProvisioningRequest {
    const recorded: FakeProvisioningRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: req.headers.authorization,
      idempotencyKey: req.headers["idempotency-key"] as string | undefined,
      body,
    };
    requests.push(recorded);
    return recorded;
  }

  function refused(req: IncomingMessage, res: ServerResponse): boolean {
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    if (bearer === undefined || !service.acceptedTokens.has(bearer)) {
      fail(res, 401, "unauthenticated", "token review failed");
      return true;
    }
    const failure = failures.shift();
    if (!failure) return false;
    send(
      res,
      failure.status,
      { code: failure.status === 429 ? "rate-limited" : "unavailable", error: "injected" },
      failure.retryAfterSeconds === undefined ? {} : { "retry-after": String(failure.retryAfterSeconds) },
    );
    return true;
  }

  function retry(uid: string, existing: UserProvisioning, recorded: FakeProvisioningRequest, res: ServerResponse): void {
    const expected = (recorded.body as { expectedAttempts?: number } | undefined)?.expectedAttempts;
    if (expected !== undefined && expected !== existing.status.work.attempts) {
      fail(res, 409, "precondition-failed", `attempts is ${existing.status.work.attempts}`);
      return;
    }
    const key = recorded.idempotencyKey ?? "";
    const answer = retries.get(key) ?? { uid, due: true };
    retries.set(key, answer);
    send(res, 202, answer);
  }

  function put(uid: string, existing: UserProvisioning | undefined, body: unknown, res: ServerResponse): void {
    const write = body as { spec: UserProvisioningSpec; expectedResourceVersion?: string };
    if (write.expectedResourceVersion !== undefined && write.expectedResourceVersion !== (existing?.resourceVersion ?? "")) {
      fail(res, 409, "precondition-failed", "resource version moved");
      return;
    }
    if (!existing) {
      send(res, 201, bump(uid, { uid, generation: 1, resourceVersion: "0", spec: write.spec, status: IDLE_STATUS }));
      return;
    }
    if (JSON.stringify(existing.spec) === JSON.stringify(write.spec)) {
      send(res, 200, existing);
      return;
    }
    send(res, 202, bump(uid, { ...existing, generation: existing.generation + 1, spec: write.spec }));
  }

  function user(uid: string, suffix: string | undefined, recorded: FakeProvisioningRequest, res: ServerResponse): void {
    const existing = resources.get(uid);
    if (recorded.method === "PUT" && suffix === undefined) return put(uid, existing, recorded.body, res);
    if (recorded.method === "DELETE" && suffix === undefined) {
      resources.delete(uid);
      return send(res, 204);
    }
    if (!existing) return fail(res, 404, "not-found", "no provisioning");
    if (suffix === "/events") return send(res, 200, { items: events.get(uid) ?? [] });
    if (suffix === "/retry") return retry(uid, existing, recorded, res);
    send(res, 200, existing);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", FAKE_BASE);
    const recorded = record(req, url, await readBody(req));
    if (refused(req, res)) return;
    if (url.pathname === "/v1/provisionings") return listOrWatch(url, res);
    const userMatch = /^\/v1\/users\/([^/]+)\/provisioning(\/retry|\/events)?$/.exec(url.pathname);
    if (!userMatch) return fail(res, 404, "not-found", "no such route");
    user(decodeURIComponent(userMatch[1]), userMatch[2], recorded, res);
  }

  async function listOrWatch(url: URL, res: ServerResponse): Promise<void> {
    if (url.searchParams.get("watch") !== "true") {
      const ready = url.searchParams.get("ready");
      const items = [...resources.values()].filter((resource) => {
        if (ready === null) return true;
        const condition = resource.status.conditions.find((candidate) => candidate.type === "Ready");
        return (condition?.status === "True") === (ready === "true");
      });
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const start = Number(url.searchParams.get("pageToken") ?? "0");
      const page = items.slice(start, start + limit);
      const next = start + limit < items.length ? String(start + limit) : undefined;
      send(res, 200, { items: page, resourceVersion: String(counter), ...(next === undefined ? {} : { nextPageToken: next }) });
      return;
    }
    const since = Number(url.searchParams.get("resourceVersion"));
    if (since < oldestRetained) return fail(res, 410, "resource-version-expired", "too old");
    const timeoutMs = Number(url.searchParams.get("timeoutSeconds") ?? "60") * 1000;
    if (changedAfter(since).length === 0) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          waiters.delete(wake);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(wake, timeoutMs);
        waiters.add(wake);
      });
    }
    send(res, 200, { items: changedAfter(since), resourceVersion: String(counter) });
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => fail(res, 500, "unavailable", String(error)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    resources,
    get acceptedTokens() {
      return service.acceptedTokens;
    },
    set acceptedTokens(tokens: Set<string>) {
      service.acceptedTokens = tokens;
    },
    failNext(status, count = 1, retryAfterSeconds) {
      for (let index = 0; index < count; index += 1) failures.push({ status, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) });
    },
    expireBefore(resourceVersion) {
      oldestRetained = resourceVersion;
    },
    setStatus(uid, status) {
      const existing = resources.get(uid);
      if (!existing) throw new Error(`fake provisioning service has no ${uid}`);
      return bump(uid, { ...existing, status: { ...existing.status, ...status } });
    },
    setEvents(uid, items) {
      events.set(uid, items);
    },
    async close() {
      for (const wake of [...waiters]) wake();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
