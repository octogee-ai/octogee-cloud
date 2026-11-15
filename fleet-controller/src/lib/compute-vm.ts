import { createVmHomeClient } from "./compute-home.js";
import type { GatewayVmBootDiskType, GatewayVmDesktop, GatewayVmProvisioningModel, RetainedUserHome } from "@octogee/shared/types/glm";

export interface ComputeRequest {
  (opts: { url: string; method: string; body?: unknown }): Promise<{ status: number; data?: unknown }>;
}

export interface GatewayVmClientDeps {
  request: ComputeRequest;
  projectId: string;
  log: (msg: string) => void;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  journalMachineType?: (input: { instanceName: string; zone: string; machineType: string }, action: () => Promise<void>) => Promise<void>;
  journalProvisioningModel?: (input: { instanceName: string; zone: string; provisioningModel: GatewayVmProvisioningModel }, action: () => Promise<void>) => Promise<void>;
  journalHomeResize?: (input: { home: RetainedUserHome; ownerUid: string; sizeGb: number }, action: () => Promise<void>) => Promise<void>;
  operationTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface CreateGatewayVmInput {
  instanceName: string;
  zones: readonly string[];
  machineType: string;
  imageFamily: string;
  imageProject?: string;
  diskSizeGb: number;
  bootDiskType: GatewayVmBootDiskType;
  homeDiskSizeGb: number;
  retainedHome?: RetainedUserHome;
  image?: ComputeImageRef;
  provisioningModel: GatewayVmProvisioningModel;
  desktop: GatewayVmDesktop;
  serviceAccountEmail: string;
  subnetwork: string;
  labels: Record<string, string>;
  metadata: Record<string, string>;
}

export interface GatewayVmDescription {
  machineType: string | null;
  name: string;
  zone: string;
  status: string;
  instanceId: string | null;
  internalIp: string | null;
  provisioningModel: GatewayVmProvisioningModel | null;
  gatewayId: string | null;
  labels: Record<string, string>;
  metadata: Record<string, string>;
  lastStartedAt: number | null;
  serviceAccounts: Array<{ email: string; scopes: string[] }>;
}

export interface ListGatewayVmsInput {
  labels: Record<string, string>;
}

export interface StartGatewayVmResult {
  fellBackToStandard: boolean;
}

export interface BindGatewayVmInput {
  labels: Record<string, string>;
  metadata: Record<string, string>;
}

export interface ComputeImageRef {
  name: string;
  id: string;
  homeAdmission?: true;
  restoreGate?: true;
}

export const COMPUTER_HOME_RESTORE_METADATA_KEY = "octogee-home-restore";

export interface CreateGatewayVmResult {
  description: GatewayVmDescription;
  provisioningModel: GatewayVmProvisioningModel;
  fellBackToStandard: boolean;
  alreadyExisted: boolean;
}

export interface GatewayVmClient {
  expandHome(home: RetainedUserHome, ownerUid: string, sizeGb: number): Promise<RetainedUserHome>;
  retainHome(instanceName: string, zone: string, ownerUid: string): Promise<RetainedUserHome>;
  verifyDetachedHome(home: RetainedUserHome, ownerUid: string): Promise<void>;
  deleteRetainedHome(home: RetainedUserHome, ownerUid: string): Promise<void>;
  deleteRetainingHome(instanceName: string, zone: string, ownerUid: string, home: RetainedUserHome, instanceId: string): Promise<void>;
  create(input: CreateGatewayVmInput): Promise<CreateGatewayVmResult>;
  describe(instanceName: string, zone: string): Promise<GatewayVmDescription | null>;
  find(instanceName: string): Promise<GatewayVmDescription | null>;
  findByLabels(labels: Record<string, string>): Promise<GatewayVmDescription | null>;
  list(input: ListGatewayVmsInput): Promise<GatewayVmDescription[]>;
  bind(instanceName: string, zone: string, input: BindGatewayVmInput): Promise<void>;
  setServiceAccount(instanceName: string, zone: string, email: string): Promise<void>;
  setMachineType(instanceName: string, zone: string, machineType: string): Promise<void>;
  setProvisioningModel(instanceName: string, zone: string, provisioningModel: GatewayVmProvisioningModel): Promise<void>;
  stop(instanceName: string, zone: string): Promise<void>;
  start(instanceName: string, zone: string): Promise<StartGatewayVmResult>;
  suspend(instanceName: string, zone: string): Promise<void>;
  resume(instanceName: string, zone: string): Promise<StartGatewayVmResult>;
  delete(instanceName: string, zone: string): Promise<boolean>;
  lastPreemptedAt(instanceName: string, zone: string): Promise<number | null>;
  readBootImage(instanceName: string, zone: string): Promise<ComputeImageRef>;
  readFamilyImage(family: string, project?: string): Promise<ComputeImageRef>;
  readImage(name: string, project?: string): Promise<ComputeImageRef>;
}

export class ComputeOperationError extends Error {
  constructor(
    message: string,
    readonly codes: readonly string[],
  ) {
    super(message);
    this.name = "ComputeOperationError";
  }
}

const ZONE_EXHAUSTED_CODES = new Set([
  "ZONE_RESOURCE_POOL_EXHAUSTED",
  "ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS",
]);
export const GATEWAY_VM_NETWORK_TAG = "octogee-computer";
const GATEWAY_ID_METADATA_KEY = "gateway-id";
const DEFAULT_OPERATION_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

interface ComputeOperation {
  name?: string;
  status?: string;
  targetLink?: string;
  insertTime?: string;
  error?: { errors?: Array<{ code?: string; message?: string }> };
}

interface ComputeMetadataItem {
  key?: string;
  value?: string;
}

interface ComputeInstance {
  machineType?: string;
  id?: string;
  name?: string;
  zone?: string;
  status?: string;
  lastStartTimestamp?: string;
  networkInterfaces?: Array<{ networkIP?: string }>;
  scheduling?: { provisioningModel?: string };
  labels?: Record<string, string>;
  labelFingerprint?: string;
  metadata?: { fingerprint?: string; items?: ComputeMetadataItem[] };
  serviceAccounts?: Array<{ email?: string; scopes?: string[] }>;
  disks?: Array<{ boot?: boolean; source?: string; deviceName?: string; autoDelete?: boolean }>;
}

interface ComputeDisk {
  sourceImage?: string;
  sourceImageId?: string;
}

interface ComputeImage {
  name?: string;
  id?: string;
  labels?: Record<string, string>;
}

interface ComputeOperationList {
  items?: ComputeOperation[];
  nextPageToken?: string;
}

const PREEMPTED_OPERATION_FILTER = 'operationType = "compute.instances.preempted"';

function preemptionOf(instanceName: string, operation: ComputeOperation): number | null {
  if (operation.targetLink?.split("/").at(-1) !== instanceName) return null;
  const at = Date.parse(operation.insertTime ?? "");
  return Number.isFinite(at) ? at : null;
}

interface ComputeAggregatedInstances {
  items?: Record<string, { instances?: ComputeInstance[] }>;
  nextPageToken?: string;
}

function statusOf(err: unknown): number | undefined {
  const e = err as { response?: { status?: number }; code?: number | string } | null;
  const code = e?.response?.status ?? e?.code;
  return typeof code === "number" ? code : undefined;
}

function isProvisioningModel(value: unknown): value is GatewayVmProvisioningModel {
  return value === "SPOT" || value === "STANDARD";
}

function isZoneExhausted(err: unknown): boolean {
  return err instanceof ComputeOperationError && err.codes.some((code) => ZONE_EXHAUSTED_CODES.has(code));
}

function schedulingFor(provisioningModel: GatewayVmProvisioningModel): Record<string, unknown> {
  return provisioningModel === "SPOT"
    ? { provisioningModel: "SPOT", instanceTerminationAction: "STOP", automaticRestart: false, onHostMaintenance: "TERMINATE" }
    : { provisioningModel: "STANDARD", automaticRestart: true, onHostMaintenance: "MIGRATE" };
}

function metadataItems(metadata: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(metadata).map(([key, value]) => ({ key, value }));
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestampOf(value: string | undefined): number | null {
  const at = Date.parse(value ?? "");
  return Number.isFinite(at) ? at : null;
}

export function labelFilter(labels: Record<string, string>): string {
  return Object.entries(labels).map(([key, value]) => `(labels.${key} = ${JSON.stringify(value)})`).join(" AND ");
}

function metadataRecord(items: ComputeMetadataItem[] | undefined): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const item of items ?? []) {
    if (typeof item.key === "string" && item.key.length > 0) metadata[item.key] = item.value ?? "";
  }
  return metadata;
}

