import { readGatewayAuthorizationInStore } from "@octogee/core/gateway-live-release";
import { verifyGatewayRetirementClaimAtomic } from "@octogee/core/gateway-retirement-claim";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { DurableGateway } from "../converge-gateway.js";
import { runGatewayRuntimeExclusive, withGatewayRuntimeMutation } from "./gateway-runtime-mutation.js";

interface RetirementUninstallClaim {
  operationId: string;
  version: number;
  assertActiveClaim?(): Promise<void>;
}

export interface GatewayRetirementUninstallPolicy {
  requiresWorker(gateway: Readonly<DurableGateway>): boolean;
  verify(input: {
    gateway: Readonly<DurableGateway>;
    operationId: string;
    version: number;
  }): Promise<void>;
}

export function gatewayRetirementUninstaller(
  store: PlatformStateStore,
  remove: (gatewayId: string) => Promise<void>,
  policy?: GatewayRetirementUninstallPolicy,
) {
  return (gatewayId: string, claim: RetirementUninstallClaim): Promise<void> =>
    runGatewayRuntimeExclusive(async () => {
      const authorization = await withGatewayRuntimeMutation(store, gatewayId, transaction =>
        readGatewayAuthorizationInStore(transaction, gatewayId));
      if (!authorization) throw new Error("gateway retirement runtime unavailable");
      const gateway = { ...authorization.config, ...authorization.gateway };
      if (policy?.requiresWorker(gateway)) {
        const assertActiveClaim = claim.assertActiveClaim;
        if (!assertActiveClaim) throw new Error("gateway retirement worker claim is unavailable");
        const verifyClaim = async () => {
          await assertActiveClaim();
          const result = await verifyGatewayRetirementClaimAtomic({
            store, gatewayId, operationId: claim.operationId, version: claim.version,
            now: Date.now(), updatedBy: "gateway-retirement",
          });
          if (!result.ok) throw new Error(result.error);
        };
        await verifyClaim();
        await policy.verify({ gateway, operationId: claim.operationId, version: claim.version });
        await verifyClaim();
      }
      await remove(gatewayId);
    });
}
