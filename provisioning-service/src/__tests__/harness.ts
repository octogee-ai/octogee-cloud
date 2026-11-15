import { randomBytes } from "node:crypto";
import pg from "pg";
import type { UserProvisioningSpec } from "@octogee/shared/types/provisioning-service";
import type { Reviewer } from "../auth/token-review.js";
import { CALLER_ROLES } from "../config.js";
import { FakeChatHost, FakeGitHost } from "../hosts/fake-hosts.js";
import type { Logger } from "../logger.js";
import { startService, type RunningService, type ServiceOptions } from "../service.js";

export const dsn = process.env.OCTOGEE_TEST_POSTGRES_DSN;
export const NAMESPACE = "platform";

export const TOKENS = {
  writer: "token-fleet-controller",
  platformApi: "token-platform-api",
  stranger: "token-stranger",
  otherNamespace: "token-other-namespace",
  invalid: "token-invalid",
} as const;

export const fakeReviewer: Reviewer = async (token) => {
  switch (token) {
    case TOKENS.writer: return { authenticated: true, namespace: NAMESPACE, serviceAccount: "octogee-glm-controller" };
    case TOKENS.platformApi: return { authenticated: true, namespace: NAMESPACE, serviceAccount: "octogee-api" };
    case TOKENS.stranger: return { authenticated: true, namespace: NAMESPACE, serviceAccount: "octogee-gateway" };
    case TOKENS.otherNamespace: return { authenticated: true, namespace: "elsewhere", serviceAccount: "octogee-glm-controller" };
    default: return { authenticated: false };
  }
};

export interface CapturedLog extends Logger {
  lines: { level: string; message: string; fields?: Record<string, unknown> }[];
}

export function capturingLogger(): CapturedLog {
  const lines: CapturedLog["lines"] = [];
  const at = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push({ level, message, ...(fields ? { fields } : {}) });
  };
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

export function spec(slug: string, overrides: Partial<UserProvisioningSpec> = {}): UserProvisioningSpec {
  return {
    slug,
    displayName: { first: "Lin", last: "Wu" },
    email: `${slug}@example.com`,
    avatarUrl: null,
    chat: { teamDisplayName: "Lin", defaultAgent: { enabled: true } },
    git: { repositories: ["workspace"], systemConfigRepository: true },
    agentIds: ["main"],
    ...overrides,
  };
}

export interface Harness {
  service: RunningService;
  chat: FakeChatHost;
  git: FakeGitHost;
  log: CapturedLog;
  schema: string;
  request(method: string, path: string, options?: { token?: string | null; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any; headers: Headers }>;
  dispose(): Promise<void>;
}

export async function createHarness(options: Partial<Pick<ServiceOptions, "queue" | "heartbeatMs" | "runWorker" | "concurrency" | "requestsPerMinute">> & { schema?: string; chat?: FakeChatHost; git?: FakeGitHost; reviewer?: Reviewer } = {}): Promise<Harness> {
  if (!dsn) throw new Error("OCTOGEE_TEST_POSTGRES_DSN is required");
  const schema = options.schema ?? `ps_test_${randomBytes(6).toString("hex")}`;
  const chat = options.chat ?? new FakeChatHost();
  const git = options.git ?? new FakeGitHost();
  const log = capturingLogger();
  const service = await startService({
    database: { connectionString: dsn },
    databaseSchema: schema,
    credentialKey: randomBytes(32),
    reviewer: options.reviewer ?? fakeReviewer,
    callerNamespace: NAMESPACE,
    roleTable: CALLER_ROLES,
    chat,
    git,
    log,
    replicaId: `test-${schema}`,
    port: 0,
    host: "127.0.0.1",
    ...(options.queue ? { queue: options.queue } : {}),
    ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    ...(options.requestsPerMinute ? { requestsPerMinute: options.requestsPerMinute } : {}),
    runWorker: options.runWorker ?? false,
  });
  return {
    service, chat, git, log, schema,
    async request(method, path, requestOptions = {}) {
      const token = requestOptions.token === undefined ? TOKENS.writer : requestOptions.token;
      const response = await fetch(`${service.url}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(requestOptions.body !== undefined ? { "content-type": "application/json" } : {}),
          ...requestOptions.headers,
        },
        ...(requestOptions.body !== undefined ? { body: JSON.stringify(requestOptions.body) } : {}),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
    },
    async dispose() {
      await service.stop();
      await dropSchema(schema);
    },
  };
}

export async function dropSchema(schema: string): Promise<void> {
  const client = new pg.Client({ connectionString: dsn });
  await client.connect();
  try {
    await client.query("SELECT set_config('provisioning_test.schema', $1, false)", [schema]);
    await client.query("DO $$ BEGIN EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', current_setting('provisioning_test.schema')); END $$");
  } finally {
    await client.end();
  }
}

export async function untilSettled(harness: Harness, maxTicks = 20): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const claimed = await harness.service.worker.tick();
    await harness.service.worker.drain();
    if (claimed === 0) return;
  }
  throw new Error("work did not settle");
}