function zoneOf(instance: ComputeInstance, fallback: string): string {
  const segment = instance.zone?.split("/").at(-1);
  return segment && segment.length > 0 ? segment : fallback;
}

function carriesLabels(labels: Record<string, string>): (instance: ComputeInstance) => boolean {
  return (instance) => Object.entries(labels).every(([key, value]) => instance.labels?.[key] === value);
}

function ambiguousByName(instanceName: string, matches: ComputeInstance[]): string {
  return `find ${instanceName}: ${matches.length} instances named ${instanceName} (${matches.map((m) => zoneOf(m, "?")).join(", ")})`;
}

function ambiguousByLabels(filter: string, matches: ComputeInstance[]): string {
  const where = matches.map((m) => [m.name ?? "?", "in", zoneOf(m, "?")].join(" ")).join(", ");
  return `find ${filter}: ${matches.length} instances match (${where})`;
}

function describeInstance(instance: ComputeInstance, instanceName: string, zone: string): GatewayVmDescription {
  const model = instance.scheduling?.provisioningModel;
  const metadata = metadataRecord(instance.metadata?.items);
  return {
    machineType: nonEmpty(instance.machineType)?.split("/").at(-1) ?? null,
    name: instance.name ?? instanceName,
    zone,
    status: instance.status ?? "UNKNOWN",
    instanceId: nonEmpty(instance.id),
    internalIp: instance.networkInterfaces?.[0]?.networkIP ?? null,
    provisioningModel: isProvisioningModel(model) ? model : null,
    gatewayId: nonEmpty(metadata[GATEWAY_ID_METADATA_KEY]),
    labels: { ...(instance.labels ?? {}) },
    metadata,
    lastStartedAt: timestampOf(instance.lastStartTimestamp),
    serviceAccounts: (instance.serviceAccounts ?? []).map((account) => ({
      email: account.email ?? "", scopes: account.scopes ?? [],
    })),
  };
}

