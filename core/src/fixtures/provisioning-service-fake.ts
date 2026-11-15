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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const body = await readBody(req);
    const recorded: FakeProvisioningRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: req.headers.authorization,
      idempotencyKey: req.headers["idempotency-key"] as string | undefined,
      body,
    };
    requests.push(recorded);
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    if (bearer === undefined || !service.acceptedTokens.has(bearer)) {
      fail(res, 401, "unauthenticated", "token review failed");
      return;
    }
    const failure = failures.shift();
    if (failure) {
      send(
        res,
        failure.status,
        { code: failure.status === 429 ? "rate-limited" : "unavailable", error: "injected" },
        failure.retryAfterSeconds === undefined ? {} : { "retry-after": String(failure.retryAfterSeconds) },
      );
      return;
    }
    const userMatch = /^\/v1\/users\/([^/]+)\/provisioning(\/retry|\/events)?$/.exec(url.pathname);
    if (url.pathname === "/v1/provisionings") {
      await listOrWatch(url, res);
      return;
    }
    if (!userMatch) {
      fail(res, 404, "not-found", "no such route");
      return;
    }
    const uid = decodeURIComponent(userMatch[1]);
    const suffix = userMatch[2];
    const existing = resources.get(uid);
    if (suffix === "/events") {
      if (!existing) return fail(res, 404, "not-found", "no provisioning");
      send(res, 200, { items: events.get(uid) ?? [] });
      return;
    }
    if (suffix === "/retry") {
      if (!existing) return fail(res, 404, "not-found", "no provisioning");
      const key = recorded.idempotencyKey ?? "";
      const expected = (body as { expectedAttempts?: number } | undefined)?.expectedAttempts;
      if (expected !== undefined && expected !== existing.status.work.attempts) {
        return fail(res, 409, "precondition-failed", `attempts is ${existing.status.work.attempts}`);
      }
      const answer = retries.get(key) ?? { uid, due: true };
      retries.set(key, answer);
      send(res, 202, answer);
      return;
    }
    if (req.method === "GET") {
      if (!existing) return fail(res, 404, "not-found", "no provisioning");
      send(res, 200, existing);
      return;
    }
    if (req.method === "DELETE") {
      resources.delete(uid);
      send(res, 204);
      return;
    }
    if (req.method === "PUT") {
      const put = body as { spec: UserProvisioningSpec; expectedResourceVersion?: string };
      if (put.expectedResourceVersion !== undefined && put.expectedResourceVersion !== (existing?.resourceVersion ?? "")) {
        return fail(res, 409, "precondition-failed", "resource version moved");
      }
      if (!existing) {
        send(res, 201, bump(uid, { uid, generation: 1, resourceVersion: "0", spec: put.spec, status: IDLE_STATUS }));
        return;
      }
      if (JSON.stringify(existing.spec) === JSON.stringify(put.spec)) {
        send(res, 200, existing);
        return;
      }
      send(res, 202, bump(uid, { ...existing, generation: existing.generation + 1, spec: put.spec }));
      return;
    }
    fail(res, 400, "invalid-request", "unsupported method");
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
