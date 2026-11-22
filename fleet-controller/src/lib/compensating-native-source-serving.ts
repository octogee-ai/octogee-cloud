import { randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { guestReleaseInstalled } from "@octogee/core/isolated-gateway-lifecycle";
import type { PlatformStateStore, PlatformStateTransaction } from "@octogee/core/platform-state";
import { dualReadIsolatedProfileImage, releasePayloadHash } from "@octogee/shared/types/gateway-releases";
import { isGatewayVmImageObservation } from "@octogee/shared/types/glm";
import { gatewayHeartbeatMatchesImageTag } from "@octogee/shared/types/image-tag";
import { requestFleetState } from "../fleet-state-client.js";
import type { CompensatingNativeReturnActions, CompensatingNativeReturnAuthority } from "./compensating-native-return.js";

export type CompensatingSourceServingInputs = {
  privateKey: string;
  port: number;
  edgePort: number;
  fetchImpl?: typeof fetch;
};

function requireServing(condition: unknown): asserts condition {
  if (!condition) throw new Error("Original Native serving witness is unavailable or changed");
}

async function requireOriginalServingClaim(tx: PlatformStateTransaction, scope: CompensatingNativeReturnAuthority) {
  const { uid, slug, sourceGatewayId, sourceEpoch, operationId, sourceRelease, attemptId } = scope;
  const [owner, assignments, root, operation] = await Promise.all([
    tx.users.records.get(uid), tx.gateways.assignments.listForUid(uid), tx.gateways.roots.get(sourceGatewayId),
    tx.journal.operations.get(operationId),
  ]);
  const original = assignments[0];
  requireServing(original && owner && root && operation);
  requireServing([
    assignments.length === 1, original.gatewayId === sourceGatewayId,
    original.epoch === sourceEpoch, original.state === "quiescing",
    owner.slug === slug, owner.gateway?.gatewayId === sourceGatewayId,
    owner.fences.migration?.operationId === operationId,
    root.liveRelease === sourceRelease, root.desiredRelease === sourceRelease,
    root.runtimeRestartFence?.attemptId === attemptId, root.runtimeRestartFence?.phase === "ingress-resumed",
    operation.status === "running", operation.cutoverCommittedAt === undefined,
  ].every(Boolean));
}

async function readOriginalServing(store: PlatformStateStore, scope: CompensatingNativeReturnAuthority) {
  return store.transaction({ readOnly: true, label: "compensating-native-return.source-serving" }, async tx => {
    const { slug, sourceGatewayId, sourceRelease, source } = scope;
    await requireOriginalServingClaim(tx, scope);
    const [runtime, release] = await Promise.all([
      tx.fleetRegistry.get(sourceGatewayId), tx.gateways.releases.get(sourceGatewayId, sourceRelease),
    ]);
    requireServing(runtime && release);
    const vm = runtime.vm;
    requireServing(vm?.internalIp);
    requireServing([
      runtime.runtime === "gce-vm", vm.status === "RUNNING", vm.internalIp === source.internalIp, isIPv4(vm.internalIp),
      vm.instanceId === source.instanceId, vm.instanceName === source.instanceName, vm.zone === source.zone,
      isDeepStrictEqual(runtime.heartbeat.mountedCustomers, [slug]), !runtime.heartbeat.migratingIn?.length,
      guestReleaseInstalled(release.payload, source.instanceId, runtime.vmImages, vm.startedAt ?? 0),
    ].every(Boolean));
    const images = runtime.vmImages;
    requireServing(isGatewayVmImageObservation(images));
    const repository = (release.payload.profileImages ? dualReadIsolatedProfileImage(release.payload.profileImages) : release.payload).imageRepository;
    const reference = images.containers.find(role => role.name === "gateway")?.imageReference;
    const tag = reference?.startsWith(repository + ":") ? reference.slice(repository.length + 1) : undefined;
    requireServing(tag);
    return { tag, vmStartedAt: vm.startedAt, imageContainers: images.containers, payloadHash: releasePayloadHash(release.payload) };
  });
}

async function fetchBody(response: Response) {
  requireServing(response.ok);
  return await response.json() as Record<string, unknown> | null;
}

export function createCompensatingSourceServingVerifier(input: CompensatingSourceServingInputs & {
  store: PlatformStateStore;
}): CompensatingNativeReturnActions["verifySourceServing"] {
  const fetchDirect: typeof fetch = (url, options) => (input.fetchImpl ?? fetch)(url, { ...options, redirect: "error" });
  const timeoutMs = 5000;
  return async (scope, current) => {
    requireServing([input.port, input.edgePort].every(port => Number.isInteger(port) && port > 0 && port <= 65535) && input.port !== input.edgePort);
    await current();
    const before = await readOriginalServing(input.store, scope);
    const baseUrl = `http://${scope.source.internalIp}:${input.port}`;
    const edgeUrl = `http://${scope.source.internalIp}:${input.edgePort}/health`;
    const [health, ready, state, edge] = await Promise.all([
      fetchDirect(baseUrl + "/health", { signal: AbortSignal.timeout(timeoutMs) }).then(fetchBody),
      fetchDirect(baseUrl + "/surge-ready", { signal: AbortSignal.timeout(timeoutMs) }).then(fetchBody),
      requestFleetState({ baseUrl, gatewayId: scope.sourceGatewayId, privateKey: input.privateKey, timeoutMs,
        fetchImpl: fetchDirect, newRequestId: randomUUID }).then(fetchBody),
      fetchDirect(edgeUrl, { signal: AbortSignal.timeout(timeoutMs) }).then(fetchBody),
    ]);
    requireServing(health?.status === "ready" && ready && state && typeof state.version === "string");
    requireServing([
      edge?.service === "gateway-edge", edge?.status === "ok",
      ready.ready === true, ready.openclawUp === true, ready.handoffReleased === true,
      ready.brokerProfilesSettled === true, ready.dashboardBridgeReady === true,
      state.gatewayId === scope.sourceGatewayId, state.status === "ready", gatewayHeartbeatMatchesImageTag(state.version, before.tag),
      isDeepStrictEqual(state.customers, [scope.slug]), state.migratingIn === undefined || isDeepStrictEqual(state.migratingIn, []),
    ].every(Boolean));
    await current();
    requireServing(isDeepStrictEqual(await readOriginalServing(input.store, scope), before));
    await current();
  };
}
