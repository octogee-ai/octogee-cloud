import { isDeepStrictEqual } from "node:util";
import { gatewayScopedJobId, signFleetRequest } from "./fleet-signature.js";
import {
  isSharedMaintenancePublication, sharedMaintenanceCompletionPurpose,
  type SharedMaintenanceRole, type SharedMaintenanceStartupEnrollment, type SharedMaintenanceCompletionReceipt,
} from "./shared-maintenance-startup.js";

type LaunchRequest = SharedMaintenanceStartupEnrollment & { nonce: string };
type RoleIdentity = {
  previousContainerId: string;
  runningContainerId: string;
  buildId: string;
  acceptedImageId: string;
  runningImageId: string;
};
type VerifiedRoleInventory = Record<SharedMaintenanceRole, RoleIdentity>;
type PodBinding = {
  namespace: string;
  gatewayId: string;
  podUid: string;
  serviceAccountName: string;
  execRole: SharedMaintenanceRole;
};
type LaunchAuthority = {
  namespace: string;
  gatewayId: string;
  podUid: string;
  serviceAccountName: string;
  attemptId: string;
  artifactSetId: string;
  roles: VerifiedRoleInventory;
  verifiedRestoredArchive: { attemptId: string; sha256: string };
};

const sha256 = /^[a-f0-9]{64}$/;
const image = /^sha256:[a-f0-9]{64}$/;

function bindingMatches(request: LaunchRequest, binding: PodBinding) {
  return binding.namespace === request.namespace &&
    binding.gatewayId === request.gatewayId && binding.podUid === request.podUid && binding.serviceAccountName.length > 0 &&
    request.role === binding.execRole;
}

function authorityMatches(request: LaunchRequest, binding: PodBinding, authority: LaunchAuthority): boolean {
  const { roles, verifiedRestoredArchive } = authority;
  if (authority.namespace !== binding.namespace || authority.gatewayId !== binding.gatewayId || authority.podUid !== binding.podUid ||
      authority.serviceAccountName !== binding.serviceAccountName || authority.attemptId !== request.attemptId ||
      authority.artifactSetId !== request.artifactSetId || !sha256.test(request.artifactSetId) ||
      verifiedRestoredArchive.attemptId !== request.attemptId || !sha256.test(verifiedRestoredArchive.sha256) ||
      roles[request.role]?.buildId !== request.buildId) return false;
  const states = [roles.gateway, roles["gateway-edge"]];
  return states.every(role => role && image.test(role.acceptedImageId) && role.acceptedImageId === role.runningImageId && role.previousContainerId && role.runningContainerId) &&
    new Set(states.flatMap(role => [role.previousContainerId, role.runningContainerId])).size === 4;
}

type ScopedRole = { request: LaunchRequest; binding: PodBinding };

function signScopedLaunch(request: LaunchRequest, authority: LaunchAuthority, key: string, expiresAt: number) {
  const raw = JSON.stringify({ request, expiresAt, restoredArchiveSha256: authority.verifiedRestoredArchive.sha256,
    observedImageId: authority.roles[request.role].runningImageId });
  const purpose = gatewayScopedJobId(`shared-maintenance-startup/${request.attemptId}/${request.role}`, request.gatewayId);
  return { raw, signature: signFleetRequest(key, purpose, raw) };
}

export async function issueSharedMaintenanceStartupPair(input: {
  environment: "test";
  gateway: ScopedRole;
  edge: ScopedRole;
  readVerifiedAuthority(): Promise<LaunchAuthority | null>;
  enrolledIssuerPrivateKey: string;
  now?: () => number;
}) {
  if (input.environment !== "test" || input.gateway.request.role !== "gateway" || input.edge.request.role !== "gateway-edge" ||
      input.gateway.request.nonce === input.edge.request.nonce) return null;
  const scoped = [input.gateway, input.edge];
  if (!scoped.every(({ request, binding }) => bindingMatches(request, binding) && sha256.test(request.nonce))) return null;
  const authority = await input.readVerifiedAuthority();
  if (!authority || !scoped.every(({ request, binding }) => authorityMatches(request, binding, authority)) ||
      !isDeepStrictEqual(await input.readVerifiedAuthority(), authority)) return null;
  const expiresAt = (input.now ?? Date.now)() + 10_000;
  return {
    gateway: signScopedLaunch(input.gateway.request, authority, input.enrolledIssuerPrivateKey, expiresAt),
    "gateway-edge": signScopedLaunch(input.edge.request, authority, input.enrolledIssuerPrivateKey, expiresAt),
  };
}


export async function issueSharedMaintenanceCompletion(input: {
  environment: "test";
  gateway: ScopedRole;
  edge: ScopedRole;
  readVerifiedPublication(): Promise<(LaunchAuthority & { publication: SharedMaintenanceCompletionReceipt["publication"] }) | null>;
  enrolledIssuerPrivateKey: string;
  now?: () => number;
}) {
  const scoped = [input.gateway, input.edge];
  if (input.environment !== "test" || input.gateway.request.role !== "gateway" || input.edge.request.role !== "gateway-edge" ||
      !scoped.every(({ request, binding }) => bindingMatches(request, binding))) return null;
  const final = await input.readVerifiedPublication();
  const now = (input.now ?? Date.now)();
  if (!final || !isSharedMaintenancePublication(final.publication, now) ||
      !scoped.every(({ request, binding }) => authorityMatches(request, binding, final)) ||
      !isDeepStrictEqual(await input.readVerifiedPublication(), final)) return null;
  const { role: _role, nonce: _nonce, ...scope } = input.gateway.request;
  const receipt: SharedMaintenanceCompletionReceipt = {
    scope,
    images: { gateway: final.roles.gateway.runningImageId, "gateway-edge": final.roles["gateway-edge"].runningImageId },
    restoredArchiveSha256: final.verifiedRestoredArchive.sha256,
    publication: final.publication,
  };
  const raw = JSON.stringify(receipt);
  return { raw, signature: signFleetRequest(input.enrolledIssuerPrivateKey, sharedMaintenanceCompletionPurpose(scope), raw) };
}
