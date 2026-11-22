import { createPublicKey, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { gatewayScopedJobId, verifyFleetRequest } from "./fleet-signature.js";

export type SharedMaintenanceRole = "gateway" | "gateway-edge";

export interface SharedMaintenanceStartupEnrollment {
  namespace: "octogee-test";
  gatewayId: string;
  podUid: string;
  attemptId: string;
  role: SharedMaintenanceRole;
  buildId: string;
  artifactSetId: string;
}

type Request = SharedMaintenanceStartupEnrollment & { nonce: string };
interface SignedLaunch {
  request: Request;
  expiresAt: number;
  restoredArchiveSha256: string;
  observedImageId: string;
}
type Response = { raw: string; signature: string };

const signaturePurpose = (request: Request) =>
  gatewayScopedJobId(`shared-maintenance-startup/${request.attemptId}/${request.role}`, request.gatewayId);
const archiveHash = /^[a-f0-9]{64}$/;

export function allowSharedMaintenanceLaunch(input: {
  request: Request;
  proof: Response;
  publicKey: string;
  now: number;
}): boolean {
  const { request, proof, publicKey, now } = input;
  if (typeof proof.raw !== "string" || proof.raw.length > 8192 ||
      !verifyFleetRequest(publicKey, signaturePurpose(request), proof.raw, proof.signature)) return false;
  const { request: signed, restoredArchiveSha256, observedImageId, expiresAt } = JSON.parse(proof.raw) as SignedLaunch;
  return isDeepStrictEqual(signed, request) && archiveHash.test(restoredArchiveSha256) &&
    /^sha256:[a-f0-9]{64}$/.test(observedImageId) && Number.isSafeInteger(expiresAt) && expiresAt > now && expiresAt <= now + 15_000;
}

function createInertProbeServer(role: SharedMaintenanceRole) {
  return createServer((request, response) => {
    const healthPath = role === "gateway" ? "/healthz" : "/health";
    response.writeHead(request.method === "GET" && request.url === healthPath ? 200 : 503).end();
  });
}

async function listen(server: Server, port: number, host: string) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

interface Startup {
  enrollment?: SharedMaintenanceStartupEnrollment;
  local: { namespace: string; gatewayId: string; role: SharedMaintenanceRole };
  publicKey: string;
  signal: AbortSignal;
  launch(): Promise<void>;
  observeProbes?(health: Server, readiness: Server | null): void;
  read: (request: Request, signal: AbortSignal) => Promise<Response | null>;
  onUnavailable(): void;
  probePort?: number;
  readinessPort?: number;
  probeHost?: string;
  retryMs?: number;
}

async function waitForSharedMaintenanceRelease(input: Startup, enrollment: SharedMaintenanceStartupEnrollment) {
  for (;;) {
    input.signal.throwIfAborted();
    const request = { ...enrollment, nonce: randomBytes(32).toString("hex") };
    let released = false;
    try {
      const proof = await input.read(request, input.signal);
      released = !!proof && allowSharedMaintenanceLaunch({ request, proof, publicKey: input.publicKey, now: Date.now() });
    } catch {
      input.onUnavailable();
    }
    input.signal.throwIfAborted();
    if (released) return;
    await setTimeout(input.retryMs ?? 2_000, undefined, { signal: input.signal });
  }
}

function startupIdentityMatches(enrollment: SharedMaintenanceStartupEnrollment, role: SharedMaintenanceRole) {
  return enrollment.role === role && /^[a-f0-9]{40}$/.test(enrollment.buildId) &&
    archiveHash.test(enrollment.artifactSetId) && Boolean(enrollment.attemptId) && Boolean(enrollment.podUid);
}

export async function runSharedMaintenanceStartup(input: Startup): Promise<void> {
  const { enrollment, local } = input;
  if (!enrollment || enrollment.namespace !== local.namespace || enrollment.gatewayId !== local.gatewayId) {
    await input.launch();
    return;
  }
  if (!startupIdentityMatches(enrollment, local.role)) throw new Error("Shared maintenance role enrollment does not match the allocation");

  const health = createInertProbeServer(enrollment.role);
  const readiness = enrollment.role === "gateway"
    ? createServer((_request, response) => response.writeHead(503).end()) : null;
  try {
    const host = input.probeHost ?? "0.0.0.0";
    await listen(health, input.probePort ?? (enrollment.role === "gateway" ? 18789 : 3001), host);
    if (readiness) await listen(readiness, input.readinessPort ?? 3003, host);
    input.observeProbes?.(health, readiness);
    await waitForSharedMaintenanceRelease(input, enrollment);
  } finally {
    const stop = (server: Server) => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await Promise.all([health, readiness].filter(server => server !== null).map(stop));
  }
  await input.launch();
}


interface InertOperatorOptions {
  publicKey: string;
  directory?: string;
  onSocket?(path: string): void;
}

async function permitBody(request: IncomingMessage): Promise<Response> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 16_384) throw new Error("Shared maintenance permit exceeds the local socket limit");
    chunks.push(buffer);
  }
  const proof = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Response;
  if (typeof proof?.raw !== "string" || typeof proof.signature !== "string") throw new Error("Shared maintenance permit is malformed");
  return proof;
}

