import { scratchOwner } from "./plan.js";
import { bootRecoveryReport } from "./boot-recovery.js";
import { prepareScratchVolumes, inspectInactiveScratchVolumes } from "./scratch.js";
import { captureHomeSnapshot, discardHomeSnapshot } from "./home-snapshot.js";
import { basename, dirname } from "node:path";
import { USER_CLAIM_FILE, userClaimFromIdentity, parseUserClaimRecord } from "@octogee/shared/types/builder-identity";
import {
  isGatewayVmRuntimeBundle,
  type GatewayVmDiskSample,
  type GatewayVmRuntimeBundle,
  type GatewayVmRuntimeRequest,
  type GatewayVmRuntimeResponse,
} from "@octogee/shared/types/glm";
import { observeVmImages } from "./image-observation.js";
import { brokerFailure, brokerPost } from "./broker.js";
import {
  containerPathExists,
  createContainer,
  inspectContainer,
  hasImmutableImage,
  pruneUnusedImages,
  pullImage,
  removeContainer,
  startContainer,
  waitContainer,
  setContainerPaused,
  setContainerRestartPolicy,
  type DockerEngine,
} from "./docker-engine.js";
import {
  HOME_CHECKPOINT_INTERVAL_MS,
  HOME_RESTORE_GATE,
  HOME_VOLUME_NAME,
  admitHome,
  checkpointHome,
  homeScope,
  restoreHome,
  type HomeCheckpointDeps,
  type HomeFs,
  type HomeRestoreResult,
  type HomeScope,
  type HomeShell,
} from "./home-checkpoint.js";
import { fetchDesk, syncDesk } from "./desk.js";
import { ensureJournalForward, planJournalForward } from "./journal-forward.js";
import type { MetadataClient } from "./metadata.js";
import { GATEWAY_HOST_DESKTOP_AUTH_DIR } from "../openclaw-computer-browser.js";
import type { DesktopControl } from "./desktop-control.js";
import {
  CA_FILE,
  SERVICE_RESTART_POLICY,
  bundleUserIdentity,
  containerName,
  TOKEN_FILE,
  imagesToPull,
  planBundle,
  planInitSpec,
  runningInitSpec,
  runningSpec,
  runningVersion,
  specVersion,
  volumeHostPath,
  type BundlePlan,
  type DockerContainerSpec,
} from "./plan.js";

export const TOKEN_REFRESH_MS = 20 * 60_000;
export const PREEMPTION_WATCH_RETRY_MS = 5_000;
export const HOME_RESTORE_RETRY_MS = 60_000;
const HOME_RESTORE_RETRY_MAX_MS = 30 * 60_000;
export const RUNTIME_UID = 1000;
export const RUNTIME_GID = 1000;
export const AGENT_CONTAINER = "octo-gateway-agent";
const VM_RUNTIME_ROUTE = "vm-runtime";
export const HOST_PROBE_CONTAINER = "octogee-host-probe";
export const HOST_OPENCLAW_VNC_REFLECTOR = "/usr/local/bin/octo-desktop-openclaw-vnc";
const HOST_PROBE_BIN = "/octogee-host-bin";

export interface AgentFs {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, content: string, mode: number): Promise<void>;
  readFile(path: string): Promise<string | null>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  diskUsage(path: string): Promise<GatewayVmDiskSample>;
}

export interface VmAgentDeps {
  gatewayId: string;
  apiUrl: string;
  stateRoot: string;
  engine: DockerEngine;
  holdOpenClaw: (openclawDir: string) => Promise<void>;
  metadata: MetadataClient;
  fetchImpl: typeof fetch;
  fs: AgentFs;
  home: { shell: HomeShell; fs: HomeFs; desktop: DesktopControl };
  now: () => number;
  log: HomeCheckpointDeps["log"];
  logError: HomeCheckpointDeps["logError"];
}

export interface VmAgentState {
  tokensWrittenAt: number | null;
  appliedVersion: string | null;
  homeCheckpointCheckedAt: number | null;
  hostDesktopAuth: boolean | null;
}

