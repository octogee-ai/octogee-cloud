

import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { computeInstanceFromPayload, createGoogleIdTokenVerifier, GOOGLE_TOKEN_ISSUERS, type VerifyGoogleIdToken } from "./gce-instance-identity.js";
import { heldNativeSourceHoldAudience, heldNativeSourceHoldJobId, heldNativeSourceReconcileJobId, gatewayScopedJobId, signFleetRequest, sourceActivationReadinessJobId } from "./fleet-signature.js";
import {
  SIGNATURE_HEADER,
  MIGRATION_QUIESCE_TIMEOUT_MS,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  MIGRATION_UNMOUNT_TIMEOUT_MS,
  MIGRATION_VERIFY_TIMEOUT_MS,
  isSchedulerMigrationResult,
  type ScheduleCheckRequestBody,
  type ScheduleCheckResult,
  type ScheduleRemoveRequestBody,
  type ScheduleRemoveResult,
  type ScheduleRestoreRequestBody,
  type ScheduleRestoreResult,
  type ScheduleSnapshotRequestBody,
  type ScheduleSnapshotResult,
  type ScheduleTransferRequestBody,
  type SchedulerMigrationRequestBody,
  type SchedulerMigrationResult,
  type FlushGatewayResponse,
  type HeldNativeSourceBinding,
  type HeldNativeSourceClaim,
  type HeldNativeSourceHoldAction,
  type HeldNativeSourceHoldProof,
  type HeldNativeSourceReconcileProof,
  type ImportResponse,
  type MigrationProgressRequestBody,
  type QuiesceResponse,
  type RestoreMigrationResponse,
  type UnmountResponse,
  type VerifyMigrationResponse,
} from "@octogee/shared/types/fleet-controller";
import type {
  FleetBrokerProjectCheckoutScope,
  FleetBrokerUserSnapshot,
} from "@octogee/shared/types/fleet-broker";
import type { MigrationSyncMode } from "./fleet-migration.js";

export interface MigrationClientTimeouts {
  quiesceMs?: number;
  transferMs?: number;
  unmountMs?: number;
  verifyMs?: number;
}

export interface MigrationClientDeps {
  privateKey: string;

  resolveGatewayUrl: (gatewayId: string) => string;

  fetch?: typeof globalThis.fetch;

  log?: (msg: string) => void;

  timeouts?: MigrationClientTimeouts;

  prepareAgentStores?: (gatewayId: string, slug: string) => Promise<void>;
  resolveTransferAttemptForCleanup?: (input: Parameters<MigrationClient["abortImport"]>[0]) => Promise<string | undefined>;
  transferState: MigrationClient["transferState"];
}

interface GatewayAddress {
  gatewayId: string;
  transportId?: string;
}

// `gatewayId` is the TENANT path id — bare, put in the in-pod URL path and
// matched by the pod's GATEWAY_ID guard. `transportId` defaults to the bare
// gatewayId; simple-roll has one stable Service per gateway, so tenant and
// transport are the same name (GATEWAY-SIMPLE-ROLL-SPEC).
export interface MigrationClient {
  abortImport(opts: { migrationId: string; gatewayId: string; slug: string; mode: MigrationSyncMode }): Promise<void>;
  scheduler(opts: SchedulerMigrationRequestBody & { gatewayId: string; transportId?: string }): Promise<SchedulerMigrationResult>;
  schedules(opts: ScheduleSnapshotRequestBody & GatewayAddress): Promise<ScheduleSnapshotResult>;
  schedules(opts: ScheduleRestoreRequestBody & GatewayAddress): Promise<ScheduleRestoreResult>;
  schedules(opts: ScheduleRemoveRequestBody & GatewayAddress): Promise<ScheduleRemoveResult>;
  schedules(opts: ScheduleCheckRequestBody & GatewayAddress): Promise<ScheduleCheckResult>;
  schedules(opts: ScheduleTransferRequestBody & GatewayAddress): Promise<ScheduleTransferResult>;
  sourceActivationReadiness(opts: GatewayAddress & { migrationId: string; slug: string }): Promise<"ready" | "unavailable" | "unsupported">;
  resume(opts: { migrationId: string; gatewayId: string; transportId?: string; slug: string; role?: "target" }): Promise<void>;
  quiesce(opts: {
    stopMattermost?: boolean;
    schedulerHandoff?: boolean;
    schedulerMigrationId?: string;
    retainNonportable?: boolean;
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    slug: string;
    timeoutMs?: number;
  }): Promise<QuiesceResponse>;

