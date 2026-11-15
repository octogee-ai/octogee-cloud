import { isBlobObjectVersion } from "@octogee/shared/types/fleet-broker";
import { createHash } from "node:crypto";
import { gatewayCredentialHeaders, internalFetch, sidecarBrokerHeaders } from "../internal-fetch.js";
import { WorkspaceStorageQuotaError } from "@octogee/shared/types/workspace-storage-quota";
import { MAX_WORKSPACE_BINARY_BYTES } from "../workspace-binary.js";
import { isManifestPath } from "../workspace-manifest.js";
import { validateFilePath } from "@octogee/shared/types/path-validation";
import { pathHasReservedOrHiddenSegment } from "./route-helpers.js";
async function brokerRequest(base, route, body, headers) {
    const response = await internalFetch(`${base.replace(/\/$/u, "")}/internal/fleet/blob/${route}`, {
        method: "POST", headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ gatewayId: process.env.GATEWAY_ID, ...body }),
    });
    if (!response.ok)
        throw new Error(`project asset ${route} failed: HTTP ${response.status}`);
    return response.json();
}
function isUploadDestination(upload, url) {
    if (url.username || url.password)
        return false;
    if (upload.storage !== "s3")
        return url.protocol === "https:" && url.hostname === "storage.googleapis.com";
    const endpoint = process.env.BLOB_S3_PUBLIC_ENDPOINT;
    return Boolean(endpoint && url.origin === new URL(endpoint).origin);
}
function assertUploadCapability(upload, gcsPath, md5Hash, size) {
    const url = new URL(upload.url);
    const writeOnce = upload.storage === "s3"
        ? upload.requiredHeaders?.["if-none-match"] === "*"
        : upload.requiredHeaders?.["x-goog-if-generation-match"] === "0";
    if (upload.gcsPath !== gcsPath || upload.method !== "PUT" || !isUploadDestination(upload, url) || !writeOnce ||
        upload.requiredHeaders?.["content-md5"] !== md5Hash || upload.requiredHeaders?.["content-length"] !== String(size)) {
        throw new Error("project asset upload identity mismatch");
    }
}
export async function uploadProjectBlobViaBroker(base, target, contents, mimeType) {
    if (!target.projectSlug || target.gcsPrefix !== `customers/${target.slug}/projects/${target.projectSlug}`)
        throw new Error("invalid project asset scope");
    const sha256 = createHash("sha256").update(contents).digest("hex");
    // eslint-disable-next-line sonarjs/hashing -- GCS validates Content-MD5 in transit; SHA-256 identifies the immutable object
    const md5Hash = createHash("md5").update(contents).digest("base64");
    const gcsPath = `${target.gcsPrefix}/.objects/${sha256}`;
    const upload = await brokerRequest(base, "project/upload-url", {
        slug: target.slug, projectSlug: target.projectSlug, sha256, size: contents.length, md5Hash, mimeType,
    }, await sidecarBrokerHeaders());
    assertUploadCapability(upload, gcsPath, md5Hash, contents.length);
    const response = await fetch(upload.url, {
        method: "PUT", headers: { ...upload.requiredHeaders, "content-type": mimeType },
        body: new Uint8Array(contents), redirect: "error", signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok && response.status !== 412)
        throw new Error(`project asset upload failed: HTTP ${response.status}`);
    const verified = await brokerRequest(base, "materialization/read-url", {
        slug: target.slug, path: `projects/${target.projectSlug}/asset`, sha256, size: contents.length,
    }, await gatewayCredentialHeaders());
    if (verified.download?.gcsPath !== gcsPath || verified.size !== contents.length || verified.md5Hash !== md5Hash ||
        !isBlobObjectVersion(verified.generation, verified.download.storage)) {
        throw new Error("project asset upload checksum mismatch");
    }
    return { gcsPath, sha256, size: contents.length };
}
function assertWorkspaceBlobScope(target, filePath, contents) {
    if (target.projectSlug !== null || target.gcsPrefix !== `customers/${target.slug}` || !isManifestPath(filePath) || validateFilePath(filePath) || pathHasReservedOrHiddenSegment(filePath) || filePath === "projects" || filePath.startsWith("projects/") || contents.length > MAX_WORKSPACE_BINARY_BYTES)
        throw new Error("invalid workspace blob scope");
}
function workspaceBlobRefusal(status, result) {
    if (status === 413 && result.code === "FREE_STORAGE_LIMIT" && typeof result.limitBytes === "number" && Number.isSafeInteger(result.limitBytes) && result.limitBytes >= 0 && typeof result.projectedBytes === "number" && Number.isSafeInteger(result.projectedBytes) && result.projectedBytes >= 0)
        return new WorkspaceStorageQuotaError(result.limitBytes, result.projectedBytes);
    return new Error(`workspace blob upload failed: HTTP ${status}`);
}
function assertWorkspaceBlobAcknowledgement(result, gcsPath, size) {
    if (result.gcsPath !== gcsPath || result.size !== size ||
        result.thumbnailUrl !== undefined && typeof result.thumbnailUrl !== "string" || result.thumbnailError !== undefined && typeof result.thumbnailError !== "string")
        throw new Error("workspace blob upload acknowledgement mismatch");
}
export async function uploadWorkspaceBlobViaBroker(base, target, filePath, contents, mimeType) {
    assertWorkspaceBlobScope(target, filePath, contents);
    const body = new FormData();
    body.append("slug", target.slug);
    body.append("path", filePath);
    body.append("file", new Blob([new Uint8Array(contents)], { type: mimeType }), "workspace-blob");
    const response = await internalFetch(`${base.replace(/\/$/u, "")}/internal/fleet/blob/workspace/upload`, {
        method: "POST", headers: await sidecarBrokerHeaders(), body,
    }, { timeoutMs: 120_000 });
    const result = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error("workspace blob upload acknowledgement mismatch");
    if (!response.ok)
        throw workspaceBlobRefusal(response.status, result);
    assertWorkspaceBlobAcknowledgement(result, `${target.gcsPrefix}/${filePath}`, contents.length);
    return { gcsPath: result.gcsPath, size: result.size, ...(result.thumbnailUrl ? { thumbnailUrl: result.thumbnailUrl } : {}), ...(result.thumbnailError ? { thumbnailError: result.thumbnailError } : {}) };
}
export function projectBlobHydrationClient(base) {
    return {
        workspaceManifestReadUrl: async (input) => brokerRequest(base, "materialization/manifest/read-url", input, await gatewayCredentialHeaders()),
        blobMaterializationReadUrl: async (input) => brokerRequest(base, "materialization/read-url", input, await gatewayCredentialHeaders()),
    };
}
export function workspaceBlobReadClient(base) {
    return {
        manifestUrl: (slug) => brokerRequest(base, "manifest/read-url", { slug }, {}),
        blobUrl: (slug, path) => brokerRequest(base, "download-url", { slug, path }, {}),
    };
}
