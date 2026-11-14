import { createHash } from "node:crypto";
import { projectGatewayMutableConfigForGateway, } from "./gateway-mutable-config.js";
import { IMAGE_TAG_PATTERN } from "./image-tag.js";
import { dualReadGatewayClassValue, } from "./glm.js";
// Simple-roll model (GATEWAY-SIMPLE-ROLL-SPEC): durable identity
// (gateways/{id}) + immutable releases (releases/{n}) + ONE stable-name
// realization per gateway (glmGateways/{gatewayId} runtime doc). A roll is a
// desiredRelease write; Kubernetes surge replacement is the only mechanism.
// gateways/{gatewayId}/releases/{n} and gateways/{gatewayId}/assignments/{uid}
// are subcollections of the durable gateway identity doc.
export const GATEWAY_RELEASES_SUBCOLLECTION = "releases";
export const GATEWAY_ASSIGNMENTS_SUBCOLLECTION = "assignments";
export function dualReadIsolatedProfileImage(images) {
    return "isolated" in images ? images.isolated : images.builder;
}
const DIGEST_BOUND_IMAGE_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/;
const RELEASE_PAYLOAD_FIELD_NAMES = new Set([
    "imageRepository",
    "imageTag",
    "openclawSourceSha",
    "profileImages",
    "gatewayEdgeImage",
]);
const RELEASE_PAYLOAD_REQUIRED_FIELDS = [
    "imageRepository",
    "imageTag",
];
function isPlainRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isReleasePayload(value) {
    if (!isPlainRecord(value))
        return false;
    if (!hasReleasePayloadShape(value) || !hasReleasePayloadIdentity(value))
        return false;
    if (value.openclawSourceSha !== undefined &&
        (typeof value.openclawSourceSha !== "string" || !/^[a-f0-9]{40}$/.test(value.openclawSourceSha))) {
        return false;
    }
    if (value.profileImages !== undefined &&
        !isGatewayProfileImages(value.profileImages, value.imageRepository, value.imageTag)) {
        return false;
    }
    return value.gatewayEdgeImage === undefined ||
        isGatewayEdgeImage(value.gatewayEdgeImage, value.imageRepository);
}
function isGatewayProfileImages(value, gatewayImageRepository, gatewayImageTag) {
    if (!isPlainRecord(value) || Object.keys(value).length !== 1)
        return false;
    const [profile] = Object.keys(value);
    if (dualReadGatewayClassValue(profile) !== "isolated")
        return false;
    const isolatedImage = value[profile];
    if (!isPlainRecord(isolatedImage) || Object.keys(isolatedImage).length !== 2)
        return false;
    const gatewayPackageSuffix = "/octogee-gateway";
    const expectedRepository = gatewayImageRepository.endsWith(gatewayPackageSuffix)
        ? `${gatewayImageRepository.slice(0, -gatewayPackageSuffix.length)}/octogee-gateway-builder`
        : "";
    return (isolatedImage.imageRepository === expectedRepository &&
        typeof isolatedImage.imageTag === "string" &&
        DIGEST_BOUND_IMAGE_TAG_PATTERN.test(isolatedImage.imageTag) &&
        isolatedImage.imageTag.split("@", 1)[0] === gatewayImageTag.split("@", 1)[0]);
}
export function isGatewayEdgeImage(value, gatewayImageRepository) {
    const gatewayPackageSuffix = "/octogee-gateway";
    const expectedRepository = gatewayImageRepository.endsWith(gatewayPackageSuffix)
        ? `${gatewayImageRepository.slice(0, -gatewayPackageSuffix.length)}/gateway-edge`
        : "";
    return (isPlainRecord(value) &&
        value.imageRepository === expectedRepository &&
        typeof value.imageTag === "string" &&
        IMAGE_TAG_PATTERN.test(value.imageTag));
}
export function upgradeReleasePayloadSchema(payload, persistedPayloadHash) {
    if (typeof persistedPayloadHash !== "string" ||
        persistedPayloadHash !== releasePayloadValueHash(payload)) {
        return { status: "unsupported", reason: "payload-hash-mismatch" };
    }
    if (isReleasePayload(payload)) {
        return { status: "current", payload, payloadHash: persistedPayloadHash };
    }
    if (!isPlainRecord(payload) ||
        !Object.prototype.hasOwnProperty.call(payload, "macOpsTokenProtocol")) {
        return { status: "unsupported", reason: "unsupported-payload-schema" };
    }
    const upgraded = { ...payload };
    delete upgraded.macOpsTokenProtocol;
    if (!isReleasePayload(upgraded)) {
        return { status: "unsupported", reason: "unsupported-payload-schema" };
    }
    return {
        status: "upgraded",
        migration: "remove-retired-mac-ops-token-protocol",
        payload: upgraded,
        payloadHash: releasePayloadValueHash(upgraded),
    };
}
function hasReleasePayloadShape(value) {
    return !(Object.keys(value).some((field) => !RELEASE_PAYLOAD_FIELD_NAMES.has(field)) ||
        RELEASE_PAYLOAD_REQUIRED_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(value, field)));
}
function hasReleasePayloadIdentity(value) {
    return (typeof value.imageRepository === "string" &&
        value.imageRepository.length > 0 &&
        typeof value.imageTag === "string" &&
        value.imageTag.length > 0 &&
        IMAGE_TAG_PATTERN.test(value.imageTag));
}
export function isAssignmentState(value) {
    return value === "serving" || value === "quiescing" || value === "migrating";
}
export function hasFreshReadyKubernetesObservation(runtime, nowMs, maxAgeMs) {
    const observation = runtime.kubernetes;
    return observation?.status === "ready" &&
        Number.isSafeInteger(observation.totalPods) &&
        observation.totalPods > 0 &&
        Number.isSafeInteger(observation.readyPods) &&
        observation.readyPods > 0 &&
        Number.isFinite(observation.observedAt) &&
        nowMs >= observation.observedAt &&
        nowMs - observation.observedAt <= maxAgeMs;
}
export function isGatewayRuntimeDoc(data) {
    if (!data || typeof data !== "object")
        return false;
    const d = data;
    return (d.docKind === "runtime" &&
        typeof d.gatewayId === "string" &&
        typeof d.release === "number" &&
        typeof d.lifecycle === "string");
}
// A gateways/{id} durable desired doc (GatewayDoc), distinct from a legacy
// GatewayDesiredState (no desiredRelease/latestRelease).
export function isGatewayDesiredDoc(data) {
    if (!data || typeof data !== "object")
        return false;
    const d = data;
    return (typeof d.gatewayId === "string" &&
        typeof d.desiredRelease === "number" &&
        typeof d.latestRelease === "number" &&
        (d.desiredStatus === "running" ||
            d.desiredStatus === "paused" ||
            d.desiredStatus === "draining" ||
            d.desiredStatus === "retired"));
}
export function projectGatewayDesiredRootForGateway(value, gatewayId) {
    if (!isGatewayDesiredDoc(value) || value.gatewayId !== gatewayId)
        return null;
    const projected = projectGatewayMutableConfigForGateway(value, gatewayId);
    return projected;
}
export function helmReleaseNameForGateway(gatewayId) {
    return `octogee-gw-${gatewayId}`;
}
// Kubernetes Service DNS names for the gateway's stable-name resources.
// Service-addressed `/g/{gatewayId}/…` targets `gateway-edge-{gatewayId}`;
// the chart renders both names directly from the bare gateway id.
export function gatewayEdgeServiceName(id) {
    return `gateway-edge-${id}`;
}
// The gateway pod Service (preview surface, port 9080).
export function gatewayPodServiceName(id) {
    return `octogee-gateway-${id}`;
}
// Deterministic, order-independent hash of a release payload. Used to reject a
// no-op release (payload equals the previous release) and to fingerprint a
// revision's rendered config. Non-cryptographic identity is not required; the
// only contract is: same normalized value → same hash, any change → different.
export function releasePayloadHash(payload) {
    return releasePayloadValueHash(payload);
}
export const PLATFORM_RELEASE_RECORD_DOC_PATH = "glmControllerState/platformRelease";
export function platformReleaseRecord(payload, writtenAt) {
    return {
        schemaVersion: 1,
        payloadHash: releasePayloadHash(payload),
        imageTag: payload.imageTag,
        openclawSourceSha: payload.openclawSourceSha ?? null,
        writtenAt,
    };
}
export function parsePlatformReleaseRecord(value) {
    if (!isPlainRecord(value))
        return null;
    const { schemaVersion, payloadHash, imageTag, openclawSourceSha, writtenAt } = value;
    if (schemaVersion !== 1 ||
        typeof payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(payloadHash) ||
        typeof imageTag !== "string" || imageTag.length === 0 ||
        (openclawSourceSha !== null && typeof openclawSourceSha !== "string") ||
        typeof writtenAt !== "number" || !Number.isSafeInteger(writtenAt) || writtenAt < 0) {
        return null;
    }
    return { schemaVersion, payloadHash, imageTag, openclawSourceSha, writtenAt };
}
function releasePayloadValueHash(payload) {
    return createHash("sha256")
        .update(canonicalJson(payload))
        .digest("hex");
}
function canonicalJson(value) {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
    }
    const entries = Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => compareKeys(a, b));
    return `{${entries
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
        .join(",")}}`;
}
function compareKeys(a, b) {
    if (a < b)
        return -1;
    if (a > b)
        return 1;
    return 0;
}
// Release-payload fields — audited via an immutable release; changing one is a
// roll. Listed for documentation + testing; the classifier does not need them
// because the conservative default already returns "release" for anything
// unlisted.
export const RELEASE_FIELDS = [
    "imageRepository",
    "imageTag",
];
// gateways/{gatewayId} DOC fields that mutate without cutting a release.
// Separate-collection observations (assignment docs, runtime heartbeat /
// lastError) are not gateway-doc fields and are not enumerated here.
export const GATEWAY_MUTABLE_FIELDS = [
    "profile",
    "gatewayClass",
    "imageProfile",
    "sizingTier",
    "gcpProject",
    "gatewayContainerSecurityContext",
    "serviceAccountName",
    "serviceAccount",
    "builderAccess",
    "ownerUid",
    "builderSlug",
    "modelBrokerLimits",
    "allocation",
    "desiredStatus",
    "liveRelease",
    "retireAfter",
];
const GATEWAY_MUTABLE_SET = new Set(GATEWAY_MUTABLE_FIELDS);
// Conservative classifier over gateway-DOC and release-PAYLOAD field NAMES.
// Only explicitly enumerated gateway-mutable fields escape the default; every
// other field — including any new field added to the payload later — is
// release-audited. That default is the safety property the spec pins
// (operator, 2026-07-08).
export function classifyGatewayField(field) {
    if (GATEWAY_MUTABLE_SET.has(field))
        return "gateway-mutable";
    return "release";
}
export function userRestoreFencePresent(user) {
    if (!isPlainRecord(user) || !isPlainRecord(user.provisioning))
        return false;
    const openclaw = user.provisioning.openclaw;
    return isPlainRecord(openclaw) && openclaw.restoreFence !== undefined;
}
export function userRuntimeMutationFenced(user) {
    if (userRestoreFencePresent(user))
        return true;
    if (!isPlainRecord(user) || !isPlainRecord(user.provisioning))
        return false;
    const openclaw = user.provisioning.openclaw;
    return isPlainRecord(openclaw) && openclaw.sourceTransferFence !== undefined;
}