export async function openSharedMaintenancePermitSocket({ publicKey, directory = "/tmp", onSocket }: InertOperatorOptions) {
  const privateDirectory = await mkdtemp(join(directory, "octogee-shared-held-"));
  const socket = join(privateDirectory, "permit.sock");
  let pending: { request: Request; resolve(proof: Response): void } | undefined;
  const server = createServer((message, response) => {
    const current = pending;
    if (!current) { response.writeHead(409).end(); return; }
    if (message.method === "GET" && message.url === "/nonce") {
      response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end(current.request.nonce);
      return;
    }
    if (message.method !== "POST" || message.url !== "/permit") { response.writeHead(404).end(); return; }
    void permitBody(message).then(proof => {
      if (pending !== current || !allowSharedMaintenanceLaunch({ request: current.request, proof, publicKey, now: Date.now() })) {
        response.writeHead(403).end();
        return;
      }
      pending = undefined;
      response.writeHead(204).end(() => current.resolve(proof));
    }).catch(() => { response.writeHead(400).end(); });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    await chmod(socket, 0o600);
    onSocket?.(socket);
  } catch (error) {
    server.close();
    await rm(privateDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    socket,
    async read(request: Request, signal: AbortSignal): Promise<Response> {
      signal.throwIfAborted();
      if (pending) throw new Error("Shared maintenance already has an outstanding nonce");
      return new Promise((resolve, reject) => {
        const abort = () => { pending = undefined; reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        pending = { request, resolve(proof) {
          signal.removeEventListener("abort", abort);
          resolve(proof);
        } };
      });
    },
    async close() {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await rm(privateDirectory, { recursive: true, force: true });
    },
  };
}

export type SharedMaintenanceStartupScope = Omit<SharedMaintenanceStartupEnrollment, "role">;
export interface SharedMaintenancePublishedRelease {
  release: number;
  payloadHash: string;
  publishedAt: number;
}
export interface SharedMaintenanceCompletionReceipt {
  scope: SharedMaintenanceStartupScope;
  images: Record<SharedMaintenanceRole, string>;
  restoredArchiveSha256: string;
  publication: SharedMaintenancePublishedRelease;
}

export function sharedMaintenanceCompletionPurpose(scope: SharedMaintenanceStartupScope) {
  return gatewayScopedJobId(`shared-maintenance-completion/${scope.attemptId}`, scope.gatewayId);
}

export function isSharedMaintenancePublication(publication: SharedMaintenancePublishedRelease | undefined, now: number) {
  return !!publication && Number.isSafeInteger(publication.release) && publication.release > 0 &&
    typeof publication.payloadHash === "string" && archiveHash.test(publication.payloadHash) &&
    Number.isSafeInteger(publication.publishedAt) && publication.publishedAt > 0 && publication.publishedAt <= now;
}

export function allowSharedMaintenanceRestart(input: {
  scope: SharedMaintenanceStartupScope;
  localBoundPodUid: string | null;
  proof: Response;
  publicKey: string;
  now: number;
}) {
  const { scope, localBoundPodUid, proof, publicKey, now } = input;
  if (!localBoundPodUid || localBoundPodUid !== scope.podUid ||
      typeof proof.raw !== "string" || proof.raw.length > 8192 ||
      !verifyFleetRequest(publicKey, sharedMaintenanceCompletionPurpose(scope), proof.raw, proof.signature)) return false;
  const receipt = JSON.parse(proof.raw) as SharedMaintenanceCompletionReceipt;
  return isDeepStrictEqual(receipt.scope, scope) && archiveHash.test(receipt.restoredArchiveSha256) &&
    isSharedMaintenancePublication(receipt.publication, now) && [receipt.images?.gateway, receipt.images?.["gateway-edge"]]
      .every(image => typeof image === "string" && /^sha256:[a-f0-9]{64}$/.test(image)) &&
    receipt.images.gateway !== receipt.images["gateway-edge"];
}

export function projectedSharedMaintenancePodUid(token: string, namespace: string): string | null {
  const [, payload] = token.trim().split(".");
  if (!payload || payload.length > 8192) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      aud?: string[];
      "kubernetes.io"?: { namespace?: string; pod?: { uid?: string } };
    };
    const identity = claims["kubernetes.io"];
    return Array.isArray(claims.aud) && claims.aud.includes("octogee-api-gateway-credentials") &&
      identity?.namespace === namespace && typeof identity.pod?.uid === "string" ? identity.pod.uid : null;
  } catch {
    return null;
  }
}

async function hasSharedMaintenanceCompletion(scope: SharedMaintenanceStartupScope, publicKey: string) {
  const file = await open("/home/node/.octogee-shared-maintenance-completion.json",
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!file) return false;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0 || info.size > 16_384) return false;
    const token = await readFile("/var/run/secrets/octogee-gateway-credentials/token", "utf8");
    return allowSharedMaintenanceRestart({
      scope, localBoundPodUid: projectedSharedMaintenancePodUid(token, scope.namespace),
      proof: JSON.parse(await file.readFile("utf8")) as Response, publicKey, now: Date.now(),
    });
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    await file.close();
  }
}

