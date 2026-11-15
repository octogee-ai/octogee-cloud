import { randomBytes, randomUUID } from "node:crypto";
import * as http from "node:http";
import { MigrationDrainPendingError } from "@octogee/core/fleet-migration-client";
import {
  type FlushGatewayResponse,
  SIGNATURE_HEADER,
  type PrepareRsyncImportResponse,
  type SchedulerMigrationResult,
} from "@octogee/shared/types/fleet-controller";
import { gatewayScopedJobId, signFleetRequest } from "@octogee/core/fleet-signature";
import { isValidUsername } from "@octogee/shared/types/identity";
import { describeFleetStateRejection, requestFleetState } from "./fleet-state-client.js";
import { parseFleetStateResponse, type GatewayFleetState } from "./gateway-heartbeat-poller.js";
import {
  SurgeGatewayScopedSignatureCapabilityMissingError,
  SurgeOpenClawProcessEndpointMissingError,
  type SurgeUserHandoffDeps,
  type SurgeFleetSignatureCapability,
  type SurgePod,
  type SurgePodHealth,
  type SurgePodSnapshot,
  type SurgePrelaunchState,
} from "./surge-user-handoff.js";

interface KubectlResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type SurgeKubectl = (args: string[], opts?: { stdin?: string; timeoutMs?: number }) => Promise<KubectlResult>;

interface PodList {
  items?: Array<{
    metadata?: {
      uid?: string;
      name?: string;
      deletionTimestamp?: string;
    };
    spec?: { containers?: Array<{ name?: string; image?: string }> };
    status?: {
      phase?: string;
      podIP?: string;
      conditions?: Array<{ type?: string; status?: string }>;
      containerStatuses?: Array<{ state?: { waiting?: { reason?: string } } }>;
    };
  }>;
}

class SurgePodControlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly body: unknown | null,
  ) {
    super(message);
  }
}

class SurgePodFleetStateError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function surgePodImage(item: NonNullable<PodList['items']>[number]): { image?: string } {
  const image = item.spec?.containers?.find(container => container.name === 'gateway')?.image;
  return image ? { image } : {};
}

export function parseSurgePodSnapshot(raw: string): SurgePodSnapshot {
  const parsed = JSON.parse(raw) as PodList;
  const observedPodUids: string[] = [];
  const pods: SurgePod[] = [];
  for (const item of parsed.items ?? []) {
    const { uid, name, deletionTimestamp } = item.metadata ?? {};
    const { phase, podIP, conditions, containerStatuses } = item.status ?? {};
    if (uid) observedPodUids.push(uid);
    if (phase !== "Running" || !uid || !name || !podIP) continue;
    pods.push({
      uid,
      name,
      podIP,
      ...surgePodImage(item),
      ready: (conditions ?? []).some((condition) =>
        condition.type === "Ready" && condition.status === "True"),
      terminating: Boolean(deletionTimestamp),
      crashLooping: (containerStatuses ?? []).some((container) =>
        container.state?.waiting?.reason === "CrashLoopBackOff"),
    });
  }
  return { pods, observedPodUids };
}

export async function listSurgePods(
  runKubectl: SurgeKubectl,
  namespace: string,
  gatewayId: string,
): Promise<SurgePodSnapshot> {
  const result = await runKubectl([
    "-n",
    namespace,
    "get",
    "pods",
    "-l",
    `app=octogee-gateway,gateway-instance=${gatewayId}`,
    "-o",
    "json",
  ]);
  if (result.code !== 0) {
    throw new Error(
      `kubectl get surge pods for ${gatewayId} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return parseSurgePodSnapshot(result.stdout);
}

export async function deleteSurgePod(
  runKubectl: SurgeKubectl,
  namespace: string,
  pod: SurgePod,
): Promise<void> {
  const result = await runKubectl(["-n", namespace, "delete", "pod", pod.name, "--wait=false"]);
  if (result.code !== 0) {
    throw new Error(
      `kubectl delete surge pod ${pod.name} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

export async function deleteCancelledSurgePod(runKubectl: SurgeKubectl, namespace: string, pod: SurgePod): Promise<void> {
  const result = await runKubectl(["-n", namespace, "delete",
    `--raw=/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod.name)}`, "-f", "-"],
  { stdin: JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid: pod.uid } }) });
  if (result.code !== 0) throw new Error(`kubectl delete cancelled surge pod ${pod.name} uid=${pod.uid} failed: ${result.stderr.trim() || result.stdout.trim()}`);
}

