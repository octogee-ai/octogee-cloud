import { dualReadIsolatedProfileImage } from "@octogee/shared/types/gateway-releases";
import { isGatewayVmImageObservation } from "@octogee/shared/types/glm";
export const GUEST_RELEASE_MODE = "guest-release";
export function immutableGuestImageRef(reference) {
    const [name, digest, extra] = reference.split("@");
    return name && extra === undefined && /^sha256:[a-f0-9]{64}$/u.test(digest ?? "") ? `${name.replace(/:[^/:]+$/u, "")}@${digest}` : null;
}
export function sameGuestImageRef(left, right) {
    const identity = immutableGuestImageRef(left);
    return left === right || (identity !== null && identity === immutableGuestImageRef(right));
}
function digestOf(image) {
    const digest = image?.imageTag.split("@").at(-1);
    return digest && /^sha256:[a-f0-9]{64}$/u.test(digest) ? `${image.imageRepository}@${digest}` : null;
}
function releaseIdentity(payload) {
    const gateway = digestOf(payload.profileImages ? dualReadIsolatedProfileImage(payload.profileImages) : payload);
    const edge = digestOf(payload.gatewayEdgeImage);
    return gateway && edge && payload.openclawSourceSha ? { gateway, edge, openclaw: payload.openclawSourceSha } : null;
}
export function hasCompleteGuestRelease(payload) {
    return releaseIdentity(payload) !== null;
}
export function guestReleaseImagesMatch(installed, desired) {
    const old = releaseIdentity(installed);
    const next = releaseIdentity(desired);
    return old !== null && next !== null && old.gateway === next.gateway && old.edge === next.edge && old.openclaw === next.openclaw;
}
export function guestReleaseInstalled(payload, instanceId, sample, after = 0) {
    const identity = releaseIdentity(payload);
    if (!identity || !isGatewayVmImageObservation(sample) || sample.instanceId !== instanceId || sample.observedAt < after)
        return false;
    return sample.containers.every(container => {
        const expected = container.name === "gateway" ? identity.gateway : identity.edge;
        return container.running && immutableGuestImageRef(container.imageReference) === expected && container.digests.includes(expected);
    });
}