interface VmPlacement {
  outcome: "created" | "exists";
  zone: string;
  provisioningModel: GatewayVmProvisioningModel;
  fellBackToStandard: boolean;
}

type InsertInZone = (zone: string, model: GatewayVmProvisioningModel) => Promise<"created" | "exists">;

function modelAttempts(model: GatewayVmProvisioningModel): GatewayVmProvisioningModel[] {
  return model === "SPOT" ? ["SPOT", "STANDARD"] : [model];
}

// Zonal capacity is not the region's: a stockout walks the zones in the
// caller's order, and spot pays the ~4x on-demand rate only once every zone
// has refused it.
async function placeAcrossZones(input: CreateGatewayVmInput, insert: InsertInZone, log: (msg: string) => void): Promise<VmPlacement> {
  const attempts = modelAttempts(input.provisioningModel).flatMap((model) => input.zones.map((zone) => ({ model, zone })));
  let lastError: unknown;
  for (const [index, { model, zone }] of attempts.entries()) {
    try {
      const outcome = await insert(zone, model);
      return { outcome, zone, provisioningModel: model, fellBackToStandard: model !== input.provisioningModel };
    } catch (err) {
      if (!isZoneExhausted(err)) throw err;
      lastError = err;
      const next = attempts[index + 1];
      if (next) {
        const retry = next.model === "STANDARD" && model === "SPOT" ? "on-demand" : next.model;
        log(`[gateway-vm] ${input.instanceName}: ${model} capacity exhausted in ${zone}; retrying ${retry} in ${next.zone}`);
      }
    }
  }
  throw lastError;
}

export const VM_HOME_DISK_DEVICE_NAME = "octogee-home";

export const GATEWAY_VM_ACCESS_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

