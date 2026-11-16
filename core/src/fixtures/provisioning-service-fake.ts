import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  GitKey,
  GitKeyHolderSummary,
  GitKeyStatus,
  ProvisioningAttempt,
  ProvisioningCredential,
  ProvisioningCredentialName,
  ProvisioningErrorBody,
  UserProvisioning,
  UserProvisioningSpec,
  UserProvisioningStatus,
  UserProvisioningWatchResponse,
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
  readonly gitKeys: Map<string, GitKey>;
  acceptedTokens: Set<string>;
  failNext(status: number, count?: number, retryAfterSeconds?: number): void;
  expireBefore(resourceVersion: number): void;
  setStatus(uid: string, status: Partial<UserProvisioningStatus>): UserProvisioning;
  setEvents(uid: string, items: ProvisioningAttempt[]): void;
  issueCredential(uid: string, name: ProvisioningCredentialName, value: string): void;
  setGitKeyStatus(uid: string, holder: string, status: GitKeyStatus): GitKey;
  credentialReader: boolean;
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

type FakeErrorCode = Extract<
  ProvisioningErrorBody["code"],
  "invalid-request" | "unauthenticated" | "precondition-failed" | "not-found" | "forbidden" | "not-issued" | "resource-version-expired" | "unavailable"
>;

const FAKE_ERROR_MESSAGES: Record<FakeErrorCode, string> = {
  "invalid-request": "uid is not a valid identifier",
  unauthenticated: "token review failed",
  "precondition-failed": "the precondition no longer holds",
  "not-found": "no such provisioning or route",
  forbidden: "this caller lacks the credential-reader role",
  "not-issued": "this credential has not been issued yet",
  "resource-version-expired": "the resource version has expired",
  unavailable: "the fake provisioning service failed",
};

function fail(res: ServerResponse, status: number, code: FakeErrorCode): void {
  send(res, status, { code, error: FAKE_ERROR_MESSAGES[code] } satisfies ProvisioningErrorBody);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
}

const SERVICE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

interface FakeChange {
  readonly version: number;
  readonly uid: string;
  readonly deleted: boolean;
}

function changePage(
  state: { changes: readonly FakeChange[]; resources: ReadonlyMap<string, UserProvisioning>; counter: number },
  since: number,
  limit: number,
): UserProvisioningWatchResponse {
  const page = state.changes.filter((change) => change.version > since).slice(0, limit);
  const items = page
    .filter((change) => !change.deleted && state.resources.get(change.uid)?.resourceVersion === String(change.version))
    .map((change) => state.resources.get(change.uid) as UserProvisioning);
  const deleted = page.filter((change) => change.deleted).map((change) => ({ uid: change.uid, resourceVersion: String(change.version) }));
  return {
    items,
    ...(deleted.length > 0 ? { deleted } : {}),
    resourceVersion: String(page.at(-1)?.version ?? state.counter),
  };
}

