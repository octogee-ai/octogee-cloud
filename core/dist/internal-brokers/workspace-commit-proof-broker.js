import { sidecarBrokerHeaders } from "../internal-fetch.js";
import { internalFetch } from "../internal-fetch.js";
const PROOF_TIMESTAMP_HEADER = "x-octogee-agent-proof-timestamp";
const PROOF_SIGNATURE_HEADER = "x-octogee-agent-proof-signature";
function requiredEnv(name, env) {
    const value = env[name]?.trim();
    if (!value)
        throw new Error(`${name} is required`);
    return value;
}
function trimBaseUrl(baseUrl) {
    let out = baseUrl.trim();
    while (out.endsWith("/"))
        out = out.slice(0, -1);
    return out;
}
export class WorkspaceCommitProofBrokerError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "WorkspaceCommitProofBrokerError";
    }
}
export async function verifyWorkspaceCommitProofViaBroker(req, target, env = process.env) {
    const baseUrl = trimBaseUrl(requiredEnv("WORKSPACE_COMMIT_PROOF_BROKER_URL", env));
    const gatewayId = requiredEnv("GATEWAY_ID", env);
    const res = await internalFetch(`${baseUrl}/internal/workspace-commit/verify-proof`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...await sidecarBrokerHeaders(),
        },
        body: JSON.stringify({
            gatewayId,
            target,
            proof: {
                timestamp: req.get(PROOF_TIMESTAMP_HEADER) ?? "",
                signature: req.get(PROOF_SIGNATURE_HEADER) ?? "",
                body: JSON.stringify(req.body),
            },
        }),
    });
    if (res.status === 403)
        return false;
    if (res.status !== 204) {
        throw new WorkspaceCommitProofBrokerError(res.status, `proof broker HTTP ${res.status}`);
    }
    return true;
}
