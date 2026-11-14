import { isDeepStrictEqual } from "node:util";
import {
  type PlatformUserRecord,
  type FleetRegistryRecord,
  type GatewayComputerProfile,
  type GatewayVmProfile,
  type PlatformStateStore,
} from "@octogee/core/platform-state";
import type { SizingTier } from "@octogee/shared/types/sizing";
import {
  isGatewayRuntime,
  isGatewayVmBootDiskType,
  isGatewayVmDesktop,
  resolveGatewayRuntime,
  type GatewayRuntime,
  type GatewayVmDesktop,
  type GatewayVmSpec,
  type GatewayVmState,
  type HelmInstancesMap,
  type RuntimeUserIdentity,
} from "@octogee/shared/types/glm";
import type { GatewayVmClient } from "./lib/compute-vm.js";
import { createVmLifecycle, recordVmObservation, vmSpecDesktop } from "./vm-lifecycle.js";
import type { KubectlSubprocess } from "./fleet-ingress.js";
import {
  helmTemplateArgsFromUpgradeArgs,
  parseConcatenatedJson,
  renderVmRuntimeBundle,
} from "./lib/vm-runtime-bundle.js";
import { buildUpgradeArgs, type HelmRunner, type HelmSubprocess } from "./helm-runner.js";

const VM_ROUTES_CONFIGMAP_KEY = "routes.json";

export interface VmGatewayRuntime extends HelmRunner {
  readDeploymentPrerequisiteError(gatewayId: string): Promise<string | null>;
  recoverUnreachable(gatewayId: string): Promise<void>;
  deleteVm(ownerUid: string): Promise<boolean>;
  replaceStoppedVm(gatewayId: string, operationId: string, assertAuthority: () => Promise<void>, options?: { forceOwnerUid: string; expectedInstanceId: string }): Promise<Record<string, unknown>>;
  detectPreemption(gatewayId: string, sinceMs: number): Promise<string | null>;
}

export interface VmGatewayRuntimeDeps {
  store: PlatformStateStore;
  namespace: string;
  environment: string;
  runHelm: HelmSubprocess;
  runKubectl: KubectlSubprocess;
  vm: GatewayVmClient;
  vmSpec: GatewayVmSpec;
  computeProjectId: string;
  bridgeServiceName: string;
  hostAliasNames: readonly string[];
  kubernetes: { apiHost: string; apiPort: string; caCert: string };
  routesConfigMap: string;
  ensureAuthSecret?: (opts: { namespace: string; gatewayId: string }) => Promise<void>;
  readDesiredStatus: (gatewayId: string) => Promise<string | null>;
  journalBootUpgrade: (input: { gatewayId: string; ownerUid: string; instanceId: string; imageId: string }, work: (assertAuthority: () => Promise<void>) => Promise<void>) => Promise<void>;
  upgradeTimeout?: string;
  wait: (ms: number) => Promise<void>;
  disposableParking?: boolean;
  homeCheckpointTimeoutMs?: number;
  homeCheckpointPollMs?: number;
  onVmCreationSettled: (gatewayId: string) => void;
  now: () => number;
  log: (msg: string) => void;
}

export async function findGatewayVmPolicy(
  store: Pick<PlatformStateStore, "config">,
  tier: SizingTier,
  runtime?: GatewayRuntime,
): Promise<GatewayComputerProfile | null> {
  const config = await store.config.orchestrator.get();
  const matches = Object.entries(config?.sizingProfiles ?? {}).flatMap(([key, entry]) =>
    entry.isolation === "isolated" && entry.sizingTier === tier && (runtime === undefined || entry.computer.runtime === runtime)
      ? [{ key, policy: entry.computer }]
      : []);
  const [first] = matches;
  if (!first) return null;
  if (matches.some(({ policy }) => !isDeepStrictEqual(policy, first.policy))) {
    throw new Error(`Conflicting gateway VM policies for sizing tier ${tier}: ${matches.map(({ key }) => key).join(", ")}`);
  }
  return first.policy;
}

export async function resolveGatewayVmPolicy(
  store: Pick<PlatformStateStore, "config">,
  sizingTier: SizingTier | null | undefined,
): Promise<GatewayComputerProfile> {
  const tier = sizingTier ?? "s";
  const policy = await findGatewayVmPolicy(store, tier);
  if (!policy) throw new Error(`No gateway VM policy for sizing tier ${tier}`);
  return policy;
}

