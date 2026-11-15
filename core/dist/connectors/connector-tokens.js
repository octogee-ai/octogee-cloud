import { gatewayCredentialHeaders, sidecarBrokerHeaders, } from "../internal-fetch.js";
import { platformStateStore } from "../identity/platform-state-store.js";
import { internalFetch } from "../internal-fetch.js";
import { decryptSecret, encryptSecret } from "./kms.js";
import { getConnector, isConnectorAgentRuntimeTokenMaterializable, isConnectorTokenBrokerable, } from "./index.js";
import { claimedUserIdentity } from "../identity/user-identity.js";
const FRESHNESS_MARGIN_MS = 60_000;
function nonBlank(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}
function trimBaseUrl(baseUrl) {
    let out = baseUrl.trim();
    while (out.endsWith("/"))
        out = out.slice(0, -1);
    return out;
}
export function connectorTokenBrokerBaseUrlFromEnv(env = process.env) {
    return nonBlank(env.CONNECTOR_TOKEN_BROKER_URL);
}
export function connectorTokenAuthorityFromEnv(env = process.env) {
    const value = nonBlank(env.CONNECTOR_TOKEN_AUTHORITY);
    return value === "1" || value === "true";
}
async function readJsonOrNull(res) {
    try {
        const body = (await res.json());
        return body && typeof body === "object" ? body : null;
    }
    catch {
        return null;
    }
}
export class ConnectorTokenReadError extends Error {
    status;
    errorCode;
    constructor(status, errorCode, message = `connector token read failed: ${errorCode}`) {
        super(message);
        this.status = status;
        this.errorCode = errorCode;
        this.name = "ConnectorTokenReadError";
    }
}
export class ConnectorTokenBrokerError extends ConnectorTokenReadError {
    constructor(status, errorCode) {
        super(status, errorCode, `connector token broker failed: ${errorCode}`);
        this.name = "ConnectorTokenBrokerError";
    }
}
async function readConnectorAccessTokenViaBroker(baseUrl, uid, connectorId, access) {
    const gatewayId = nonBlank(process.env.GATEWAY_ID);
    if (!gatewayId) {
        throw new Error("CONNECTOR_TOKEN_BROKER_URL is set but GATEWAY_ID is missing");
    }
    const res = await internalFetch(`${trimBaseUrl(baseUrl)}/internal/connectors/access-token`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...await gatewayCredentialHeaders(),
        },
        body: JSON.stringify({
            gatewayId,
            ...(uid ? { uid } : {}),
            connectorId,
            ...(access ? { access } : {}),
        }),
    }, {});
    if (res.status === 404)
        return null;
    const body = await readJsonOrNull(res);
    if (!res.ok) {
        const error = typeof body?.error === "string" ? body.error : `broker HTTP ${res.status}`;
        throw new ConnectorTokenBrokerError(res.status, error);
    }
    const accessToken = body?.accessToken;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
        throw new Error("connector token broker returned malformed response");
    }
    return accessToken;
}
async function readConnectorAccessTokenDirect(uid, connectorId, access) {
    const allowed = access?.kind === "owner-runtime"
        ? isConnectorAgentRuntimeTokenMaterializable(connectorId)
        : isConnectorTokenBrokerable(connectorId);
    if (!allowed) {
        throw new Error(`connector not brokerable: ${connectorId}`);
    }
    if (access?.kind === "owner-runtime") {
        const def = getConnector(connectorId);
        if (!def)
            throw new Error(`connector not brokerable: ${connectorId}`);
        const fresh = await getFreshAccessToken(uid, def);
        if (!fresh.ok) {
            if (fresh.reason === "not_connected")
                return null;
            throw new ConnectorTokenReadError(409, fresh.reason);
        }
        return fresh.accessToken;
    }
    const secret = await readConnectorSecret(platformStateStore, uid, connectorId);
    const enc = readEncryptedToken(secret?.encryptedAccessToken);
    if (!enc)
        return null;
    return decryptSecret(enc);
}
export async function readConnectorAccessToken(uid, connectorId, access) {
    const baseUrl = connectorTokenBrokerBaseUrlFromEnv();
    if (baseUrl)
        return readConnectorAccessTokenViaBroker(baseUrl, uid, connectorId, access);
    if (connectorTokenAuthorityFromEnv())
        return readConnectorAccessTokenDirect(uid, connectorId, access);
    throw new Error("CONNECTOR_TOKEN_BROKER_URL is required");
}
export async function readOwnerRuntimeConnectorAccessToken(connectorId) {
    const baseUrl = connectorTokenBrokerBaseUrlFromEnv();
    if (!baseUrl)
        throw new Error("CONNECTOR_TOKEN_BROKER_URL is required");
    const builderSlug = claimedUserIdentity()?.builderSlug;
    if (!builderSlug)
        throw new Error("this isolated gateway has no claimed owner yet");
    return readConnectorAccessTokenViaBroker(baseUrl, null, connectorId, {
        kind: "owner-runtime",
        builderSlug,
    });
}
function githubProjectCloneBrokerIdentity() {
    const baseUrl = connectorTokenBrokerBaseUrlFromEnv();
    if (!baseUrl)
        throw new Error("CONNECTOR_TOKEN_BROKER_URL is required");
    const gatewayId = nonBlank(process.env.GATEWAY_ID);
    const builderSlug = claimedUserIdentity()?.builderSlug;
    if (!gatewayId || !builderSlug) {
        throw new Error("GATEWAY_ID and a claimed user owner are required for GitHub project clone");
    }
    return { baseUrl, gatewayId, builderSlug };
}
function githubProjectCloneResponse(body) {
    const accessToken = body?.accessToken;
    const repository = body?.repository;
    if (typeof accessToken !== "string" || accessToken.length === 0 ||
        !repository || typeof repository !== "object" ||
        typeof repository.owner !== "string" ||
        typeof repository.repo !== "string") {
        throw new Error("connector token broker returned malformed GitHub project clone response");
    }
    return {
        accessToken,
        repository: {
            owner: repository.owner,
            repo: repository.repo,
        },
    };
}
export async function readOwnerGithubProjectCloneAccess(projectSlug) {
    const { baseUrl, gatewayId, builderSlug } = githubProjectCloneBrokerIdentity();
    let headers;
    try {
        headers = await sidecarBrokerHeaders();
    }
    catch {
        throw new ConnectorTokenReadError(503, "sidecar_broker_credential_unavailable");
    }
    const res = await internalFetch(`${trimBaseUrl(baseUrl)}/internal/connectors/github-project-clone-access`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...headers,
        },
        body: JSON.stringify({
            gatewayId,
            connectorId: "github",
            access: { kind: "project-clone", builderSlug, projectSlug },
        }),
    }, {});
    if (res.status === 404)
        return null;
    const body = await readJsonOrNull(res);
    if (!res.ok) {
        const error = typeof body?.error === "string" ? body.error : `broker HTTP ${res.status}`;
        throw new ConnectorTokenBrokerError(res.status, error);
    }
    return githubProjectCloneResponse(body);
}
export function configuredEnvValue(value) {
    const trimmed = value?.trim();
    if (!trimmed || trimmed === "placeholder")
        return null;
    return trimmed;
}
export function readConnectorClientCreds(def) {
    if (!def.oauth)
        return null;
    const clientId = configuredEnvValue(process.env[def.oauth.clientIdEnv]);
    const clientSecret = configuredEnvValue(process.env[def.oauth.clientSecretEnv]);
    if (!clientId || !clientSecret)
        return null;
    return { clientId, clientSecret };
}
export async function getFreshAccessToken(uid, def) {
    return getFreshAccessTokenFromStore(platformStateStore, uid, def);
}
async function readConnectorSecret(store, uid, connectorId) {
    const stored = await store.secrets.get(uid, connectorId);
    if (stored === null)
        return null;
    if (stored.kind !== "connector")
        throw new Error(`users/${uid}/secrets/${connectorId} is not a connector secret`);
    return stored;
}
function tokenDetail(secret) {
    const tokens = secret.detail.tokens;
    return tokens !== null && typeof tokens === "object" && !Array.isArray(tokens)
        ? tokens
        : {};
}
export async function getFreshAccessTokenFromStore(store, uid, def) {
    const secret = await readConnectorSecret(store, uid, def.meta.id);
    const enc = readEncryptedToken(secret?.encryptedAccessToken);
    if (!secret || !enc) {
        return { ok: false, reason: "not_connected" };
    }
    const tokens = tokenDetail(secret);
    if (isStoredAccessTokenFresh(tokens)) {
        return { ok: true, accessToken: await decryptSecret(enc) };
    }
    const encRefresh = readEncryptedToken(secret.encryptedRefreshToken);
    if (!encRefresh || !def.oauth) {
        return { ok: false, reason: "reauth_required" };
    }
    const creds = readConnectorClientCreds(def);
    if (!creds) {
        return { ok: false, reason: "reauth_required" };
    }
    return refreshAccessToken({
        store,
        uid,
        secret,
        def,
        creds,
        encRefresh,
        previousAccessEnc: enc,
    });
}
function readEncryptedToken(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function isStoredAccessTokenFresh(tokens) {
    const expiresAt = typeof tokens.expiresAt === "number" ? tokens.expiresAt : null;
    return expiresAt === null || expiresAt > Date.now() + FRESHNESS_MARGIN_MS;
}
function readStoredTokenType(tokens) {
    return typeof tokens.tokenType === "string" ? tokens.tokenType : "bearer";
}
async function refreshAccessToken(args) {
    const { store, uid, secret, def, creds, encRefresh, previousAccessEnc } = args;
    const lost = async () => (await rereadAfterRefreshLoss(store, uid, secret.secretId, previousAccessEnc)) ?? { ok: false, reason: "reauth_required" };
    const refreshToken = await decryptSecret(encRefresh);
    const resp = await fetch(def.oauth.tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
        },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
        }),
    });
    if (!resp.ok)
        return lost();
    const out = (await resp.json());
    if (out.error || !out.access_token)
        return lost();
    const encryptedAccessToken = await encryptSecret(out.access_token);
    const encryptedRefreshToken = out.refresh_token ? await encryptSecret(out.refresh_token) : encRefresh;
    const expiresAt = out.expires_in ? Date.now() + out.expires_in * 1000 : null;
    const stored = await store.transaction({ label: "connector-tokens.refresh" }, async (transaction) => {
        const latest = await readConnectorSecret(transaction, uid, secret.secretId);
        if (latest === null)
            return false;
        const tokens = tokenDetail(latest);
        await transaction.secrets.put(uid, {
            kind: "connector",
            secretId: latest.secretId,
            encryptedAccessToken,
            encryptedRefreshToken,
            detail: {
                ...latest.detail,
                tokens: { ...tokens, expiresAt, tokenType: out.token_type ?? readStoredTokenType(tokens) },
                updatedAt: { serverNow: true },
            },
        });
        return true;
    });
    if (!stored)
        return { ok: false, reason: "not_connected" };
    return { ok: true, accessToken: out.access_token };
}
async function rereadAfterRefreshLoss(store, uid, secretId, previousEncryptedAccessToken) {
    const secret = await readConnectorSecret(store, uid, secretId);
    const enc = readEncryptedToken(secret?.encryptedAccessToken);
    if (!secret || !enc || enc === previousEncryptedAccessToken) {
        return null;
    }
    if (!isStoredAccessTokenFresh(tokenDetail(secret))) {
        return null;
    }
    return { ok: true, accessToken: await decryptSecret(enc) };
}
