import { readFile } from "node:fs/promises";
import {
  PROVISIONING_API_VERSION,
  type ProvisioningCredential,
  type ProvisioningCredentialName,
  type ProvisioningErrorCode,
  type ProvisioningEventsResponse,
  type RetryProvisioningRequest,
  type UserProvisioning,
  type UserProvisioningList,
  type UserProvisioningListQuery,
  type UserProvisioningSpec,
  type UserProvisioningWatchResponse,
} from "@octogee/shared/types/provisioning-service";

export const PROVISIONING_SERVICE_URL_ENV = "PROVISIONING_SERVICE_URL";
export const PROVISIONING_SERVICE_TOKEN_PATH_ENV = "PROVISIONING_SERVICE_TOKEN_PATH";

const TOKEN_REFRESH_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const LONG_POLL_GRACE_MS = 15_000;
const PUT_OUTCOMES: Readonly<Record<number, PutProvisioningResult["outcome"]>> = { 201: "created", 202: "changed" };

export interface ProvisioningServiceRetryPolicy {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_PROVISIONING_SERVICE_RETRY: ProvisioningServiceRetryPolicy = {
  attempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
};

export type ProvisioningServiceRequestOutcome = "ok" | "client-error" | "server-error" | "unreachable";

export interface ProvisioningServiceClientOptions {
  readonly baseUrl: string;
  readonly tokenPath: string;
  readonly fetch?: typeof fetch;
  readonly readToken?: (path: string) => Promise<string>;
  readonly retry?: ProvisioningServiceRetryPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly onRequest?: (outcome: ProvisioningServiceRequestOutcome) => void;
}

export class ProvisioningServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: ProvisioningErrorCode | "unreachable" | "unexpected-response",
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ProvisioningServiceError";
  }

  get transient(): boolean {
    return this.code === "unreachable" || this.status === 429 || this.status >= 500;
  }
}

export interface PutProvisioningResult {
  readonly outcome: "created" | "changed" | "unchanged";
  readonly resource: UserProvisioning;
}

export interface GetProvisioningOptions {
  readonly waitForGeneration?: number;
  readonly timeoutSeconds?: number;
}

export interface WatchProvisioningsOptions {
  readonly resourceVersion: string;
  readonly timeoutSeconds?: number;
}

export interface ProvisioningServiceClient {
  putProvisioning(uid: string, spec: UserProvisioningSpec, options?: { expectedResourceVersion?: string }): Promise<PutProvisioningResult>;
  getProvisioning(uid: string, options?: GetProvisioningOptions): Promise<UserProvisioning | null>;
  deleteProvisioning(uid: string): Promise<void>;
  listProvisionings(query?: UserProvisioningListQuery): Promise<UserProvisioningList>;
  listAllProvisionings(query?: Omit<UserProvisioningListQuery, "pageToken">): Promise<UserProvisioningWatchResponse>;
  watchProvisionings(options: WatchProvisioningsOptions): Promise<UserProvisioningWatchResponse>;
  retryProvisioning(uid: string, request: RetryProvisioningRequest, idempotencyKey: string): Promise<unknown>;
  getProvisioningEvents(uid: string): Promise<ProvisioningEventsResponse | null>;
  getCredential(uid: string, name: ProvisioningCredentialName): Promise<ProvisioningCredential | null>;
}

export interface ProvisioningServiceConfig {
  readonly baseUrl: string;
  readonly tokenPath: string;
}

export function provisioningServiceConfigFromEnvironment(env: NodeJS.ProcessEnv): ProvisioningServiceConfig | null {
  const baseUrl = env[PROVISIONING_SERVICE_URL_ENV]?.trim() ?? "";
  if (baseUrl === "") return null;
  const tokenPath = env[PROVISIONING_SERVICE_TOKEN_PATH_ENV]?.trim() ?? "";
  if (tokenPath === "") {
    throw new Error(`${PROVISIONING_SERVICE_URL_ENV} is set but ${PROVISIONING_SERVICE_TOKEN_PATH_ENV} is not`);
  }
  return { baseUrl, tokenPath };
}

export function backoffDelayMs(attempt: number, policy: Pick<ProvisioningServiceRetryPolicy, "baseDelayMs" | "maxDelayMs">, random: () => number): number {
  const capped = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
  return Math.round(capped * (0.8 + 0.4 * random()));
}

function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function errorFromResponse(response: Response): Promise<ProvisioningServiceError> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const code = isRecord(body) && typeof body.code === "string" ? body.code : "unexpected-response";
  const message = isRecord(body) && typeof body.error === "string" ? body.error : `provisioning service answered ${response.status}`;
  return new ProvisioningServiceError(
    response.status,
    code as ProvisioningServiceError["code"],
    message,
    retryAfterMs(response.headers.get("retry-after")),
  );
}

