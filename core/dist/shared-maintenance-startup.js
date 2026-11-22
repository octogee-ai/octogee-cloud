import { createPublicKey, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { gatewayScopedJobId, verifyFleetRequest } from "./fleet-signature.js";
const signaturePurpose = (request) => gatewayScopedJobId(`shared-maintenance-startup/${request.attemptId}/${request.role}`, request.gatewayId);
const archiveHash = /^[a-f0-9]{64}$/;
export function allowSharedMaintenanceLaunch(input) {
    const { request, proof, publicKey, now } = input;
    if (typeof proof.raw !== "string" || proof.raw.length > 8192 ||
        !verifyFleetRequest(publicKey, signaturePurpose(request), proof.raw, proof.signature))
        return false;
    const { request: signed, restoredArchiveSha256, observedImageId, expiresAt } = JSON.parse(proof.raw);
    return isDeepStrictEqual(signed, request) && archiveHash.test(restoredArchiveSha256) &&
        /^sha256:[a-f0-9]{64}$/.test(observedImageId) && Number.isSafeInteger(expiresAt) && expiresAt > now && expiresAt <= now + 15_000;
}
function createInertProbeServer(role) {
    return createServer((request, response) => {
        const healthPath = role === "gateway" ? "/healthz" : "/health";
        response.writeHead(request.method === "GET" && request.url === healthPath ? 200 : 503).end();
    });
}
async function listen(server, port, host) {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
    });
}
async function waitForSharedMaintenanceRelease(input, enrollment) {
    for (;;) {
        input.signal.throwIfAborted();
        const request = { ...enrollment, nonce: randomBytes(32).toString("hex") };
        let released = false;
        try {
            const proof = await input.read(request, input.signal);
            released = !!proof && allowSharedMaintenanceLaunch({ request, proof, publicKey: input.publicKey, now: Date.now() });
        }
        catch {
            input.onUnavailable();
        }
        input.signal.throwIfAborted();
        if (released)
            return;
        await setTimeout(input.retryMs ?? 2_000, undefined, { signal: input.signal });
    }
}
function startupIdentityMatches(enrollment, role) {
    return enrollment.role === role && /^[a-f0-9]{40}$/.test(enrollment.buildId) &&
        archiveHash.test(enrollment.artifactSetId) && Boolean(enrollment.attemptId) && Boolean(enrollment.podUid);
}
export async function runSharedMaintenanceStartup(input) {
    const { enrollment, local } = input;
    if (!enrollment || enrollment.namespace !== local.namespace || enrollment.gatewayId !== local.gatewayId) {
        await input.launch();
        return;
    }
    if (!startupIdentityMatches(enrollment, local.role))
        throw new Error("Shared maintenance role enrollment does not match the allocation");
    const health = createInertProbeServer(enrollment.role);
    const readiness = enrollment.role === "gateway"
        ? createServer((_request, response) => response.writeHead(503).end()) : null;
    try {
        const host = input.probeHost ?? "0.0.0.0";
        await listen(health, input.probePort ?? (enrollment.role === "gateway" ? 18789 : 3001), host);
        if (readiness)
            await listen(readiness, input.readinessPort ?? 3003, host);
        input.observeProbes?.(health, readiness);
        await waitForSharedMaintenanceRelease(input, enrollment);
    }
    finally {
        const stop = (server) => new Promise(resolve => {
            server.close(() => resolve());
            server.closeAllConnections();
        });
        await Promise.all([health, readiness].filter(server => server !== null).map(stop));
    }
    await input.launch();
}
async function permitBody(request) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 16_384)
            throw new Error("Shared maintenance permit exceeds the local socket limit");
        chunks.push(buffer);
    }
    const proof = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof proof?.raw !== "string" || typeof proof.signature !== "string")
        throw new Error("Shared maintenance permit is malformed");
    return proof;
}
export async function openSharedMaintenancePermitSocket({ publicKey, directory = "/tmp", onSocket }) {
    const privateDirectory = await mkdtemp(join(directory, "octogee-shared-held-"));
    const socket = join(privateDirectory, "permit.sock");
    let pending;
    const server = createServer((message, response) => {
        const current = pending;
        if (!current) {
            response.writeHead(409).end();
            return;
        }
        if (message.method === "GET" && message.url === "/nonce") {
            response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end(current.request.nonce);
            return;
        }
        if (message.method !== "POST" || message.url !== "/permit") {
            response.writeHead(404).end();
            return;
        }
        void permitBody(message).then(proof => {
            if (pending !== current || !allowSharedMaintenanceLaunch({ request: current.request, proof, publicKey, now: Date.now() })) {
                response.writeHead(403).end();
                return;
            }
            pending = undefined;
            response.writeHead(204).end(() => current.resolve(proof));
        }).catch(() => { response.writeHead(400).end(); });
    });
    try {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(socket, resolve);
        });
        await chmod(socket, 0o600);
        onSocket?.(socket);
    }
    catch (error) {
        server.close();
        await rm(privateDirectory, { recursive: true, force: true });
        throw error;
    }
    return {
        socket,
        async read(request, signal) {
            signal.throwIfAborted();
            if (pending)
                throw new Error("Shared maintenance already has an outstanding nonce");
            return new Promise((resolve, reject) => {
                const abort = () => { pending = undefined; reject(signal.reason); };
                signal.addEventListener("abort", abort, { once: true });
                pending = { request, resolve(proof) {
                        signal.removeEventListener("abort", abort);
                        resolve(proof);
                    } };
            });
        },
        async close() {
            await new Promise(resolve => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
            await rm(privateDirectory, { recursive: true, force: true });
        },
    };
}
export function sharedMaintenanceCompletionPurpose(scope) {
    return gatewayScopedJobId(`shared-maintenance-completion/${scope.attemptId}`, scope.gatewayId);
}
export function isSharedMaintenancePublication(publication, now) {
    return !!publication && Number.isSafeInteger(publication.release) && publication.release > 0 &&
        typeof publication.payloadHash === "string" && archiveHash.test(publication.payloadHash) &&
        Number.isSafeInteger(publication.publishedAt) && publication.publishedAt > 0 && publication.publishedAt <= now;
}
export function allowSharedMaintenanceRestart(input) {
    const { scope, localBoundPodUid, proof, publicKey, now } = input;
    if (!localBoundPodUid || localBoundPodUid !== scope.podUid ||
        typeof proof?.raw !== "string" || proof.raw.length > 8192 ||
        !verifyFleetRequest(publicKey, sharedMaintenanceCompletionPurpose(scope), proof.raw, proof.signature))
        return false;
    const receipt = JSON.parse(proof.raw);
    return receipt !== null && isDeepStrictEqual(receipt.scope, scope) && archiveHash.test(receipt.restoredArchiveSha256) &&
        isSharedMaintenancePublication(receipt.publication, now) && [receipt.images?.gateway, receipt.images?.["gateway-edge"]]
        .every(image => typeof image === "string" && /^sha256:[a-f0-9]{64}$/.test(image)) &&
        receipt.images.gateway !== receipt.images["gateway-edge"];
}
export function projectedSharedMaintenancePodUid(token, namespace) {
    const [, payload] = token.trim().split(".");
    if (!payload || payload.length > 8192)
        return null;
    try {
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        const identity = claims["kubernetes.io"];
        return Array.isArray(claims.aud) && claims.aud.includes("octogee-api-gateway-credentials") &&
            identity?.namespace === namespace && typeof identity.pod?.uid === "string" ? identity.pod.uid : null;
    }
    catch {
        return null;
    }
}
const installedFiles = {
    enrollment: "/etc/octogee/shared-maintenance-startup.json",
    completion: "/home/node/.octogee-shared-maintenance-completion.json",
    projectedToken: "/var/run/secrets/octogee-gateway-credentials/token",
    enrollmentOwnerUid: 0,
};
async function hasSharedMaintenanceCompletion(scope, publicKey, files) {
    const file = await open(files.completion, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error) => {
        if (error.code === "ENOENT")
            return null;
        throw error;
    });
    if (!file)
        return false;
    try {
        const info = await file.stat();
        if (!info.isFile() || info.size <= 0 || info.size > 16_384)
            return false;
        const token = await readFile(files.projectedToken, "utf8");
        const released = allowSharedMaintenanceRestart({
            scope, localBoundPodUid: projectedSharedMaintenancePodUid(token, scope.namespace),
            proof: JSON.parse(await file.readFile("utf8")), publicKey, now: Date.now(),
        });
        if (!released)
            process.stderr.write("Shared maintenance completion receipt could not authorize this restart\n");
        return released;
    }
    catch (error) {
        if (error instanceof SyntaxError || error.code === "ENOENT")
            return false;
        throw error;
    }
    finally {
        await file.close();
    }
}
async function readInertStartupDocument(files) {
    const file = await open(files.enrollment, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        .catch((error) => {
        if (error.code === "ENOENT")
            return null;
        throw error;
    });
    if (!file)
        return null;
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== files.enrollmentOwnerUid || (stat.mode & 0o022) !== 0 || stat.size <= 0 || stat.size > 8192) {
            throw new Error("Shared maintenance startup enrollment is not an immutable image file");
        }
        const contents = await file.readFile();
        if (contents.length !== stat.size)
            throw new Error("Shared maintenance startup enrollment changed");
        return JSON.parse(contents.toString("utf8"));
    }
    finally {
        await file.close();
    }
}
function validInstalledMaintenanceDocument(document) {
    return document.version === 1 && document.environment === "test" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(document.namespace) &&
        Boolean(document.gatewayId) && Boolean(document.attemptId) && Boolean(document.podUid) &&
        /^[a-f0-9]{40}$/.test(document.buildId) && archiveHash.test(document.artifactSetId) &&
        typeof document.enrolledIssuerPublicKey === "string" &&
        createPublicKey(document.enrolledIssuerPublicKey).asymmetricKeyType === "ed25519";
}
export async function waitForInstalledSharedMaintenanceGate(role, env, deps = { files: installedFiles, hold: holdInstalledMaintenance }) {
    if (env.GATEWAY_CLASS !== "shared")
        return;
    const document = await readInertStartupDocument(deps.files);
    if (!document)
        return;
    if (!validInstalledMaintenanceDocument(document))
        throw new Error("Shared maintenance startup enrollment is malformed");
    const { version: _version, environment: _environment, enrolledIssuerPublicKey, ...scope } = document;
    if (document.namespace !== env.K8S_NAMESPACE || document.gatewayId !== env.GATEWAY_ID)
        return;
    if (await hasSharedMaintenanceCompletion(scope, enrolledIssuerPublicKey, deps.files))
        return;
    await deps.hold({ ...scope, role }, enrolledIssuerPublicKey);
}
async function holdInstalledMaintenance(enrollment, enrolledIssuerPublicKey) {
    const { role } = enrollment;
    const abort = new AbortController();
    const shutdown = () => abort.abort();
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    const localPermit = await openSharedMaintenancePermitSocket({
        publicKey: enrolledIssuerPublicKey,
        onSocket(path) { process.stderr.write(`Shared maintenance ${role} local permit socket: ${path}\n`); },
    });
    try {
        await runSharedMaintenanceStartup({
            enrollment, local: enrollment, publicKey: enrolledIssuerPublicKey, signal: abort.signal,
            read: localPermit.read,
            async launch() { },
            onUnavailable() { process.stderr.write("Shared maintenance retained launch authority is unavailable\n"); },
        });
    }
    finally {
        await localPermit.close();
        process.off("SIGTERM", shutdown);
        process.off("SIGINT", shutdown);
    }
}