function createFakeGitKeys(nextVersion: () => number) {
  const keys = new Map<string, GitKey>();
  const releaseWhere = (matches: (key: GitKey) => boolean): void => {
    for (const [id, key] of keys) if (matches(key)) keys.delete(id);
  };
  return {
    keys,
    put(uid: string, holder: string, spec: GitKey["spec"]): { status: number; key: GitKey } {
      const existing = keys.get(`${uid}/${holder}`);
      if (existing?.spec.publicKey === spec.publicKey) return { status: 200, key: existing };
      const key: GitKey = {
        uid,
        gatewayId: holder.slice(0, holder.indexOf("/")),
        holder,
        generation: (existing?.generation ?? 0) + 1,
        resourceVersion: String(nextVersion()),
        deletionRequestedAt: null,
        spec,
        status: existing?.status ?? { observedGeneration: 0, conditions: [], nextAttemptAt: null },
      };
      keys.set(`${uid}/${holder}`, key);
      return { status: existing ? 202 : 201, key };
    },
    delete(uid: string, holder: string, expectedPublicKey: string | undefined): number {
      const existing = keys.get(`${uid}/${holder}`);
      if (existing && expectedPublicKey !== undefined && existing.spec.publicKey !== expectedPublicKey) return 409;
      keys.delete(`${uid}/${holder}`);
      return 202;
    },
    holders(): GitKeyHolderSummary[] {
      const summaries = new Map<string, GitKeyHolderSummary>();
      for (const key of keys.values()) {
        const rows = (summaries.get(key.holder)?.rows ?? 0) + 1;
        summaries.set(key.holder, { holder: key.holder, gatewayId: key.gatewayId, rows, newestUpdatedAt: new Date(0).toISOString() });
      }
      return [...summaries.values()].sort((left, right) => left.holder.localeCompare(right.holder));
    },
    releaseHolder: (holder: string) => releaseWhere((key) => key.holder === holder),
    releaseGateway: (gatewayId: string) => releaseWhere((key) => key.gatewayId === gatewayId),
    setStatus(uid: string, holder: string, status: GitKeyStatus): GitKey {
      const existing = keys.get(`${uid}/${holder}`);
      if (!existing) throw new Error(`fake provisioning service has no git key ${uid}/${holder}`);
      const next = { ...existing, resourceVersion: String(nextVersion()), status };
      keys.set(`${uid}/${holder}`, next);
      return next;
    },
  };
}

type FakeGitKeys = ReturnType<typeof createFakeGitKeys>;

const GIT_KEY_PATH = /^\/v1\/users\/([^/]+)\/git-keys\/([^/]+)$/;
const GIT_KEY_HOLDER_PATH = /^\/v1\/git-key-holders\/([^/]+)$/;
const GATEWAY_GIT_KEYS_PATH = /^\/v1\/gateways\/([^/]+)\/git-keys$/;

function putFakeGitKey(gitKeys: FakeGitKeys, resources: ReadonlyMap<string, UserProvisioning>, match: RegExpExecArray, body: unknown, res: ServerResponse): void {
  const uid = decodeURIComponent(match[1]);
  if (!resources.has(uid)) return fail(res, 404, "not-found");
  const { status, key } = gitKeys.put(uid, decodeURIComponent(match[2]), (body as { spec: GitKey["spec"] }).spec);
  send(res, status, key);
}

function deleteFakeGitKey(gitKeys: FakeGitKeys, match: RegExpExecArray, body: unknown, res: ServerResponse): void {
  const expected = (body as { expectedPublicKey?: string } | undefined)?.expectedPublicKey;
  const status = gitKeys.delete(decodeURIComponent(match[1]), decodeURIComponent(match[2]), expected);
  if (status === 409) return fail(res, 409, "precondition-failed");
  send(res, status);
}

function routeFakeGitKeys(
  gitKeys: FakeGitKeys,
  resources: Map<string, UserProvisioning>,
  recorded: FakeProvisioningRequest,
  pathname: string,
  res: ServerResponse,
): boolean {
  const gitKeyMatch = GIT_KEY_PATH.exec(pathname);
  const holderMatch = GIT_KEY_HOLDER_PATH.exec(pathname);
  const gatewayMatch = GATEWAY_GIT_KEYS_PATH.exec(pathname);
  if (gitKeyMatch && recorded.method === "PUT") putFakeGitKey(gitKeys, resources, gitKeyMatch, recorded.body, res);
  else if (gitKeyMatch && recorded.method === "DELETE") deleteFakeGitKey(gitKeys, gitKeyMatch, recorded.body, res);
  else if (pathname === "/v1/git-key-holders" && recorded.method === "GET") send(res, 200, { holders: gitKeys.holders() });
  else if (holderMatch && recorded.method === "DELETE") {
    gitKeys.releaseHolder(decodeURIComponent(holderMatch[1]));
    send(res, 202, { remaining: 0 });
  } else if (gatewayMatch && recorded.method === "DELETE") {
    gitKeys.releaseGateway(decodeURIComponent(gatewayMatch[1]));
    send(res, 202, { remaining: 0 });
  } else return false;
  return true;
}

