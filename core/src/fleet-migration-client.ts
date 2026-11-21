

import { gatewayScopedJobId, signFleetRequest } from "./fleet-signature.js";
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
      return await fetchImpl(url, { ...init, signal: controller.signal });
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
}

function createSignedJsonPoster(deps: {
  privateKey: string;
  resolveGatewayUrl: (transportId: string) => string;
  fetchWithTimeout: FetchWithTimeout;
}): <Resp>(request: SignedGatewayPost) => Promise<Resp> {
  return async <Resp>(request: SignedGatewayPost): Promise<Resp> => {
    const { path, timeoutMs } = request;
    const rawBody = JSON.stringify(request.body);
    const signature = signFleetRequest(
      deps.privateKey,
      gatewayScopedJobId(request.migrationId, request.gatewayId),
      rawBody,
    );
    const res = await deps.fetchWithTimeout(
      path,
      `${deps.resolveGatewayUrl(request.transportId)}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: signature,
        },
        body: rawBody,
      },
      timeoutMs,
    );
    if (!res.ok) throw await migrationRpcError(path, res);
    try {
      return (await res.json()) as Resp;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new MigrationTransportError(`${path} response body was incomplete: ${message}`, {
        cause: err,
      });
    }
  };
}

export function createMigrationClient(deps: MigrationClientDeps): MigrationClient {
  const log = deps.log ?? (() => undefined);
  const quiesceMs = deps.timeouts?.quiesceMs ?? MIGRATION_QUIESCE_TIMEOUT_MS;
  const transferMs = deps.timeouts?.transferMs ?? MIGRATION_TRANSFER_TIMEOUT_MS;
  const unmountMs = deps.timeouts?.unmountMs ?? MIGRATION_UNMOUNT_TIMEOUT_MS;
  const verifyMs = deps.timeouts?.verifyMs ?? MIGRATION_VERIFY_TIMEOUT_MS;
  const postSignedJson = createSignedJsonPoster({
    privateKey: deps.privateKey,
    resolveGatewayUrl: deps.resolveGatewayUrl,
    fetchWithTimeout: createFetchWithTimeout(deps.fetch ?? globalThis.fetch),
  });

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
  const post = createSignedJsonPoster({
    privateKey: deps.privateKey,
    resolveGatewayUrl: deps.resolveGatewayUrl,
    fetchWithTimeout: createFetchWithTimeout(deps.fetch ?? globalThis.fetch),
  });
  await post({
    transportId: gatewayId,
    path: `/migration-progress/${gatewayId}`,
    gatewayId,
    migrationId: body.migrationId,
    body: { ...body },
    timeoutMs: 2_000,
  });
}