  flushGateway(opts: {
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    slug: string;
    reason: string;
    expectedSystemConfigCommit?: string;
  }): Promise<FlushGatewayResponse>;

  restoreTarget(opts: {
    resume?: boolean;
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    uid: string;
    slug: string;
    snapshot: FleetBrokerUserSnapshot;
  }): Promise<RestoreMigrationResponse>;

  transferState(opts: {
    migrationId: string;
    fromGatewayId: string;
    toGatewayId: string;
    fromTransportId?: string;
    toTransportId?: string;
    slug: string;
    mode?: MigrationSyncMode;
    includeActivationManifest?: boolean;
    preserveSource?: true;
    projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
    reportImport?: (status: "running" | "done" | "failed", at: number) => Promise<void>;
  }): Promise<ImportResponse>;

  verifyTarget(opts: {
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    slug: string;
  }): Promise<VerifyMigrationResponse>;

  unmount(opts: {
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    slug: string;
  }): Promise<UnmountResponse>;
}

export interface MigrationRpcErrorOptions {
  details?: unknown;
  status?: number;
  code?: string;
  retryable?: boolean;
}

export class MigrationRpcError extends Error {
  readonly details?: unknown;
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean | undefined;

  constructor(message: string, options: MigrationRpcErrorOptions = {}) {
    super(message);
    this.name = "MigrationRpcError";
    this.details = options.details;
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

export class MigrationDrainPendingError extends Error {
  readonly retryable = true;
}

export class MigrationTransportError extends Error {
  readonly retryable = true;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "MigrationTransportError";
  }
}

export function isDefinitiveConfigRpcRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const rpc = error as { status?: unknown };
  return typeof rpc.status === "number" &&
    (rpc.status === 501 ||
      rpc.status >= 400 &&
      rpc.status < 500 &&
      rpc.status !== 408 &&
      rpc.status !== 429);
}

type FetchWithTimeout = (
  label: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
) => Promise<Response>;

function createFetchWithTimeout(fetchImpl: typeof globalThis.fetch): FetchWithTimeout {
  return async (label, url, init, timeoutMs) => {
    const controller = new AbortController();
    let didTimeout = false;
    const timer = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeoutMs);
    try {
      const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
      return await fetchImpl(url, { ...init, signal });
    } catch (err) {
      if (didTimeout) {
        throw new MigrationTransportError(
          `${label} timed out after ${timeoutMs}ms (${url})`,
          { cause: err },
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new MigrationTransportError(`${label} transport failed: ${message}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  };
}

// gatewayId is the pod the call addresses: the signature is scoped to it so a pod
// cannot relay a call it received to a sibling gateway. transportId addresses the
// K8s Service (a revision), which is why the two are separate.
interface SignedGatewayPost {
  transportId: string;
  path: string;
  gatewayId: string;
  migrationId: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  jobId?: string;
  signal?: AbortSignal;
}

function createSignedGatewayPoster(deps: {
  privateKey: string;
  resolveGatewayUrl: (transportId: string) => string;
  fetchWithTimeout: FetchWithTimeout;
}): (request: SignedGatewayPost) => Promise<Response> {
  return async request => {
    const { path, timeoutMs } = request;
    const rawBody = JSON.stringify(request.body);
    const signature = signFleetRequest(
      deps.privateKey,
      request.jobId ?? gatewayScopedJobId(request.migrationId, request.gatewayId),
      rawBody,
    );
    return deps.fetchWithTimeout(
      path,
      `${deps.resolveGatewayUrl(request.transportId)}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: signature,
        },
        body: rawBody,
        ...(request.signal ? { signal: request.signal, redirect: "error" } : {}),
      },
      timeoutMs,
    );
  };
}

async function readSignedJsonResponse<Resp>(response: Response, path: string): Promise<Resp> {
  if (!response.ok) throw await migrationRpcError(path, response);
  try {
    return (await response.json()) as Resp;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MigrationTransportError(`${path} response body was incomplete: ${message}`, { cause: err });
  }
}

function isActivationReadinessAcknowledgement(value: unknown, migrationId: string, slug: string): boolean {
  if (typeof value !== "object" || value === null || Object.keys(value).length !== 3) return false;
  const reply = value as Record<string, unknown>;
  return reply.migrationId === migrationId && reply.slug === slug && reply.exportable === true;
}

