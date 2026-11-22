import { isIPv4 } from "node:net";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { GatewayVmClient } from "./compute-vm.js";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import type { AgentStoreHandoffAuthority, PrepareMigrationAgentStores } from "../migration-agent-stores.js";
import type { CompensatingNativeReturnActions, CompensatingNativeReturnAuthority, CompensatingNativeReturnProviders } from "./compensating-native-return.js";

export function createCompensatingNativeReturnActions(deps: {
  prepareSourceStores: PrepareMigrationAgentStores;
  sourceClient(source: CompensatingNativeReturnAuthority["source"], authority: AgentStoreHandoffAuthority): Promise<MigrationClient>;
  verifySourceServing: CompensatingNativeReturnActions["verifySourceServing"];
}): CompensatingNativeReturnActions {
  const owned = (authority: CompensatingNativeReturnAuthority, assertCurrent: () => Promise<void>) =>
    ({ expectedUserUid: authority.uid, assertCurrent });
  return {
    prepareSourceStores: (authority, assertCurrent) =>
      deps.prepareSourceStores(authority.sourceGatewayId, authority.slug, owned(authority, assertCurrent)),
    async resumeSourceScheduler(authority, assertCurrent) {
      const client = await deps.sourceClient(authority.source, owned(authority, assertCurrent));
      await assertCurrent();
      await client.scheduler({ gatewayId: authority.sourceGatewayId, migrationId: authority.schedulerMigrationId, slug: authority.slug, phase: "resume" });
    },
    async resumeSourceIngress(authority, assertCurrent) {
      const client = await deps.sourceClient(authority.source, owned(authority, assertCurrent));
      await assertCurrent();
      await client.resume({ gatewayId: authority.sourceGatewayId, migrationId: `mig-${authority.operationId}`, slug: authority.slug });
    },
    verifySourceServing: deps.verifySourceServing,
  };
}

export function createCompensatingNativeOriginalObserver(deps: {
  store: PlatformStateStore;
  vm: Pick<GatewayVmClient, "describe" | "readAttachedGuestDisks">;
}): CompensatingNativeReturnProviders["observeOriginalSource"] {
  return async ({ sourceGatewayId, uid, slug }) => {
    const [runtime, owner] = await Promise.all([deps.store.fleetRegistry.get(sourceGatewayId), deps.store.users.records.get(uid)]);
    const recorded = runtime?.vm;
    if (runtime?.runtime !== "gce-vm" || owner?.gateway?.gatewayId !== sourceGatewayId || owner.slug !== slug) {
      throw new Error("Compensating Native return original source is unavailable");
    }
    assertRegistryIdentity(recorded);
    const [live, disks] = await Promise.all([
      deps.vm.describe(recorded.instanceName, recorded.zone),
      deps.vm.readAttachedGuestDisks(recorded.instanceName, recorded.zone, uid, recorded.instanceId),
    ]);
    if (!live || ![live.status === "RUNNING", live.instanceId === recorded.instanceId, live.name === recorded.instanceName,
      live.zone === recorded.zone, live.gatewayId === sourceGatewayId, live.internalIp === recorded.internalIp,
      live.metadata["octogee-owner-uid"] === uid, disks.homeDiskId === owner.home.homeDisk?.id].every(Boolean)) {
      throw new Error("Compensating Native return source provider identity changed");
    }
    return { instanceId: recorded.instanceId, instanceName: recorded.instanceName, zone: recorded.zone, internalIp: recorded.internalIp,
      bootDiskId: disks.bootDiskId, homeDiskId: disks.homeDiskId };
  };
}

function assertRegistryIdentity(vm: NonNullable<Awaited<ReturnType<PlatformStateStore["fleetRegistry"]["get"]>>>["vm"]):
  asserts vm is NonNullable<typeof vm> & { instanceName: string; zone: string; instanceId: string; internalIp: string } {
  if (!vm?.instanceName || !vm.zone || !vm.instanceId || !vm.internalIp || !isIPv4(vm.internalIp) || vm.status !== "RUNNING") {
    throw new Error("Compensating Native return original source identity is unavailable");
  }
}