async function sizingProfileComputer(
  store: Pick<PlatformStateStore, "config">,
  gatewayId: string,
  sizingProfile: string,
): Promise<GatewayComputerProfile> {
  const profiles = (await store.config.orchestrator.get())?.sizingProfiles ?? {};
  const profile = Object.hasOwn(profiles, sizingProfile) ? profiles[sizingProfile] : undefined;
  if (profile?.isolation !== "isolated") throw new Error(`gateway ${gatewayId}: sizing profile ${sizingProfile} is not an isolated sizing profile`);
  return profile.computer;
}

export function resolveIsolatedParking(env: Record<string, string | undefined>): boolean {
  const raw = env.GATEWAY_BUILDER_DISPOSABLE_PARKING?.trim();
  if (!raw || raw === "false") return false;
  if (raw === "true") throw new Error("disposable-home parking was withdrawn; user home disks must be retained");
  throw new Error(`GATEWAY_BUILDER_DISPOSABLE_PARKING must be true or false (got ${raw})`);
}

function assertZones(zones: unknown): void {
  if (!Array.isArray(zones) || zones.length === 0 || zones.some((zone) => typeof zone !== "string" || zone.length === 0)) {
    throw new Error("GATEWAY_VM_SPEC_JSON.zones must be a non-empty array of zone names");
  }
  if (new Set(zones).size !== zones.length) throw new Error("GATEWAY_VM_SPEC_JSON.zones must not repeat a zone");
}

export function parseGatewayVmSpec(raw: string | undefined): GatewayVmSpec {
  if (!raw?.trim()) throw new Error("GATEWAY_VM_SPEC_JSON is required for GCE gateway VMs");
  const spec = JSON.parse(raw) as Partial<GatewayVmSpec>;
  const strings = ["machineType", "imageFamily", "serviceAccountEmail", "subnetwork"] as const;
  for (const key of strings) {
    if (typeof spec[key] !== "string" || spec[key].length === 0) throw new Error(`GATEWAY_VM_SPEC_JSON.${key} must be a non-empty string`);
  }
  if (spec.imageProject !== undefined && (typeof spec.imageProject !== "string" || spec.imageProject.length === 0)) {
    throw new Error("GATEWAY_VM_SPEC_JSON.imageProject must be a non-empty string when set");
  }
  if (typeof spec.diskSizeGb !== "number" || spec.diskSizeGb <= 0) throw new Error("GATEWAY_VM_SPEC_JSON.diskSizeGb must be a positive number");
  if (typeof spec.homeDiskSizeGb !== "number" || spec.homeDiskSizeGb <= 0) throw new Error("GATEWAY_VM_SPEC_JSON.homeDiskSizeGb must be a positive number");
  assertSpecChoices(spec);
  assertZones(spec.zones);
  return spec as GatewayVmSpec;
}

function assertSpecChoices(spec: Partial<GatewayVmSpec>): void {
  if (spec.provisioningModel !== "SPOT" && spec.provisioningModel !== "STANDARD") {
    throw new Error("GATEWAY_VM_SPEC_JSON.provisioningModel must be SPOT or STANDARD");
  }
  if (!isGatewayVmDesktop(spec.desktop)) throw new Error("GATEWAY_VM_SPEC_JSON.desktop must be omarchy or x11");
  if (!isGatewayVmBootDiskType(spec.bootDiskType)) throw new Error("GATEWAY_VM_SPEC_JSON.bootDiskType must be pd-ssd or pd-balanced");
}

type TierVmShape = Pick<GatewayVmSpec, "machineType" | "diskSizeGb" | "bootDiskType" | "homeDiskSizeGb" | "provisioningModel" | "desktop">;

function tierVmShape(policy: GatewayVmProfile): TierVmShape {
  if (!policy.machineType || !policy.provisioningModel || !policy.bootDisk) throw new Error("a gce-vm user tier needs a machine type, provisioning model and boot disk");
  return {
    machineType: policy.machineType, diskSizeGb: policy.bootDisk.sizeGb, bootDiskType: policy.bootDisk.type,
    homeDiskSizeGb: policy.homeSizeGiB, provisioningModel: policy.provisioningModel, desktop: policy.desktop,
  };
}

function runtimeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hasObservedClusterPods(data: Partial<FleetRegistryRecord>): boolean {
  const observation = runtimeRecord(data.kubernetes);
  return ["ready", "not-ready"].includes(String(observation.status))
    && typeof observation.totalPods === "number" && observation.totalPods > 0;
}

function hasPriorClusterDeployment(data: Partial<FleetRegistryRecord>, gatewayId: string): boolean {
  const helm = runtimeRecord(data.helm);
  return helm.releaseName === `octogee-gw-${gatewayId}`
    && helm.deploymentName === `octogee-gateway-${gatewayId}`
    && typeof helm.lastAppliedAt === "number" && Number.isFinite(helm.lastAppliedAt) && helm.lastAppliedAt > 0;
}

function validateRuntimeObservation(data: Partial<FleetRegistryRecord>, gatewayId: string): void {
  if (data.runtime !== undefined && !isGatewayRuntime(data.runtime)) {
    throw new Error(`gateway ${gatewayId}: invalid runtime stamp ${String(data.runtime)}`);
  }
  const hasVm = data.vm != null || data.vmInstance != null;
  if (hasVm && data.runtime === undefined) throw new Error(`gateway ${gatewayId}: unstamped VM state requires operator reconciliation`);
  if ((hasVm && data.runtime === "cluster") || (data.runtime === "gce-vm" && hasObservedClusterPods(data))) {
    throw new Error(`gateway ${gatewayId}: conflicting cluster and VM runtime observations`);
  }
}

interface GatewayRuntimeStampInput {
  store: Pick<PlatformStateStore, "config" | "fleetRegistry" | "transaction">;
  gatewayId: string;
  initial: FleetRegistryRecord;
  gatewayClass: string | null | undefined;
  sizingTier?: SizingTier | null;
  sizingProfile?: string | null;
  vmSpec: GatewayVmSpec | null;
  assertStorage?: (runtime: GatewayRuntime) => Promise<void>;
  log: (msg: string) => void;
}

async function reconcileStampedVmSpec(input: GatewayRuntimeStampInput, data: Partial<FleetRegistryRecord>): Promise<void> {
  if (data.runtime !== "gce-vm" || input.gatewayClass !== "builder" || !input.vmSpec) return;
  const tier = input.sizingTier ?? "s";
  const policy = input.sizingProfile
    ? await sizingProfileComputer(input.store, input.gatewayId, input.sizingProfile)
    : await findGatewayVmPolicy(input.store, tier, "gce-vm");
  if (!policy) {
    if (!data.vmSpec) throw new Error(`No gateway VM policy for sizing tier ${tier}`);
    input.log(`[vm-gateway-runtime] ${input.gatewayId}: no sizing profile has tier ${tier}; keeping the stamped VM spec`);
    return;
  }
  if (policy.runtime !== "gce-vm") return;
  const shape = tierVmShape(policy);
  await input.store.transaction({ label: "gateway-runtime.reconcile-vm-spec" }, async (transaction) => {
    const current = await transaction.fleetRegistry.get(input.gatewayId);
    if (current?.runtime !== "gce-vm") throw new Error(`gateway ${input.gatewayId}: runtime changed during VM specification reconciliation`);
    const prior = runtimeRecord(current.vmSpec);
    if ((Object.keys(shape) as Array<keyof TierVmShape>).every((key) => prior[key] === shape[key])) return;
    await transaction.fleetRegistry.patch(input.gatewayId, {
      vmSpec: { ...input.vmSpec, ...prior, ...shape } as GatewayVmSpec,
    }, { revision: current.revision });
  });
}

async function newGatewayVmPolicy(
  input: GatewayRuntimeStampInput,
  data: Partial<FleetRegistryRecord>,
): Promise<GatewayVmProfile | null> {
  if (input.gatewayClass !== "builder" || hasObservedClusterPods(data) || hasPriorClusterDeployment(data, input.gatewayId)) return null;
  const policy = input.sizingProfile
    ? await sizingProfileComputer(input.store, input.gatewayId, input.sizingProfile)
    : await resolveGatewayVmPolicy(input.store, input.sizingTier);
  return policy.runtime === "gce-vm" ? policy : null;
}