interface InertStartupDocument extends Omit<SharedMaintenanceStartupEnrollment, "role"> {
  version: 1;
  enrolledIssuerPublicKey: string;
}

async function readInertStartupDocument() {
  const file = await open("/etc/octogee/shared-maintenance-startup.json", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (!file) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size <= 0 || stat.size > 8192) {
      throw new Error("Shared maintenance startup enrollment is not an immutable image file");
    }
    const contents = await file.readFile();
    if (contents.length !== stat.size) throw new Error("Shared maintenance startup enrollment changed");
    return JSON.parse(contents.toString("utf8")) as InertStartupDocument;
  } finally {
    await file.close();
  }
}

export async function waitForInstalledSharedMaintenanceGate(role: SharedMaintenanceRole, env: NodeJS.ProcessEnv) {
  if (env.GATEWAY_CLASS !== "shared") return;
  const document = await readInertStartupDocument();
  if (!document) return;
  const { version, enrolledIssuerPublicKey, ...scope } = document;
  if (version !== 1 || scope.namespace !== "octogee-test" || !scope.gatewayId || !scope.attemptId || !scope.podUid ||
      !/^[a-f0-9]{40}$/.test(scope.buildId) || !archiveHash.test(scope.artifactSetId) || typeof enrolledIssuerPublicKey !== "string" || createPublicKey(enrolledIssuerPublicKey).asymmetricKeyType !== "ed25519") {
    throw new Error("Shared maintenance startup enrollment is malformed");
  }
  if (document.namespace !== env.K8S_NAMESPACE || document.gatewayId !== env.GATEWAY_ID) return;
  if (await hasSharedMaintenanceCompletion(scope, enrolledIssuerPublicKey)) return;
  const enrollment = { ...scope, role };
  const abort = new AbortController();
  const shutdown = () => abort.abort();
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  const localPermit = await openSharedMaintenancePermitSocket({
    publicKey: enrolledIssuerPublicKey,
    onSocket(path) { process.stderr.write(`Shared maintenance ${role} local permit socket: ${path}\n`); },
  });
  try {
    await runSharedMaintenanceStartup({
      enrollment, local: enrollment, publicKey: enrolledIssuerPublicKey, signal: abort.signal,
      read: localPermit.read,
      async launch() {},
      onUnavailable() { process.stderr.write("Shared maintenance retained launch authority is unavailable\n"); },
    });
  } finally {
    await localPermit.close();
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
  }
}