export async function readPodSystemConfigCommit(runKubectl: SurgeKubectl, namespace: string, pod: SurgePod): Promise<string> {
  const script = `const {execFileSync}=require("node:child_process"),path=require("node:path");const root=process.env.OPENCLAW_STATE_DIR||path.join(process.env.HOME||"/home/node",".openclaw"),repo=path.join(root,"system_config");const run=(...args)=>execFileSync("git",["-C",repo,...args],{encoding:"utf8"}).trim();if(run("status","--porcelain","--untracked-files=no"))throw Error("system config checkout has tracked changes");process.stdout.write(run("rev-parse","HEAD"));`;
  const result = await runKubectl(["-n", namespace, "exec", `pod/${pod.name}`, "-c", "gateway", "--", "node", "-e", script]);
  const commit = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error(`cannot verify system config commit on pod=${pod.name}`);
  return commit;
}

const FLEET_STATE_READ_TIMEOUT_MS = 5_000;

function podBaseUrl(pod: SurgePod): string {
  const host = pod.podIP.includes(":") ? `[${pod.podIP}]` : pod.podIP;
  return `http://${host}:3003`;
}

async function responseJson(response: Response, context: string): Promise<Record<string, unknown>> {
  return responseTextJson(response.status, await response.text(), context);
}

