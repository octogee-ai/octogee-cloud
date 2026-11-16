function proofFor(gatewayId) {
    return Object.freeze({ gatewayId });
}
export async function releaseGitKeysBeforeRootDelete(keys, gatewayId) {
    if (keys === null)
        return { outcome: "released", proof: proofFor(gatewayId) };
    let remaining;
    try {
        ({ remaining } = await keys.releaseGatewayGitKeys(gatewayId));
    }
    catch (error) {
        return { outcome: "kept", reason: `releasing the git keys of ${gatewayId} failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (remaining > 0)
        return { outcome: "kept", reason: `the provisioning service still holds ${remaining} git key rows for ${gatewayId}` };
    return { outcome: "released", proof: proofFor(gatewayId) };
}
export function assertGitKeysReleasedFor(gatewayId, proof) {
    if (proof.gatewayId !== gatewayId) {
        throw new Error(`gateway root ${gatewayId} cannot be deleted with the git key release proof of ${proof.gatewayId}`);
    }
}
