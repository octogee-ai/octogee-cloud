import { Agent, fetch as undiciFetch } from "undici";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import type { GatewayVmAddress } from "./gateway-address.js";
import { gatewayVmPodName } from "@octogee/shared/types/glm";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { assertTransferClaim, claimTransferTask, controllerPodIdentity, finishTransferTask, type ControllerPodIdentity, type TransferClaim } from "./migration-transfer-lease.js";
import {
  type FinishRsyncImportRequestBody,
  type ImportResponse,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  MIGRATION_IMPORT_FINISH_TIMEOUT_MS,
  MIGRATION_TRANSFER_LEASE_MS,
  type PrepareRsyncImportRequestBody,
  type PrepareRsyncImportResponse,
  type PushRsyncStateRequestBody,
  SIGNATURE_HEADER,
} from "@octogee/shared/types/fleet-controller";
import { isUserActivateOperationIdFor } from "@octogee/core/isolated-operation-ids";
import type { MigrationSyncMode } from "@octogee/core/fleet-migration";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import { gatewayScopedJobId, signFleetRequest } from "@octogee/core/fleet-signature";
import { withLogContext } from "@octogee/shared/server/service-logger";

const DEFAULT_LEASE_MS = MIGRATION_TRANSFER_LEASE_MS;
const controlDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const DEFAULT_WORKER_ID = `glm-${randomUUID()}`;
const MIGRATION_TRANSFER_USER = "migration";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<CommandResult>;

import type { RetainedSourceTransfer } from './retained-source-transfer.js';

export interface RSyncMigrationTransferDeps {
  prepareAgentStores?: (gatewayId: string, slug: string) => Promise<void>;
  retainedSource?: RetainedSourceTransfer;
  store: PlatformStateStore;
  namespace: string;
  privateKey: string;
  fleetControllerPort: string;
  resolveGatewayUrl: (gatewayId: string) => string;
  resolveGatewayVm?: (transportId: string) => Promise<GatewayVmAddress | null>;
  wait?: (ms: number) => Promise<void>;
  runCommand?: CommandRunner;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  workerId?: string;
  controllerPod?: ControllerPodIdentity;
  leaseMs?: number;
  log?: (msg: string) => void;
}

