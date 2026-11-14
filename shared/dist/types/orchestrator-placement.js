import { userEntitlements } from "./user-entitlements.js";
import { accountAllowsInteractiveAccess } from "./account-lifecycle.js";
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
export function resolveLiveActivationTargetGatewayId(input) {
    if (!accountAllowsInteractiveAccess(input.userData))
        return null;
    if (userEntitlements().sizingKey(input.userData, input.now) === null)
        return null;
    const provisioning = input.userData.provisioning;
    if (!provisioning || typeof provisioning !== "object" || Array.isArray(provisioning))
        return null;
    const openclaw = provisioning.openclaw;
    if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw))
        return null;
    const lease = openclaw.activationLease;
    if (!lease || typeof lease !== "object" || Array.isArray(lease))
        return null;
    const status = lease.status;
    if (status !== "provisioning" && status !== "activating" && status !== "active")
        return null;
    return nonEmptyString(lease.targetGatewayId);
}
export function resolveContinuousUserPlacement(input) {
    const ownedGatewayId = resolveLiveActivationTargetGatewayId(input);
    if (!ownedGatewayId) {
        return { targetGatewayId: input.defaultGatewayId, ownedGatewayId: null };
    }
    const gateway = input.ownedGateway;
    const ownedGatewayIsUsable = gateway !== null &&
        gateway.gatewayId === ownedGatewayId &&
        gateway.gatewayClass === "isolated" &&
        gateway.ownerUid === input.uid &&
        gateway.disposable === true &&
        gateway.desiredStatus === "running" &&
        input.currentGatewayId === ownedGatewayId;
    return {
        targetGatewayId: ownedGatewayIsUsable ? ownedGatewayId : input.defaultGatewayId,
        ownedGatewayId,
    };
}
export function resolveDefaultPlacementEligibility(data) {
    const hold = data.provisioning?.openclaw;
    if (hold?.managedBy === "operator")
        return { eligible: false, reason: "operator-managed" };
    if (data.admitted !== true) {
        return { eligible: false, reason: "not-admitted" };
    }
    if (!accountAllowsInteractiveAccess(data)) {
        return { eligible: false, reason: "account-not-interactive" };
    }
    const provisioning = data.provisioning;
    if (provisioning?.status !== "in_progress" && provisioning?.status !== "complete") {
        return { eligible: false, reason: "provisioning-not-started" };
    }
    const openclaw = provisioning.openclaw;
    const slugCandidate = typeof openclaw?.slug === "string" ? openclaw.slug : data.username;
    const slug = typeof slugCandidate === "string" ? slugCandidate.trim() : "";
    return slug
        ? { eligible: true, slug }
        : { eligible: false, reason: "builder-slug-missing" };
}