export function hasVmIdentity(description: GatewayVmDescription, email: string): boolean {
  return description.serviceAccounts.some((account) =>
    account.email === email && GATEWAY_VM_ACCESS_SCOPES.every((scope) => account.scopes.includes(scope)),
  );
}

export function instanceInsertBody(
  projectId: string,
  input: CreateGatewayVmInput,
  zone: string,
  provisioningModel: GatewayVmProvisioningModel,
  image: ComputeImageRef,
): Record<string, unknown> {
  const ownerUid = input.labels["octogee-owner-uid"];
  if (!ownerUid) throw new Error(`${input.instanceName}: a VM needs its octogee-owner-uid label`);
  return {
    name: input.instanceName,
    machineType: `zones/${zone}/machineTypes/${input.machineType}`,
    disks: [
      {
        boot: true,
        autoDelete: true,
        initializeParams: {
          sourceImage: `projects/${input.imageProject ?? projectId}/global/images/${image.name}`,
          diskSizeGb: String(input.diskSizeGb),
          diskType: `zones/${zone}/diskTypes/${input.bootDiskType}`,
        },
      },
      input.retainedHome ? {
        boot: false, autoDelete: false, deviceName: VM_HOME_DISK_DEVICE_NAME,
        source: input.retainedHome.source, mode: "READ_WRITE",
      } : {
        boot: false,
        autoDelete: false,
        deviceName: VM_HOME_DISK_DEVICE_NAME,
        initializeParams: {
          diskName: `${input.instanceName}-home`,
          diskSizeGb: String(input.homeDiskSizeGb),
          diskType: `zones/${zone}/diskTypes/pd-balanced`,
          labels: { "octogee-owner-uid": ownerUid, "octogee-storage": "customer-home" },
        },
      },
    ],
    networkInterfaces: [{ subnetwork: input.subnetwork }],
    serviceAccounts: [
      { email: input.serviceAccountEmail, scopes: [...GATEWAY_VM_ACCESS_SCOPES] },
    ],
    scheduling: schedulingFor(provisioningModel),
    shieldedInstanceConfig: { enableSecureBoot: false, enableVtpm: true, enableIntegrityMonitoring: true },
    tags: { items: [GATEWAY_VM_NETWORK_TAG] },
    labels: input.labels,
    metadata: { items: metadataItems(input.metadata) },
  };
}

async function readLastPreemptedAt(request: ComputeRequest, base: string, instanceName: string, zone: string): Promise<number | null> {
  let latest: number | null = null;
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ filter: PREEMPTED_OPERATION_FILTER });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await request({ url: `${base}/zones/${zone}/operations?${params.toString()}`, method: "GET" });
    const page = (res.data ?? {}) as ComputeOperationList;
    for (const operation of page.items ?? []) {
      const at = preemptionOf(instanceName, operation);
      if (at !== null && (latest === null || at > latest)) latest = at;
    }
    pageToken = nonEmpty(page.nextPageToken) ?? undefined;
  } while (pageToken);
  return latest;
}

async function readBootImage(request: ComputeRequest, base: string, instanceName: string, zone: string): Promise<ComputeImageRef> {
  const instance = ((await request({ url: `${base}/zones/${zone}/instances/${instanceName}`, method: "GET" })).data ?? {}) as ComputeInstance;
  const diskName = instance.disks?.find((disk) => disk.boot)?.source?.split("/").at(-1);
  if (!diskName) throw new Error(`boot image of ${instanceName}: compute returned no boot disk`);
  const disk = ((await request({ url: `${base}/zones/${zone}/disks/${diskName}`, method: "GET" })).data ?? {}) as ComputeDisk;
  const name = nonEmpty(disk.sourceImage?.split("/").at(-1));
  const id = nonEmpty(disk.sourceImageId);
  if (!name || !id) throw new Error(`boot image of ${instanceName}: boot disk ${diskName} records no source image`);
  return { name, id };
}

