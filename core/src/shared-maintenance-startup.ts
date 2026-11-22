import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { gatewayScopedJobId, verifyFleetRequest } from "./fleet-signature.js";
import { gatewayCredentialHeaders, internalFetch, sidecarBrokerHeaders } from "./internal-fetch.js";

export type SharedMaintenanceRole = "gateway" | "gateway-edge";

export interface SharedMaintenanceStartupEnrollment {
  namespace: "octogee-test";
  gatewayId: string;
  podUid: string;
  attemptId: string;
  role: SharedMaintenanceRole;
  buildId: string;
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

export function readSharedMaintenanceLaunch(enrollment: SharedMaintenanceStartupEnrollment) {
  return async (request: Request, signal: AbortSignal): Promise<Response | null> => {
    const roleHeaders = request.role === "gateway-edge" ? await sidecarBrokerHeaders() : {};
    const response = await internalFetch(
      `http://octogee-api.${enrollment.namespace}.svc.cluster.local:3001/internal/fleet/shared-maintenance/startup/${request.role}`,
      { method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", ...await gatewayCredentialHeaders(), ...roleHeaders }, body: JSON.stringify(request) },
      { internalServiceKey: "", requireProjectedToken: true, timeoutMs: 5_000 },
    );
    if (response.status === 409) return null;
    if (!response.ok) throw new Error("Shared maintenance startup broker is unavailable");
    const { raw, signature } = await response.json() as Response;
    return { raw, signature };
  };
}

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

export async function runSharedMaintenanceStartup(input: Startup): Promise<void> {
  const { enrollment, local } = input;
  if (!enrollment || enrollment.namespace !== local.namespace || enrollment.gatewayId !== local.gatewayId) {
    await input.launch();
    return;
  }
  if (enrollment.role !== local.role || !/^[a-f0-9]{40}$/.test(enrollment.buildId) ||
      !enrollment.attemptId || !enrollment.podUid) throw new Error("Shared maintenance role enrollment does not match the allocation");

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


interface InertStartupDocument extends Omit<SharedMaintenanceStartupEnrollment, "role"> {
  version: 1;
  fleetPublicKey: string;
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
  const { version, fleetPublicKey, ...scope } = document;
  if (version !== 1 || scope.namespace !== "octogee-test" || !scope.gatewayId || !scope.attemptId || !scope.podUid ||
      !/^[a-f0-9]{40}$/.test(scope.buildId) || typeof fleetPublicKey !== "string" || !fleetPublicKey.includes("PUBLIC KEY")) {
    throw new Error("Shared maintenance startup enrollment is malformed");
  }
  if (document.namespace !== env.K8S_NAMESPACE || document.gatewayId !== env.GATEWAY_ID) return;
  const enrollment = { ...scope, role };
  await runSharedMaintenanceStartup({
    enrollment, local: enrollment, publicKey: fleetPublicKey, signal: new AbortController().signal,
    read: readSharedMaintenanceLaunch(enrollment),
    async launch() {},
    onUnavailable() { process.stderr.write("Shared maintenance retained launch authority is unavailable\n"); },
  });
}