function responseTextJson(
  status: number,
  text: string,
  context: string,
): Record<string, unknown> {
  if (status < 200 || status >= 300) {
    let body: unknown | null = null;
    let code: string | null = null;
    try {
      body = JSON.parse(text);
      if (
        body !== null &&
        typeof body === "object" &&
        typeof (body as { code?: unknown }).code === "string"
      ) {
        code = (body as { code: string }).code;
      }
    } catch {}
    throw new SurgePodControlError(
      `${context}: ${status} ${text}`,
      status,
      code,
      body,
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${context}: invalid JSON response`);
  }
}

const SURGE_POD_CONTROL_TIMEOUT_MS = 330_000;
export const SURGE_OPENCLAW_COMPLETE_TIMEOUT_MS = 1_500_000;
const SURGE_OPENCLAW_HOLD_TIMEOUT_MS = SURGE_OPENCLAW_COMPLETE_TIMEOUT_MS;
export const SURGE_OPENCLAW_RESUME_TIMEOUT_MS = 720_000;
const SURGE_RSYNC_PREPARE_TIMEOUT_MS = SURGE_OPENCLAW_COMPLETE_TIMEOUT_MS;
export const SURGE_RSYNC_PUSH_TIMEOUT_MS = 480_000;
export const SURGE_RSYNC_FINISH_TIMEOUT_MS = 720_000;

const NATIVE_SURGE_CONTROL_TIMEOUTS: Readonly<Record<string, number>> = {
  "hold-surge-openclaw": SURGE_OPENCLAW_HOLD_TIMEOUT_MS,
  "unreserve-surge-openclaw": SURGE_OPENCLAW_HOLD_TIMEOUT_MS,
  "resume-surge-openclaw": SURGE_OPENCLAW_RESUME_TIMEOUT_MS,
  "complete-surge-handoff": SURGE_OPENCLAW_COMPLETE_TIMEOUT_MS,
  flush: SURGE_POD_CONTROL_TIMEOUT_MS,
  "prepare-rsync-import": SURGE_RSYNC_PREPARE_TIMEOUT_MS,
  "push-rsync-state": SURGE_RSYNC_PUSH_TIMEOUT_MS,
  "finish-rsync-import": SURGE_RSYNC_FINISH_TIMEOUT_MS,
};

export interface SurgeControlResponse {
  readonly statusCode?: number;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "aborted" | "end", listener: () => void): unknown;
}

export interface SurgeControlClientRequest {
  setTimeout(timeoutMs: number, onTimeout: () => void): unknown;
  destroy(error: Error): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  end(body: string): unknown;
}

export type SurgeControlRequest = (
  options: http.RequestOptions,
  onResponse: (response: SurgeControlResponse) => void,
) => SurgeControlClientRequest;

interface SignedPodRequestOptions {
  privateKey: string;
  pod: SurgePod;
  gatewayId: string;
  path: string;
  operationId: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  request: SurgeControlRequest;
}

function postSignedViaHttp(opts: SignedPodRequestOptions): Promise<Record<string, unknown>> {
  const rawBody = JSON.stringify(opts.body);
  const context = `${opts.path} pod=${opts.pod.name}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const deadline = { timer: undefined as ReturnType<typeof setTimeout> | undefined };
    const finish = (error: unknown | null, value?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      if (deadline.timer !== undefined) clearTimeout(deadline.timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const req = opts.request({
      hostname: opts.pod.podIP,
      port: 3003,
      path: `/${opts.path}/${encodeURIComponent(opts.gatewayId)}`,
      method: "POST",
      agent: false,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(rawBody),
        [SIGNATURE_HEADER]: signFleetRequest(
          opts.privateKey,
          gatewayScopedJobId(opts.operationId, opts.gatewayId),
          rawBody,
        ),
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.once("error", (error) => finish(error));
      res.once("aborted", () => finish(new Error(`${context}: response aborted`)));
      res.once("end", () => {
        try {
          finish(null, responseTextJson(res.statusCode ?? 0, text, context));
        } catch (error) {
          finish(error);
        }
      });
    });
    const timedOut = (): void => {
      const error = new Error(`${context} timed out after ${opts.timeoutMs}ms`);
      req.destroy(error);
      finish(error);
    };
    deadline.timer = setTimeout(timedOut, opts.timeoutMs);
    req.setTimeout(opts.timeoutMs, timedOut);
    req.once("error", (error) => finish(error));
    req.end(rawBody);
  });
}

function nativeSurgeControlTimeout(path: string, timeoutMs: number | undefined): number | undefined {
  const nativeTimeoutMs = NATIVE_SURGE_CONTROL_TIMEOUTS[path];
  return nativeTimeoutMs === undefined ? undefined : timeoutMs ?? nativeTimeoutMs;
}

async function postSigned(
  opts: {
    fetch: typeof globalThis.fetch;
    privateKey: string;
    pod: SurgePod;
    gatewayId: string;
    path: string;
    operationId: string;
    body: Record<string, unknown>;
    timeoutMs?: number;
    request?: SurgeControlRequest;
  },
): Promise<Record<string, unknown>> {
  const nativeTimeoutMs = nativeSurgeControlTimeout(opts.path, opts.timeoutMs);
  if (nativeTimeoutMs !== undefined) {
    return postSignedViaHttp({
      privateKey: opts.privateKey,
      pod: opts.pod,
      gatewayId: opts.gatewayId,
      path: opts.path,
      operationId: opts.operationId,
      body: opts.body,
      timeoutMs: nativeTimeoutMs,
      request: opts.request ?? http.request,
    });
  }
  const rawBody = JSON.stringify(opts.body);
  const response = await opts.fetch(
    `${podBaseUrl(opts.pod)}/${opts.path}/${encodeURIComponent(opts.gatewayId)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signFleetRequest(
          opts.privateKey,
          gatewayScopedJobId(opts.operationId, opts.gatewayId),
          rawBody,
        ),
      },
      body: rawBody,
      signal: AbortSignal.timeout(opts.timeoutMs ?? SURGE_POD_CONTROL_TIMEOUT_MS),
    },
  );
  return responseJson(response, `${opts.path} pod=${opts.pod.name}`);
}

async function readPodFleetState(
  opts: {
    fetch: typeof globalThis.fetch;
    privateKey: string;
    pod: SurgePod;
    gatewayId: string;
  },
): Promise<GatewayFleetState | null> {
  const response = await requestFleetState({
    baseUrl: podBaseUrl(opts.pod),
    gatewayId: opts.gatewayId,
    privateKey: opts.privateKey,
    timeoutMs: FLEET_STATE_READ_TIMEOUT_MS,
    fetchImpl: opts.fetch,
    newRequestId: randomUUID,
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new SurgePodFleetStateError(
      `fleet state pod=${opts.pod.name}: ${response.status} — ` +
      describeFleetStateRejection(response.status),
      response.status,
    );
  }
  const state = parseFleetStateResponse(await response.json());
  if (!state) throw new Error(`invalid fleet state response from pod=${opts.pod.name}`);
  return state;
}

export interface SurgePodTransportOptions {
  privateKey: string;
  fetch?: typeof globalThis.fetch;
  request?: SurgeControlRequest;
  randomKey?: () => string;
  log: (message: string) => void;
}

export type SurgePodTransport = Pick<
  SurgeUserHandoffDeps,
  | "reportMigrationProgress"
  | "readPodHealth"
  | "quiesce"
  | "waitForSourceIdle"
  | "scheduler"
  | "resumeSourceIngress"
  | "stopSourceOpenClaw"
  | "resumeSourceOpenClaw"
  | "holdTargetOpenClaw"
  | "unreserveTargetOpenClaw"
  | "flush"
  | "transfer"
  | "discardTargetUser"
  | "releaseTarget"
>;

const SURGE_PRELAUNCH_STATES: readonly SurgePrelaunchState[] = [
  "none",
  "held",
  "hydrated",
  "starting",
  "serving",
];

// A pod that predates the process gate omits the field; anything else must be
// a known state or the whole health read is invalid.
function parsePrelaunchState(value: unknown): SurgePrelaunchState | null {
  if (value === undefined) return "none";
  return (SURGE_PRELAUNCH_STATES as readonly unknown[]).includes(value)
    ? value as SurgePrelaunchState
    : null;
}

interface SurgePodHealthReaderOptions {
  fetch: typeof globalThis.fetch;
  privateKey: string;
  rejectedSignaturePods: ReadonlyMap<string, string>;
  reportLegacySignaturePod: (pod: SurgePod, version: string) => string;
  reportRejectedSignaturePod: (pod: SurgePod, status: number) => string;
  log: (message: string) => void;
}

async function readSurgeHealthResponses(
  fetchImpl: typeof globalThis.fetch,
  pod: SurgePod,
): Promise<{ health: Record<string, unknown>; ready: Record<string, unknown> }> {
  const [healthResponse, readyResponse] = await Promise.all([
    fetchImpl(`${podBaseUrl(pod)}/health`, { signal: AbortSignal.timeout(5_000) }),
    fetchImpl(`${podBaseUrl(pod)}/surge-ready`, { signal: AbortSignal.timeout(5_000) }),
  ]);
  return {
    health: await responseJson(healthResponse, `health pod=${pod.name}`),
    ready: await readyResponse.json() as Record<string, unknown>,
  };
}

async function resolveSurgeFleetState(input: {
  fetch: typeof globalThis.fetch;
  privateKey: string;
  pod: SurgePod;
  gatewayId: string;
  health: Record<string, unknown>;
}): Promise<{
  state: GatewayFleetState | null;
  fleetSignatureCapability: SurgeFleetSignatureCapability;
}> {
  const legacyState = parseFleetStateResponse(input.health);
  if (legacyState) {
    return { state: legacyState, fleetSignatureCapability: "legacy" };
  }
  return {
    state: await readPodFleetState(input),
    fleetSignatureCapability: "gateway-scoped",
  };
}

function optionalTerminalFlag(record: Record<string, unknown>, name: string, pod: SurgePod): boolean | undefined {
  const value = record[name];
  if (value !== undefined && typeof value !== "boolean") throw new Error(`invalid terminal target from pod=${pod.name}`);
  return value as boolean | undefined;
}

function parseTerminalTarget(value: unknown, pod: SurgePod): SurgePodHealth["terminalTarget"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid terminal target from pod=${pod.name}`);
  const record = value as Record<string, unknown>;
  if (typeof record.migrationId !== "string" || !record.migrationId || record.migrationId.length > 512 ||
      typeof record.slug !== "string" || !isValidUsername(record.slug) || record.targetPodUid !== pod.uid) {
    throw new Error(`invalid terminal target from pod=${pod.name}`);
  }
  const processHeld = optionalTerminalFlag(record, "processHeld", pod);
  const completionStarted = optionalTerminalFlag(record, "completionStarted", pod);
  return { migrationId: record.migrationId, slug: record.slug, targetPodUid: pod.uid,
    ...(processHeld !== undefined ? { processHeld } : {}),
    ...(completionStarted !== undefined ? { completionStarted } : {}) };
}

function parseSurgePodHealth(input: {
  pod: SurgePod;
  health: Record<string, unknown>;
  ready: Record<string, unknown>;
  state: GatewayFleetState | null;
  fleetSignatureCapability: SurgeFleetSignatureCapability;
  reportLegacySignaturePod: (pod: SurgePod, version: string) => string;
}): SurgePodHealth {
  const prelaunchState = parsePrelaunchState(input.ready.prelaunchState);
  const terminalTarget = parseTerminalTarget(input.ready.terminalTarget, input.pod);
  if (
    (input.health.status !== "booting" && input.health.status !== "ready") ||
    typeof input.state?.version !== "string" ||
    typeof input.ready.handoffReleased !== "boolean" ||
    typeof input.ready.openclawUp !== "boolean" ||
    prelaunchState === null
  ) {
    throw new Error(`invalid surge health response from pod=${input.pod.name}`);
  }
  if (input.fleetSignatureCapability === "legacy") {
    input.reportLegacySignaturePod(input.pod, input.state.version);
  }
  return {
    status: input.ready.openclawUp ? "ready" : "booting",
    version: input.state.version,
    fleetSignatureCapability: input.fleetSignatureCapability,
    handoffReleased: input.ready.handoffReleased,
    prelaunchState,
    ...(terminalTarget ? { terminalTarget } : {}),
    mountedCustomers: [...new Set(input.state.users)],
    ...(input.state.migratingIn ? { migratingIn: [...new Set(input.state.migratingIn)] } : {}),
  };
}

async function readSurgePodHealth(
  opts: SurgePodHealthReaderOptions,
  pod: SurgePod,
  gatewayId: string,
): Promise<SurgePodHealth | null> {
  if (opts.rejectedSignaturePods.has(pod.uid)) return null;
  try {
    const { health, ready } = await readSurgeHealthResponses(opts.fetch, pod);
    const { state, fleetSignatureCapability } = await resolveSurgeFleetState({
      fetch: opts.fetch,
      privateKey: opts.privateKey,
      pod,
      gatewayId,
      health,
    });
    return parseSurgePodHealth({
      pod,
      health,
      ready,
      state,
      fleetSignatureCapability,
      reportLegacySignaturePod: opts.reportLegacySignaturePod,
    });
  } catch (error) {
    if (
      error instanceof SurgePodFleetStateError &&
      (error.status === 401 || error.status === 403)
    ) {
      opts.reportRejectedSignaturePod(pod, error.status);
      return null;
    }
    opts.log(
      `[surge-handoff] pod=${pod.name} health unavailable: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

interface SurgeControlOptions {
  operationId: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
}

type SurgeControlCall = (
  pod: SurgePod,
  gatewayId: string,
  path: string,
  options: SurgeControlOptions,
) => Promise<Record<string, unknown>>;

export function isReleasedSurgeTargetHold(error: unknown): boolean {
  if (!(error instanceof SurgePodControlError) || error.status !== 409) return false;
  const body = error.body;
  return body !== null && typeof body === "object" &&
    "error" in body && body.error === "OpenClaw process hold failed" &&
    "message" in body && body.message === "surge OpenClaw process gate target migration already released";
}

function assertHeldTargetResponse(
  response: Record<string, unknown>,
  input: { operationId: string; slug: string; targetPod: SurgePod },
  operation: "hold" | "unreserve",
): void {
  if (response.migrationId !== input.operationId || response.slug !== input.slug ||
      response.targetPodUid !== input.targetPod.uid || response.operation !== operation ||
      response.mode !== "held" || response.phase !== "held" ||
      (response.role !== "normal" && (operation !== "hold" || response.role !== "target"))) {
    throw new Error(`target OpenClaw ${operation} did not confirm its held migration identity`);
  }
}

function assertHeldSourceResponse(response: Record<string, unknown>, input: { operationId: string; slug: string; targetPod: SurgePod }): void {
  if (response.migrationId !== input.operationId || response.slug !== input.slug || response.targetPodUid !== input.targetPod.uid ||
      response.operation !== "hold" || response.role !== "source" || response.mode !== "held" || response.phase !== "held") {
    throw new Error("source OpenClaw hold did not confirm its held migration identity");
  }
}

async function controlSurgeOpenClawProcess(
  control: SurgeControlCall,
  input: {
    pod: SurgePod;
    gatewayId: string;
    path: "hold-surge-openclaw" | "resume-surge-openclaw" | "unreserve-surge-openclaw";
    operationId: string;
    slug: string;
    targetPodUid: string;
    capability: string;
    timeoutMs?: number;
    inspectTarget?: boolean;
    reserveTarget?: boolean;
  },
): Promise<Record<string, unknown>> {
  try {
    return await control(
      input.pod,
      input.gatewayId,
      input.path,
      {
        operationId: input.operationId,
        body: {
          migrationId: input.operationId,
          slug: input.slug,
          targetPodUid: input.targetPodUid,
          receivingPodUid: input.pod.uid,
          ...(input.inspectTarget ? { inspectTarget: true } : {}),
          ...(input.reserveTarget ? { reserveTarget: true } : {}),
        },
        timeoutMs: input.timeoutMs,
      },
    );
  } catch (error) {
    if (error instanceof SurgePodControlError && error.status === 404) {
      throw new SurgeOpenClawProcessEndpointMissingError(
        `pod ${input.pod.name} lacks the required surge OpenClaw ${input.capability} endpoint`,
        { cause: error },
      );
    }
    throw error;
  }
}

interface SurgeTransferRuntime {
  control: SurgeControlCall;
  randomKey: () => string;
  log: (message: string) => void;
}

type SurgeTransferInput = Parameters<SurgeUserHandoffDeps["transfer"]>[0];

async function abortTargetImport(
  runtime: SurgeTransferRuntime,
  input: SurgeTransferInput,
  mode: "keys" | "final",
): Promise<void> {
  const { gatewayId, slug, operationId, targetPod, configTransferMode } = input;
  await runtime.control(targetPod, gatewayId, "abort-rsync-import", {
    operationId,
    body: {
      migrationId: operationId,
      slug,
      rpcPhase: "abort-rsync-import",
      mode,
      ...(mode === "final" ? { configTransferMode } : {}),
    },
  }).catch((abortError) => {
    runtime.log(
      `[surge-handoff] abort failed pod=${targetPod.name} slug=${slug}: ` +
      `${abortError instanceof Error ? abortError.message : String(abortError)}`,
    );
  });
}

async function transferMode(
  runtime: SurgeTransferRuntime,
  input: SurgeTransferInput,
  mode: "keys" | "final",
): Promise<void> {
  const { gatewayId, slug, operationId, sourcePod, targetPod, loadStrategy, configTransferMode } = input;
  const transferKey = runtime.randomKey();
  let prepared = false;
  try {
    const prepare = await runtime.control(targetPod, gatewayId, "prepare-rsync-import", {
      operationId,
      body: {
        migrationId: operationId,
        slug,
        rpcPhase: "prepare-rsync-import",
        mode,
        transferUser: "migration",
        transferKey,
        sourcePodIp: sourcePod.podIP,
        ...(mode === "final" ? { configTransferMode } : {}),
      },
    }) as unknown as PrepareRsyncImportResponse;
    prepared = true;
    if (!Number.isInteger(prepare.port) || prepare.port <= 0) {
      throw new Error(`target pod ${targetPod.name} returned invalid rsync port`);
    }
    if (typeof prepare.certificatePem !== "string" || prepare.certificatePem.length === 0) {
      throw new Error(`target pod ${targetPod.name} did not return a migration TLS certificate`);
    }
    await runtime.control(sourcePod, gatewayId, "push-rsync-state", {
      operationId,
      body: {
        migrationId: operationId,
        slug,
        rpcPhase: "push-rsync-state",
        mode,
        targetHost: targetPod.podIP,
        targetPort: prepare.port,
        targetCertificatePem: prepare.certificatePem,
        transferUser: "migration",
        transferKey,
        ...(mode === "final"
          ? {
            configTransferMode,
            ...(configTransferMode === "activation-manifest" ? { includeActivationManifest: true } : {}),
          }
          : {}),
      },
    });
    await runtime.control(targetPod, gatewayId, "finish-rsync-import", {
      operationId,
      body: {
        migrationId: operationId,
        slug,
        rpcPhase: "finish-rsync-import",
        mode,
        ...(mode === "final" ? { loadStrategy, configTransferMode } : {}),
      },
    });
  } catch (error) {
    if (prepared) await abortTargetImport(runtime, input, mode);
    throw error;
  }
}

async function transferUserState(
  runtime: SurgeTransferRuntime,
  input: SurgeTransferInput,
): Promise<void> {
  const { gatewayId, slug, operationId, targetPod, configTransferMode, expectedSystemConfigCommit } = input;
  if (configTransferMode === "configured-builder-system-config" && !expectedSystemConfigCommit) {
    throw new Error(`configured user transfer is missing system config commit for ${slug}`);
  }
  await transferMode(runtime, input, "keys");
  if (configTransferMode === "configured-builder-system-config") {
    try {
      await runtime.control(targetPod, gatewayId, "flush", {
        operationId,
        body: {
          migrationId: operationId,
          slug,
          reason: "migration-converge",
          expectedSystemConfigCommit: expectedSystemConfigCommit!,
        },
      });
    } catch (error) {
      await abortTargetImport(runtime, input, "final");
      throw error;
    }
  }
  await transferMode(runtime, input, "final");
}

async function quiesceSurgeSource(
  control: SurgeControlCall,
  { gatewayId, slug, operationId, sourcePod }: Parameters<SurgeUserHandoffDeps["quiesce"]>[0],
): Promise<void> {
  const response = await control(sourcePod, gatewayId, "quiesce", {
    operationId,
    body: { migrationId: operationId, slug, timeoutMs: 30_000, stopMattermost: false },
  });
  if (response.drained === false) throw new MigrationDrainPendingError(
    `quiesce still active on ${gatewayId} for slug=${slug}: ${response.runningCount} running`,
  );
  if (response.drained !== true) throw new Error(`invalid quiesce response from pod=${sourcePod.name}`);
}

async function migrateSurgeScheduler(
  control: SurgeControlCall,
  { gatewayId, pod, operationId, ...body }: Parameters<NonNullable<SurgeUserHandoffDeps["scheduler"]>>[0],
): Promise<SchedulerMigrationResult> {
  const response = await control(pod, gatewayId, "scheduler", {
    operationId,
    body: { ...body, migrationId: operationId },
  }) as unknown as SchedulerMigrationResult;
  if (response.operationId !== operationId || response.phase !== body.phase ||
      !Array.isArray(response.agentIds) || response.agentIds.some(id => typeof id !== "string" || !id) ||
      (response.agentIds.length === 0 && body.phase !== "resume" && body.phase !== "abort") ||
      response.drained !== true || (body.phase === "export" && response.snapshot === undefined)) {
    throw new Error(`scheduler ${body.phase} did not prove a drained matching operation on pod=${pod.name}`);
  }
  return response;
}

export function createSurgePodTransport(opts: SurgePodTransportOptions): SurgePodTransport {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const randomKey = opts.randomKey ?? (() => randomBytes(32).toString("hex"));
  const legacySignaturePods = new Map<string, { version: string; message: string }>();
  const rejectedSignaturePods = new Map<string, string>();

  const legacySignatureMessage = (pod: SurgePod, version: string): string =>
    `pod=${pod.name} version=${version} predates the gateway-scoped fleet signature protocol; ` +
    "roll the pod before starting a surge handoff";
  const rejectedSignatureMessage = (pod: SurgePod, status: number): string =>
    `pod=${pod.name} rejected the gateway-scoped fleet signature with HTTP ${status}; ` +
    "the pod's fleet key does not match the fleet controller's signing key; repair the key or roll the pod " +
    "before starting a surge handoff";
  const reportLegacySignaturePod = (pod: SurgePod, version: string): string => {
    const message = legacySignatureMessage(pod, version);
    const previous = legacySignaturePods.get(pod.uid);
    legacySignaturePods.set(pod.uid, { version, message });
    if (!previous || previous.version !== version) opts.log(`[surge-handoff] ${message}`);
    return message;
  };
  const reportRejectedSignaturePod = (pod: SurgePod, status: number): string => {
    const message = rejectedSignatureMessage(pod, status);
    if (!rejectedSignaturePods.has(pod.uid)) opts.log(`[surge-handoff] ${message}`);
    rejectedSignaturePods.set(pod.uid, message);
    return message;
  };
  const assertGatewayScopedSignatureCapability = (pod: SurgePod): void => {
    const legacy = legacySignaturePods.get(pod.uid);
    const rejected = rejectedSignaturePods.get(pod.uid);
    if (legacy) throw new SurgeGatewayScopedSignatureCapabilityMissingError(legacy.message);
    if (rejected) throw new SurgeGatewayScopedSignatureCapabilityMissingError(rejected);
  };

  const control = async (
    pod: SurgePod,
    gatewayId: string,
    path: string,
    controlOptions: SurgeControlOptions,
  ): Promise<Record<string, unknown>> => {
    assertGatewayScopedSignatureCapability(pod);
    try {
      return await postSigned({
        fetch: fetchImpl,
        privateKey: opts.privateKey,
        pod,
        gatewayId,
        path,
        operationId: controlOptions.operationId,
        body: controlOptions.body,
        timeoutMs: controlOptions.timeoutMs,
        request: opts.request,
      });
    } catch (error) {
      if (
        error instanceof SurgePodControlError &&
        (error.status === 401 || error.status === 403)
      ) {
        throw new SurgeGatewayScopedSignatureCapabilityMissingError(
          reportRejectedSignaturePod(pod, error.status),
        );
      }
      throw error;
    }
  };

  return {
    reportMigrationProgress: ({ gatewayId, targetPod, event }) => control(targetPod, gatewayId, "migration-progress", {
      operationId: event.migrationId,
      body: { ...event },
      timeoutMs: 2_000,
    }),
    readPodHealth: (pod, gatewayId) => readSurgePodHealth({
      fetch: fetchImpl,
      privateKey: opts.privateKey,
      rejectedSignaturePods,
      reportLegacySignaturePod,
      reportRejectedSignaturePod,
      log: opts.log,
    }, pod, gatewayId),

    scheduler: input => migrateSurgeScheduler(control, input),

    quiesce: (input) => quiesceSurgeSource(control, input),
    waitForSourceIdle: (input) => quiesceSurgeSource(control, input),
    async resumeSourceIngress({ gatewayId, slug, operationId, sourcePod }) {
      const response = await control(sourcePod, gatewayId, "resume", {
        operationId, body: { migrationId: operationId, slug },
      });
      if (response.resumed !== true) throw new Error(`source admission did not resume for ${slug} on pod=${sourcePod.name}`);
    },

    async stopSourceOpenClaw({ gatewayId, slug, operationId, sourcePod, targetPod }) {
      const response = await controlSurgeOpenClawProcess(control, {
        pod: sourcePod,
        gatewayId,
        path: "hold-surge-openclaw",
        operationId,
        slug,
        targetPodUid: targetPod.uid,
        capability: "hold",
      });
      assertHeldSourceResponse(response, { operationId, slug, targetPod });
    },

    async resumeSourceOpenClaw({ gatewayId, slug, operationId, sourcePod, targetPod }) {
      await controlSurgeOpenClawProcess(control, {
        pod: sourcePod,
        gatewayId,
        path: "resume-surge-openclaw",
        operationId,
        slug,
        targetPodUid: targetPod.uid,
        capability: "resume",
        timeoutMs: SURGE_OPENCLAW_RESUME_TIMEOUT_MS,
      });
    },

    async holdTargetOpenClaw({ gatewayId, slug, operationId, targetPod, inspectTarget, reserveTarget }) {
      const response = await controlSurgeOpenClawProcess(control, {
        pod: targetPod,
        gatewayId,
        path: "hold-surge-openclaw",
        operationId,
        slug,
        targetPodUid: targetPod.uid,
        capability: "reserve",
        inspectTarget, reserveTarget,
      });
      assertHeldTargetResponse(response, { operationId, slug, targetPod }, "hold");
      return typeof response.completionStarted === "boolean" ? { completionStarted: response.completionStarted } : undefined;
    },

    async unreserveTargetOpenClaw({ gatewayId, slug, operationId, targetPod }) {
      const response = await controlSurgeOpenClawProcess(control, {
        pod: targetPod,
        gatewayId,
        path: "unreserve-surge-openclaw",
        operationId,
        slug,
        targetPodUid: targetPod.uid,
        capability: "unreserve",
      });
      assertHeldTargetResponse(response, { operationId, slug, targetPod }, "unreserve");
    },

    async flush({
      gatewayId,
      slug,
      operationId,
      pod,
      reason,
      expectedSystemConfigCommit,
    }) {
      const response = await control(pod, gatewayId, "flush", {
        operationId,
        body: {
          migrationId: operationId,
          slug,
          reason,
          ...(expectedSystemConfigCommit ? { expectedSystemConfigCommit } : {}),
        },
      }) as unknown as FlushGatewayResponse;
      return {
        ...(typeof response.systemConfigCommit === "string"
          ? { systemConfigCommit: response.systemConfigCommit }
          : {}),
      };
    },

    transfer: (input) => transferUserState({
      control,
      randomKey,
      log: opts.log,
    }, input),
    async discardTargetUser({ gatewayId, slug, operationId, targetPod }) {
      const unmount = () => control(
        targetPod,
        gatewayId,
        "unmount",
        {
          operationId,
          body: {
            migrationId: operationId,
            slug,
          },
        },
      );
      try {
        await unmount();
      } catch (error) {
        if (!(error instanceof SurgePodControlError) || error.code !== "hash-mismatch") {
          throw error;
        }
        opts.log(
          `[surge-handoff] target cleanup lost config CAS pod=${targetPod.name} slug=${slug}; retrying signed unmount once`,
        );
        await unmount();
      }
    },

    async releaseTarget({ gatewayId, operationId, pod }) {
      await control(pod, gatewayId, "complete-surge-handoff", {
        operationId,
        body: {
          migrationId: operationId,
          targetPodUid: pod.uid,
        },
        timeoutMs: SURGE_OPENCLAW_COMPLETE_TIMEOUT_MS,
      });
    },
  };
}
