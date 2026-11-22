import { isDeepStrictEqual } from "node:util";
import { gatewayScopedJobId, signFleetRequest } from "./fleet-signature.js";
import type { SharedMaintenanceRole, SharedMaintenanceStartupEnrollment } from "./shared-maintenance-startup.js";

type LaunchRequest = SharedMaintenanceStartupEnrollment & { nonce: string };
type RoleIdentity = {
  previousContainerId: string;
  runningContainerId: string;
  buildId: string;
  acceptedImageId: string;
  runningImageId: string;
};
type VerifiedRoleInventory = Record<SharedMaintenanceRole, RoleIdentity>;
type PodBinding = { namespace: string; gatewayId: string; podUid: string; serviceAccountName: string; sidecarAudience: boolean };
type LaunchAuthority = {
  namespace: string;
  gatewayId: string;
  podUid: string;
  serviceAccountName: string;
  attemptId: string;
  roles: VerifiedRoleInventory;
  verifiedRestoredArchive: { attemptId: string; sha256: string };
};

const sha256 = /^[a-f0-9]{64}$/;
const image = /^sha256:[a-f0-9]{64}$/;

function bindingMatches(request: LaunchRequest, binding: PodBinding) {
  return request.namespace === "octogee-test" && binding.namespace === request.namespace &&
    binding.gatewayId === request.gatewayId && binding.podUid === request.podUid && binding.serviceAccountName.length > 0 &&
    (request.role === "gateway" || (request.role === "gateway-edge" && binding.sidecarAudience));
}

function authorityMatches(request: LaunchRequest, binding: PodBinding, authority: LaunchAuthority): boolean {
  const { roles, verifiedRestoredArchive } = authority;
  if (authority.namespace !== binding.namespace || authority.gatewayId !== binding.gatewayId || authority.podUid !== binding.podUid ||
      authority.serviceAccountName !== binding.serviceAccountName || authority.attemptId !== request.attemptId ||
      verifiedRestoredArchive.attemptId !== request.attemptId || !sha256.test(verifiedRestoredArchive.sha256) ||
      roles[request.role]?.buildId !== request.buildId) return false;
  const states = [roles.gateway, roles["gateway-edge"]];
  return states.every(role => role && image.test(role.acceptedImageId) && role.acceptedImageId === role.runningImageId && role.previousContainerId && role.runningContainerId) &&
    new Set(states.flatMap(role => [role.previousContainerId, role.runningContainerId])).size === 4;
}

export async function issueSharedMaintenanceStartupPermit(input: {
  request: LaunchRequest;
  binding: PodBinding;
  readVerifiedAuthority(): Promise<LaunchAuthority | null>;
  fleetPrivateKey: string;
  now?: () => number;
}) {
  const { request, binding, readVerifiedAuthority, fleetPrivateKey } = input;
  if (!bindingMatches(request, binding) || !sha256.test(request.nonce)) return null;
  const authority = await readVerifiedAuthority();
  if (!authority || !authorityMatches(request, binding, authority) ||
      !isDeepStrictEqual(await readVerifiedAuthority(), authority)) return null;
  const raw = JSON.stringify({ request, expiresAt: (input.now ?? Date.now)() + 10_000,
    restoredArchiveSha256: authority.verifiedRestoredArchive.sha256, observedImageId: authority.roles[request.role].runningImageId });
  const purpose = gatewayScopedJobId(`shared-maintenance-startup/${request.attemptId}/${request.role}`, request.gatewayId);
  return { raw, signature: signFleetRequest(fleetPrivateKey, purpose, raw) };
}
