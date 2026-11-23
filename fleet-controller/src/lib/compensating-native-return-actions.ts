import { isIPv4 } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { createHeldReturnStoreCustodyVerifier } from "@octogee/core/agent-store-credentials";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { GatewayVmClient } from "./compute-vm.js";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import type { PrepareMigrationAgentStores } from "../migration-agent-stores.js";
import type { CompensatingNativeReturnActions, CompensatingNativeReturnAuthority, CompensatingNativeReturnProviders } from "./compensating-native-return.js";

export function createCompensatingNativeReturnActions(deps: {
  prepareSourceStores: PrepareMigrationAgentStores;
  sourceClient(gatewayId: string, source: CompensatingNativeReturnAuthority["source"], prepareStores: PrepareMigrationAgentStores): Promise<Pick<MigrationClient, "resume" | "scheduler">>;
  verifyRetiredSourceStores: CompensatingNativeReturnActions["prepareSourceStores"];
  verifySourceServing: CompensatingNativeReturnActions["verifySourceServing"];
}): CompensatingNativeReturnActions {
  function prepareStores(authority: CompensatingNativeReturnAuthority, assertCurrent: () => Promise<void>): PrepareMigrationAgentStores {
    return async (gatewayId, slug) => {
      if (gatewayId !== authority.sourceGatewayId || slug !== authority.slug) {
        throw new Error("Compensating Native return store scope changed");
      }
      if (authority.retiredTarget) await deps.verifyRetiredSourceStores(authority, assertCurrent);
      else await deps.prepareSourceStores(gatewayId, slug, { expectedUserUid: authority.uid, assertCurrent });
    };
  }

  return {
    prepareSourceStores: (authority, assertCurrent) =>
      prepareStores(authority, assertCurrent)(authority.sourceGatewayId, authority.slug),
    async resumeSourceScheduler(authority, assertCurrent) {
      const client = await deps.sourceClient(authority.sourceGatewayId, authority.source, prepareStores(authority, assertCurrent));
      await assertCurrent();
      await client.scheduler({ gatewayId: authority.sourceGatewayId, migrationId: authority.schedulerMigrationId, slug: authority.slug, phase: "resume" });
    },
    async resumeSourceIngress(authority, assertCurrent) {
      const client = await deps.sourceClient(authority.sourceGatewayId, authority.source, prepareStores(authority, assertCurrent));
      await assertCurrent();
      await client.resume({ gatewayId: authority.sourceGatewayId, migrationId: `mig-${authority.operationId}`, slug: authority.slug, requireExactAcknowledgement: true });
    },
    verifySourceServing: deps.verifySourceServing,
  };
}

export function createRetiredNativeSourceStoreVerifier(
  store: PlatformStateStore, adminDsn: string,
): CompensatingNativeReturnActions["prepareSourceStores"] {
  const verify = createHeldReturnStoreCustodyVerifier(adminDsn, { targetState: "retired" });
  return async (authority, assertCurrent) => {
    await assertCurrent();
    const read = () => store.users.agentStores.list(authority.uid);
    const before = await read();
    if (!before.length || before.some(row => row.gatewayId !== authority.sourceGatewayId)) {
      throw new Error("Compensating Native return original agent-store inventory is unavailable or changed");
    }
    await verify({ ...authority, schemas: before.map(row => row.schema) });
    if (!isDeepStrictEqual(await read(), before)) {
      throw new Error("Compensating Native return original agent-store inventory changed during verification");
    }
    await assertCurrent();
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