export async function startFakeProvisioningService(options: { tokens?: string[] } = {}): Promise<FakeProvisioningService> {
  const requests: FakeProvisioningRequest[] = [];
  const resources = new Map<string, UserProvisioning>();
  const changes: FakeChange[] = [];
  const events = new Map<string, ProvisioningAttempt[]>();
  const retries = new Map<string, unknown>();
  const failures: Array<{ status: number; retryAfterSeconds?: number }> = [];
  const waiters = new Set<() => void>();
  let counter = 0;
  let oldestRetained = 0;
  const credentials = new Map<string, ProvisioningCredential>();
  const gitKeys = createFakeGitKeys(() => (counter += 1));
  const service = { acceptedTokens: new Set(options.tokens ?? ["token"]), credentialReader: true };

  function bump(uid: string, resource: UserProvisioning): UserProvisioning {
    counter += 1;
    const next = { ...resource, resourceVersion: String(counter) };
    resources.set(uid, next);
    changes.push({ version: counter, uid, deleted: false });
    for (const wake of [...waiters]) wake();
    return next;
  }

  function remove(uid: string): void {
    if (!resources.delete(uid)) return;
    counter += 1;
    changes.push({ version: counter, uid, deleted: true });
    for (const wake of [...waiters]) wake();
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
      fail(res, 401, "unauthenticated");
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
      fail(res, 409, "precondition-failed");
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
      fail(res, 409, "precondition-failed");
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
      remove(uid);
      return send(res, 204);
    }
    if (!existing) return fail(res, 404, "not-found");
    if (suffix === "/events") return send(res, 200, { items: events.get(uid) ?? [] });
    if (suffix === "/retry") return retry(uid, existing, recorded, res);
    send(res, 200, existing);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", FAKE_BASE);
    const recorded = record(req, url, await readBody(req));
    if (refused(req, res)) return;
    if (url.pathname === "/v1/provisionings") return listOrWatch(url, res);
    const credentialMatch = /^\/v1\/users\/([^/]+)\/credentials\/([^/]+)$/.exec(url.pathname);
    if (credentialMatch) return credential(decodeURIComponent(credentialMatch[1]), decodeURIComponent(credentialMatch[2]), res);
    if (routeFakeGitKeys(gitKeys, resources, recorded, url.pathname, res)) return;
    const userMatch = /^\/v1\/users\/([^/]+)\/provisioning(\/retry|\/events)?$/.exec(url.pathname);
    if (!userMatch) return fail(res, 404, "not-found");
    const uid = decodeURIComponent(userMatch[1]);
    if (!SERVICE_IDENTIFIER.test(uid)) return fail(res, 400, "invalid-request");
    user(uid, userMatch[2], recorded, res);
  }

  function credential(uid: string, name: string, res: ServerResponse): void {
    if (!service.credentialReader) return fail(res, 403, "forbidden");
    const issued = credentials.get(`${uid}/${name}`);
    if (issued) return send(res, 200, issued);
    if (!resources.has(uid)) return fail(res, 404, "not-found");
    fail(res, 409, "not-issued");
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
    if (since < oldestRetained) return fail(res, 410, "resource-version-expired");
    const timeoutMs = Number(url.searchParams.get("timeoutSeconds") ?? "60") * 1000;
    const limit = Number(url.searchParams.get("limit") ?? "500");
    if (!changes.some((change) => change.version > since)) {
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
    send(res, 200, changePage({ changes, resources, counter }, since, limit));
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error("fake provisioning service handler failed", error);
      fail(res, 500, "unavailable");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    resources,
    gitKeys: gitKeys.keys,
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
    issueCredential(uid, name, value) {
      const previous = credentials.get(`${uid}/${name}`);
      credentials.set(`${uid}/${name}`, { name, value, version: (previous?.version ?? 0) + 1 });
    },
    setGitKeyStatus: gitKeys.setStatus,
    get credentialReader() {
      return service.credentialReader;
    },
    set credentialReader(allowed: boolean) {
      service.credentialReader = allowed;
    },
    async close() {
      for (const wake of [...waiters]) wake();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
