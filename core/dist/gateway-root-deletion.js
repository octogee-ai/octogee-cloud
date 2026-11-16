function proofFor(gatewayId) {
    return Object.freeze({ gatewayId });
}
function remainingRows(answer) {
    if (answer === null || typeof answer !== "object")
        return null;
    const { remaining } = answer;
    return typeof remaining === "number" && Number.isInteger(remaining) && remaining >= 0 ? remaining : null;
}
export async function releaseGitKeysBeforeRootDelete(gate, gatewayId) {
    if (gate.client === null) {
        gate.log(`[git-keys] no provisioning service is configured, so the root of ${gatewayId} is deleted without releasing git keys`);
        return { outcome: "released", proof: proofFor(gatewayId) };
    }
    let answer;
    try {
        answer = await gate.client.releaseGatewayGitKeys(gatewayId);
    }
    catch (error) {
        return { outcome: "kept", reason: `releasing the git keys of ${gatewayId} failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const remaining = remainingRows(answer);
    if (remaining === null)
        return { outcome: "kept", reason: `the provisioning service did not answer how many git key rows remain for ${gatewayId}` };
    if (remaining > 0)
        return { outcome: "kept", reason: `the provisioning service still holds ${remaining} git key rows for ${gatewayId}` };
    return { outcome: "released", proof: proofFor(gatewayId) };
}
export function assertGitKeysReleasedFor(gatewayId, proof) {
    if (proof.gatewayId !== gatewayId) {
        throw new Error(`gateway root ${gatewayId} cannot be deleted with the git key release proof of ${proof.gatewayId}`);
    }
}
