import { isDeepStrictEqual } from "node:util";
import { gatewayScopedJobId, signFleetRequest, verifyFleetRequest } from "./fleet-signature.js";

export interface OfflineNativeRecoveryIdentity {
  uid: string;
  slug: string;
  operationId: string;
  sourceGatewayId: string;
  targetGatewayId: string;
  requestId: string;
  sourceEpoch: number;
  schedulerMigrationId: string;
  claimStartedAt: number;
  holdGeneration: string;
  original: { instanceId: string; bootDiskId: string; homeDiskId: string };
  maintenance: { instanceId: string; bootDiskId: string; bootId: string; acceptedImageId: string; cloneDiskId: string };
  immutableSnapshotId: string;
  cleanFileSha256: string;
  ownerAnchorSha256: string;
  ownerStoreSha256: string;
  desiredSnapshotSha256: string;
}

type OfflineAction = "reconcile" | "rollback";

export interface OfflineNativeRequest {
  identity: OfflineNativeRecoveryIdentity;
  action: OfflineAction;
  nonce: string;
  expiresAt: number;
}

export interface OfflineNativeResult {
  request: OfflineNativeRequest;
  outcome: "staged" | "restored";
  fileSha256: string;
  ownerAnchorSha256: string;
}

function purpose(request: OfflineNativeRequest, response: boolean): string {
  const { original, maintenance, sourceGatewayId } = request.identity;
  const intent = `held-native-offline-${response ? "result" : "request"}/${request.action}/${original.instanceId}/${maintenance.instanceId}`;
  return gatewayScopedJobId(intent, sourceGatewayId);
}

const digest = /^[a-f0-9]{64}$/;

export function verifyOfflineNativeRequest(input: {
  raw: string;
  signature: string;
  fleetPublicKey: string;
  expected: OfflineNativeRecoveryIdentity;
  now: number;
}): OfflineNativeRequest {
  if (input.raw.length > 8192) throw new Error("Held Native offline request exceeds its bounded scope");
  const request = JSON.parse(input.raw) as OfflineNativeRequest | null;
  if (!request || !isDeepStrictEqual(request.identity, input.expected) || !digest.test(request.identity.desiredSnapshotSha256) ||
      (request.action !== "reconcile" && request.action !== "rollback") ||
      typeof request.nonce !== "string" || !digest.test(request.nonce) ||
      !Number.isSafeInteger(request.expiresAt) || request.expiresAt < input.now || request.expiresAt > input.now + 120_000 ||
      !verifyFleetRequest(input.fleetPublicKey, purpose(request, false), input.raw, input.signature)) {
    throw new Error("Held Native offline request has stale or mismatched authority");
  }
  return request;
}

export function signOfflineNativeRequest(request: OfflineNativeRequest, fleetPrivateKey: string) {
  const raw = JSON.stringify(request);
  return { raw, signature: signFleetRequest(fleetPrivateKey, purpose(request, false), raw) };
}

export function signOfflineNativeResult(result: OfflineNativeResult, maintenancePrivateKey: string) {
  const raw = JSON.stringify(result);
  return { raw, signature: signFleetRequest(maintenancePrivateKey, purpose(result.request, true), raw) };
}

export function verifyOfflineNativeResult(input: {
  raw: string;
  signature: string;
  maintenancePublicKey: string;
  request: OfflineNativeRequest;
  now: number;
}): OfflineNativeResult {
  if (input.raw.length > 8192) throw new Error("Held Native offline result exceeds its bounded scope");
  const result = JSON.parse(input.raw) as OfflineNativeResult | null;
  const { request } = input;
  const rollback = request.action === "rollback";
  if (!result || !isDeepStrictEqual(result.request, request) || input.now > request.expiresAt ||
      result.outcome !== (rollback ? "restored" : "staged") || typeof result.fileSha256 !== "string" || !digest.test(result.fileSha256) ||
      result.ownerAnchorSha256 !== request.identity.ownerAnchorSha256 || (rollback && result.fileSha256 !== request.identity.cleanFileSha256) ||
      !verifyFleetRequest(input.maintenancePublicKey, purpose(request, true), input.raw, input.signature)) {
    throw new Error("Held Native offline result lacks its fresh maintenance authority");
  }
  return result;
}

export {
  readHeldNativeOfflineDesiredProjection, signHeldNativeOfflineDesiredProjection, type HeldNativeProjectionScope,
} from "./held-native-offline-projection.js";
