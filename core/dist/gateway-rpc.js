import { assertWorkspaceIdentityReady } from "./openclaw-workspace-bootstrap.js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { OPENCLAW_PROTOCOL_VERSION } from "@octogee/shared/types/openclaw-wire";
import { OpenclawWireError, startConnectChallengeTracker, waitForWsOpen, sendWsRequest, } from "@octogee/shared/types/openclaw-wire-core";
import { OPENCLAW_CONTROL_UI_CLIENT_ID, OPENCLAW_PROVISIONER_SERVICE_IDENTITY, isPerUserControlIdentity, openClawProxyIdentityHeaders, openClawProxyOrigin, } from "@octogee/shared/types/openclaw-proxy-identity";
import { log as defaultLog } from "./config.js";
import { loadOrCreateDeviceIdentity, signConnectDevice, } from "./gateway-device-identity.js";
export { OpenclawWireError, } from "@octogee/shared/types/openclaw-wire-core";
const INVALID_RESPONSE = "invalid-response";
function parseDegradedSecretOwners(payload) {
    const owners = payload?.degradedSecretOwners;
    if (!Array.isArray(owners) || owners.some((owner) => !owner || typeof owner !== "object" || typeof owner.ownerKind !== "string" ||
        typeof owner.ownerId !== "string" || owner.state !== "unavailable" ||
        (owner.degradationState !== undefined && owner.degradationState !== "cold" && owner.degradationState !== "stale") ||
        !Array.isArray(owner.paths) || owner.paths.some((p) => typeof p !== "string") ||
        typeof owner.reason !== "string")) {
        throw new OpenclawWireError(INVALID_RESPONSE, "status payload missing valid degradedSecretOwners");
    }
    return owners.map(({ ownerKind, ownerId, state, degradationState, paths, reason }) => ({
        ownerKind, ownerId, state, ...(degradationState ? { degradationState } : {}), paths, reason,
    }));
}
function parseSecretsReloadPayload(payload) {
    if (!payload || typeof payload !== "object") {
        throw new OpenclawWireError(INVALID_RESPONSE, "secrets.reload returned non-object payload");
    }
    const p = payload;
    if (p.warningCount !== undefined && typeof p.warningCount !== "number") {
        throw new OpenclawWireError(INVALID_RESPONSE, `secrets.reload payload.warningCount must be a number when present (got ${typeof p.warningCount})`);
    }
    if (p.ok !== undefined && typeof p.ok !== "boolean") {
        throw new OpenclawWireError(INVALID_RESPONSE, `secrets.reload payload.ok must be a boolean when present (got ${typeof p.ok})`);
    }
    return p;
}
function parseBrokerProfileMaterializationPayload(payload) {
    if (!payload || typeof payload !== "object" || payload.ok !== true) {
        throw new OpenclawWireError(INVALID_RESPONSE, "broker profile materialization was not acknowledged");
    }
    return { ok: true };
}
const AGENT_NOT_FOUND_MESSAGE = /^agent "[^"]*" not found$/;
const AGENT_ALREADY_EXISTS_MESSAGE = /^agent "[^"]*" already exists$/;
const AGENT_DELETION_PENDING_MESSAGE = /^agent "([^"]*)" deletion cleanup is still pending$/;
const GATEWAY_RESTART_REQUIRED_MESSAGE = /recovery restart is required|\(applied-restart-required\)/;
const RECOVERY_RESTART_REASON = "octogee.recovery-restart-required";
const RECOVERY_RESTART_INTERVAL_MS = 10 * 60_000;
const recoveryRestartRequestedAt = new Map();
const recoveryRestartInFlight = new Map();
/**
 * openclaw refuses `agents.create` for an id already in the roster with
 * `errorShape(INVALID_REQUEST, 'agent "<id>" already exists')`. An ensure that
 * raced another writer has to treat that as already-done; every other refusal —
 * an unwritable workspace, a transport failure — must still fail the mount.
 * A pending deletion journal is the one refusal with a native remedy; see
 * `isAgentDeletionPendingRpcError`.
 */
export function isAgentAlreadyExistsRpcError(err) {
    return (err instanceof OpenclawWireError &&
        err.code === "rpc-error" &&
        AGENT_ALREADY_EXISTS_MESSAGE.test(err.message));
}
/**
 * openclaw refuses `agents.create` while an earlier `agents.delete` of the same
 * id is journaled with its cleanup incomplete:
 * `errorShape(INVALID_REQUEST, 'agent "<id>" deletion cleanup is still pending')`
 * (agent-create.ts "deletion-pending"). A fresh `agents.delete` resumes that
 * cleanup; the create is retryable once it completes. The refusal must name
 * the agent being created, since the remedy deletes it.
 */