async function readImageRef(request: ComputeRequest, path: string, project: string): Promise<ComputeImageRef> {
  const res = await request({ url: `https://compute.googleapis.com/compute/v1/projects/${project}/global/images/${path}`, method: "GET" });
  const image = (res.data ?? {}) as ComputeImage;
  const name = nonEmpty(image.name);
  const id = nonEmpty(image.id);
  if (!name || !/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(name) || !id || !/^[1-9]\d{0,19}$/u.test(id)) throw new Error(`image ${project}/${path}: compute returned no valid current image`);
  return {
    name, id,
    ...(image.labels?.["home-admission"] === "retained-v1" ? { homeAdmission: true as const } : {}),
    ...(image.labels?.["home-restore"] === "gated-v1" ? { restoreGate: true as const } : {}),
  };
}

async function readFamilyImage(request: ComputeRequest, family: string, project: string): Promise<ComputeImageRef> {
  return readImageRef(request, `family/${family}`, project);
}

function operationWaiter(deps: GatewayVmClientDeps, base: string) {
  const operationTimeoutMs = deps.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  return async function waitForOperation(zone: string, operation: ComputeOperation, what: string): Promise<void> {
    const name = operation.name;
    if (!name) throw new Error(`${what}: compute returned an operation without a name`);
    const deadline = deps.now() + operationTimeoutMs;
    let current = operation;
    while (current.status !== "DONE") {
      if (deps.now() >= deadline) {
        throw new Error(`${what}: operation ${name} did not finish within ${operationTimeoutMs}ms`);
      }
      await deps.wait(pollIntervalMs);
      const res = await deps.request({ url: `${base}/zones/${zone}/operations/${name}`, method: "GET" });
      current = (res.data ?? {}) as ComputeOperation;
    }
    const errors = current.error?.errors ?? [];
    if (errors.length > 0) {
      const codes = errors.map((e) => e.code ?? "UNKNOWN");
      const detail = errors.map((e) => [e.code ?? "UNKNOWN", e.message ?? ""].join(": ")).join("; ");
      throw new ComputeOperationError(`${what}: ${detail}`, codes);
    }
  };
}