async function isUnregisteredActivationReadinessRoute(response: Response, path: string): Promise<boolean> {
  if (response.status !== 404 || response.headers.get("content-type") !== "text/html; charset=utf-8" ||
      response.headers.get("x-content-type-options") !== "nosniff" ||
      response.headers.get("content-security-policy") !== "default-src 'none'") return false;
  return (await response.text()) === [
    "<!DOCTYPE html>", '<html lang="en">', "<head>", '<meta charset="utf-8">', "<title>Error</title>", "</head>",
    "<body>", `<pre>Cannot POST ${path}</pre>`, "</body>", "</html>", "",
  ].join("\n");
}

export { reconcileHeldNativeSource } from "./held-native-source-reconcile.js";

export async function requestHeldNativeSourceHold(input: {
  claim: HeldNativeSourceClaim;
  action: HeldNativeSourceHoldAction;
  sourceUrl: string;
  privateKey: string;
  gce: { projectId: string; zone: string; instanceName: string; serviceAccountEmail: string };
  fetch?: typeof globalThis.fetch;
  verifyInstanceIdentity?: VerifyGoogleIdToken;
}): Promise<HeldNativeSourceHoldProof> {
  const { claim, action } = input;
  const sourceUrl = new URL(input.sourceUrl);
  assertHeldSourceOrigin(sourceUrl);
  const { gatewayId, operationId } = claim;
  const path = `/held-native-source-hold/${action}/${encodeURIComponent(gatewayId)}`;
  const nonce = randomBytes(32).toString("hex");
  const body = { claim, nonce, expiresAt: Date.now() + (action === "acquire" ? 90_000 : 10_000) };
  const post = createSignedGatewayPoster({
    privateKey: input.privateKey,
    resolveGatewayUrl: () => sourceUrl.origin,
    fetchWithTimeout: createFetchWithTimeout((url, init) => (input.fetch ?? globalThis.fetch)(url, { ...init, redirect: "error" })),
  });
  const response = await post({ path, transportId: gatewayId, gatewayId, migrationId: `mig-${operationId}`, timeoutMs: action === "acquire" ? 90_000 : 5_000,
    jobId: heldNativeSourceHoldJobId(action, operationId, gatewayId),
    body,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Held Native source hold ${action} returned HTTP ${response.status}`);
  }
  const reply = await response.json() as { nonce?: string; hold?: HeldNativeSourceHoldProof; instanceIdentity?: string } | null;
  if (reply?.nonce !== nonce || !reply.hold || Date.now() > body.expiresAt) {
    throw new Error("Held Native source returned a stale hold acknowledgement");
  }
  const hold = validateSourceHold(reply.hold, claim, Date.now());
  if (typeof reply.instanceIdentity !== "string") throw new Error("Held Native source returned no instance attestation");
  const verify = input.verifyInstanceIdentity ?? createGoogleIdTokenVerifier();
  const payload = await verify(reply.instanceIdentity, heldNativeSourceHoldAudience(action, JSON.stringify(body), hold));
  const instance = payload && GOOGLE_TOKEN_ISSUERS.has(String(payload.iss)) && computeInstanceFromPayload(payload, input.gce);
  if (!instance || instance.instanceId !== claim.vmId || instance.zone !== input.gce.zone || instance.instanceName !== input.gce.instanceName) {
    throw new Error("Held Native source returned an unexpected GCE instance attestation");
  }
  return hold;
}

function assertHeldSourceOrigin(source: URL): void {
  const [first, second] = source.hostname.split(".").map(Number);
  const privateIPv4 = isIP(source.hostname) === 4 &&
    (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168));
  const supported = source.protocol === "https:" || (source.protocol === "http:" && privateIPv4);
  if (!supported || source.username || source.password || source.search || source.hash || source.pathname !== "/") {
    throw new Error("Held Native source hold requires HTTPS or a private Compute HTTP origin");
  }
}

function validateSourceHold(hold: HeldNativeSourceHoldProof, claim: HeldNativeSourceClaim, now: number): HeldNativeSourceHoldProof {
  const { gatewayId: sourceGatewayId, claimStartedAt: _, vmId, bootId, bootDiskId, homeDiskId, ...scope } = claim;
  if (!isDeepStrictEqual(hold.scope, { ...scope, sourceGatewayId }) ||
      !isDeepStrictEqual(hold.source, { vmId, bootId, bootDiskId, homeDiskId }) ||
      typeof hold.generation !== "string" || !/^[a-f0-9]{64}$/.test(hold.generation) ||
      !Number.isSafeInteger(hold.heldSince) || hold.heldSince <= 0 || hold.heldSince > now || !validHeldSourceStoreRoster(hold.stores)) {
    throw new Error("Held Native source returned a mismatched hold acknowledgement");
  }
  return hold;
}

function validHeldSourceStoreRoster(stores: HeldNativeSourceHoldProof["stores"]): boolean {
  if (!Array.isArray(stores) || !stores.length || stores.length > 1024) return false;
  return stores.every(store => store && typeof store.storeId === "string" && store.storeId.length > 0 &&
      typeof store.databaseIdentity === "string" && store.databaseIdentity.length > 0) &&
    new Set(stores.map(store => store.storeId)).size === stores.length;
}

export async function requestHeldNativeSourceReconcile(input: {
  binding: HeldNativeSourceBinding;
  sourceUrl: string;
  privateKey: string;
  fetch?: typeof globalThis.fetch;
}): Promise<HeldNativeSourceReconcileProof> {
  const { binding } = input;
  const { gatewayId, slug } = binding;
  const migrationId = `mig-${binding.operationId}`;
  const path = `/held-native-source-reconcile/${encodeURIComponent(gatewayId)}`;
  const nonce = randomBytes(32).toString("hex");
  const post = createSignedGatewayPoster({
    privateKey: input.privateKey,
    resolveGatewayUrl: () => input.sourceUrl,
    fetchWithTimeout: createFetchWithTimeout((url, init) => (input.fetch ?? globalThis.fetch)(url, { ...init, redirect: "error" })),
  });
  const response = await post({ path, transportId: gatewayId, gatewayId, migrationId, timeoutMs: MIGRATION_TRANSFER_TIMEOUT_MS,
    jobId: heldNativeSourceReconcileJobId(migrationId, gatewayId),
    body: { migrationId, slug, binding, nonce, expiresAt: Date.now() + 60_000 },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Held source reconciliation returned HTTP ${response.status}`);
  }
  return readHeldSourceProof(await response.json() as Record<string, unknown>, binding, nonce);
}

