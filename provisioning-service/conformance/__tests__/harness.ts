import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import type { UserProvisioningSpec } from "@octogee/shared/types/provisioning-service";

export const dsn = process.env.PROVISIONING_CONFORMANCE_DSN;
export const NAMESPACE = "conformance";
const AUDIENCE = "provisioning-service";
const REVIEWER_TOKEN = "conformance-reviewer";
const DEFAULT_COMMAND = `${JSON.stringify(process.execPath)} --import tsx src/main.ts`;

export const TOKENS = {
  writer: "conformance-fleet-controller",
  platformApi: "conformance-platform-api",
  stranger: "conformance-unknown-account",
  otherNamespace: "conformance-other-namespace",
  wrongAudience: "conformance-wrong-audience",
} as const;

const IDENTITIES: Record<string, { username: string; audiences: string[] }> = {
  [TOKENS.writer]: { username: `system:serviceaccount:${NAMESPACE}:octogee-glm-controller`, audiences: [AUDIENCE] },
  [TOKENS.platformApi]: { username: `system:serviceaccount:${NAMESPACE}:octogee-api`, audiences: [AUDIENCE] },
  [TOKENS.stranger]: { username: `system:serviceaccount:${NAMESPACE}:octogee-gateway`, audiences: [AUDIENCE] },
  [TOKENS.otherNamespace]: { username: "system:serviceaccount:elsewhere:octogee-glm-controller", audiences: [AUDIENCE] },
  [TOKENS.wrongAudience]: { username: `system:serviceaccount:${NAMESPACE}:octogee-glm-controller`, audiences: ["another-audience"] },
};

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

function startTokenReview(): Promise<Server> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.headers.authorization !== `Bearer ${REVIEWER_TOKEN}`) {
        response.writeHead(401).end();
        return;
      }
      const review = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { spec: { token: string; audiences?: string[] } };
      const identity = IDENTITIES[review.spec.token];
      const requested = review.spec.audiences ?? [];
      const matched = identity ? identity.audiences.filter((audience) => requested.includes(audience)) : [];
      const status = identity && matched.length > 0
        ? { authenticated: true, user: { username: identity.username }, audiences: matched }
        : { authenticated: false };
      response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ apiVersion: "authentication.k8s.io/v1", kind: "TokenReview", status }));
    });
  });
  return new Promise((resolveServer) => server.listen(0, "127.0.0.1", () => resolveServer(server)));
}

async function emptyDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: dsn });
  await client.connect();
  try {
    await client.query("DROP OWNED BY CURRENT_USER CASCADE");
  } finally {
    await client.end();
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

export interface Replica {
  url: string;
  process: ChildProcess;
  output: string[];
}

export interface Implementation {
  replicas: Replica[];
  url: string;
  request(method: string, path: string, options?: { token?: string | null; body?: unknown; headers?: Record<string, string>; replica?: number }): Promise<{ status: number; body: any; headers: Headers }>;
  startReplica(): Promise<Replica>;
  stop(): Promise<void>;
}

export async function startImplementation(options: { replicas?: number } = {}): Promise<Implementation> {
  if (!dsn) throw new Error("PROVISIONING_CONFORMANCE_DSN is required");
  await emptyDatabase();
  const tokenReview = await startTokenReview();
  const directory = mkdtempSync(join(tmpdir(), "provisioning-conformance-"));
  const tokenFile = join(directory, "reviewer-token");
  writeFileSync(tokenFile, REVIEWER_TOKEN, { mode: 0o600 });
  const target = new URL(dsn);
  const socketHost = target.searchParams.get("host");
  const environment = {
    PROVISIONING_DB_HOST: socketHost ?? target.hostname,
    PROVISIONING_DB_PORT: target.port || "5432",
    PROVISIONING_DB_NAME: target.pathname.slice(1),
    PROVISIONING_DB_USER: decodeURIComponent(target.username),
    PROVISIONING_DB_PASSWORD: decodeURIComponent(target.password) || "unused",
    PROVISIONING_DB_SSLMODE: "disable",
    PROVISIONING_CALLER_NAMESPACE: NAMESPACE,
    PROVISIONING_CREDENTIAL_KEY: randomBytes(32).toString("base64"),
    PROVISIONING_TOKEN_REVIEW_URL: `http://127.0.0.1:${(tokenReview.address() as AddressInfo).port}/apis/authentication.k8s.io/v1/tokenreviews`,
    PROVISIONING_TOKEN_REVIEW_TOKEN_FILE: tokenFile,
    PROVISIONING_HOST_ADAPTERS: "fake",
  };
  const command = process.env.PROVISIONING_CONFORMANCE_COMMAND ?? DEFAULT_COMMAND;
  const cwd = resolve(import.meta.dirname, "../..");
  const replicas: Replica[] = [];

  const startReplica = async (): Promise<Replica> => {
    const port = await freePort();
    const child = spawn(`exec ${command}`, {
      cwd,
      shell: true,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...environment, PROVISIONING_PORT: String(port), HOSTNAME: `replica-${replicas.length}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
    const replica = { url: `http://127.0.0.1:${port}`, process: child, output };
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the implementation exited with ${child.exitCode}:\n${output.join("")}`);
      try {
        if ((await fetch(`${replica.url}/readyz`)).ok) break;
      } catch {
        if (Date.now() > deadline) throw new Error(`the implementation did not become ready:\n${output.join("")}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    replicas.push(replica);
    return replica;
  };

  for (let index = 0; index < (options.replicas ?? 1); index += 1) await startReplica();

  return {
    replicas,
    get url() {
      return replicas[0].url;
    },
    startReplica,
    async request(method, path, requestOptions = {}) {
      const token = requestOptions.token === undefined ? TOKENS.writer : requestOptions.token;
      const replica = replicas[requestOptions.replica ?? 0];
      const response = await fetch(`${replica.url}${path}`, {
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
    async stop() {
      await Promise.all(replicas.map((replica) => new Promise<void>((resolveExit) => {
        if (replica.process.exitCode !== null || replica.process.signalCode !== null) return resolveExit();
        replica.process.once("exit", () => resolveExit());
        replica.process.kill("SIGTERM");
      })));
      await new Promise<void>((resolveClose) => tokenReview.close(() => resolveClose()));
      await emptyDatabase();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function untilReady(implementation: Implementation, uid: string, generation: number, timeoutSeconds = 60): Promise<any> {
  const response = await implementation.request("GET", `/v1/users/${uid}/provisioning?waitForGeneration=${generation}&timeoutSeconds=${timeoutSeconds}`);
  return response.body;
}

export function condition(resource: any, type: string): { status: string; reason: string } | undefined {
  return resource.status.conditions.find((candidate: { type: string }) => candidate.type === type);
}