export const initialAgentState = (): VmAgentState => ({ tokensWrittenAt: null, appliedVersion: null, homeCheckpointCheckedAt: null, hostDesktopAuth: null });

export type HomeCheckpointSignal = GatewayVmRuntimeResponse["homeCheckpoint"];

export type BundleFetch =
  | { kind: "bundle"; bundle: GatewayVmRuntimeBundle; homeCheckpoint: HomeCheckpointSignal }
  | { kind: "not-rendered" };

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function diskReport(deps: VmAgentDeps): Promise<GatewayVmRuntimeRequest> {
  try {
    return { disk: await deps.fs.diskUsage(deps.stateRoot) };
  } catch (err) {
    deps.log(`[vm-agent] disk usage unavailable for ${deps.stateRoot}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

async function imageReport(deps: VmAgentDeps): Promise<GatewayVmRuntimeRequest> {
  try {
    return { images: await observeVmImages(deps.engine) };
  } catch (error) {
    deps.log(`[vm-agent] image observation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

async function publishImageReport(deps: VmAgentDeps): Promise<void> {
  const report = await imageReport(deps);
  if (!report.images) return;
  const response = await brokerPost(deps, VM_RUNTIME_ROUTE, { images: report.images });
  if (!response.ok) throw await brokerFailure("vm-runtime image report", response);
  await response.body?.cancel();
}

export async function fetchRuntimeBundle(deps: VmAgentDeps): Promise<BundleFetch> {
  const [disk, images, recovery] = await Promise.all([diskReport(deps), imageReport(deps), bootRecoveryReport(deps)]);
  const res = await brokerPost(deps, VM_RUNTIME_ROUTE, { ...disk, ...images, ...recovery });
  if (res.status === 404) return { kind: "not-rendered" };
  if (!res.ok) throw await brokerFailure(VM_RUNTIME_ROUTE, res);
  const body = (await res.json()) as Partial<GatewayVmRuntimeResponse>;
  if (!isGatewayVmRuntimeBundle(body.bundle) || body.bundle.gatewayId !== deps.gatewayId) {
    throw new Error("vm-runtime: response is not this gateway's runtime bundle");
  }
  return {
    kind: "bundle",
    bundle: body.bundle,
    homeCheckpoint: {
      requestedAt: numberOrNull(body.homeCheckpoint?.requestedAt),
      completedAt: numberOrNull(body.homeCheckpoint?.completedAt),
    },
  };
}

async function writeReadable(deps: VmAgentDeps, dir: string, file: string, content: string): Promise<void> {
  await deps.fs.mkdir(dir);
  await deps.fs.writeFile(`${dir}/${file}`, content, 0o644);
}

export async function writeTokens(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle): Promise<void> {
  let accessToken: string | null = null;
  for (const volume of bundle.volumes) {
    if (volume.kind !== "identityToken" && volume.kind !== "kubernetesApi") continue;
    const dir = volumeHostPath(deps.stateRoot, volume);
    if (volume.kind === "identityToken") {
      await writeReadable(deps, dir, TOKEN_FILE, await deps.metadata.identityToken(volume.audience));
    } else if (volume.kind === "kubernetesApi") {
      accessToken ??= await deps.metadata.accessToken();
      await writeReadable(deps, dir, TOKEN_FILE, accessToken);
      await writeReadable(deps, dir, CA_FILE, bundle.kubernetes.caCert);
    }
  }
}

export async function ensureVolumes(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle, vmId: string): Promise<void> {
  const names = bundle.volumes.filter(volume => volume.kind === "ephemeral").map(volume => volume.name);
  if (names.length) {
    const agent = await inspectContainer(deps.engine, AGENT_CONTAINER);
    if (!agent?.Image) throw new Error("scratch preparation requires the running platform agent image");
    const groups = new Map<string, string[]>();
    for (const name of names) {
      const owner = scratchOwner(bundle, vmId, name);
      groups.set(owner, [...(groups.get(owner) ?? []), name]);
    }
    for (const [owner, selected] of groups) await prepareScratchVolumes({ engine: deps.engine, image: agent.Image, vmId: owner, stateRoot: deps.stateRoot, names: selected,
      beforeCreate: async () => {
        const boot = await deps.fs.diskUsage("/");
        if (!Number.isFinite(boot.freeBytes) || boot.freeBytes < 2 * 1024 ** 3) throw new Error("scratch preparation requires at least 2 GiB boot headroom; retained home and existing scratch kept");
      },
    });
  }
  for (const volume of bundle.volumes) {
    if (volume.kind !== "emptyDir") continue;
    const dir = volumeHostPath(deps.stateRoot, volume);
    await deps.fs.mkdir(dir);
    await deps.fs.chown(dir, RUNTIME_UID, RUNTIME_GID);
  }
  if (bundle.containers.some((container) => container.name === "gateway")) {
    const documents = `${deps.stateRoot}/desktop-home/Documents`;
    await deps.fs.mkdir(documents);
    await deps.fs.chown(documents, RUNTIME_UID, RUNTIME_GID);
  }
}

export async function probeHostDesktopAuth(deps: VmAgentDeps): Promise<boolean> {
  const agent = await inspectContainer(deps.engine, AGENT_CONTAINER);
  if (!agent?.Image) throw new Error(`host desktop probe: ${AGENT_CONTAINER} container not found`);
  await removeContainer(deps.engine, HOST_PROBE_CONTAINER);
  await createContainer(deps.engine, HOST_PROBE_CONTAINER, {
    Image: agent.Image,
    NetworkDisabled: true,
    HostConfig: { Binds: [`${dirname(HOST_OPENCLAW_VNC_REFLECTOR)}:${HOST_PROBE_BIN}:ro`] },
  });
  try {
    const shipped = await containerPathExists(deps.engine, HOST_PROBE_CONTAINER, `${HOST_PROBE_BIN}/${basename(HOST_OPENCLAW_VNC_REFLECTOR)}`);
    if (!shipped) {
      deps.log(`[vm-agent] this computer's image has no ${HOST_OPENCLAW_VNC_REFLECTOR}, so its desktop publishes no OpenClaw VNC password; `
        + `octogee-gateway runs without ${GATEWAY_HOST_DESKTOP_AUTH_DIR} and the OpenClaw desktop panel is unavailable on this computer`);
    }
    return shipped;
  } finally {
    await removeContainer(deps.engine, HOST_PROBE_CONTAINER);
  }
}

function hostDesktopAuth(deps: VmAgentDeps, state: VmAgentState): Promise<boolean> {
  return state.hostDesktopAuth === null ? probeHostDesktopAuth(deps) : Promise.resolve(state.hostDesktopAuth);
}

async function replaceContainer(engine: DockerEngine, spec: DockerContainerSpec): Promise<void> {
  await removeContainer(engine, spec.name);
  await createContainer(engine, spec.name, spec.config);
  await startContainer(engine, spec.name);
}

async function resumeWriters(deps: VmAgentDeps, names: string[]): Promise<void> {
  const results = await Promise.allSettled([
    ...names.map(async (name) => { await setContainerRestartPolicy(deps.engine, name, SERVICE_RESTART_POLICY); await setContainerPaused(deps.engine, name, false); }),
    deps.home.desktop.run("thaw"),
  ]);
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, `home snapshot resume failed: ${errors.map(String).join("; ")}`);
}

function homeDeps(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle, holdAfterSnapshot = false) {
  return {
    ...deps, shell: deps.home.shell, fs: deps.home.fs, desktop: deps.home.desktop,
    captureSnapshot: () => captureHomeSnapshot({ ...deps, fs: deps.home.fs, shell: deps.home.shell }),
    discardSnapshot: () => discardHomeSnapshot({ ...deps, fs: deps.home.fs }),
    snapshot: async (work: () => Promise<void>) => {
      const startedAt = deps.now();
      const paused: string[] = [];
      const errors: unknown[] = [];
      deps.log(`[vm-agent] home snapshot pausing ${bundle.containers.length} writers for a ${holdAfterSnapshot ? "requested checkpoint, then holding them" : "scheduled checkpoint"}`);
      try {
        await deps.home.desktop.run("freeze");
        for (const container of bundle.containers) {
          const name = containerName(container);
          paused.push(name);
          if (holdAfterSnapshot) await setContainerRestartPolicy(deps.engine, name, "no");
          if (!(await inspectContainer(deps.engine, name))?.State?.Paused) await setContainerPaused(deps.engine, name, true);
        }
        await work();
      } catch (error) {
        errors.push(error);
      }
      if (!holdAfterSnapshot) {
        try { await resumeWriters(deps, paused); } catch (error) { errors.push(error); }
      }
      deps.log(`[vm-agent] home snapshot writers ${holdAfterSnapshot ? "held for retirement" : "resumed"} after ${deps.now() - startedAt}ms`);
      if (errors.length) throw new AggregateError(errors, `home snapshot failed: ${errors.map(String).join("; ")}`);
    },
  };
}

const restoreBackoff = new WeakMap<VmAgentDeps, { failures: number; retryAt: number }>();

async function restoreHomeWithBackoff(deps: VmAgentDeps, home: HomeCheckpointDeps, scope: HomeScope): Promise<HomeRestoreResult> {
  const previous = restoreBackoff.get(deps);
  if (previous && deps.now() < previous.retryAt) {
    throw new Error(`[vm-agent] home restore failed ${previous.failures} time(s); retrying after ${new Date(previous.retryAt).toISOString()}`);
  }
  try {
    const result = await restoreHome(home, scope);
    restoreBackoff.delete(deps);
    return result;
  } catch (error) {
    const failures = (previous?.failures ?? 0) + 1;
    restoreBackoff.set(deps, { failures, retryAt: deps.now() + Math.min(HOME_RESTORE_RETRY_MS * 2 ** (failures - 1), HOME_RESTORE_RETRY_MAX_MS) });
    throw error;
  }
}

export async function restoreHomeIfEmpty(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle): Promise<void> {
  const scope = homeScope(deps.stateRoot, bundle);
  if (!scope) {
    const gate = `${deps.stateRoot}/${HOME_RESTORE_GATE}`;
    if (await deps.home.fs.exists(gate)) throw new Error(`[vm-agent] the checkpoint restore gate ${gate} is closed but bundle ${bundle.version} carries no user home to restore; writers stay off`);
    return;
  }
  const home = homeDeps(deps, bundle);
  const result = await restoreHomeWithBackoff(deps, home, scope);
  await admitHome(home, scope);
  if (result.status === "restored") deps.log(`[vm-agent] home restore restored ${result.name} (${result.size} bytes)`);
}

async function assertHomeClaimOwner(
  deps: VmAgentDeps,
  file: string,
  claim: { gatewayId: string; ownerUid: string; builderSlug: string },
): Promise<void> {
  const raw = await deps.fs.readFile(file);
  if (raw === null) return;
  let existing: ReturnType<typeof parseUserClaimRecord> = null;
  try {
    existing = parseUserClaimRecord(JSON.parse(raw));
  } catch {
    existing = null;
  }
  if (!existing) throw new Error(`[vm-agent] User claim ${file} in this home is malformed; refusing to start ${claim.gatewayId}`);
  if (existing.ownerUid !== claim.ownerUid || existing.builderSlug !== claim.builderSlug) {
    throw new Error(
      `[vm-agent] this home is claimed by ${existing.ownerUid}/${existing.builderSlug} on ${existing.gatewayId}, ` +
      `not ${claim.ownerUid}/${claim.builderSlug}; refusing to start ${claim.gatewayId}`,
    );
  }
  if (existing.gatewayId !== claim.gatewayId) {
    deps.log(`[vm-agent] ${claim.builderSlug}'s home moves its claim from ${existing.gatewayId} to ${claim.gatewayId}`);
  }
}

export async function writeBundleUserClaim(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle): Promise<void> {
  const identity = bundleUserIdentity(bundle);
  const data = bundle.volumes.find((volume) => volume.name === HOME_VOLUME_NAME && volume.kind === "emptyDir");
  if (!identity || !data) {
    deps.log(`[vm-agent] bundle ${bundle.version} carries no user identity; the gateway reads its claim from the broker`);
    return;
  }
  const dir = `${volumeHostPath(deps.stateRoot, data)}/.openclaw`;
  const file = `${dir}/${USER_CLAIM_FILE}`;
  const claim = userClaimFromIdentity({ gatewayId: bundle.gatewayId, state: "claimed", leaseId: null, generation: null, ...identity }, deps.now());
  await assertHomeClaimOwner(deps, file, claim);
  await deps.fs.mkdir(dir);
  await deps.fs.chown(dir, RUNTIME_UID, RUNTIME_GID);
  await deps.fs.writeFile(file, `${JSON.stringify(claim)}\n`, 0o600);
  await deps.fs.chown(file, RUNTIME_UID, RUNTIME_GID);
}

async function ensureImages(deps: VmAgentDeps, images: string[]): Promise<void> {
  let accessToken: string | undefined;
  for (const image of images) {
    if (await hasImmutableImage(deps.engine, image)) continue;
    const boot = await deps.fs.diskUsage("/");
    if (!Number.isFinite(boot.freeBytes) || boot.freeBytes < 16 * 1024 ** 3) {
      throw new Error("boot disk needs at least 16 GiB free before pulling an image");
    }
    accessToken ??= await deps.metadata.accessToken();
    deps.log(`[vm-agent] pulling ${image}`);
    await pullImage(deps.engine, image, accessToken);
  }
}

export async function applyBundle(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle, plan: BundlePlan): Promise<void> {
  await ensureImages(deps, imagesToPull(bundle));
  await holdGatewayForReplacement(deps, bundle, plan.services);
  for (const service of plan.services) await removeContainer(deps.engine, service.name);
  await restoreHomeIfEmpty(deps, bundle);
  await writeBundleUserClaim(deps, bundle);
  if (plan.init) {
    deps.log(`[vm-agent] running init ${plan.init.name}`);
    await replaceContainer(deps.engine, plan.init);
    const code = await waitContainer(deps.engine, plan.init.name);
    if (code !== 0) throw new Error(`init container ${plan.init.name} exited ${code}`);
    await removeContainer(deps.engine, plan.init.name);
  }
  for (const service of plan.services) {
    deps.log(`[vm-agent] starting ${service.name} (${bundle.version})`);
    await replaceContainer(deps.engine, service);
  }
}

export async function applyServices(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle, services: DockerContainerSpec[]): Promise<void> {
  await ensureImages(deps, [...new Set(services.map((service) => service.config.Image as string))]);
  await holdGatewayForReplacement(deps, bundle, services);
  for (const service of services) {
    deps.log(`[vm-agent] replacing ${service.name} (${bundle.version})`);
    await replaceContainer(deps.engine, service);
  }
}

async function holdGatewayForReplacement(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle, services: DockerContainerSpec[]): Promise<void> {
  if (!services.some((service) => service.name === "octogee-gateway")) return;
  const gateway = await inspectContainer(deps.engine, "octogee-gateway");
  if (!gateway?.State?.Running) return;
  if (gateway.State.Paused) throw new Error("cannot replace a paused Native gateway");
  const data = bundle.volumes.find((volume) => volume.name === HOME_VOLUME_NAME && volume.kind === "emptyDir");
  if (!data) throw new Error("cannot stop Native without its persistent home volume");
  const startedAt = deps.now();
  await deps.holdOpenClaw(`${volumeHostPath(deps.stateRoot, data)}/.openclaw`);
  deps.log(`[vm-agent] Native supervisor stopped gateway for replacement in ${deps.now() - startedAt}ms`);
}

export async function syncUserDesk(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle): Promise<void> {
  const scope = homeScope(deps.stateRoot, bundle);
  if (!scope) return;
  try {
    const desk = await fetchDesk(deps, scope.slug);
    if (!desk) {
      deps.log(`[vm-agent] desk sync waiting: ${scope.slug} has no configured user bootstrap yet`);
      return;
    }
    const { written } = await syncDesk(deps, scope, desk);
    if (written) deps.log(`[vm-agent] desk written for ${scope.slug}: ${desk.agentName || "agent"} as ${desk.look.style} ${desk.look.color}`);
  } catch (err) {
    deps.log(`[vm-agent] desk sync failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function outstandingCheckpointRequestedAt(signal: HomeCheckpointSignal): number | null {
  return signal.requestedAt !== null && signal.requestedAt > (signal.completedAt ?? 0) ? signal.requestedAt : null;
}

export function homeCheckpointDue(state: VmAgentState, signal: HomeCheckpointSignal, now: number): { due: boolean; force: boolean } {
  const force = outstandingCheckpointRequestedAt(signal) !== null;
  const periodic = state.homeCheckpointCheckedAt === null || now - state.homeCheckpointCheckedAt >= HOME_CHECKPOINT_INTERVAL_MS;
  return { due: force || periodic, force };
}

export async function checkpointHomeIfDue(
  deps: VmAgentDeps,
  bundle: GatewayVmRuntimeBundle,
  signal: HomeCheckpointSignal,
  state: VmAgentState,
): Promise<VmAgentState> {
  const now = deps.now();
  const { due, force } = homeCheckpointDue(state, signal, now);
  if (!due) return state;
  const scope = homeScope(deps.stateRoot, bundle);
  if (!scope) {
    const requested = force ? ` (requested at ${signal.requestedAt})` : "";
    deps.log(`[vm-agent] home checkpoint skipped${requested}: bundle ${bundle.version} carries no user home (data emptyDir + user identity)`);
    return { ...state, homeCheckpointCheckedAt: now };
  }
  let reporting: Promise<void> | undefined;
  const timer = setInterval(() => {
    reporting ??= publishImageReport(deps)
      .catch(error => deps.log(`[vm-agent] checkpoint image report failed: ${String(error)}`))
      .finally(() => { reporting = undefined; });
  }, 30_000);
  try {
    const result = await checkpointHome(homeDeps(deps, bundle, force), scope, { force, requestedAt: signal.requestedAt });
    if (result.status === "uploaded") {
      deps.log(`[vm-agent] home checkpoint ${result.name} uploaded (${result.size} bytes${force ? ", requested" : ""}; pruned ${result.pruned ?? "?"})`);
    }
  } catch (err) {
    deps.log(`[vm-agent] home checkpoint failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearInterval(timer);
    await reporting;
  }
  return { ...state, homeCheckpointCheckedAt: now };
}

function allHomeWritersHeld(running: ContainerInspection[]): boolean {
  return running.every((inspection) => inspection?.State?.Running && inspection.State.Paused);
}

async function keepAcknowledgedCheckpointHeld(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle, running: ContainerInspection[], signal: HomeCheckpointSignal): Promise<boolean> {
  if (signal.requestedAt === null || signal.completedAt === null || signal.completedAt < signal.requestedAt) return false;
  await deps.home.desktop.run("freeze");
  let repaused = 0;
  for (const [index, inspection] of running.entries()) {
    if (!inspection?.State?.Running) continue;
    await setContainerRestartPolicy(deps.engine, containerName(bundle.containers[index]), "no");
    if (inspection.State.Paused) continue;
    await setContainerPaused(deps.engine, containerName(bundle.containers[index]), true);
    repaused += 1;
  }
  if (repaused) deps.log(`[vm-agent] paused ${repaused} home writers again to keep the checkpoint requested at ${signal.requestedAt} consistent`);
  return true;
}

async function releaseHomeWriterHold(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle, running: ContainerInspection[]): Promise<void> {
  let released = 0;
  for (const [index, inspection] of running.entries()) {
    if (!inspection?.State?.Paused) continue;
    await setContainerRestartPolicy(deps.engine, containerName(bundle.containers[index]), SERVICE_RESTART_POLICY);
    await setContainerPaused(deps.engine, containerName(bundle.containers[index]), false);
    released += 1;
  }
  await deps.home.desktop.run("thaw");
  if (released) deps.log(`[vm-agent] released ${released} held home writers; no checkpoint hold is in force`);
}

export async function convergeOnce(deps: VmAgentDeps, state: VmAgentState): Promise<VmAgentState> {
  const fetched = await fetchRuntimeBundle(deps);
  if (fetched.kind === "not-rendered") {
    deps.log("[vm-agent] runtime bundle not rendered yet; waiting");
    return state;
  }
  const { bundle, homeCheckpoint: signal } = fetched;
  const requestedAt = outstandingCheckpointRequestedAt(signal);
  if (requestedAt !== null) {
    deps.log("[vm-agent] home checkpoint request observed", {
      gatewayId: deps.gatewayId, builderSlug: bundleUserIdentity(bundle)?.builderSlug,
      category: "home-checkpoint", phase: "request-observed", status: "done", requestedAt,
      requestAgeMs: deps.now() - requestedAt,
    });
  }
  if (!bundle.namespace) {
    deps.log(`[vm-agent] bundle ${bundle.version} carries no namespace; VM logs stay unlabelled until the platform is upgraded`);
  }
  const identity = await deps.metadata.instanceIdentity();
  const now = deps.now();
  let next = state;
  if (state.tokensWrittenAt === null || now - state.tokensWrittenAt >= TOKEN_REFRESH_MS) {
    await writeTokens(deps, bundle);
    next = { ...next, tokensWrittenAt: now };
  }
  await ensureVolumes(deps, bundle, identity.instanceId);
  const running = await Promise.all(bundle.containers.map((c) => inspectContainer(deps.engine, `octogee-${c.name}`)));
  if (await keepAcknowledgedCheckpointHeld(deps, bundle, running, signal)) return next;
  if (signal.requestedAt !== null && allHomeWritersHeld(running)) {
    return checkpointHomeIfDue(deps, bundle, signal, next);
  }
  await releaseHomeWriterHold(deps, bundle, running);
  const desktopAuth = await hostDesktopAuth(deps, next);
  next = { ...next, hostDesktopAuth: desktopAuth };
  const plan = planBundle(bundle, { stateRoot: deps.stateRoot, instanceId: identity.instanceId, desktopAuth });
  const decision = decideConvergence(plan, running);
  if (decision.kind === "steady") {
    if (next.appliedVersion !== bundle.version) next = { ...next, appliedVersion: bundle.version };
    await syncUserDesk(deps, bundle);
    await inspectUnusedScratch(deps, identity.instanceId);
    return checkpointHomeIfDue(deps, bundle, signal, next);
  }
  await applyDecision(deps, bundle, plan, decision, { running, vmId: identity.instanceId });
  await syncUserDesk(deps, bundle);
  return { ...next, appliedVersion: bundle.version };
}

type ContainerInspection = Awaited<ReturnType<typeof inspectContainer>>;

export type ConvergenceDecision =
  | { kind: "steady" }
  | { kind: "full" }
  | { kind: "services"; services: DockerContainerSpec[] };

async function applyDecision(
  deps: VmAgentDeps,
  bundle: GatewayVmRuntimeBundle,
  plan: BundlePlan,
  decision: Exclude<ConvergenceDecision, { kind: "steady" }>,
  computer: { running: ContainerInspection[]; vmId: string },
): Promise<void> {
  const { running, vmId } = computer;
  const runningVersions = running.map((inspection) => runningVersion(inspection) ?? "none").join(",");
  const action = decision.kind === "full" ? "full apply" : `replacing ${decision.services.map((service) => service.name).join(",")}`;
  deps.log(`[vm-agent] converging to bundle ${bundle.version} (running: ${runningVersions}; ${action})`);
  if (decision.kind === "full") await applyBundle(deps, bundle, plan);
  else await applyServices(deps, bundle, decision.services);
  await inspectUnusedScratch(deps, vmId);
  await reclaimUnusedImages(deps, bundle);
}

async function inspectUnusedScratch(deps: VmAgentDeps, vmId: string): Promise<void> {
  try {
    await inspectInactiveScratchVolumes({ ...deps, vmId });
  } catch (error) {
    deps.log(`[vm-agent] scratch inspection failed; preserving storage for retry: ${String(error)}`);
  }
}

async function reclaimUnusedImages(deps: VmAgentDeps, bundle: GatewayVmRuntimeBundle): Promise<void> {
  try {
    const { imagesDeleted, spaceReclaimed } = await pruneUnusedImages(deps.engine);
    deps.log(`[vm-agent] reclaimed ${spaceReclaimed} bytes from ${imagesDeleted} unused image(s) after applying bundle ${bundle.version}`);
  } catch (err) {
    deps.log(`[vm-agent] image reclaim after applying bundle ${bundle.version} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function decideConvergence(plan: BundlePlan, running: ContainerInspection[]): ConvergenceDecision {
  const initSpec = planInitSpec(plan);
  const initChanged = running.some((inspection) => inspection !== null && runningInitSpec(inspection) !== initSpec);
  const stale = plan.services.filter((service, index) =>
    running[index]?.State?.Running !== true || runningSpec(running[index]) !== specVersion(service));
  if (stale.length === 0 && !initChanged) return { kind: "steady" };
  if (initChanged || running.every((inspection) => inspection === null)) return { kind: "full" };
  return { kind: "services", services: stale };
}

async function reportPreemption(deps: VmAgentDeps): Promise<void> {
  const res = await brokerPost(deps, VM_RUNTIME_ROUTE, { preempted: true });
  if (!res.ok) throw await brokerFailure(VM_RUNTIME_ROUTE, res);
  deps.log("[vm-agent] the fleet controller has this computer's preemption notice");
}

export async function watchPreemption(deps: VmAgentDeps, opts: { sleep: (ms: number) => Promise<void>; stop?: () => boolean }): Promise<void> {
  let waitForChange = false;
  while (!opts.stop?.()) {
    try {
      if (await deps.metadata.preempted(waitForChange)) {
        deps.log("[vm-agent] ⚠ GCE announced this Spot VM's preemption; it stops in about 30 s");
        await reportPreemption(deps);
        return;
      }
      waitForChange = true;
    } catch (err) {
      deps.log(`[vm-agent] preemption watch failed: ${err instanceof Error ? err.message : String(err)}; retrying in ${PREEMPTION_WATCH_RETRY_MS}ms`);
      waitForChange = false;
      await opts.sleep(PREEMPTION_WATCH_RETRY_MS);
    }
  }
}

async function keepJournalForwarded(deps: VmAgentDeps): Promise<void> {
  try {
    const agent = await inspectContainer(deps.engine, AGENT_CONTAINER);
    if (!agent?.Image) throw new Error(`${AGENT_CONTAINER} container not found`);
    await ensureJournalForward(deps.engine, planJournalForward(deps.gatewayId, agent.Image), deps.log);
  } catch (err) {
    deps.log(`[vm-agent] journal forwarding unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function runVmGatewayAgent(deps: VmAgentDeps, opts: { intervalMs: number; sleep: (ms: number) => Promise<void>; stop?: () => boolean }): Promise<void> {
  const preemption = watchPreemption(deps, opts);
  let state = initialAgentState();
  while (!opts.stop?.()) {
    await keepJournalForwarded(deps);
    try {
      state = await convergeOnce(deps, state);
    } catch (err) {
      deps.log(`[vm-agent] converge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await opts.sleep(opts.intervalMs);
  }
  await preemption;
}