export function isAgentDeletionPendingRpcError(err, agentId) {
    return (err instanceof OpenclawWireError &&
        err.code === "rpc-error" &&
        AGENT_DELETION_PENDING_MESSAGE.exec(err.message)?.[1] === agentId);
}
/**
 * openclaw refuses `agents.delete` for an id that is neither rostered nor
 * mid-deletion with `errorShape(INVALID_REQUEST, 'agent "<id>" not found')`
 * (server-methods/agents.ts respondAgentNotFound). An eviction has to treat
 * that as already-done; every other refusal — the default agent, a wedged
 * deletion journal, a transport failure — must still fail the eviction.
 */
export function isAgentNotFoundRpcError(err) {
    return (err instanceof OpenclawWireError &&
        err.code === "rpc-error" &&
        AGENT_NOT_FOUND_MESSAGE.test(err.message));
}
export function isGatewayRestartRequiredRpcError(err) {
    return (err instanceof OpenclawWireError &&
        err.code === "rpc-error" &&
        err.details?.serverCode === "UNAVAILABLE" &&
        GATEWAY_RESTART_REQUIRED_MESSAGE.test(err.message));
}
const SCHEDULE_TRANSFER_CRON_METHODS = ["cron.list", "cron.add", "cron.remove", "cron.scratch.get", "cron.scratch.set", "cron.update"];
function configChangedHash(data) {
    let parsed;
    try {
        parsed = JSON.parse(typeof data === "string"
            ? data
            : data.toString("utf-8"));
    }
    catch {
        return null;
    }
    if (!parsed ||
        typeof parsed !== "object" ||
        parsed.type !== "event" ||
        parsed.event !== "config.changed") {
        return null;
    }
    const hash = parsed.payload?.hash;
    return typeof hash === "string" && hash.length > 0 ? hash : null;
}
function trackConfigRevisionWakeups(ws) {
    const changedHashes = new Set();
    const waiters = new Map();
    const onMessage = (data) => {
        const hash = configChangedHash(data);
        if (!hash)
            return;
        changedHashes.add(hash);
        for (const resolve of waiters.get(hash) ?? [])
            resolve();
        waiters.delete(hash);
    };
    ws.on("message", onMessage);
    return {
        waitFor(hash, timeoutMs) {
            if (ws.readyState !== WebSocket.OPEN) {
                return Promise.reject(new OpenclawWireError("connect-failed", "socket closed before config revision was applied"));
            }
            if (changedHashes.delete(hash))
                return Promise.resolve();
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    cleanup();
                    resolve();
                }, timeoutMs);
                const onClose = () => {
                    cleanup();
                    reject(new OpenclawWireError("connect-failed", "socket closed before config revision was applied"));
                };
                const wake = () => {
                    cleanup();
                    changedHashes.delete(hash);
                    resolve();
                };
                function cleanup() {
                    clearTimeout(timer);
                    ws.removeListener("close", onClose);
                    waiters.get(hash)?.delete(wake);
                }
                const hashWaiters = waiters.get(hash) ?? new Set();
                hashWaiters.add(wake);
                waiters.set(hash, hashWaiters);
                ws.on("close", onClose);
                if (changedHashes.delete(hash))
                    wake();
            });
        },
        close() {
            ws.removeListener("message", onMessage);
            waiters.clear();
        },
    };
}
function parseConfigGetResult(payload) {
    const snap = payload;
    if (!snap || typeof snap !== "object") {
        throw new OpenclawWireError(INVALID_RESPONSE, "config.get returned non-object payload");
    }
    if (typeof snap.hash !== "string" || snap.hash.length === 0) {
        throw new OpenclawWireError(INVALID_RESPONSE, "config.get payload missing `hash`");
    }
    if (typeof snap.configRevisionHash !== "string" || snap.configRevisionHash.length === 0) {
        throw new OpenclawWireError(INVALID_RESPONSE, "config.get payload missing `configRevisionHash`");
    }
    if (snap.appliedConfigHash !== null &&
        (typeof snap.appliedConfigHash !== "string" || snap.appliedConfigHash.length === 0)) {
        throw new OpenclawWireError(INVALID_RESPONSE, "config.get payload has invalid `appliedConfigHash`");
    }
    return {
        config: snap.config,
        hash: snap.hash,
        configRevisionHash: snap.configRevisionHash,
        appliedConfigHash: snap.appliedConfigHash,
    };
}
async function writeConfig(call, method, config, baseHash, replacePaths) {
    try {
        const payload = await call(method, {
            raw: JSON.stringify(config),
            baseHash,
            ...(replacePaths && replacePaths.length > 0
                ? { replacePaths: [...replacePaths] }
                : {}),
        });
        if (!payload || typeof payload !== "object") {
            throw new OpenclawWireError(INVALID_RESPONSE, `${method} returned non-object payload`);
        }
        const result = payload;
        if (result.ok !== true) {
            throw new OpenclawWireError(INVALID_RESPONSE, `${method} payload missing \`ok: true\``);
        }
        return result;
    }
    catch (err) {
        if (err instanceof OpenclawWireError && err.code === "rpc-error") {
            const message = err.message.toLowerCase();
            if (message.includes("config changed since last load") || message.includes("base hash")) {
                throw new OpenclawWireError("hash-mismatch", err.message, err.details);
            }
            if (message.includes("invalid config")) {
                throw new OpenclawWireError("invalid-patch", err.message, err.details);
            }
        }
        throw err;
    }
}
function formatConnectTrace(trace) {
    const phases = [
        trace.wsOpenMs !== undefined ? `wsOpen=${trace.wsOpenMs}ms` : null,
        trace.challengeMs !== undefined ? `challenge=${trace.challengeMs}ms` : null,
        trace.connectMs !== undefined ? `connect=${trace.connectMs}ms` : null,
    ]
        .filter(Boolean)
        .join(" ");
    const outcome = trace.success
        ? "OK"
        : `FAIL stage=${trace.stage} ${trace.errorCode}: ${trace.errorMessage}`;
    return `[rpc-trace] ${outcome} total=${trace.totalMs}ms ${phases} url=${trace.url}`;
}
function parseToolsCatalogResult(payload, agentId) {
    if (!payload || typeof payload !== "object") {
        throw new OpenclawWireError(INVALID_RESPONSE, "tools.catalog returned non-object payload");
    }
    const result = payload;
    if (result.agentId !== agentId || !Array.isArray(result.groups)) {
        throw new OpenclawWireError(INVALID_RESPONSE, "tools.catalog payload missing the requested agentId or groups array");
    }
    return payload;
}
async function fetchToolsCatalog(call, params, timeoutMs) {
    return parseToolsCatalogResult(await call("tools.catalog", params, timeoutMs), params.agentId);
}
function createDefaultConnectTraceHandler(traceVerbose, slowTraceMs, failureSampleMs) {
    let lastFailureKey = "";
    let lastFailureLogAt = 0;
    let suppressedFailures = 0;
    return (trace) => {
        if (traceVerbose) {
            defaultLog(formatConnectTrace(trace));
            return;
        }
        if (trace.success) {
            if (suppressedFailures > 0) {
                defaultLog(`${formatConnectTrace(trace)} (recovered after ${suppressedFailures} suppressed failures)`);
                suppressedFailures = 0;
                lastFailureKey = "";
            }
            else if (trace.totalMs >= slowTraceMs) {
                defaultLog(formatConnectTrace(trace));
            }
            return;
        }
        const now = Date.now();
        const failureKey = `${trace.stage}:${trace.errorCode}:${trace.errorMessage ?? ""}`;
        const shouldLog = failureKey !== lastFailureKey ||
            lastFailureLogAt === 0 ||
            now - lastFailureLogAt >= failureSampleMs;
        if (shouldLog) {
            const suffix = suppressedFailures > 0 ? ` (suppressed ${suppressedFailures} similar failures)` : "";
            defaultLog(`${formatConnectTrace(trace)}${suffix}`);
            lastFailureKey = failureKey;
            lastFailureLogAt = now;
            suppressedFailures = 0;
        }
        else {
            suppressedFailures++;
        }
    };
}
async function patchConfigAndWaitForChange(connection, patch, baseHash, replacePaths) {
    const deadline = Date.now() + connection.callTimeoutMs;
    const remainingMs = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new OpenclawWireError("timeout", `config.patch applied revision timed out after ${connection.callTimeoutMs}ms`);
        }
        return remaining;
    };
    const ws = await openAndConnect({
        url: connection.url,
        ...connection.auth,
        connectTimeoutMs: connection.connectTimeoutMs,
        deadlineAtMs: deadline,
        identity: connection.identity,
        scopes: connection.scopes,
        onConnectTrace: connection.onConnectTrace,
    });
    const change = trackConfigRevisionWakeups(ws);
    const connectedCall = async (method, params) => await sendWsRequest({
        ws,
        id: randomUUID(),
        method,
        params,
        timeoutMs: remainingMs(),
    });
    try {
        const result = await writeConfig(connectedCall, "config.patch", patch, baseHash, replacePaths);
        remainingMs();
        if (result.noop === true)
            return result;
        if (typeof result.hash !== "string" || result.hash.length === 0) {
            throw new OpenclawWireError(INVALID_RESPONSE, "config.patch payload missing `hash` required for applied revision confirmation");
        }
        while (true) {
            const current = parseConfigGetResult(await connectedCall("config.get", {}));
            remainingMs();
            if (current.hash !== result.hash) {
                throw new OpenclawWireError("hash-mismatch", "config changed before confirming the accepted revision was applied; rebuild the patch");
            }
            if (current.appliedConfigHash === current.configRevisionHash)
                return result;
            await change.waitFor(result.hash, Math.min(1_000, remainingMs()));
        }
    }
    finally {
        change.close();
        try {
            ws.close();
        }
        catch { /* */ }
    }
}
function createChannelsStatusConnection(connection) {
    let ws = null;
    let connecting = null;
    let generation = 0;
    let connectionGeneration = 0;
    function disconnect(activeWs) {
        if (ws === activeWs)
            ws = null;
        try {
            activeWs.close();
        }
        catch { /* */ }
    }
    async function getConnection() {
        if (ws?.readyState === WebSocket.OPEN)
            return ws;
        if (connecting)
            return await connecting;
        const activeGeneration = generation;
        const pending = (async () => {
            const activeWs = await openAndConnect({
                url: connection.url,
                ...connection.auth,
                connectTimeoutMs: connection.connectTimeoutMs,
                identity: connection.identity(),
                scopes: connection.scopes,
                onConnectTrace: connection.onConnectTrace,
            });
            if (generation !== activeGeneration) {
                disconnect(activeWs);
                throw new OpenclawWireError("connect-failed", "gateway RPC client closed while channels.status was connecting");
            }
            ws = activeWs;
            connectionGeneration += 1;
            activeWs.once("close", () => {
                if (ws === activeWs)
                    ws = null;
            });
            return activeWs;
        })();
        connecting = pending;
        try {
            return await pending;
        }
        finally {
            if (connecting === pending)
                connecting = null;
        }
    }
    return {
        async call() {
            const activeWs = await getConnection();
            try {
                return await sendWsRequest({
                    ws: activeWs,
                    id: randomUUID(),
                    method: "channels.status",
                    params: {},
                    timeoutMs: connection.callTimeoutMs,
                });
            }
            catch (err) {
                if (!(err instanceof OpenclawWireError) || err.code !== "rpc-error") {
                    disconnect(activeWs);
                }
                throw err;
            }
        },
        connectionGeneration: () => connectionGeneration,
        async close() {
            generation++;
            const activeWs = ws;
            ws = null;
            if (activeWs)
                disconnect(activeWs);
            const pending = connecting;
            connecting = null;
            if (pending) {
                try {
                    disconnect(await pending);
                }
                catch { /* */ }
            }
        },
    };
}
function createIdentityResolver(initialIdentity) {
    let identity = initialIdentity ?? null;
    return () => {
        if (identity)
            return identity;
        identity = loadOrCreateDeviceIdentity();
        return identity;
    };
}
function resolveRpcTraceSettings() {
    return {
        traceVerbose: /^(1|true|yes|debug)$/i.test(process.env.OCTOGEE_RPC_TRACE_VERBOSE ?? ""),
        slowTraceMs: Number.parseInt(process.env.OCTOGEE_RPC_TRACE_SLOW_MS ?? "5000", 10),
        failureSampleMs: Number.parseInt(process.env.OCTOGEE_RPC_TRACE_FAILURE_SAMPLE_MS ?? "30000", 10),
    };
}
function createRecoveryRestart(url, call) {
    async function requestRecoveryRestart(method) {
        const inFlight = recoveryRestartInFlight.get(url);
        if (inFlight)
            return inFlight;
        const last = recoveryRestartRequestedAt.get(url);
        if (last !== undefined && Date.now() - last < RECOVERY_RESTART_INTERVAL_MS)
            return;
        const request = (async () => {
            try {
                const result = await requestGatewayRestart(call, { reason: RECOVERY_RESTART_REASON });
                recoveryRestartRequestedAt.set(url, Date.now());
                defaultLog(`[gateway-rpc] ${method} needs a Gateway recovery restart — restart ${result.status}`);
            }
            catch (err) {
                defaultLog(`⚠ [gateway-rpc] ${method} needs a Gateway recovery restart — restart request failed: ${err.message}`);
            }
        })();
        recoveryRestartInFlight.set(url, request);
        try {
            await request;
        }
        finally {
            recoveryRestartInFlight.delete(url);
        }
    }
    return async (method, work) => {
        try {
            return await work();
        }
        catch (err) {
            if (method !== "gateway.restart.request" && isGatewayRestartRequiredRpcError(err)) {
                await requestRecoveryRestart(method);
            }
            throw err;
        }
    };
}
async function abortSession(call, params) {
    const payload = await call("sessions.abort", params);
    const value = payload;
    if (!value || typeof value !== "object" || value.ok !== true ||
        (value.status !== "aborted" && value.status !== "no-active-run") ||
        (value.abortedRunId !== null && typeof value.abortedRunId !== "string")) {
        throw new OpenclawWireError(INVALID_RESPONSE, "sessions.abort payload missing `ok: true` with an abort status");
    }
    return value;
}
async function stopChannels(call, params) {
    const payload = await call("channels.stop", params);
    if (!payload || typeof payload !== "object" ||
        payload.stopped !== true) {
        throw new OpenclawWireError(INVALID_RESPONSE, "channels.stop payload missing `stopped: true`");
    }
    return payload;
}
async function startChannels(call, params) {
    const payload = await call("channels.start", params);
    if (!payload || typeof payload !== "object" ||
        typeof payload.started !== "boolean") {
        throw new OpenclawWireError(INVALID_RESPONSE, "channels.start payload missing boolean `started`");
    }
    return payload;
}
async function requestGatewayRestart(call, params) {
    const payload = await call("gateway.restart.request", params);
    const result = payload;
    const restart = result?.restart;
    if (!result ||
        typeof result !== "object" ||
        result.ok !== true ||
        !["scheduled", "deferred", "coalesced"].includes(String(result.status)) ||
        !restart ||
        typeof restart !== "object" ||
        restart.ok !== true ||
        !Number.isSafeInteger(restart.pid) ||
        restart.pid <= 0 ||
        restart.signal !== "SIGUSR2" ||
        typeof restart.coalesced !== "boolean" ||
        (result.status === "coalesced") !== restart.coalesced) {
        throw new OpenclawWireError(INVALID_RESPONSE, "gateway.restart.request returned malformed restart acknowledgement");
    }
    return result;
}
async function callOkPayload(call, method, params) {
    const payload = await call(method, params);
    if (!payload || typeof payload !== "object" || payload.ok !== true) {
        throw new OpenclawWireError(INVALID_RESPONSE, `${method} payload missing \`ok: true\``);
    }
    return payload;
}
async function callAgentsCreate(call, params) {
    const payload = await callOkPayload(call, "agents.create", params);
    if (typeof payload.agentId !== "string" || payload.agentId.length === 0) {
        throw new OpenclawWireError(INVALID_RESPONSE, "agents.create payload missing string `agentId`");
    }
    return payload;
}
async function callAgentsDelete(call, params) {
    const payload = await callOkPayload(call, "agents.delete", params);
    if (payload.purgeFailed !== undefined && typeof payload.purgeFailed !== "boolean") {
        throw new OpenclawWireError(INVALID_RESPONSE, "agents.delete payload has invalid `purgeFailed`");
    }
    if (payload.failed !== undefined && !Array.isArray(payload.failed)) {
        throw new OpenclawWireError(INVALID_RESPONSE, "agents.delete payload has invalid `failed` array");
    }
    return payload;
}
export function createGatewayRpc(opts = {}) {
    const url = opts.url ??
        `ws://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT || process.env.GATEWAY_PORT || 18789}`;
    const auth = resolveGatewayAuth(opts);
    const connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
    const callTimeoutMs = opts.callTimeoutMs ?? 30_000;
    const scopes = opts.scopes ?? ["operator.admin"];
    const { traceVerbose, slowTraceMs, failureSampleMs } = resolveRpcTraceSettings();
    const onConnectTrace = opts.onConnectTrace ??
        createDefaultConnectTraceHandler(traceVerbose, slowTraceMs, failureSampleMs);
    const resolveIdentity = createIdentityResolver(opts.identity);
    const withRecoveryRestart = createRecoveryRestart(url, (method, params) => call(method, params));
    async function call(method, params, requestTimeoutMs = callTimeoutMs) {
        const ws = await openAndConnect({
            url,
            ...auth,
            connectTimeoutMs,
            identity: resolveIdentity(),
            scopes,
            onConnectTrace,
        });
        try {
            return await withRecoveryRestart(method, () => sendWsRequest({
                ws,
                id: randomUUID(),
                method,
                params,
                timeoutMs: requestTimeoutMs,
            }));
        }
        finally {
            try {
                ws.close();
            }
            catch { /* */ }
        }
    }
    const statusConnection = createChannelsStatusConnection({
        url, auth, connectTimeoutMs, callTimeoutMs, identity: resolveIdentity,
        scopes, onConnectTrace,
    });
    return {
        async configGet() {
            return parseConfigGetResult(await call("config.get", {}));
        },
        async configApply(config, baseHash) {
            return await writeConfig(call, "config.apply", config, baseHash);
        },
        async configPatch(patch, baseHash, opts) {
            return await writeConfig(call, "config.patch", patch, baseHash, opts?.replacePaths);
        },
        async configPatchAndWaitForChange(patch, baseHash, opts) {
            return await withRecoveryRestart("config.patch", () => patchConfigAndWaitForChange({
                url,
                auth,
                connectTimeoutMs,
                callTimeoutMs,
                identity: resolveIdentity(),
                scopes,
                onConnectTrace,
            }, patch, baseHash, opts?.replacePaths));
        },
        channelsStatus: statusConnection.call,
        channelsStatusConnectionGeneration: statusConnection.connectionGeneration,
        channelsStop: (params) => stopChannels(call, params),
        channelsStart: (params) => startChannels(call, params),
        async modelsAuthRefresh(params) {
            const payload = await call("models.authRefresh", params);
            if (!payload || typeof payload !== "object" || payload.refreshed !== true) {
                throw new OpenclawWireError(INVALID_RESPONSE, "models.authRefresh did not acknowledge refreshed credentials");
            }
            return { refreshed: true };
        },
        gatewayRestartRequest: (params) => requestGatewayRestart(call, params),
        async sessionsList(params) {
            const payload = await call("sessions.list", params);
            if (!payload || typeof payload !== "object") {
                throw new OpenclawWireError(INVALID_RESPONSE, "sessions.list returned non-object payload");
            }
            const sessions = payload.sessions;
            if (!Array.isArray(sessions)) {
                throw new OpenclawWireError(INVALID_RESPONSE, "sessions.list payload missing `sessions` array");
            }
            for (const session of sessions) {
                if (!session || typeof session !== "object" || typeof session.key !== "string") {
                    throw new OpenclawWireError(INVALID_RESPONSE, "sessions.list returned a session without string `key`");
                }
            }
            return payload;
        },
        async sessionsReset(params) {
            const payload = await call("sessions.reset", params);
            if (!payload || typeof payload !== "object" || payload.ok !== true) {
                throw new OpenclawWireError(INVALID_RESPONSE, "sessions.reset payload missing `ok: true`");
            }
            return payload;
        },
        sessionsAbort: (params) => abortSession(call, params),
        toolsCatalog: (params, timeoutMs) => fetchToolsCatalog(call, params, timeoutMs),
        async schedulerMigration(params) {
            const result = await call("cron.migration", params);
            if (!result || typeof result !== "object")
                throw new OpenclawWireError(INVALID_RESPONSE, "cron.migration returned non-object payload");
            const value = result;
            if (value.operationId !== params.operationId || value.phase !== params.phase ||
                typeof value.drained !== "boolean" || !Array.isArray(value.agentIds) ||
                value.agentIds.some(id => typeof id !== "string" || !id) ||
                (value.agentIds.length === 0 && params.phase !== "resume" && params.phase !== "abort") ||
                (params.phase === "export" && value.snapshot === undefined)) {
                throw new OpenclawWireError(INVALID_RESPONSE, "cron.migration returned a mismatched operation or invalid scheduler state");
            }
            return value;
        },
        async cronRequest(method, params) {
            if (!SCHEDULE_TRANSFER_CRON_METHODS.includes(method))
                throw new Error(`cronRequest does not allow ${String(method)}`);
            return call(method, params);
        },
        async cronJobCount(agentId, opts) {
            const payload = await call("cron.list", {
                agentId, enabled: opts?.includeDisabled ? "all" : "enabled", compact: true, limit: 1,
            });
            const total = payload?.total;
            if (!Number.isSafeInteger(total) || total < 0) {
                throw new OpenclawWireError(INVALID_RESPONSE, "cron.list payload missing nonnegative total");
            }
            return total;
        },
        async cronAdd(spec) {
            const payload = await call("cron.add", spec);
            if (!payload || typeof payload !== "object") {
                throw new OpenclawWireError(INVALID_RESPONSE, "cron.add returned non-object payload");
            }
            const result = payload;
            const job = typeof result.created === "boolean" ? result.job : payload;
            const id = job && typeof job === "object" ? job.id : undefined;
            if (typeof id !== "string" || id.length === 0) {
                throw new OpenclawWireError(INVALID_RESPONSE, "cron.add payload missing string `id`");
            }
            return { ...payload, id };
        },
        agentsCreate: (params) => callAgentsCreate(call, params),
        agentsDelete: (params) => callAgentsDelete(call, params),
        agentsDetach: async (params) => {
            const payload = await callOkPayload(call, "agents.detach", params);
            if (payload.agentId !== params.agentId || (payload.purgeFailed !== undefined && payload.purgeFailed !== false) ||
                payload.failed !== undefined && (!Array.isArray(payload.failed) || payload.failed.length > 0)) {
                throw new OpenclawWireError(INVALID_RESPONSE, "agents.detach did not confirm completed store-preserving cleanup");
            }
            return payload;
        },
        agentsDetachMany: async (params) => {
            const payload = await callOkPayload(call, "agents.detachMany", params);
            if (!Array.isArray(payload.results) || payload.results.length !== params.agentIds.length ||
                !payload.results.every((result, index) => {
                    if (!result || typeof result !== "object")
                        return false;
                    const receipt = result;
                    return receipt.ok === true && receipt.agentId === params.agentIds[index] &&
                        receipt.purgeFailed === undefined && Array.isArray(receipt.failed) && receipt.failed.length === 0 &&
                        Array.isArray(receipt.removed) && receipt.removed.length === 0;
                })) {
                throw new OpenclawWireError(INVALID_RESPONSE, "agents.detachMany did not confirm completed store-preserving cleanup for every agent");
            }
        },
        async secretsReload() {
            return parseSecretsReloadPayload(await call("secrets.reload", {}));
        },
        brokerProfilesMaterialize: async (params) => parseBrokerProfileMaterializationPayload(await call("octogee.brokerProfiles.materialize", params)),
        async degradedSecretsStatus() {
            return parseDegradedSecretOwners(await call("status", { includeChannelSummary: false }));
        },
        async isGatewayUp(timeoutMs) {
            const t = timeoutMs ?? connectTimeoutMs;
            try {
                const ws = await openAndConnect({
                    url,
                    ...auth,
                    connectTimeoutMs: t,
                    identity: resolveIdentity(),
                    scopes,
                    onConnectTrace,
                });
                try {
                    ws.close();
                }
                catch { /* */ }
                return true;
            }
            catch {
                return false;
            }
        },
        close: statusConnection.close,
    };
}
const IN_POD_SERVICE_IDENTITY = OPENCLAW_PROVISIONER_SERVICE_IDENTITY;
function inPodProxyClientAddress() {
    const address = Object.values(os.networkInterfaces())
        .flatMap((entries) => entries ?? [])
        .find((entry) => !entry.internal && entry.family === "IPv4")?.address;
    if (!address)
        throw new Error("per-user service RPC requires a non-loopback IPv4 address");
    return address;
}
function resolveGatewayAuth(opts) {
    if (typeof opts.deviceToken === "string" && opts.deviceToken.length > 0) {
        return { deviceToken: opts.deviceToken };
    }
    if (typeof opts.token === "string" && opts.token.length > 0)
        return { token: opts.token };
    if (!opts.allowLegacyGatewayTokenFallback)
        return {};
    if (isPerUserControlIdentity()) {
        return { proxyIdentity: {
                ...openClawProxyIdentityHeaders({
                    user: IN_POD_SERVICE_IDENTITY,
                    clientAddress: inPodProxyClientAddress(),
                }),
                origin: openClawProxyOrigin(),
            } };
    }
    const fromEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
    if (typeof fromEnv === "string" && fromEnv.length > 0)
        return { token: fromEnv };
    const fromFile = readTokenFromOpenClawJson(opts.openclawConfigPath);
    return fromFile ? { token: fromFile } : {};
}
function readTokenFromOpenClawJson(configPath) {
    const activeConfigPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
    const resolved = configPath
        ?? activeConfigPath
        ?? path.join(os.homedir(), ".openclaw", "openclaw.json");
    try {
        const raw = fs.readFileSync(resolved, "utf8");
        const parsed = JSON.parse(raw);
        const token = parsed?.gateway?.auth?.token;
        if (typeof token === "string" && token.length > 0)
            return token;
    }
    catch { /* */ }
    return "";
}
const PROTOCOL_VERSION = OPENCLAW_PROTOCOL_VERSION;
function proxyIdentityConnectParams() {
    return {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
            id: OPENCLAW_CONTROL_UI_CLIENT_ID,
            displayName: "octogee-provisioner",
            version: "1.0.0",
            platform: process.platform,
            mode: "backend",
        },
        role: "operator",
    };
}
function deviceConnectParams(params, nonce) {
    const clientInfo = {
        id: "gateway-client",
        displayName: "octogee-provisioner",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
    };
    const device = signConnectDevice({
        identity: params.identity,
        clientId: clientInfo.id,
        clientMode: clientInfo.mode,
        role: "operator",
        scopes: params.scopes,
        nonce,
        token: params.deviceToken || params.token || null,
        platform: clientInfo.platform,
    });
    let auth;
    if (params.deviceToken)
        auth = { deviceToken: params.deviceToken };
    else if (params.token)
        auth = { token: params.token };
    else
        auth = undefined;
    return {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: clientInfo,
        role: "operator",
        scopes: params.scopes,
        device,
        ...(auth ? { auth } : {}),
    };
}
async function openAndConnect(params) {
    if (params.proxyIdentity)
        assertWorkspaceIdentityReady();
    const t0 = Date.now();
    let wsOpenMs;
    let challengeMs;
    let connectMs;
    let stage = "ws-open";
    const emitTrace = (success, err) => {
        if (!params.onConnectTrace)
            return;
        params.onConnectTrace({
            url: params.url,
            stage: success ? "done" : stage,
            success,
            wsOpenMs,
            challengeMs,
            connectMs,
            totalMs: Date.now() - t0,
            errorCode: err?.code,
            errorMessage: err?.message,
        });
    };
    const ws = params.proxyIdentity
        ? new WebSocket(params.url, { headers: params.proxyIdentity })
        : new WebSocket(params.url);
    ws.on("error", () => { });
    const nonceTracker = startConnectChallengeTracker(ws);
    const phaseTimeoutMs = () => {
        if (params.deadlineAtMs === undefined)
            return params.connectTimeoutMs;
        const remaining = params.deadlineAtMs - Date.now();
        if (remaining <= 0) {
            throw new OpenclawWireError("timeout", "gateway connection deadline exceeded");
        }
        return Math.min(params.connectTimeoutMs, remaining);
    };
    try {
        const wsOpenStart = Date.now();
        await waitForWsOpen(ws, phaseTimeoutMs());
        wsOpenMs = Date.now() - wsOpenStart;
        stage = "challenge";
        const challengeStart = Date.now();
        const nonce = await nonceTracker.wait(phaseTimeoutMs());
        challengeMs = Date.now() - challengeStart;
        stage = "connect";
        const connectStart = Date.now();
        await sendWsRequest({
            ws,
            id: randomUUID(),
            method: "connect",
            params: params.proxyIdentity
                ? proxyIdentityConnectParams()
                : deviceConnectParams(params, nonce),
            timeoutMs: phaseTimeoutMs(),
            mapConnectErrors: true,
        });
        connectMs = Date.now() - connectStart;
        phaseTimeoutMs();
        emitTrace(true);
    }
    catch (err) {
        try {
            ws.terminate();
        }
        catch { /* */ }
        emitTrace(false, err instanceof OpenclawWireError ? err : undefined);
        throw err;
    }
    return ws;
}
export function provisionDefaultAgentAutomation(rpc, user) {
    if (!user.coachChannelId || !/^[a-z0-9]{26}$/u.test(user.coachChannelId)) {
        throw new Error(`Agent automation for ${user.slug} requires its workspace's private agent channel ID`);
    }
    const agentId = `octogee-${user.slug}-coach`;
    return rpc.cronAdd({
        declarationKey: `octogee:coach-monitor:${agentId}`,
        name: `Proactive check (${agentId})`,
        agentId,
        enabled: true,
        schedule: { kind: "every", everyMs: 30 * 60 * 1000 },
        sessionTarget: `session:agent:${agentId}:main`,
        sessionKey: `agent:${agentId}:main`,
        wakeMode: "now",
        idleOnly: true,
        payload: {
            kind: "agentTurn",
            message: "Review your automation scratch checklist and relevant session context. Do not infer or repeat old tasks from prior conversations. Take useful action only when needed. Use NO_REPLY when there is nothing to tell the user.",
            skipIfScratchEmpty: true,
        },
        delivery: {
            mode: "announce",
            channel: "mattermost",
            accountId: `${user.slug}-coach`,
            to: `channel:${user.coachChannelId}`,
        },
    });
}