function readHeldSourceProof(
  reply: Record<string, unknown>, binding: HeldNativeSourceBinding, nonce: string,
): HeldNativeSourceReconcileProof {
  if (!reply) throw new Error("Held source returned an empty reconciliation proof");
  const proof = reply.proof as Partial<HeldNativeSourceReconcileProof> | undefined;
  if (reply.nonce !== nonce || reply.requestId !== binding.requestId || reply.holdGeneration !== binding.holdGeneration ||
      typeof proof?.verifiedAt !== "number" || !Number.isSafeInteger(proof.verifiedAt) || proof.verifiedAt < binding.claimStartedAt ||
      typeof proof.appliedFingerprint !== "string" || !/^[0-9a-f]{16}$/.test(proof.appliedFingerprint) ||
      typeof proof.activationManifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(proof.activationManifestSha256)) {
    throw new Error("Held source returned a mismatched reconciliation proof");
  }
  return { verifiedAt: proof.verifiedAt, appliedFingerprint: proof.appliedFingerprint, activationManifestSha256: proof.activationManifestSha256 };
}

export function createMigrationClient(deps: MigrationClientDeps): MigrationClient {
  const log = deps.log ?? (() => undefined);
  const quiesceMs = deps.timeouts?.quiesceMs ?? MIGRATION_QUIESCE_TIMEOUT_MS;
  const transferMs = deps.timeouts?.transferMs ?? MIGRATION_TRANSFER_TIMEOUT_MS;
  const unmountMs = deps.timeouts?.unmountMs ?? MIGRATION_UNMOUNT_TIMEOUT_MS;
  const verifyMs = deps.timeouts?.verifyMs ?? MIGRATION_VERIFY_TIMEOUT_MS;
  const postSigned = createSignedGatewayPoster({
    privateKey: deps.privateKey,
    resolveGatewayUrl: deps.resolveGatewayUrl,
    fetchWithTimeout: createFetchWithTimeout(deps.fetch ?? globalThis.fetch),
  });
  const postSignedJson = async <Resp>(request: SignedGatewayPost): Promise<Resp> =>
    readSignedJsonResponse(await postSigned(request), request.path);

  return {
    async abortImport({ migrationId, gatewayId, slug, mode }) {
      const transferAttemptId = await deps.resolveTransferAttemptForCleanup?.({ migrationId, gatewayId, slug, mode });
      const result = await postSignedJson<ImportResponse>({
        transportId: gatewayId, path: `/abort-rsync-import/${gatewayId}`, gatewayId, migrationId,
        body: { migrationId, slug, mode, rpcPhase: "abort-rsync-import", ...(transferAttemptId ? { transferAttemptId } : {}) }, timeoutMs: unmountMs,
      });
      if (result.migrationId !== migrationId || result.slug !== slug || result.imported !== false) {
        throw new Error("import cleanup acknowledgement mismatch");
      }
    },
    async scheduler({ gatewayId, transportId, ...body }) {
      const result = await postSignedJson<unknown>({
        transportId: transportId ?? gatewayId,
        path: `/scheduler/${gatewayId}`,
        gatewayId,
        migrationId: body.migrationId,
        body,
        timeoutMs: quiesceMs,
      });
      if (!isSchedulerMigrationResult(result, body.migrationId, body.phase) || !result.drained) {
        throw new Error(`scheduler ${body.phase} did not prove a drained matching operation`);
      }
      return result;
    },
    schedules: (async ({ gatewayId, transportId, ...body }: ScheduleTransferRequestBody & GatewayAddress) => {
      const result = await postSignedJson<ScheduleTransferResult>({
        transportId: transportId ?? gatewayId,
        path: `/schedules/${gatewayId}`,
        gatewayId,
        migrationId: body.migrationId,
        body,
        timeoutMs: quiesceMs,
      });
      if (!scheduleTransferAcknowledged(body, result)) {
        throw new Error(`schedules ${body.op} acknowledgement mismatch`);
      }
      return result;
    }) as MigrationClient["schedules"],
    async restoreTarget({ migrationId, gatewayId, transportId, uid, slug, snapshot, resume }) {
      await deps.prepareAgentStores?.(gatewayId, slug);
      const res = await postSignedJson<RestoreMigrationResponse>({
        transportId: transportId ?? gatewayId,
        path: `/${resume === true ? "resume-restore" : "restore"}/${gatewayId}`,
        gatewayId,
        migrationId,
        body: { migrationId, uid, slug, snapshot },
        timeoutMs: transferMs,
      });
      log(
        `[migration-client] ✅ restoreTarget migrationId=${migrationId} slug=${slug} gateway=${gatewayId} steps=${res.steps.join(",")}`,
      );
      return res;
    },

    async sourceActivationReadiness({ gatewayId, transportId, migrationId, slug }) {
      const path = `/source-activation-ready/${gatewayId}`;
      try {
        const response = await postSigned({
          transportId: transportId ?? gatewayId, path, gatewayId, migrationId,
          jobId: sourceActivationReadinessJobId(migrationId, gatewayId),
          body: { migrationId, slug }, timeoutMs: verifyMs, signal: AbortSignal.timeout(verifyMs),
        });
        if (await isUnregisteredActivationReadinessRoute(response, path)) return "unsupported";
        if (response.status !== 200 || !/^application\/json(?:; charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")) {
          return "unavailable";
        }
        return isActivationReadinessAcknowledgement(await response.json(), migrationId, slug) ? "ready" : "unavailable";
      } catch {
        return "unavailable";
      }
    },

    async resume({ migrationId, gatewayId, transportId, slug, role }) {
      await deps.prepareAgentStores?.(gatewayId, slug);
      const response = await postSignedJson<{ resumed: boolean }>({
        transportId: transportId ?? gatewayId, path: `/resume/${gatewayId}`,
        gatewayId, migrationId, body: { migrationId, slug, ...(role ? { role } : {}) }, timeoutMs: quiesceMs,
      });
      if (response.resumed !== true) throw new Error(`source ingress did not resume for ${slug}`);
    },

    async quiesce({ migrationId, gatewayId, transportId, slug, timeoutMs, stopMattermost, schedulerHandoff, schedulerMigrationId, retainNonportable }) {
      const handoff = schedulerHandoff
        ? { schedulerHandoff: true, schedulerMigrationId: schedulerMigrationId ?? migrationId, ...(retainNonportable ? { retainNonportable: true } : {}) }
        : {};
      const res = await postSignedJson<QuiesceResponse>({
        transportId: transportId ?? gatewayId,
        path: `/quiesce/${gatewayId}`,
        gatewayId,
        migrationId,
        body: { migrationId, slug, ...(timeoutMs == null ? {} : { timeoutMs }), ...(stopMattermost === undefined ? {} : { stopMattermost }), ...handoff },
        timeoutMs: Math.max(quiesceMs, (timeoutMs ?? MIGRATION_QUIESCE_TIMEOUT_MS) + 30_000),
      });
      if (!res.drained) {
        throw new MigrationDrainPendingError(
          `quiesce did not drain: ${res.runningCount} still running on ${gatewayId} for slug=${slug}`,
        );
      }
      log(`[migration-client] ✅ quiesce ok migrationId=${migrationId} slug=${slug}`);
      return res;
    },

    async flushGateway({
      migrationId,
      gatewayId,
      transportId,
      slug,
      reason,
      expectedSystemConfigCommit,
    }) {
      const res = await postSignedJson<FlushGatewayResponse>({
        transportId: transportId ?? gatewayId,
        path: `/flush/${gatewayId}`,
        gatewayId,
        migrationId,
        body: {
          migrationId,
          slug,
          reason,
          ...(expectedSystemConfigCommit ? { expectedSystemConfigCommit } : {}),
        },
        timeoutMs: transferMs,
      });
      log(
        `[migration-client] ✅ flushGateway migrationId=${migrationId} slug=${slug} gateway=${gatewayId} ok=${res.ok}`,
      );
      return res;
    },

    async unmount({ migrationId, gatewayId, transportId, slug }) {
      const res = await postSignedJson<UnmountResponse>({
        transportId: transportId ?? gatewayId,
        path: `/unmount/${gatewayId}`,
        gatewayId,
        migrationId,
        body: { migrationId, slug },
        timeoutMs: unmountMs,
      });
      if (res.migrationId !== migrationId || res.slug !== slug || typeof res.unmounted !== "boolean") {
        throw new Error("unmount cleanup acknowledgement mismatch");
      }
      log(
        `[migration-client] ✅ unmount migrationId=${migrationId} slug=${slug} wasMounted=${res.unmounted}`,
      );
      return res;
    },


    transferState: deps.transferState,

    async verifyTarget({ migrationId, gatewayId, transportId, slug }) {
      const res = await postSignedJson<VerifyMigrationResponse>({
        transportId: transportId ?? gatewayId,
        path: `/verify/${gatewayId}`,
        gatewayId,
        migrationId,
        body: { migrationId, slug },
        timeoutMs: verifyMs,
      });
      if (!res.ready) {
        throw new Error(
          `target verify failed on ${gatewayId} for slug=${slug}: ${JSON.stringify(res.checks)}`,
        );
      }
      log(
        `[migration-client] ✅ verifyTarget migrationId=${migrationId} slug=${slug} gateway=${gatewayId}`,
      );
      return res;
    },
  };
}

type ScheduleTransferResult = ScheduleSnapshotResult | ScheduleRestoreResult | ScheduleRemoveResult | ScheduleCheckResult;

function scheduleTransferAcknowledged(request: ScheduleTransferRequestBody, result: ScheduleTransferResult): boolean {
  if (result.migrationId !== request.migrationId || result.slug !== request.slug || result.op !== request.op) return false;
  if (result.op === "snapshot") return Array.isArray(result.records) && Array.isArray(result.skipped);
  if (result.op === "remove") return typeof result.removed === "number" && Array.isArray(result.failed);
  if (result.op === "check") return Array.isArray(result.conflicts);
  return Array.isArray(result.failed);
}

async function migrationRpcError(path: string, response: Response): Promise<MigrationRpcError> {
  const text = await response.text().catch(() => "<no body>");
  let details: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      details = parsed as Record<string, unknown>;
    }
  } catch {
    details = {};
  }
  const options: MigrationRpcErrorOptions = { status: response.status, details };
  if (typeof details.retryable === "boolean") options.retryable = details.retryable;
  if (typeof details.code === "string") options.code = details.code;
  return new MigrationRpcError(`${path}: ${response.status} ${text}`, options);
}

export async function reportMigrationProgress(
  deps: Pick<MigrationClientDeps, "privateKey" | "resolveGatewayUrl" | "fetch">,
  gatewayId: string,
  body: MigrationProgressRequestBody,
): Promise<void> {
  const post = createSignedGatewayPoster({
    privateKey: deps.privateKey,
    resolveGatewayUrl: deps.resolveGatewayUrl,
    fetchWithTimeout: createFetchWithTimeout(deps.fetch ?? globalThis.fetch),
  });
  const path = `/migration-progress/${gatewayId}`;
  const response = await post({
    transportId: gatewayId,
    path,
    gatewayId,
    migrationId: body.migrationId,
    body: { ...body },
    timeoutMs: 2_000,
  });
  await readSignedJsonResponse(response, path);
}