export async function stampGatewayRuntime(input: GatewayRuntimeStampInput): Promise<GatewayRuntime> {
  if (input.initial.gatewayId !== input.gatewayId) throw new Error(`gateway ${input.gatewayId}: initial runtime record names ${input.initial.gatewayId}`);
  const data: Partial<FleetRegistryRecord> = (await input.store.fleetRegistry.get(input.gatewayId)) ?? {};
  validateRuntimeObservation(data, input.gatewayId);
  if (isGatewayRuntime(data.runtime)) {
    await input.assertStorage?.(data.runtime);
    await reconcileStampedVmSpec(input, data);
    return data.runtime;
  }
  const policy = await newGatewayVmPolicy(input, data);
  const runtime: GatewayRuntime = policy?.runtime ?? "cluster";
  if (policy && !input.vmSpec) throw new Error(`gateway ${input.gatewayId}: gce-vm runtime needs a vmSpec`);
  await input.assertStorage?.(runtime);
  await input.store.fleetRegistry.upsert(input.gatewayId, input.initial, {
    runtime, ...(policy ? { vmSpec: { ...input.vmSpec!, ...tierVmShape(policy) } } : {}),
  });
  input.log(`[vm-gateway-runtime] ${input.gatewayId}: runtime stamped ${runtime}`);
  return runtime;
}

type VmInstanceRecord = HelmInstancesMap[string] & Partial<RuntimeUserIdentity>;

function withoutUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function vmRoutesFromRecords(records: readonly FleetRegistryRecord[]): Record<string, string> {
  const routes: Record<string, string> = {};
  for (const record of records) {
    if (resolveGatewayRuntime(record.runtime) !== "gce-vm") continue;
    const vm: Partial<GatewayVmState> | null | undefined = record.vm;
    if (vm && typeof vm.internalIp === "string" && vm.internalIp.length > 0 && vm.status === "RUNNING") {
      routes[record.gatewayId] = vm.internalIp;
    }
  }
  return routes;
}

function homeStorageIdOf(uid: string, user: PlatformUserRecord | null): string | undefined {
  const disk = user?.home.homeStorage?.disk as { id?: unknown } | undefined;
  if (disk?.id === undefined) return undefined;
  if (typeof disk.id !== "string" || disk.id.length === 0) throw new Error(`User ${uid}: home storage disk id is malformed`);
  return disk.id;
}

