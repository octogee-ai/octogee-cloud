import type { UntypedRecord } from "@octogee/core/platform-state";
import type { GatewayVmClient } from "./compute-vm.js";

export function nativeReturnSourceIdentity(runtime: UntypedRecord | undefined, root: UntypedRecord | undefined) {
  const vm = runtime?.vm;
  if (runtime?.runtime !== "gce-vm" || root?.gatewayClass !== "isolated" ||
      !["paused", "retired"].includes(root.desiredStatus) ||
      ![root.ownerUid, root.builderSlug, vm?.instanceName, vm?.zone, vm?.instanceId].every(v => typeof v === "string" && v.length > 0)) return null;
  return { ownerUid: root.ownerUid, slug: root.builderSlug, desiredStatus: root.desiredStatus,
    instanceName: vm.instanceName, zone: vm.zone, instanceId: vm.instanceId };
}

export type NativeReturnSourceState = "running" | "suspended" | "stopped";
export type ParkedVmPowerStatus = "SUSPENDED" | "TERMINATED" | "STOPPED";

export async function observeNativeReturnSource(vm: Pick<GatewayVmClient, "describe">,
  identity: { instanceName: string; zone: string; instanceId: string }):
  Promise<{ state: NativeReturnSourceState; powerStatus?: ParkedVmPowerStatus }> {
  const current = await vm.describe(identity.instanceName, identity.zone);
  if (current === null) return { state: "stopped" };
  if (current.instanceId !== identity.instanceId) return { state: "running" };
  const status = current.status;
  if (status === "SUSPENDED") return { state: "suspended", powerStatus: status };
  if (status === "TERMINATED" || status === "STOPPED") return { state: "stopped", powerStatus: status };
  return { state: "running" };
}

export async function nativeReturnSourceStopped(vm: Pick<GatewayVmClient, "describe">,
  identity: NonNullable<ReturnType<typeof nativeReturnSourceIdentity>>): Promise<boolean> {
  return (await observeNativeReturnSource(vm, identity)).state !== "running";
}
