import type { GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
import { projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
import { type GatewaySizingProfile } from "@octogee/shared/types/sizing-profile";
import type { GatewayAssignment } from "../platform-state/gateways.js";
import type { PlatformUserRecord } from "../platform-state/users.js";
import type { PlatformStateStore } from "../platform-state/store.js";
import { type AllocateIsolatedGatewayInput, type IsolatedLifecycleDeps, type LifecycleMode } from "./inputs.js";
import type { HomeReadinessFence } from "./home-readiness.js";
export interface IsolatedGatewayAllocationDeps extends IsolatedLifecycleDeps {
    requireHomeReady: HomeReadinessFence;
    namespace: string;
    ensureAuthSecret(input: {
        namespace: string;
        gatewayId: string;
    }): Promise<unknown>;
}
export interface IsolatedGatewayAllocation {
    gatewayId: string;
    outcome: "allocated" | "resumed";
}
export declare function buildIsolatedGatewayConfig(gatewayId: string, request: AllocateIsolatedGatewayInput): GatewayMutableConfig;
export declare function allocatedIsolatedGatewayId(request: AllocateIsolatedGatewayInput): string;
export declare function isolatedAllocationFenceAllows(input: {
    request: AllocateIsolatedGatewayInput;
    configuredSharedGatewayIds: readonly string[];
    user: PlatformUserRecord;
    sizingKey: string | null;
    sizingProfile: GatewaySizingProfile | null;
    assignment: GatewayAssignment | null;
}): boolean;
export declare function sharedSourceRelease(value: unknown, gatewayId: string): number | null;
type DesiredRoot = ReturnType<typeof projectGatewayDesiredRootForGateway>;
export declare function gatewayRunsArtifact(store: Pick<PlatformStateStore, "gateways">, root: NonNullable<DesiredRoot>, artifact: unknown): Promise<boolean>;
export declare function allocateIsolatedGateway(input: IsolatedGatewayAllocationDeps, request: AllocateIsolatedGatewayInput, mode?: LifecycleMode): Promise<IsolatedGatewayAllocation>;
export declare function refreshRequestedAllocation(input: IsolatedLifecycleDeps, request: AllocateIsolatedGatewayInput, mode?: LifecycleMode): Promise<boolean>;
export {};