export function createVmGatewayRuntime(deps: VmGatewayRuntimeDeps): VmGatewayRuntime {
  const upgradeTimeout = deps.upgradeTimeout ?? "10m";
  let routesTail: Promise<void> = Promise.resolve();

  async function kubectl(args: string[], stdin?: string): Promise<string> {
    const result = await deps.runKubectl(args, stdin === undefined ? undefined : { stdin });
    if (result.code !== 0) {
      throw new Error(`kubectl ${args.slice(0, 3).join(" ")} failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result.stdout;
  }

  async function readSecret(name: string, key: string): Promise<string> {
    const { data } = JSON.parse(await kubectl(["get", "secret", name, "-n", deps.namespace, "-o", "json"])) as { data?: Record<string, unknown> };
    const raw = data && Object.hasOwn(data, key) ? data[key] : undefined;
    if (typeof raw !== "string" || raw.length === 0) throw new Error(`secret ${name}/${key} in ${deps.namespace} is empty or missing`);
    return Buffer.from(raw, "base64").toString("utf8");
  }

  async function bridgeIp(): Promise<string> {
    const ip = (await kubectl(["get", "svc", deps.bridgeServiceName, "-n", deps.namespace, "-o", "jsonpath={.status.loadBalancer.ingress[0].ip}"])).trim();
    if (!ip) throw new Error(`service ${deps.bridgeServiceName} in ${deps.namespace} has no internal load balancer IP yet`);
    return ip;
  }

  async function renderManifests(opts: Parameters<HelmRunner["upsertInstance"]>[0], desktop: GatewayVmDesktop): Promise<unknown[]> {
    const release = `octogee-gw-${opts.revisionId ?? opts.gatewayId}`;
    const args = [...helmTemplateArgsFromUpgradeArgs(buildUpgradeArgs({ ...opts, release, upgradeTimeout })), "--set", `computerDesktop=${desktop}`, "--set", "runtimeKind=gce-vm"];
    const rendered = await deps.runHelm(args);
    if (rendered.code !== 0) {
      throw new Error(`helm template ${release} failed (code=${rendered.code}): ${rendered.stderr.trim() || rendered.stdout.trim()}`);
    }
    return parseConcatenatedJson(await kubectl(["create", "--dry-run=client", "-o", "json", "-f", "-"], rendered.stdout));
  }

  function reconcileRoutes(): Promise<void> {
    const pending = routesTail.then(publishRoutes);
    routesTail = pending.catch(() => undefined);
    return pending;
  }

  async function publishRoutes(): Promise<void> {
    const routes = vmRoutesFromRecords(await deps.store.fleetRegistry.list({ runtime: "gce-vm" }));
    const manifest = JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: deps.routesConfigMap,
        namespace: deps.namespace,
        labels: { "app.kubernetes.io/managed-by": "glm-controller", "octogee.ai/controller": "cowboy" },
      },
      data: { [VM_ROUTES_CONFIGMAP_KEY]: JSON.stringify(routes) },
    });
    await kubectl(["apply", "-n", deps.namespace, "-f", "-"], `${manifest}\n`);
    deps.log(`[vm-gateway-runtime] routes reconciled: ${Object.keys(routes).length} VM gateway(s)`);
  }

  const vmLifecycle = createVmLifecycle({
    store: deps.store,
    vm: deps.vm,
    environment: deps.environment,
    vmSpec: deps.vmSpec,
    readDesiredStatus: deps.readDesiredStatus,
    journalBootUpgrade: deps.journalBootUpgrade,
    resolveBridge: bridgeIp,
    reconcileRoutes,
    wait: deps.wait,
    disposableParking: deps.disposableParking,
    homeCheckpointTimeoutMs: deps.homeCheckpointTimeoutMs,
    homeCheckpointPollMs: deps.homeCheckpointPollMs,
    onVmCreationSettled: deps.onVmCreationSettled,
    now: deps.now,
    log: deps.log,
  });

  return {
    async readDeployedInstances() {
      const entries: Array<[string, HelmInstancesMap[string]]> = [];
      for (const record of await deps.store.fleetRegistry.list({ runtime: "gce-vm" })) {
        const instance = record.vmInstance as HelmInstancesMap[string] | undefined;
        if (instance) entries.push([record.gatewayId, instance]);
      }
      return Object.fromEntries(entries);
    },

    async readDeployedInstance({ gatewayId }) {
      const instance = (await deps.store.fleetRegistry.get(gatewayId))?.vmInstance as HelmInstancesMap[string] | undefined;
      return instance ?? null;
    },

    async upsertInstance(opts) {
      const { gatewayId } = opts;
      if (deps.ensureAuthSecret) await deps.ensureAuthSecret({ namespace: deps.namespace, gatewayId });
      const desktop = vmSpecDesktop((await deps.store.fleetRegistry.get(gatewayId))?.vmSpec, deps.vmSpec);
      const [manifests, bridge] = await Promise.all([renderManifests(opts, desktop), bridgeIp()]);
      const ownerUid = opts.builderIdentity?.ownerUid;
      const homeStorageId = ownerUid ? homeStorageIdOf(ownerUid, await deps.store.users.records.get(ownerUid)) : undefined;
      const bundle = await renderVmRuntimeBundle({
        ...(homeStorageId ? { homeStorageId } : {}),
        ...(opts.builderIdentity ? { builderIdentity: opts.builderIdentity } : {}),
        gatewayId,
        namespace: deps.namespace,
        imageRepository: opts.imageRepository,
        imageTag: opts.imageTag,
        desktop,
        computer: { serviceAccountEmail: deps.vmSpec.serviceAccountEmail, projectId: deps.computeProjectId },
        manifests,
        readSecret,
        hostAliases: Object.fromEntries(deps.hostAliasNames.map((name) => [name, bridge])),
        kubernetes: deps.kubernetes,
        now: deps.now,
      });
      const instance: VmInstanceRecord = withoutUndefined({
        enabled: true,
        image: { repository: opts.imageRepository, tag: opts.imageTag },
        gatewayId,
        chartFingerprint: opts.chartFingerprint,
        deploymentIntentFingerprint: opts.deploymentIntentFingerprint,
        serviceAccountName: opts.serviceAccountName,
        serviceAccount: opts.serviceAccount,
        gatewayContainerSecurityContext: opts.gatewayContainerSecurityContext,
        builderAccess: opts.builderAccess,
        profile: opts.profile,
        gatewayClass: opts.gatewayClass,
        imageProfile: opts.imageProfile,
        ownerUid,
        builderSlug: opts.builderIdentity?.builderSlug,
        sizingTier: opts.sizingTier,
        replicas: opts.replicas,
      });
      if (opts.replicas === 0) {
        await vmLifecycle.pauseVm(gatewayId);
      } else {
        await vmLifecycle.ensureVm(gatewayId, `${opts.imageRepository}:${opts.imageTag}`, ownerUid, bridge);
      }
      if (ownerUid && bundle.volumes.some(volume => volume.name === "project-materializations" && volume.kind === "ephemeral")) {
        await deps.store.users.records.patch(ownerUid, { home: { projectStorageNativeBoot: true } });
      }
      await deps.store.gateways.vmRuntime.put(gatewayId, bundle);
      deps.log(`[vm-gateway-runtime] ${gatewayId}: runtime bundle ${bundle.version} rendered (${opts.imageTag})`);
      await reconcileRoutes();
      await deps.store.fleetRegistry.patch(gatewayId, { vmInstance: { ...instance } });
    },

    async removeInstance({ gatewayId, awaitHomeCheckpoint }) {
      const parked = await vmLifecycle.parkVm(gatewayId, { awaitHomeCheckpoint: awaitHomeCheckpoint === true });
      await deps.store.gateways.vmRuntime.delete(gatewayId);
      await recordVmObservation(deps, gatewayId, { vm: parked, vmInstance: { clear: true } }, "park");
      await reconcileRoutes();
    },

    async listPendingReleases() {
      return [];
    },

    async recoverRelease({ gatewayId }) {
      return `${gatewayId}: VM runtime has no Helm release to recover`;
    },

    readDeploymentPrerequisiteError: vmLifecycle.readDeploymentPrerequisiteError,
    recoverUnreachable: vmLifecycle.recoverUnreachable,
    deleteVm: vmLifecycle.deleteVm,
    replaceStoppedVm: vmLifecycle.replaceStoppedVm,
    detectPreemption: vmLifecycle.detectPreemption,
  };
}

export function createRuntimeDispatchingHelmRunner(input: {
  cluster: HelmRunner;
  vm: HelmRunner;
  isVmGateway: (gatewayId: string) => Promise<boolean>;
}): HelmRunner {
  const pick = async (gatewayId: string) => ((await input.isVmGateway(gatewayId)) ? input.vm : input.cluster);
  async function assertObservedRuntime(gatewayId: string, hasCluster: boolean, hasVm: boolean): Promise<void> {
    const vmStamped = await input.isVmGateway(gatewayId);
    if ((hasCluster && hasVm) || (vmStamped && hasCluster) || (!vmStamped && hasVm)) {
      throw new Error(`gateway ${gatewayId}: conflicting cluster and VM deployments or runtime stamp`);
    }
  }
  return {
    async readDeployedInstances(opts) {
      const [cluster, vm] = await Promise.all([input.cluster.readDeployedInstances(opts), input.vm.readDeployedInstances(opts)]);
      await Promise.all([...new Set([...Object.keys(cluster), ...Object.keys(vm)])]
        .map((gatewayId) => assertObservedRuntime(gatewayId, Boolean(cluster[gatewayId]), Boolean(vm[gatewayId]))));
      return { ...cluster, ...vm };
    },
    async readDeployedInstance(opts) {
      const [cluster, vm] = await Promise.all([input.cluster.readDeployedInstance(opts), input.vm.readDeployedInstance(opts)]);
      await assertObservedRuntime(opts.gatewayId, Boolean(cluster), Boolean(vm));
      return cluster ?? vm;
    },
    async upsertInstance(opts) {
      return (await pick(opts.gatewayId)).upsertInstance(opts);
    },
    async removeInstance(opts) {
      return (await pick(opts.gatewayId)).removeInstance(opts);
    },
    listPendingReleases: (opts) => input.cluster.listPendingReleases(opts),
    async recoverRelease(opts) {
      return (await pick(opts.gatewayId)).recoverRelease(opts);
    },
  };
}