export function createGatewayVmClient(deps: GatewayVmClientDeps): GatewayVmClient {
  const base = `https://compute.googleapis.com/compute/v1/projects/${deps.projectId}`;

  const waitForOperation = operationWaiter(deps, base);

  async function readInstance(instanceName: string, zone: string): Promise<ComputeInstance | null> {
    try {
      const res = await deps.request({ url: `${base}/zones/${zone}/instances/${instanceName}`, method: "GET" });
      return (res.data ?? {}) as ComputeInstance;
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
  }

  async function describe(instanceName: string, zone: string): Promise<GatewayVmDescription | null> {
    const instance = await readInstance(instanceName, zone);
    return instance ? describeInstance(instance, instanceName, zone) : null;
  }

  async function aggregatedList(filter: string): Promise<ComputeInstance[]> {
    const instances: ComputeInstance[] = [];
    let pageToken: string | undefined;
    do {
      const pageQuery = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
      const res = await deps.request({ url: `${base}/aggregated/instances?filter=${encodeURIComponent(filter)}${pageQuery}`, method: "GET" });
      const page = (res.data ?? {}) as ComputeAggregatedInstances;
      instances.push(...Object.values(page.items ?? {}).flatMap((scope) => scope.instances ?? []));
      pageToken = nonEmpty(page.nextPageToken) ?? undefined;
    } while (pageToken);
    return instances;
  }

  async function aggregatedFind(
    filter: string,
    keep: (instance: ComputeInstance) => boolean,
    ambiguity: (matches: ComputeInstance[]) => string,
  ): Promise<GatewayVmDescription | null> {
    const matches = (await aggregatedList(filter)).filter(keep);
    if (matches.length > 1) throw new Error(ambiguity(matches));
    return matches.length === 1 ? describeInstance(matches[0], matches[0].name ?? "unknown", zoneOf(matches[0], "")) : null;
  }

  function find(instanceName: string): Promise<GatewayVmDescription | null> {
    return aggregatedFind(`name = "${instanceName}"`, (instance) => instance.name === instanceName, (matches) => ambiguousByName(instanceName, matches));
  }

  function findByLabels(labels: Record<string, string>): Promise<GatewayVmDescription | null> {
    const filter = labelFilter(labels);
    return aggregatedFind(filter, carriesLabels(labels), (matches) => ambiguousByLabels(filter, matches));
  }

  async function list(input: ListGatewayVmsInput): Promise<GatewayVmDescription[]> {
    const instances = (await aggregatedList(labelFilter(input.labels))).filter(carriesLabels(input.labels));
    return instances.map((instance) => describeInstance(instance, instance.name ?? "unknown", zoneOf(instance, "")));
  }

  async function bind(instanceName: string, zone: string, input: BindGatewayVmInput): Promise<void> {
    const instance = await readInstance(instanceName, zone);
    if (!instance) throw new Error(`bind ${instanceName}: instance is absent`);
    if (!instance.labelFingerprint || !instance.metadata?.fingerprint) {
      throw new Error(`bind ${instanceName}: compute returned no label/metadata fingerprint`);
    }
    const labelsRes = await deps.request({
      url: `${base}/zones/${zone}/instances/${instanceName}/setLabels`,
      method: "POST",
      body: { labelFingerprint: instance.labelFingerprint, labels: input.labels },
    });
    await waitForOperation(zone, (labelsRes.data ?? {}) as ComputeOperation, `setLabels ${instanceName}`);
    const merged = new Map<string, string>();
    for (const item of instance.metadata.items ?? []) {
      if (typeof item.key === "string" && typeof item.value === "string") merged.set(item.key, item.value);
    }
    for (const [key, value] of Object.entries(input.metadata)) merged.set(key, value);
    const metadataRes = await deps.request({
      url: `${base}/zones/${zone}/instances/${instanceName}/setMetadata`,
      method: "POST",
      body: { fingerprint: instance.metadata.fingerprint, items: [...merged].map(([key, value]) => ({ key, value })) },
    });
    await waitForOperation(zone, (metadataRes.data ?? {}) as ComputeOperation, `setMetadata ${instanceName}`);
  }

  async function insert(input: CreateGatewayVmInput, zone: string, provisioningModel: GatewayVmProvisioningModel, image: ComputeImageRef): Promise<"created" | "exists"> {
    let res: { status: number; data?: unknown };
    try {
      res = await deps.request({
        url: `${base}/zones/${zone}/instances`,
        method: "POST",
        body: instanceInsertBody(deps.projectId, input, zone, provisioningModel, image),
      });
    } catch (err) {
      if (statusOf(err) === 409) return "exists";
      throw err;
    }
    if (res.status === 409) return "exists";
    await waitForOperation(zone, (res.data ?? {}) as ComputeOperation, `insert ${input.instanceName}`);
    return "created";
  }

  async function create(input: CreateGatewayVmInput): Promise<CreateGatewayVmResult> {
    if (input.zones.length === 0) throw new Error(`${input.instanceName}: no zones to place it in`);
    const image = input.image
      ? await readImageRef(deps.request, input.image.name, input.imageProject ?? deps.projectId)
      : await readFamilyImage(deps.request, input.imageFamily, input.imageProject ?? deps.projectId);
    if (input.image && (image.name !== input.image.name || image.id !== input.image.id)) throw new Error("pinned VM image identity changed before creation");
    if (input.retainedHome && !image.homeAdmission) throw new Error("retained home requires the platform image's native migration and current-SSH admission contract");
    if (input.metadata[COMPUTER_HOME_RESTORE_METADATA_KEY] === "checkpoint" && !image.restoreGate) {
      throw new Error(`image ${image.name} does not gate the home's writers until a checkpoint restore admits them; refusing to create ${input.instanceName} for a checkpoint restore`);
    }
    const placement = await placeAcrossZones(input, (zone, model) => insert(input, zone, model, image), deps.log);
    const { outcome, zone, provisioningModel, fellBackToStandard } = placement;
    const description = await describe(input.instanceName, zone);
    if (!description) throw new Error(`insert ${input.instanceName}: instance vanished after ${outcome}`);
    if (outcome === "exists") {
      deps.log(`[gateway-vm] ${input.instanceName}: already exists in ${zone} (${description.status}); reusing`);
    }
    return {
      description,
      provisioningModel: description.provisioningModel ?? provisioningModel,
      fellBackToStandard,
      alreadyExisted: outcome === "exists",
    };
  }

  async function instanceAction(action: string, instanceName: string, zone: string, body?: unknown): Promise<void> {
    const res = await deps.request({ url: `${base}/zones/${zone}/instances/${instanceName}/${action}`, method: "POST", ...(body === undefined ? {} : { body }) });
    await waitForOperation(zone, (res.data ?? {}) as ComputeOperation, `${action} ${instanceName}`);
  }

  const lifecycle = (action: "stop" | "start" | "suspend" | "resume", instanceName: string, zone: string) => instanceAction(action, instanceName, zone);

  async function setServiceAccount(instanceName: string, zone: string, email: string): Promise<void> {
    await instanceAction("setServiceAccount", instanceName, zone, { email, scopes: [...GATEWAY_VM_ACCESS_SCOPES] });
  }

  async function setMachineType(instanceName: string, zone: string, machineType: string): Promise<void> {
    const action = () => instanceAction("setMachineType", instanceName, zone, { machineType: `zones/${zone}/machineTypes/${machineType}` });
    if (deps.journalMachineType) await deps.journalMachineType({ instanceName, zone, machineType }, action);
    else await action();
  }

  async function setProvisioningModel(instanceName: string, zone: string, provisioningModel: GatewayVmProvisioningModel): Promise<void> {
    const action = () => instanceAction("setScheduling", instanceName, zone, schedulingFor(provisioningModel));
    if (deps.journalProvisioningModel) await deps.journalProvisioningModel({ instanceName, zone, provisioningModel }, action);
    else await action();
  }

  async function start(instanceName: string, zone: string): Promise<StartGatewayVmResult> {
    try {
      await lifecycle("start", instanceName, zone);
      return { fellBackToStandard: false };
    } catch (err) {
      if (!isZoneExhausted(err)) throw err;
    }
    deps.log(`[gateway-vm] ${instanceName}: spot capacity exhausted in ${zone}; restarting on-demand`);
    await instanceAction("setScheduling", instanceName, zone, schedulingFor("STANDARD"));
    await lifecycle("start", instanceName, zone);
    return { fellBackToStandard: true };
  }

  async function resume(instanceName: string, zone: string): Promise<StartGatewayVmResult> {
    try {
      await lifecycle("resume", instanceName, zone);
      return { fellBackToStandard: false };
    } catch (err) {
      if (!isZoneExhausted(err)) throw err;
    }
    deps.log(`[gateway-vm] ${instanceName}: spot capacity exhausted in ${zone} on resume; stopping and restarting`);
    await lifecycle("stop", instanceName, zone);
    return start(instanceName, zone);
  }

  async function remove(instanceName: string, zone: string): Promise<boolean> {
    let res: { status: number; data?: unknown };
    try {
      res = await deps.request({ url: `${base}/zones/${zone}/instances/${instanceName}`, method: "DELETE" });
    } catch (err) {
      if (statusOf(err) === 404) {
        deps.log(`[gateway-vm] ${instanceName}: already absent`);
        return false;
      }
      throw err;
    }
    await waitForOperation(zone, (res.data ?? {}) as ComputeOperation, `delete ${instanceName}`);
    return true;
  }


  return {
    ...createVmHomeClient({ request: deps.request, projectId: deps.projectId, readInstance, journalHomeResize: deps.journalHomeResize,
      waitForOperation: (zone, operation, what) => waitForOperation(zone, operation as ComputeOperation, what) }),
    create,
    describe,
    find,
    findByLabels,
    list,
    bind,
    setServiceAccount,
    setMachineType,
    setProvisioningModel,
    stop: (instanceName, zone) => lifecycle("stop", instanceName, zone),
    start,
    suspend: (instanceName, zone) => lifecycle("suspend", instanceName, zone),
    resume,
    delete: remove, lastPreemptedAt: (instanceName, zone) => readLastPreemptedAt(deps.request, base, instanceName, zone),
    readImage: (name, project = deps.projectId) => readImageRef(deps.request, name, project),
    readBootImage: (name, zone) => readBootImage(deps.request, base, name, zone), readFamilyImage: (family, project = deps.projectId) => readFamilyImage(deps.request, family, project),
  };
}