// Extracted to module scope so the per-event `() => resolve(...)` arrows sit
// at a shallow nesting depth (the inline Promise executor put them 5 levels
// deep). Behaviour is identical — settle() still de-dupes the first outcome.
function runSubprocess(
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
  resolve: (result: CommandResult) => void,
  reject: (err: Error) => void,
): void {
  const proc = spawn(command, args, {
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timeout: NodeJS.Timeout | null = null;
  const settle = (action: () => void): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    action();
  };
  if (opts.timeoutMs) {
    timeout = setTimeout(() => {
      stderr += `\n${command} timed out after ${opts.timeoutMs}ms`;
      proc.kill("SIGTERM");
      settle(() => resolve({ stdout, stderr, code: 124 }));
    }, opts.timeoutMs);
  }

  proc.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  proc.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  proc.on("error", (err) => {
    settle(() => reject(err));
  });
  proc.on("close", (code, signal) => {
    if (signal != null) {
      settle(() =>
        resolve({ stdout, stderr: `${stderr}\n${command} terminated by ${signal}`, code: 128 }),
      );
      return;
    }
    settle(() => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

export function createSubprocessCommandRunner(): CommandRunner {
  return (command, args, opts = {}) =>
    new Promise<CommandResult>((resolve, reject) => runSubprocess(command, args, opts, resolve, reject));
}

export function migrationTransferTaskId(input: {
  migrationId: string;
  mode?: MigrationSyncMode;
}): string {
  const mode = input.mode ?? "pre";
  return `${sanitizeDocId(input.migrationId)}__${mode}`;
}

function sanitizeDocId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

const VM_READY_TIMEOUT_MS = 60_000;
const VM_READY_POLL_MS = 2_000;

async function waitForTargetVmReady(
  fetchImpl: typeof globalThis.fetch,
  wait: (ms: number) => Promise<void>,
  now: () => number,
  target: { name: string; baseUrl: string },
): Promise<void> {
  const deadline = now() + VM_READY_TIMEOUT_MS;
  let lastStatus = "unreachable";
  while (now() < deadline) {
    try {
      const res = await fetchImpl(`${target.baseUrl}/surge-ready`);
      if (res.ok) return;
      lastStatus = `HTTP ${res.status}`;
    } catch (err) {
      lastStatus = err instanceof Error ? err.message : String(err);
    }
    await wait(VM_READY_POLL_MS);
  }
  throw new Error(`migration target ${target.name} did not become Ready: ${lastStatus}`);
}

async function waitForTargetPodReady(
  runCommand: CommandRunner,
  namespace: string,
  podName: string,
): Promise<void> {
  const result = await runCommand("kubectl", [
    "-n", namespace, "wait", "--for=condition=Ready", `pod/${podName}`, "--timeout=60s",
  ], { timeoutMs: 65_000 });
  if (result.code !== 0) {
    throw new Error(`migration target ${podName} did not become Ready: ${result.stderr || result.stdout}`);
  }
}

async function postSignedJson<Resp>(
  deps: {
    fetchImpl: typeof globalThis.fetch;
    privateKey: string;
    resolveGatewayUrl: (gatewayId: string) => string;
  },
  opts: {
    transportId: string;
    baseUrl?: string;
    path: string;
    gatewayId: string;
    migrationId: string;
    body: Record<string, unknown>;
  },
): Promise<Resp> {
  const rawBody = JSON.stringify(opts.body);
  const signature = signFleetRequest(deps.privateKey, gatewayScopedJobId(opts.migrationId, opts.gatewayId), rawBody);
  const url = `${opts.baseUrl ?? deps.resolveGatewayUrl(opts.transportId)}${opts.path}`;
  const timeoutMs = opts.path.startsWith("/finish-rsync-import/")
    ? MIGRATION_IMPORT_FINISH_TIMEOUT_MS : MIGRATION_TRANSFER_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${opts.path} timed out after ${timeoutMs}ms`)), timeoutMs);
  const init = {
    method: "POST", headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature },
    body: rawBody, signal: controller.signal,
  };
  try {
    const res = deps.fetchImpl === globalThis.fetch
      ? await undiciFetch(url, { ...init, dispatcher: controlDispatcher })
      : await deps.fetchImpl(url, init);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${opts.path}: ${res.status} ${text}`);
    }
    return await res.json() as Resp;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

interface PodList {
  items?: Array<{
    metadata?: { name?: string; uid?: string; deletionTimestamp?: string };
    status?: {
      phase?: string;
      podIP?: string;
      conditions?: Array<{ type?: string; status?: string }>;
    };
  }>;
}

async function assertTargetTransferFencing(fetchImpl: typeof globalThis.fetch, baseUrl: string, name: string): Promise<void> {
  const health = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
  if (!health.ok || (await health.json() as { rsyncAttemptFencing?: unknown }).rsyncAttemptFencing !== true) {
    throw new Error(`migration target ${name} does not support fenced transfer attempts: status 503`);
  }
}

function userActivationGeneration(migrationId: unknown, gatewayId: string): number | undefined {
  if (typeof migrationId !== "string" || !migrationId.startsWith("mig-") ||
      !isUserActivateOperationIdFor(migrationId.slice(4), gatewayId)) return undefined;
  const generation = Number(migrationId.slice(migrationId.lastIndexOf("-g") + 2));
  return Number.isSafeInteger(generation) ? generation : undefined;
}

async function assertFinalImportNotReleased(fetchImpl: typeof globalThis.fetch, baseUrl: string, input: { migrationId: string; slug: string; toGatewayId: string }, targetUid?: string): Promise<void> {
  const response = await fetchImpl(`${baseUrl}/surge-ready`, { signal: AbortSignal.timeout(5_000) });
  if (response.status !== 200 && response.status !== 503) throw new Error(`migration target readiness inspection failed: status ${response.status}`);
  const state = await response.json() as { terminalTarget?: unknown };
  if (state.terminalTarget === undefined) return;
  const terminal = state.terminalTarget as Record<string, unknown> | null;
  if (!terminal || typeof terminal !== "object" || !targetUid || terminal.targetPodUid !== targetUid ||
      terminal.slug !== input.slug) {
    throw new Error("migration target terminal identity does not match the reclaimed transfer");
  }
  if (terminal.migrationId === input.migrationId) {
    throw new Error(`target import already released for migration ${input.migrationId} on ${input.toGatewayId}`);
  }
  const previous = userActivationGeneration(terminal.migrationId, input.toGatewayId);
  const current = userActivationGeneration(input.migrationId, input.toGatewayId);
  if ((response.ok || terminal.processHeld === true) && previous !== undefined && current !== undefined && previous < current) return;
  throw new Error("migration target terminal identity does not match the reclaimed transfer");
}

async function inspectReclaimedFinalImport(lease: { store: PlatformStateStore; claim: TransferClaim }, fetchImpl: typeof globalThis.fetch, baseUrl: string, input: { migrationId: string; slug: string; toGatewayId: string; mode: MigrationSyncMode }, targetUid?: string): Promise<void> {
  await assertTransferClaim(lease.store, lease.claim);
  if (input.mode !== "final" || lease.claim.attempt <= 1) return;
  await assertFinalImportNotReleased(fetchImpl, baseUrl, input, targetUid);
  await assertTransferClaim(lease.store, lease.claim);
}

async function resolveRunningGatewayPod(params: {
  namespace: string;
  transportId: string;
  runCommand: CommandRunner;
  requireReady: boolean;
}): Promise<{ name: string; podIP: string; uid?: string }> {
  const selector = `app=octogee-gateway,gateway-instance=${params.transportId}`;
  const result = await params.runCommand("kubectl", [
    "-n",
    params.namespace,
    "get",
    "pods",
    "-l",
    selector,
    "-o",
    "json",
  ]);
  if (result.code !== 0) {
    throw new Error(
      `kubectl get pods transport=${params.transportId} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as PodList;
  const running = (parsed.items ?? []).filter((item) => {
    if (!item.metadata?.name || !item.status?.podIP || item.metadata.deletionTimestamp) return false;
    if (item.status?.phase !== "Running") return false;
    return true;
  });
  const ready = running.filter((item) => (item.status?.conditions ?? []).some(
    (condition) => condition.type === "Ready" && condition.status === "True",
  ));
  const selectionRequiresReady = params.requireReady || running.length > 1;
  const candidates = selectionRequiresReady ? ready : running;
  if (candidates.length !== 1) {
    const state = selectionRequiresReady ? "ready" : "running";
    throw Object.assign(
      new Error(
        `expected exactly one ${state} pod for transport=${params.transportId}; found ${candidates.length}`,
      ),
      { retryable: true },
    );
  }
  const item = candidates[0];
  return { name: item.metadata!.name!, podIP: item.status!.podIP!, uid: item.metadata!.uid };
}

interface GatewayEndpoint {
  name: string;
  podIP: string;
  vm: boolean;
  uid?: string;
}

async function resolveGatewayEndpoint(params: {
  namespace: string;
  transportId: string;
  runCommand: CommandRunner;
  requireReady: boolean;
  resolveGatewayVm?: (transportId: string) => Promise<GatewayVmAddress | null>;
}): Promise<GatewayEndpoint> {
  const vm = params.resolveGatewayVm ? await params.resolveGatewayVm(params.transportId) : null;
  if (vm) return { name: vm.instanceName, podIP: vm.internalIp, vm: true,
    ...(vm.instanceId ? { uid: gatewayVmPodName(params.transportId, vm.instanceId) } : {}) };
  const pod = await resolveRunningGatewayPod(params);
  return { ...pod, vm: false };
}

function podBaseUrl(podIP: string, port: string): string {
  const host = podIP.includes(":") ? `[${podIP}]` : podIP;
  return `http://${host}:${port}`;
}

export async function resolveMigrationRecoveryUrl(params: {
  namespace: string;
  gatewayId: string;
  port: string;
  runCommand: CommandRunner;
  resolveGatewayVm: (gatewayId: string) => Promise<GatewayVmAddress | null>;
}): Promise<string> {
  const target = await resolveGatewayEndpoint({
    namespace: params.namespace,
    transportId: params.gatewayId,
    runCommand: params.runCommand,
    requireReady: false,
    resolveGatewayVm: params.resolveGatewayVm,
  });
  return podBaseUrl(target.podIP, params.port);
}

function requireTargetCertificate(prepared: PrepareRsyncImportResponse, target: string): string {
  if (typeof prepared.certificatePem !== "string" || prepared.certificatePem.length === 0) {
    throw new Error(`target ${target} did not return a migration TLS certificate`);
  }
  return prepared.certificatePem;
}

export async function abortRetainedSourceImport(
  deps: RSyncMigrationTransferDeps,
  input: {migrationId:string;slug:string;toGatewayId:string},
): Promise<void> {
  const retained=deps.retainedSource;
  if (!retained) throw new Error('retained source cleanup unavailable');
  const observed=await retained.observe();
  if (!observed || observed.targetCleanup==='complete' || (observed.status==='failed' && observed.targetCleanup===undefined)) return;
  if (observed.status!=='failed' && observed.status!=='transferred') throw new Error('source transfer observation pending');
  const target=await resolveGatewayEndpoint({namespace:deps.namespace,transportId:input.toGatewayId,runCommand:deps.runCommand ?? createSubprocessCommandRunner(),requireReady:false,resolveGatewayVm:deps.resolveGatewayVm});
  const record=await retained.settledTarget(target);
  if (!record) return;
  const response=await postSignedJson<ImportResponse>({fetchImpl:deps.fetch ?? globalThis.fetch,privateKey:deps.privateKey,resolveGatewayUrl:deps.resolveGatewayUrl},{transportId:input.toGatewayId,gatewayId:input.toGatewayId,migrationId:input.migrationId,path:`/abort-rsync-import/${input.toGatewayId}`,baseUrl:podBaseUrl(target.podIP,deps.fleetControllerPort),body:{migrationId:input.migrationId,slug:input.slug,mode:'final',rpcPhase:'abort-rsync-import'}});
  if (response.migrationId!==input.migrationId || response.slug!==input.slug || response.imported!==false) throw new Error('retained source cleanup acknowledgement mismatch');
  await retained.acknowledgeCleanup(record);
}

type TransferInput = Parameters<MigrationClient["transferState"]>[0];

function measureTransfer(input: TransferInput, now: () => number, log: (message: string) => void) {
  return async function measure<T>(phase: string, gatewayId: string, work: () => Promise<T>): Promise<T> {
    const report = phase === "target-import-and-activation" ? input.reportImport : undefined;
    const startedAt = now();
    const notify = async (status: "running" | "done" | "failed", at: number): Promise<void> => {
      withLogContext({
        category: "migration-transfer", migrationId: input.migrationId, builderSlug: input.slug,
        gatewayId, sourceGateway: input.fromGatewayId, targetGateway: input.toGatewayId,
        phase, mode: input.mode ?? "pre", status,
        ...(status === "running" ? {} : { durationMs: Math.max(0, at - startedAt) }),
      }, () => log(status === "failed" ? "🔴 [migration-rsync] Phase failed" : "[migration-rsync] Phase progress"));
      await report?.(status, at);
    };
    await notify("running", startedAt);
    let result: T;
    try {
      result = await work();
    } catch (error) {
      await notify("failed", now());
      throw error;
    }
    await notify("done", now());
    return result;
  };
}

export function createRsyncMigrationTransfer(
  deps: RSyncMigrationTransferDeps,
): MigrationClient["transferState"] {
  const runCommand = deps.runCommand ?? createSubprocessCommandRunner();
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());
  const workerId = deps.workerId ?? DEFAULT_WORKER_ID;
  const controllerPod = deps.controllerPod ?? controllerPodIdentity(process.env);
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const log = deps.log ?? (() => undefined);
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const control = <Resp>({ pathSuffix, ...options }: {
    transportId: string;
    gatewayId: string;
    pathSuffix: string;
    migrationId: string;
    body: Record<string, unknown>;
    baseUrl?: string;
  }) =>
    postSignedJson<Resp>(
      { fetchImpl, privateKey: deps.privateKey, resolveGatewayUrl: deps.resolveGatewayUrl },
      { ...options, path: `${pathSuffix}/${options.gatewayId}` },
    );

  async function transferRetained(input: TransferInput): Promise<ImportResponse> {
    const retainedSource = deps.retainedSource;
    if (!retainedSource) throw new Error("retained source transport unavailable");
    const mode = "final";
    const measure = measureTransfer(input, now, log);
    const toTransportId = input.toTransportId ?? input.toGatewayId;
      const target = await resolveGatewayEndpoint({namespace:deps.namespace,transportId:toTransportId,runCommand,requireReady:false,resolveGatewayVm:deps.resolveGatewayVm});
      const record = await measure("retained-source-export-and-transfer", input.fromGatewayId, () => retainedSource.execute({target,prepare: async sourcePodIp => {
        const transferKey = randomBytes(32).toString("hex");
        const prepared = await control<PrepareRsyncImportResponse>({transportId:toTransportId,gatewayId:input.toGatewayId,pathSuffix:"/prepare-rsync-import",migrationId:input.migrationId,body:{migrationId:input.migrationId,slug:input.slug,rpcPhase:"prepare-rsync-import",mode,transferUser:MIGRATION_TRANSFER_USER,transferKey,sourcePodIp},baseUrl:podBaseUrl(target.podIP,deps.fleetControllerPort)});
        return {migrationId:input.migrationId,slug:input.slug,rpcPhase:"push-rsync-state",mode:"final",targetHost:target.podIP,targetPort:prepared.port,targetCertificatePem:requireTargetCertificate(prepared,target.name),transferUser:MIGRATION_TRANSFER_USER,transferKey,includeActivationManifest:input.includeActivationManifest};
      }}));
      if (record.targetGatewayId !== input.toGatewayId || record.targetName !== target.name || record.targetIp !== target.podIP || record.targetVm !== target.vm) throw new Error("retained transfer target changed");
      const baseUrl = podBaseUrl(record.targetIp,deps.fleetControllerPort);
      await retainedSource.settledTarget(target);
      await retainedSource.assertActiveClaim();
      if (deps.prepareAgentStores) await measure("target-agent-store-handoff", input.toGatewayId, () => deps.prepareAgentStores!(input.toGatewayId, input.slug));
      const finished = await measure("target-import-and-activation", input.toGatewayId, () => control<ImportResponse>({transportId:toTransportId,gatewayId:input.toGatewayId,pathSuffix:"/finish-rsync-import",migrationId:input.migrationId,body:{migrationId:input.migrationId,slug:input.slug,rpcPhase:"finish-rsync-import",mode},baseUrl}));
      await measure("target-readiness", input.toGatewayId, () => target.vm
        ? waitForTargetVmReady(fetchImpl,wait,now,{name:target.name,baseUrl})
        : waitForTargetPodReady(runCommand,deps.namespace,target.name));
      return finished;
  }

  return async (input) => {
    const mode = input.mode ?? "pre";
    const measure = measureTransfer(input, now, log);
    const fromTransportId = input.fromTransportId ?? input.fromGatewayId;
    const toTransportId = input.toTransportId ?? input.toGatewayId;
    if (deps.retainedSource && mode === "final") return transferRetained(input);
    const transferKey = randomBytes(32).toString("hex");
    let recoveryTarget: GatewayEndpoint | undefined;
    const resolveTarget = async () => recoveryTarget ?? resolveGatewayEndpoint({
      namespace: deps.namespace, transportId: toTransportId, runCommand, requireReady: false, resolveGatewayVm: deps.resolveGatewayVm,
    });
    const claimed = await claimTransferTask(
      { store: deps.store, now, workerId, leaseMs, namespace: deps.namespace, runCommand, controllerPod, log,
        beforeRecovery: async () => {
          recoveryTarget = await resolveTarget();
          await assertTargetTransferFencing(fetchImpl, podBaseUrl(recoveryTarget.podIP, deps.fleetControllerPort), recoveryTarget.name);
        },
      },
      migrationTransferTaskId({ ...input, mode }),
      { ...input, mode },
    );

    let targetPrepareAttempted = false;
    let targetPod: GatewayEndpoint | undefined;
    try {
      const [sourcePod, resolvedTargetPod] = await Promise.all([
        resolveGatewayEndpoint({
          namespace: deps.namespace,
          transportId: fromTransportId,
          runCommand,
          requireReady: true,
          resolveGatewayVm: deps.resolveGatewayVm,
        }),
        resolveTarget(),
      ]);
      targetPod = resolvedTargetPod;
      const targetBaseUrl = podBaseUrl(targetPod.podIP, deps.fleetControllerPort);
      await inspectReclaimedFinalImport({ store: deps.store, claim: claimed }, fetchImpl, targetBaseUrl, { ...input, mode }, targetPod.uid);
      const prepareBody: PrepareRsyncImportRequestBody = {
        transferAttempt: claimed.attempt,
        transferAttemptId: claimed.attemptId,
        migrationId: input.migrationId,
        slug: input.slug,
        rpcPhase: "prepare-rsync-import",
        mode,
        transferUser: MIGRATION_TRANSFER_USER,
        transferKey,
        sourcePodIp: sourcePod.podIP,
      };
      targetPrepareAttempted = true;
      const prepared = await measure("target-import-preparation", input.toGatewayId, () => control<PrepareRsyncImportResponse>({
        transportId: toTransportId,
        gatewayId: input.toGatewayId,
        pathSuffix: "/prepare-rsync-import",
        migrationId: input.migrationId,
        body: prepareBody as unknown as Record<string, unknown>,
        baseUrl: targetBaseUrl,
      }));
      log(
        `[migration-rsync] task=${claimed.taskId} attempt=${claimed.attempt} mode=${mode} ${input.fromGatewayId}/${sourcePod.name} → ${input.toGatewayId}/${targetPod.name} target=${targetPod.podIP}:${prepared.port}`,
      );
      await assertTransferClaim(deps.store, claimed);
      const pushBody: PushRsyncStateRequestBody = {
        migrationId: input.migrationId,
        slug: input.slug,
        rpcPhase: "push-rsync-state",
        mode,
        targetHost: targetPod.podIP,
        targetPort: prepared.port,
        targetCertificatePem: requireTargetCertificate(prepared, targetPod.name),
        transferUser: MIGRATION_TRANSFER_USER,
        transferKey,
        includeActivationManifest: input.includeActivationManifest,
      };
      await measure("source-export-and-transfer", input.fromGatewayId, () => control<ImportResponse>({
        transportId: fromTransportId,
        gatewayId: input.fromGatewayId,
        pathSuffix: "/push-rsync-state",
        migrationId: input.migrationId,
        body: pushBody as unknown as Record<string, unknown>,
      }));
      await assertTransferClaim(deps.store, claimed);
      if (mode === "final" && deps.prepareAgentStores) {
        await measure("target-agent-store-handoff", input.toGatewayId, () => deps.prepareAgentStores!(input.toGatewayId, input.slug));
      }
      const finished = await measure(mode === "final" ? "target-import-and-activation" : "target-import", input.toGatewayId, () => control<ImportResponse>({
        transportId: toTransportId,
        gatewayId: input.toGatewayId,
        pathSuffix: "/finish-rsync-import",
        migrationId: input.migrationId,
        body: {
          transferAttemptId: claimed.attemptId,
          migrationId: input.migrationId,
          slug: input.slug,
          rpcPhase: "finish-rsync-import",
          mode,
          ...(input.preserveSource ? { preserveSource: true as const, loadStrategy: "expedited" as const } : {}),
        } satisfies FinishRsyncImportRequestBody,
        baseUrl: targetBaseUrl,
      }));
      if (mode === "final") {
        await measure("target-readiness", input.toGatewayId, () => resolvedTargetPod.vm
          ? waitForTargetVmReady(fetchImpl, wait, now, { name: resolvedTargetPod.name, baseUrl: targetBaseUrl })
          : waitForTargetPodReady(runCommand, deps.namespace, resolvedTargetPod.name));
      }
      await finishTransferTask(deps.store, claimed, now);
      // The target committed the import and told us which post-commit step it could
      // not confirm. Aborting here would unmount work that landed and send the retry
      // back into the same reload, so the state stands and the reconcile converges it.
      if (finished.verificationPending) {
        log(
          `[migration-rsync] ⚠ task=${claimed.taskId} migrationId=${input.migrationId} ` +
          `slug=${input.slug} imported with verification pending: ${finished.verificationPending}`,
        );
      }
      log(
        `[migration-rsync] ✅ task=${claimed.taskId} mode=${mode} migrationId=${input.migrationId} slug=${input.slug}`,
      );
      return finished;
    } catch (err) {
      await assertTransferClaim(deps.store, claimed);
      if (targetPrepareAttempted && targetPod) {
        await control<ImportResponse>({
          transportId: toTransportId,
          gatewayId: input.toGatewayId,
          pathSuffix: "/abort-rsync-import",
          migrationId: input.migrationId,
          body: {
            migrationId: input.migrationId,
            slug: input.slug,
            rpcPhase: "abort-rsync-import",
            transferAttemptId: claimed.attemptId,
            mode,
          },
          baseUrl: podBaseUrl(targetPod.podIP, deps.fleetControllerPort),
        }).catch((abortErr) => {
          log(
            `[migration-rsync] ⚠ abort failed mode=${mode} migrationId=${input.migrationId} slug=${input.slug}: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`,
          );
        });
      }
      await finishTransferTask(deps.store, claimed, now, err).catch((markErr) => {
        log(
          `[migration-rsync] ⚠ failed to mark task=${claimed.taskId} failed: ${markErr instanceof Error ? markErr.message : String(markErr)}`,
        );
      });
      throw err;
    }
  };
}
