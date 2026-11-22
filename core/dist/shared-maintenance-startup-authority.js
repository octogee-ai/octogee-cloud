import { isDeepStrictEqual } from "node:util";
import { gatewayScopedJobId, signFleetRequest } from "./fleet-signature.js";
import { isSharedMaintenancePublication, sharedMaintenanceCompletionPurpose, } from "./shared-maintenance-startup.js";
const sha256 = /^[a-f0-9]{64}$/;
const image = /^sha256:[a-f0-9]{64}$/;
function bindingMatches(request, binding) {
    return request.namespace === "octogee-test" && binding.namespace === request.namespace &&
        binding.gatewayId === request.gatewayId && binding.podUid === request.podUid && binding.serviceAccountName.length > 0 &&
        request.role === binding.execRole;
}
function authorityMatches(request, binding, authority) {
    const { roles, verifiedRestoredArchive } = authority;
    if (authority.namespace !== binding.namespace || authority.gatewayId !== binding.gatewayId || authority.podUid !== binding.podUid ||
        authority.serviceAccountName !== binding.serviceAccountName || authority.attemptId !== request.attemptId ||
        authority.artifactSetId !== request.artifactSetId || !sha256.test(request.artifactSetId) ||
        verifiedRestoredArchive.attemptId !== request.attemptId || !sha256.test(verifiedRestoredArchive.sha256) ||
        roles[request.role]?.buildId !== request.buildId)
        return false;
    const states = [roles.gateway, roles["gateway-edge"]];
    return states.every(role => role && image.test(role.acceptedImageId) && role.acceptedImageId === role.runningImageId && role.previousContainerId && role.runningContainerId) &&
        new Set(states.flatMap(role => [role.previousContainerId, role.runningContainerId])).size === 4;
}
function signScopedLaunch(request, authority, key, expiresAt) {
    const raw = JSON.stringify({ request, expiresAt, restoredArchiveSha256: authority.verifiedRestoredArchive.sha256,
        observedImageId: authority.roles[request.role].runningImageId });
    const purpose = gatewayScopedJobId(`shared-maintenance-startup/${request.attemptId}/${request.role}`, request.gatewayId);
    return { raw, signature: signFleetRequest(key, purpose, raw) };
}
export async function issueSharedMaintenanceStartupPair(input) {
    if (input.gateway.request.role !== "gateway" || input.edge.request.role !== "gateway-edge" ||
        input.gateway.request.nonce === input.edge.request.nonce)
        return null;
    const scoped = [input.gateway, input.edge];
    if (!scoped.every(({ request, binding }) => bindingMatches(request, binding) && sha256.test(request.nonce)))
        return null;
    const authority = await input.readVerifiedAuthority();
    if (!authority || !scoped.every(({ request, binding }) => authorityMatches(request, binding, authority)) ||
        !isDeepStrictEqual(await input.readVerifiedAuthority(), authority))
        return null;
    const expiresAt = (input.now ?? Date.now)() + 10_000;
    return {
        gateway: signScopedLaunch(input.gateway.request, authority, input.enrolledIssuerPrivateKey, expiresAt),
        "gateway-edge": signScopedLaunch(input.edge.request, authority, input.enrolledIssuerPrivateKey, expiresAt),
    };
}
export async function issueSharedMaintenanceCompletion(input) {
    const scoped = [input.gateway, input.edge];
    if (input.gateway.request.role !== "gateway" || input.edge.request.role !== "gateway-edge" ||
        !scoped.every(({ request, binding }) => bindingMatches(request, binding)))
        return null;
    const final = await input.readVerifiedPublication();
    const now = (input.now ?? Date.now)();
    if (!final || !isSharedMaintenancePublication(final.publication, now) ||
        !scoped.every(({ request, binding }) => authorityMatches(request, binding, final)) ||
        !isDeepStrictEqual(await input.readVerifiedPublication(), final))
        return null;
    const { role: _role, nonce: _nonce, ...scope } = input.gateway.request;
    const receipt = {
        scope,
        images: { gateway: final.roles.gateway.runningImageId, "gateway-edge": final.roles["gateway-edge"].runningImageId },
        restoredArchiveSha256: final.verifiedRestoredArchive.sha256,
        publication: final.publication,
    };
    const raw = JSON.stringify(receipt);
    return { raw, signature: signFleetRequest(input.enrolledIssuerPrivateKey, sharedMaintenanceCompletionPurpose(scope), raw) };
}
