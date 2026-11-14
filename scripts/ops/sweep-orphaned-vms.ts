import "../src/main.js";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { type PlatformStateStore } from "@octogee/core/platform-state";
import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import { operatorPlatformStateStore } from "../lib/platform-state-store.js";

import { GATEWAY_VM_INSTANCE_PREFIX } from "../../shared/types/glm.js";

export interface SweepOrphanedVmsArgs {
  environment: "test" | "prod";
  apply: boolean;
  computeProjectId: string;
}

export function parseSweepOrphanedVmsArgs(argv: string[]): SweepOrphanedVmsArgs {
  const envArg = argv.find((arg) => arg.startsWith("--env="))?.slice("--env=".length);
  if (envArg !== "test" && envArg !== "prod") throw new Error("sweep-orphaned-vms needs --env=test|prod");
  const unknown = argv.filter((arg) => !arg.startsWith("--env=") && arg !== "--apply");
  if (unknown.length > 0) throw new Error(`sweep-orphaned-vms: unexpected arguments ${unknown.join(" ")}`);
  const settings = deploymentEnvironmentSettings(envArg);
  return { environment: envArg, apply: argv.includes("--apply"), computeProjectId: settings.clusterProjectId };
}

export interface TerminatedVm {
  name: string;
  zone: string;
  instanceId: string;
  ownerUid: string | null;
  lastStopTimestamp: string | null;
}

export interface VmReferences {
  parkedInstanceIds: ReadonlySet<string>;
  gatewayInstanceIds: ReadonlySet<string>;
  existingOwnerUids: ReadonlySet<string>;
}

export type VmVerdict =
  | { action: "keep"; reason: "parked" | "gateway" | "owner-active" }
  | { action: "delete"; reason: "owner-gone" | "no-owner" };

export function classifyTerminatedVm(vm: TerminatedVm, refs: VmReferences): VmVerdict {
  if (refs.parkedInstanceIds.has(vm.instanceId)) return { action: "keep", reason: "parked" };
  if (refs.gatewayInstanceIds.has(vm.instanceId)) return { action: "keep", reason: "gateway" };
  if (!vm.ownerUid) return { action: "delete", reason: "no-owner" };
  if (refs.existingOwnerUids.has(vm.ownerUid)) return { action: "keep", reason: "owner-active" };
  return { action: "delete", reason: "owner-gone" };
}

interface GcloudInstance {
  name?: unknown;
  id?: unknown;
  zone?: unknown;
  status?: unknown;
  lastStopTimestamp?: unknown;
  metadata?: { items?: Array<{ key?: unknown; value?: unknown }> };
}

export function terminatedVmFromGcloud(raw: GcloudInstance): TerminatedVm {
  if (typeof raw.name !== "string" || typeof raw.id !== "string" || typeof raw.zone !== "string") {
    throw new Error(`Compute returned an instance without name/id/zone: ${JSON.stringify(raw)}`);
  }
  const owner = raw.metadata?.items?.find((item) => item.key === "octogee-owner-uid")?.value;
  return {
    name: raw.name,
    zone: raw.zone.slice(raw.zone.lastIndexOf("/") + 1),
    instanceId: raw.id,
    ownerUid: typeof owner === "string" && owner.length > 0 ? owner : null,
    lastStopTimestamp: typeof raw.lastStopTimestamp === "string" ? raw.lastStopTimestamp : null,
  };
}

function run(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(" ")} failed (${result.status ?? "signal"}): ${result.stderr.trim()}`);
  return result.stdout;
}

function listTerminatedVms(args: SweepOrphanedVmsArgs): TerminatedVm[] {
  const raw = JSON.parse(run("gcloud", [
    "compute", "instances", "list",
    `--project=${args.computeProjectId}`,
    `--filter=name~^${GATEWAY_VM_INSTANCE_PREFIX}${args.environment}- AND status=TERMINATED`,
    "--format=json",
  ])) as GcloudInstance[];
  return raw.map(terminatedVmFromGcloud);
}

export async function readVmReferences(store: PlatformStateStore, vms: readonly TerminatedVm[]): Promise<VmReferences> {
  const parkedInstanceIds = new Set<string>();
  const gatewayInstanceIds = new Set<string>();
  const existingOwnerUids = new Set<string>();
  for (const vm of vms) {
    if (await store.users.records.findByVmInstanceId(vm.instanceId) !== null) parkedInstanceIds.add(vm.instanceId);
    if (await store.fleetRegistry.findByVmInstanceId(vm.instanceId) !== null) gatewayInstanceIds.add(vm.instanceId);
    if (vm.ownerUid && await store.users.records.get(vm.ownerUid) !== null) existingOwnerUids.add(vm.ownerUid);
  }
  return { parkedInstanceIds, gatewayInstanceIds, existingOwnerUids };
}

async function main(): Promise<void> {
  const args = parseSweepOrphanedVmsArgs(process.argv.slice(2));
  const store = await operatorPlatformStateStore(deploymentEnvironmentSettings(args.environment).targetId);
  const vms = listTerminatedVms(args);
  console.log(`${vms.length} TERMINATED ${GATEWAY_VM_INSTANCE_PREFIX}${args.environment}-* instance(s) in ${args.computeProjectId}`);
  const refs = await readVmReferences(store, vms);
  let deleted = 0;
  for (const vm of vms) {
    const verdict = classifyTerminatedVm(vm, refs);
    const stopped = vm.lastStopTimestamp ?? "unknown stop time";
    if (verdict.action === "keep") {
      console.log(`  keep   ${vm.name} (${vm.zone}, ${stopped}): ${verdict.reason}${vm.ownerUid ? ` owner=${vm.ownerUid}` : ""}`);
      continue;
    }
    console.log(`  ${args.apply ? "DELETE" : "delete"} ${vm.name} (${vm.zone}, ${stopped}): ${verdict.reason}${vm.ownerUid ? ` owner=${vm.ownerUid}` : ""}`);
    if (!args.apply) continue;
    run("gcloud", ["compute", "instances", "delete", vm.name, `--zone=${vm.zone}`, `--project=${args.computeProjectId}`, "--quiet"]);
    deleted += 1;
  }
  console.log(args.apply ? `deleted ${deleted} instance(s)` : "dry run; pass --apply to delete");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
