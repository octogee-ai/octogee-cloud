import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { loadSnapshot } from "@octogee/core/broker-user-snapshot";
import { requestHeldNativeSourceReconcile } from "@octogee/core/fleet-migration-client";
import { createCachedHouseModelResolver, createCachedUserAgentDefaultResolver } from "@octogee/core/model-broker/model-config";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { snapshotConfigFingerprint } from "@octogee/core/user-snapshot-mapping";
import type { HeldNativeSourceBinding } from "@octogee/shared/types/fleet-controller";
import type { UserDocuments } from "../user-documents.js";
import type { GatewayVmClient } from "./compute-vm.js";

type Scope = Pick<HeldNativeSourceBinding, "operationId" | "uid" | "slug" | "requestId" | "targetGatewayId" | "sourceEpoch" | "schedulerMigrationId"> & { sourceGatewayId: string };
type Backing = Pick<HeldNativeSourceBinding, "vmId" | "bootId" | "bootDiskId" | "homeDiskId">;
interface SourceDeps {
  store: PlatformStateStore;
  documents: UserDocuments;
  privateKey: string;
  port: string;
  vm: Pick<GatewayVmClient, "describe" | "readAttachedGuestDisks">;
}

export function createHeldNativeSourceReconciler(deps: SourceDeps) {
  async function readDesired(scope: Scope) {
    const { store, documents } = deps;
    if (!documents.projectRecipes) throw new Error("Missing authoritative source project records");
    const [owner, root, account] = await Promise.all([
      store.users.records.get(scope.uid), store.gateways.roots.get(scope.sourceGatewayId), documents.account(scope.uid),
    ]);
    if (!owner || !root || !account || owner.gateway?.gatewayId !== scope.sourceGatewayId || owner.slug !== scope.slug) {
      throw new Error("Held source lost owner custody");
    }
    const failures: unknown[] = [];
    const options = { platformConfig: store.config.platform, onError: (err: unknown) => failures.push(err) };
    const [house, userAgentDefault] = await Promise.all([
      createCachedHouseModelResolver(options)(), createCachedUserAgentDefaultResolver(options)(),
    ]);
    if (failures.length) throw new Error("Held source desired model settings are unavailable");
    const snapshot = await loadSnapshot({ store, records: { userDocuments: {
      agent: uid => documents.agent(uid), projectRecipes: slug => documents.projectRecipes!(slug),
    } } }, owner, account, { gatewayId: scope.sourceGatewayId, gatewayData: root, modelDials: { freeTierModelRef: house.ref, userAgentDefault } });
    if (!snapshot || snapshot.runtimeMutationFenced !== true || snapshot.runtimeReset || snapshot.restoreAuthority || snapshot.status !== "complete") {
      throw new Error("Held source lacks its complete fenced broker configuration");
    }
    return { fingerprint: snapshotConfigFingerprint(snapshot), roster: [...snapshot.agentIds].sort() };
  }

  async function readBoundUrl(scope: Scope, backing: Backing) {
    const runtime = await deps.store.fleetRegistry.get(scope.sourceGatewayId);
    const recorded = runtime?.vm;
    if (runtime?.runtime !== "gce-vm" || !recorded?.instanceName || !recorded.zone || !recorded.internalIp ||
        isIP(recorded.internalIp) !== 4 || recorded.instanceId !== backing.vmId || recorded.status !== "RUNNING") {
      throw new Error("Held source registry does not identify the backed-up VM");
    }
    const [live, disks, owner] = await Promise.all([
      deps.vm.describe(recorded.instanceName, recorded.zone),
      deps.vm.readAttachedGuestDisks(recorded.instanceName, recorded.zone, scope.uid, backing.vmId),
      deps.store.users.records.get(scope.uid),
    ]);
    if (!live || live.gatewayId !== scope.sourceGatewayId || live.status !== "RUNNING" || live.metadata["octogee-owner-uid"] !== scope.uid ||
        live.instanceId !== backing.vmId || live.internalIp !== recorded.internalIp || disks.homeDiskId !== backing.homeDiskId ||
        disks.bootDiskId !== backing.bootDiskId || owner?.home.homeDisk?.id !== backing.homeDiskId) {
      throw new Error("Held source VM or disks differ from the verified backup");
    }
    return `http://${live.internalIp}:${deps.port}`;
  }

  return async (authority: Scope & { claimStartedAt: number }, assertCurrent: () => Promise<void>,
    backedUp: { scope: Scope; source: Backing; holdGeneration: string }) => {
    const { claimStartedAt, ...scope } = authority;
    if (!isDeepStrictEqual(scope, backedUp.scope)) throw new Error("Held source backup has a different scope");
    await assertCurrent();
    const [sourceUrl, desired] = await Promise.all([readBoundUrl(scope, backedUp.source), readDesired(scope)]);
    const { sourceGatewayId: gatewayId, ...rest } = scope;
    const binding = { ...rest, ...backedUp.source, claimStartedAt, gatewayId, holdGeneration: backedUp.holdGeneration };
    await assertCurrent();
    const proof = await requestHeldNativeSourceReconcile({ binding, privateKey: deps.privateKey, sourceUrl });
    await assertCurrent();
    const [finalUrl, finalDesired] = await Promise.all([readBoundUrl(scope, backedUp.source), readDesired(scope)]);
    if (finalUrl !== sourceUrl || !isDeepStrictEqual(finalDesired, desired) || proof.appliedFingerprint !== desired.fingerprint) {
      throw new Error("Held source successful apply could not be matched to its current owner configuration");
    }
    await assertCurrent();
    return proof;
  };
}
