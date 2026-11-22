import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, } from "node:crypto";
export function canonicalPayload(jobId, rawBody) {
    return `${jobId}\n${rawBody}`;
}
// Binds a pod-addressed RPC signature to the gateway it is meant for. The request
// path is not signed, so without this scoping a pod that legitimately receives one
// signed call can relay the same body and signature to a sibling gateway, which
// would verify it and act.
export function gatewayScopedJobId(jobId, gatewayId) {
    return `${jobId}@${gatewayId}`;
}
export function sourceActivationReadinessJobId(migrationId, gatewayId) {
    return gatewayScopedJobId(`source-activation-ready/${migrationId}`, gatewayId);
}
export function signFleetRequest(privateKeyPem, jobId, rawBody) {
    const payload = Buffer.from(canonicalPayload(jobId, rawBody), "utf8");
    return cryptoSign(null, payload, createPrivateKey(normalizeKeyMaterial(privateKeyPem)))
        .toString("base64url");
}
export function verifyFleetRequest(publicKeyPem, jobId, rawBody, headerValue) {
    if (!headerValue)
        return false;
    try {
        const signature = Buffer.from(headerValue, "base64url");
        if (signature.length !== 64)
            return false;
        return cryptoVerify(null, Buffer.from(canonicalPayload(jobId, rawBody), "utf8"), createPublicKey(normalizeKeyMaterial(publicKeyPem)), signature);
    }
    catch {
        return false;
    }
}
function normalizeKeyMaterial(raw) {
    const value = raw.trim().replace(/\\n/g, "\n");
    if (value.includes("-----BEGIN "))
        return value;
    for (const encoding of ["base64url", "base64"]) {
        try {
            const decoded = Buffer.from(value, encoding).toString("utf8").trim().replace(/\\n/g, "\n");
            if (decoded.includes("-----BEGIN "))
                return decoded;
        }
        catch {
            // Try the next encoding.
        }
    }
    return value;
}
export function heldNativeSourceReconcileJobId(migrationId, gatewayId) {
    return gatewayScopedJobId(`held-native-source-reconcile/${migrationId}`, gatewayId);
}
export function heldNativeSourceHoldJobId(action, operationId, gatewayId) {
    return gatewayScopedJobId(`held-native-source-hold/${action}/${operationId}`, gatewayId);
}
export function heldNativeSourceHoldAudience(action, rawRequest, hold) {
    const digest = createHash("sha256").update(JSON.stringify([action, rawRequest, hold])).digest("hex");
    return `urn:octogee:held-native-source-hold:${digest}`;
}
