import { randomBytes } from "node:crypto";
import { heldNativeSourceReconcileJobId, gatewayScopedJobId, signFleetRequest, sourceActivationReadinessJobId } from "./fleet-signature.js";
import { SIGNATURE_HEADER, MIGRATION_QUIESCE_TIMEOUT_MS, MIGRATION_TRANSFER_TIMEOUT_MS, MIGRATION_UNMOUNT_TIMEOUT_MS, MIGRATION_VERIFY_TIMEOUT_MS, isSchedulerMigrationResult, } from "@octogee/shared/types/fleet-controller";
export class MigrationRpcError extends Error {
    details;
    status;
    code;
    retryable;
    constructor(message, options = {}) {
        super(message);
        this.name = "MigrationRpcError";
        this.details = options.details;
        this.status = options.status;
        this.code = options.code;
        this.retryable = options.retryable;
    }
}
export class MigrationDrainPendingError extends Error {
    retryable = true;
}
export class MigrationTransportError extends Error {
    retryable = true;
    constructor(message, options = {}) {
        super(message, options);
        this.name = "MigrationTransportError";
    }
}
export function isDefinitiveConfigRpcRejection(error) {
    if (!error || typeof error !== "object")
        return false;
    const rpc = error;
    return typeof rpc.status === "number" &&
        (rpc.status === 501 ||
            rpc.status >= 400 &&
                rpc.status < 500 &&
                rpc.status !== 408 &&
                rpc.status !== 429);
}
function createFetchWithTimeout(fetchImpl) {
    return async (label, url, init, timeoutMs) => {
        const controller = new AbortController();
        let didTimeout = false;
        const timer = setTimeout(() => {
            didTimeout = true;
            controller.abort();
        }, timeoutMs);
        try {
            const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
            return await fetchImpl(url, { ...init, signal });
        }
        catch (err) {
            if (didTimeout) {
                throw new MigrationTransportError(`${label} timed out after ${timeoutMs}ms (${url})`, { cause: err });
            }
            const message = err instanceof Error ? err.message : String(err);
            throw new MigrationTransportError(`${label} transport failed: ${message}`, { cause: err });
        }
        finally {
            clearTimeout(timer);
        }
    };
}
function createSignedGatewayPoster(deps) {
    return async (request) => {
        const { path, timeoutMs } = request;
        const rawBody = JSON.stringify(request.body);
        const signature = signFleetRequest(deps.privateKey, request.jobId ?? gatewayScopedJobId(request.migrationId, request.gatewayId), rawBody);
        return deps.fetchWithTimeout(path, `${deps.resolveGatewayUrl(request.transportId)}${path}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                [SIGNATURE_HEADER]: signature,
            },
            body: rawBody,
            ...(request.signal ? { signal: request.signal, redirect: "error" } : {}),
        }, timeoutMs);
    };
}
async function readSignedJsonResponse(response, path) {
    if (!response.ok)
        throw await migrationRpcError(path, response);
    try {
        return (await response.json());
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new MigrationTransportError(`${path} response body was incomplete: ${message}`, { cause: err });
    }
}
function isActivationReadinessAcknowledgement(value, migrationId, slug) {
    if (typeof value !== "object" || value === null || Object.keys(value).length !== 3)
        return false;
    const reply = value;
    return reply.migrationId === migrationId && reply.slug === slug && reply.exportable === true;
}
async function isUnregisteredActivationReadinessRoute(response, path) {
    if (response.status !== 404 || response.headers.get("content-type") !== "text/html; charset=utf-8" ||
        response.headers.get("x-content-type-options") !== "nosniff" ||
        response.headers.get("content-security-policy") !== "default-src 'none'")
        return false;
    return (await response.text()) === [
        "<!DOCTYPE html>", '<html lang="en">', "<head>", '<meta charset="utf-8">', "<title>Error</title>", "</head>",
        "<body>", `<pre>Cannot POST ${path}</pre>`, "</body>", "</html>", "",
    ].join("\n");
}
export { reconcileHeldNativeSource } from "./held-native-source-reconcile.js";
export async function requestHeldNativeSourceReconcile(input) {
    const { binding } = input;
    const { gatewayId, slug } = binding;
    const migrationId = `mig-${binding.operationId}`;
    const path = `/held-native-source-reconcile/${encodeURIComponent(gatewayId)}`;
    const nonce = randomBytes(32).toString("hex");
    const post = createSignedGatewayPoster({
        privateKey: input.privateKey,
        resolveGatewayUrl: () => input.sourceUrl,
        fetchWithTimeout: createFetchWithTimeout((url, init) => (input.fetch ?? globalThis.fetch)(url, { ...init, redirect: "error" })),
    });
    const response = await post({ path, transportId: gatewayId, gatewayId, migrationId, timeoutMs: MIGRATION_TRANSFER_TIMEOUT_MS,
        jobId: heldNativeSourceReconcileJobId(migrationId, gatewayId),
        body: { migrationId, slug, binding, nonce, expiresAt: Date.now() + 60_000 },
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Held source reconciliation returned HTTP ${response.status}`);
    }
    const reply = await response.json();
    const proof = reply?.proof;
    if (reply?.nonce !== nonce || reply?.requestId !== binding.requestId || reply?.holdGeneration !== binding.holdGeneration ||
        typeof proof?.verifiedAt !== "number" || !Number.isSafeInteger(proof.verifiedAt) || proof.verifiedAt < binding.claimStartedAt ||
        typeof proof.appliedFingerprint !== "string" || !/^[0-9a-f]{16}$/.test(proof.appliedFingerprint) ||
        typeof proof.activationManifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(proof.activationManifestSha256)) {
        throw new Error("Held source returned a mismatched reconciliation proof");
    }
    return { verifiedAt: proof.verifiedAt, appliedFingerprint: proof.appliedFingerprint, activationManifestSha256: proof.activationManifestSha256 };
}
export function createMigrationClient(deps) {
    const log = deps.log ?? (() => undefined);
    const quiesceMs = deps.timeouts?.quiesceMs ?? MIGRATION_QUIESCE_TIMEOUT_MS;
    const transferMs = deps.timeouts?.transferMs ?? MIGRATION_TRANSFER_TIMEOUT_MS;
    const unmountMs = deps.timeouts?.unmountMs ?? MIGRATION_UNMOUNT_TIMEOUT_MS;
    const verifyMs = deps.timeouts?.verifyMs ?? MIGRATION_VERIFY_TIMEOUT_MS;
    const postSigned = createSignedGatewayPoster({
        privateKey: deps.privateKey,
        resolveGatewayUrl: deps.resolveGatewayUrl,
        fetchWithTimeout: createFetchWithTimeout(deps.fetch ?? globalThis.fetch),
    });
    const postSignedJson = async (request) => readSignedJsonResponse(await postSigned(request), request.path);
    return {
        async abortImport({ migrationId, gatewayId, slug, mode }) {
            const transferAttemptId = await deps.resolveTransferAttemptForCleanup?.({ migrationId, gatewayId, slug, mode });
            const result = await postSignedJson({
                transportId: gatewayId, path: `/abort-rsync-import/${gatewayId}`, gatewayId, migrationId,
                body: { migrationId, slug, mode, rpcPhase: "abort-rsync-import", ...(transferAttemptId ? { transferAttemptId } : {}) }, timeoutMs: unmountMs,
            });
            if (result.migrationId !== migrationId || result.slug !== slug || result.imported !== false) {
                throw new Error("import cleanup acknowledgement mismatch");
            }
        },
        async scheduler({ gatewayId, transportId, ...body }) {
            const result = await postSignedJson({
                transportId: transportId ?? gatewayId,
                path: `/scheduler/${gatewayId}`,
                gatewayId,
                migrationId: body.migrationId,
                body,
                timeoutMs: quiesceMs,
            });
            if (!isSchedulerMigrationResult(result, body.migrationId, body.phase) || !result.drained) {
                throw new Error(`scheduler ${body.phase} did not prove a drained matching operation`);
            }
            return result;
        },
        schedules: (async ({ gatewayId, transportId, ...body }) => {
            const result = await postSignedJson({
                transportId: transportId ?? gatewayId,
                path: `/schedules/${gatewayId}`,
                gatewayId,
                migrationId: body.migrationId,
                body,
                timeoutMs: quiesceMs,
            });
            if (!scheduleTransferAcknowledged(body, result)) {
                throw new Error(`schedules ${body.op} acknowledgement mismatch`);
            }
            return result;
        }),
        async restoreTarget({ migrationId, gatewayId, transportId, uid, slug, snapshot, resume }) {
            await deps.prepareAgentStores?.(gatewayId, slug);
            const res = await postSignedJson({
                transportId: transportId ?? gatewayId,
                path: `/${resume === true ? "resume-restore" : "restore"}/${gatewayId}`,
                gatewayId,
                migrationId,
                body: { migrationId, uid, slug, snapshot },
                timeoutMs: transferMs,
            });
            log(`[migration-client] ✅ restoreTarget migrationId=${migrationId} slug=${slug} gateway=${gatewayId} steps=${res.steps.join(",")}`);
            return res;
        },
        async sourceActivationReadiness({ gatewayId, transportId, migrationId, slug }) {
            const path = `/source-activation-ready/${gatewayId}`;
            try {
                const response = await postSigned({
                    transportId: transportId ?? gatewayId, path, gatewayId, migrationId,
                    jobId: sourceActivationReadinessJobId(migrationId, gatewayId),
                    body: { migrationId, slug }, timeoutMs: verifyMs, signal: AbortSignal.timeout(verifyMs),
                });
                if (await isUnregisteredActivationReadinessRoute(response, path))
                    return "unsupported";
                if (response.status !== 200 || !/^application\/json(?:; charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")) {
                    return "unavailable";
                }
                return isActivationReadinessAcknowledgement(await response.json(), migrationId, slug) ? "ready" : "unavailable";
            }
            catch {
                return "unavailable";
            }
        },
        async resume({ migrationId, gatewayId, transportId, slug, role }) {
            await deps.prepareAgentStores?.(gatewayId, slug);
            const response = await postSignedJson({
                transportId: transportId ?? gatewayId, path: `/resume/${gatewayId}`,
                gatewayId, migrationId, body: { migrationId, slug, ...(role ? { role } : {}) }, timeoutMs: quiesceMs,
            });
            if (response.resumed !== true)
                throw new Error(`source ingress did not resume for ${slug}`);
        },
        async quiesce({ migrationId, gatewayId, transportId, slug, timeoutMs, stopMattermost, schedulerHandoff, schedulerMigrationId, retainNonportable }) {
            const handoff = schedulerHandoff
                ? { schedulerHandoff: true, schedulerMigrationId: schedulerMigrationId ?? migrationId, ...(retainNonportable ? { retainNonportable: true } : {}) }
                : {};
            const res = await postSignedJson({
                transportId: transportId ?? gatewayId,
                path: `/quiesce/${gatewayId}`,
                gatewayId,
                migrationId,
                body: { migrationId, slug, ...(timeoutMs == null ? {} : { timeoutMs }), ...(stopMattermost === undefined ? {} : { stopMattermost }), ...handoff },
                timeoutMs: Math.max(quiesceMs, (timeoutMs ?? MIGRATION_QUIESCE_TIMEOUT_MS) + 30_000),
            });
            if (!res.drained) {
                throw new MigrationDrainPendingError(`quiesce did not drain: ${res.runningCount} still running on ${gatewayId} for slug=${slug}`);
            }
            log(`[migration-client] ✅ quiesce ok migrationId=${migrationId} slug=${slug}`);
            return res;
        },
        async flushGateway({ migrationId, gatewayId, transportId, slug, reason, expectedSystemConfigCommit, }) {
            const res = await postSignedJson({
                transportId: transportId ?? gatewayId,
                path: `/flush/${gatewayId}`,
                gatewayId,
                migrationId,
                body: {
                    migrationId,
                    slug,
                    reason,
                    ...(expectedSystemConfigCommit ? { expectedSystemConfigCommit } : {}),
                },
                timeoutMs: transferMs,
            });
            log(`[migration-client] ✅ flushGateway migrationId=${migrationId} slug=${slug} gateway=${gatewayId} ok=${res.ok}`);
            return res;
        },
        async unmount({ migrationId, gatewayId, transportId, slug }) {
            const res = await postSignedJson({
                transportId: transportId ?? gatewayId,
                path: `/unmount/${gatewayId}`,
                gatewayId,
                migrationId,
                body: { migrationId, slug },
                timeoutMs: unmountMs,
            });
            if (res.migrationId !== migrationId || res.slug !== slug || typeof res.unmounted !== "boolean") {
                throw new Error("unmount cleanup acknowledgement mismatch");
            }
            log(`[migration-client] ✅ unmount migrationId=${migrationId} slug=${slug} wasMounted=${res.unmounted}`);
            return res;
        },
        transferState: deps.transferState,
        async verifyTarget({ migrationId, gatewayId, transportId, slug }) {
            const res = await postSignedJson({
                transportId: transportId ?? gatewayId,
                path: `/verify/${gatewayId}`,
                gatewayId,
                migrationId,
                body: { migrationId, slug },
                timeoutMs: verifyMs,
            });
            if (!res.ready) {
                throw new Error(`target verify failed on ${gatewayId} for slug=${slug}: ${JSON.stringify(res.checks)}`);
            }
            log(`[migration-client] ✅ verifyTarget migrationId=${migrationId} slug=${slug} gateway=${gatewayId}`);
            return res;
        },
    };
}
function scheduleTransferAcknowledged(request, result) {
    if (result.migrationId !== request.migrationId || result.slug !== request.slug || result.op !== request.op)
        return false;
    if (result.op === "snapshot")
        return Array.isArray(result.records) && Array.isArray(result.skipped);
    if (result.op === "remove")
        return typeof result.removed === "number" && Array.isArray(result.failed);
    if (result.op === "check")
        return Array.isArray(result.conflicts);
    return Array.isArray(result.failed);
}
async function migrationRpcError(path, response) {
    const text = await response.text().catch(() => "<no body>");
    let details = {};
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            details = parsed;
        }
    }
    catch {
        details = {};
    }
    const options = { status: response.status, details };
    if (typeof details.retryable === "boolean")
        options.retryable = details.retryable;
    if (typeof details.code === "string")
        options.code = details.code;
    return new MigrationRpcError(`${path}: ${response.status} ${text}`, options);
}
export async function reportMigrationProgress(deps, gatewayId, body) {
    const post = createSignedGatewayPoster({
        privateKey: deps.privateKey,
        resolveGatewayUrl: deps.resolveGatewayUrl,
        fetchWithTimeout: createFetchWithTimeout(deps.fetch ?? globalThis.fetch),
    });
    const path = `/migration-progress/${gatewayId}`;
    const response = await post({
        transportId: gatewayId,
        path,
        gatewayId,
        migrationId: body.migrationId,
        body: { ...body },
        timeoutMs: 2_000,
    });
    await readSignedJsonResponse(response, path);
}
