import { type GatewayKubernetesObservation } from "@octogee/shared/types/gateway-releases";
import type { PlatformStateStore, PlatformStateTransaction } from "./platform-state/store.js";
export interface SupersedeRollingSharedGatewayRollInput {
    sourceGatewayId: string;
    targetGatewayId: string;
    expectedLiveRelease: number;
    expectedDesiredRelease: number;
    targetHeartbeatMaxAgeMs?: number;
}
export type SupersedeRollingSharedGatewayRollResult = {
    kind: "scheduled";
    release: number;
    operationId: string;
} | {
    kind: "already-scheduled";
    release: number;
    operationId: string;
} | {
    kind: "not-eligible";
    reason: string;
};
export interface SharedGatewayRollRecoveryDeps {
    store: PlatformStateStore;
    now: () => number;
}
export declare function sharedRollRecoveryOperationId(input: SupersedeRollingSharedGatewayRollInput): string;
export declare function appendSharedRollRecoveryInTransaction(transaction: PlatformStateTransaction, input: SupersedeRollingSharedGatewayRollInput, options: {
    now: number;
    sourceKubernetes?: GatewayKubernetesObservation;
}): Promise<SupersedeRollingSharedGatewayRollResult>;
export declare function supersedeRollingSharedGatewayRoll(deps: SharedGatewayRollRecoveryDeps, input: SupersedeRollingSharedGatewayRollInput): Promise<SupersedeRollingSharedGatewayRollResult>;
