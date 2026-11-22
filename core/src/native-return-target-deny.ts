import { operationAuditDocumentId } from "./operation-audit.js";
import type { PlatformStateRepositories } from "./platform-state/index.js";

export const NATIVE_RETURN_TARGET_EXCLUSION = "native-return-target-exclusion";

export function nativeReturnTargetExclusionId(uid: string): string {
  return operationAuditDocumentId(`${NATIVE_RETURN_TARGET_EXCLUSION}:${uid}`);
}

export async function nativeReturnTargetDenied(
  store: Pick<PlatformStateRepositories, "journal" | "gateways">, uid: string, gatewayId: string,
): Promise<boolean> {
  const record = await store.journal.audits.get(nativeReturnTargetExclusionId(uid));
  if (!record) return false;
  const target = record.target;
  if (record.mutation.kind !== NATIVE_RETURN_TARGET_EXCLUSION || target.uid !== uid ||
      typeof target.targetGatewayId !== "string") return true;
  if (target.targetGatewayId === gatewayId) return true;
  const root = await store.gateways.roots.get(gatewayId);
  return root?.gatewayClass !== "isolated";
}

export async function nativeReturnSharedStoreHandoffDenied(
  store: Pick<PlatformStateRepositories, "journal">, uid: string,
): Promise<boolean> {
  return (await store.journal.audits.get(nativeReturnTargetExclusionId(uid))) !== null;
}