function outcomeOf(error: unknown): ProvisioningServiceRequestOutcome {
  if (!(error instanceof ProvisioningServiceError)) return "unreachable";
  if (error.code === "unreachable") return "unreachable";
  return error.status >= 500 ? "server-error" : "client-error";
}

function credentialFrom(text: string, name: ProvisioningCredentialName): ProvisioningCredential {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ProvisioningServiceError(200, "unexpected-response", `provisioning service answered an unreadable ${name} credential`);
  }
  if (!isRecord(body) || body.name !== name || typeof body.value !== "string" || body.value === "" || typeof body.version !== "number") {
    throw new ProvisioningServiceError(200, "unexpected-response", `provisioning service answered a malformed ${name} credential`);
  }
  return { name, value: body.value, version: body.version };
}

interface RequestInput {
  readonly method: "GET" | "PUT" | "POST" | "DELETE";
  readonly path: string;
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly allowNotFound?: boolean;
}

export function createProvisioningServiceClient(options: ProvisioningServiceClientOptions): ProvisioningServiceClient {
  const fetchImpl = options.fetch ?? fetch;
  const readToken = options.readToken ?? (async (path: string) => (await readFile(path, "utf8")).trim());
  const retry = options.retry ?? DEFAULT_PROVISIONING_SERVICE_RETRY;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const base = new URL(`/${PROVISIONING_API_VERSION}/`, options.baseUrl);
  let cachedToken: { value: string; readAt: number } | null = null;

  async function token(forceRead: boolean): Promise<string> {
    if (!forceRead && cachedToken !== null && now() - cachedToken.readAt < TOKEN_REFRESH_MS) return cachedToken.value;
    const value = await readToken(options.tokenPath);
    if (value === "") throw new ProvisioningServiceError(0, "unreachable", `service account token at ${options.tokenPath} is empty`);
    cachedToken = { value, readAt: now() };
    return value;
  }

  function urlOf(input: RequestInput): URL {
    const url = new URL(input.path, base);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  async function once(input: RequestInput, forceTokenRead: boolean): Promise<Response> {
    const bearer = await token(forceTokenRead);
    try {
      return await fetchImpl(urlOf(input), {
        method: input.method,
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: "application/json",
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
          ...input.headers,
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: AbortSignal.timeout(input.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ProvisioningServiceError(0, "unreachable", `provisioning service ${input.method} ${input.path} failed: ${errorMessage(error)}`);
    }
  }

  async function attempt(input: RequestInput): Promise<Response> {
    let response = await once(input, false);
    if (response.status === 401) response = await once(input, true);
    if (response.ok || (input.allowNotFound === true && response.status === 404)) return response;
    throw await errorFromResponse(response);
  }

  async function request(input: RequestInput): Promise<Response> {
    for (let attemptIndex = 0; ; attemptIndex += 1) {
      try {
        const response = await attempt(input);
        options.onRequest?.("ok");
        return response;
      } catch (error) {
        options.onRequest?.(outcomeOf(error));
        const transient = error instanceof ProvisioningServiceError && error.transient;
        if (!transient || attemptIndex + 1 >= retry.attempts) throw error;
        const hinted = error.retryAfterMs;
        await sleep(hinted ?? backoffDelayMs(attemptIndex, retry, random));
      }
    }
  }

  async function json<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new ProvisioningServiceError(response.status, "unexpected-response", `provisioning service answered unreadable JSON: ${errorMessage(error)}`);
    }
  }

  const userPath = (uid: string) => `users/${encodeURIComponent(uid)}/provisioning`;

  const client: ProvisioningServiceClient = {
    async putProvisioning(uid, spec, putOptions) {
      const response = await request({
        method: "PUT",
        path: userPath(uid),
        body: { spec, ...(putOptions?.expectedResourceVersion === undefined ? {} : { expectedResourceVersion: putOptions.expectedResourceVersion }) },
      });
      return { outcome: PUT_OUTCOMES[response.status] ?? "unchanged", resource: await json<UserProvisioning>(response) };
    },

    async getProvisioning(uid, getOptions) {
      const timeoutSeconds = getOptions?.timeoutSeconds;
      const response = await request({
        method: "GET",
        path: userPath(uid),
        query: { waitForGeneration: getOptions?.waitForGeneration, timeoutSeconds },
        ...(timeoutSeconds === undefined ? {} : { timeoutMs: timeoutSeconds * 1000 + LONG_POLL_GRACE_MS }),
        allowNotFound: true,
      });
      return response.status === 404 ? null : json<UserProvisioning>(response);
    },

    async deleteProvisioning(uid) {
      await request({ method: "DELETE", path: userPath(uid), allowNotFound: true });
    },

    async listProvisionings(query) {
      const response = await request({
        method: "GET",
        path: "provisionings",
        query: {
          ready: query?.ready,
          reason: query?.reason,
          workState: query?.workState,
          limit: query?.limit,
          pageToken: query?.pageToken,
        },
      });
      return json<UserProvisioningList>(response);
    },

    async listAllProvisionings(query) {
      const items: UserProvisioning[] = [];
      let pageToken: string | undefined;
      let resourceVersion: string | null = null;
      do {
        const page = await client.listProvisionings({ ...query, ...(pageToken === undefined ? {} : { pageToken }) });
        resourceVersion ??= page.resourceVersion;
        items.push(...page.items);
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);
      return { items, resourceVersion: resourceVersion ?? "0" };
    },

    async watchProvisionings(watchOptions) {
      const timeoutSeconds = watchOptions.timeoutSeconds ?? 60;
      const response = await request({
        method: "GET",
        path: "provisionings",
        query: { watch: true, resourceVersion: watchOptions.resourceVersion, timeoutSeconds },
        timeoutMs: timeoutSeconds * 1000 + LONG_POLL_GRACE_MS,
      });
      return json<UserProvisioningWatchResponse>(response);
    },

    async retryProvisioning(uid, retryRequest, idempotencyKey) {
      const response = await request({
        method: "POST",
        path: `${userPath(uid)}/retry`,
        body: retryRequest,
        headers: { "idempotency-key": idempotencyKey },
      });
      const text = await response.text();
      return text === "" ? {} : (JSON.parse(text) as unknown);
    },

    async getProvisioningEvents(uid) {
      const response = await request({ method: "GET", path: `${userPath(uid)}/events`, allowNotFound: true });
      return response.status === 404 ? null : json<ProvisioningEventsResponse>(response);
    },

    async getCredential(uid, name) {
      let response: Response;
      try {
        response = await request({ method: "GET", path: `users/${encodeURIComponent(uid)}/credentials/${encodeURIComponent(name)}` });
      } catch (error) {
        if (error instanceof ProvisioningServiceError && error.status === 409 && error.code === "not-issued") return null;
        throw error;
      }
      return credentialFrom(await response.text(), name);
    },
  };
  return client;
}

export interface ProvisioningWatchHandlers {
  onSnapshot(items: readonly UserProvisioning[]): Promise<void>;
  onChanges(items: readonly UserProvisioning[]): Promise<void>;
  onError(error: unknown, consecutiveFailures: number): void;
}

export interface ProvisioningWatchOptions {
  readonly timeoutSeconds?: number;
  readonly retry?: Pick<ProvisioningServiceRetryPolicy, "baseDelayMs" | "maxDelayMs">;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export const PROVISIONING_WATCH_RETRY = { baseDelayMs: 1_000, maxDelayMs: 60_000 } as const;

export function startProvisioningWatch(
  client: Pick<ProvisioningServiceClient, "listAllProvisionings" | "watchProvisionings">,
  handlers: ProvisioningWatchHandlers,
  options: ProvisioningWatchOptions = {},
): { stop(): void; stopped: Promise<void> } {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const retry = options.retry ?? PROVISIONING_WATCH_RETRY;
  let stopping = false;

  async function run(): Promise<void> {
    let resourceVersion: string | null = null;
    let failures = 0;
    while (!stopping) {
      try {
        if (resourceVersion === null) {
          const listed = await client.listAllProvisionings();
          if (stopping) return;
          await handlers.onSnapshot(listed.items);
          resourceVersion = listed.resourceVersion;
        } else {
          const changed = await client.watchProvisionings({ resourceVersion, timeoutSeconds: options.timeoutSeconds ?? 60 });
          if (stopping) return;
          if (changed.items.length > 0) await handlers.onChanges(changed.items);
          resourceVersion = changed.resourceVersion;
        }
        failures = 0;
      } catch (error) {
        if (error instanceof ProvisioningServiceError && error.code === "resource-version-expired") {
          resourceVersion = null;
          continue;
        }
        failures += 1;
        handlers.onError(error, failures);
        await sleep(backoffDelayMs(failures - 1, retry, random));
      }
    }
  }

  const stopped = run();
  return {
    stop() {
      stopping = true;
    },
    stopped,
  };
}
