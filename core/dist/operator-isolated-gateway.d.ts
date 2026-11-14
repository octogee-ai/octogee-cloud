import type { GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
import type { SizingTier } from "@octogee/shared/types/sizing";
import { type GatewayArtifact } from "./gateway-live-release.js";
import type { GatewaySizingProfile } from "./platform-state/config.js";
import type { PlatformStateRepositories, PlatformStateStore } from "./platform-state/store.js";
export declare const OPERATOR_ISOLATED_GATEWAY_SOURCE = "operator-isolated-gateway";
export declare function operatorAllocationId(): string;
export declare function isOperatorIssuedAllocation(allocation: {
    leaseId?: unknown;
} | null | undefined): boolean;
export interface OperatorIsolatedGatewayAnswer {
    status: number;
    body: Record<string, unknown>;
}
type Reader = Pick<PlatformStateRepositories, "config" | "users" | "gateways" | "fleetRegistry" | "journal">;
type IsolatedSizingProfile = Extract<GatewaySizingProfile, {
    isolation: "isolated";
}>;
export interface NamedIsolatedSizingProfile {
    sizingKey: string;
    sizingTier: SizingTier;
}
interface GivePlan extends NamedIsolatedSizingProfile {
    uid: string;
    slug: string;
    sourceGatewayId: string;
    artifact: GatewayArtifact;
}
export declare function isolatedSizingProfileKeys(reader: Pick<PlatformStateRepositories, "config">): Promise<string[]>;
export declare function hasComputerShape(profile: IsolatedSizingProfile): boolean;
export declare function resolveIsolatedSizingProfile(reader: Pick<PlatformStateRepositories, "config">, named: unknown): Promise<NamedIsolatedSizingProfile | {
    refusal: OperatorIsolatedGatewayAnswer;
}>;
export declare function planOperatorIsolatedGateway(reader: Reader, input: {
    uid: string;
    sizingProfile: unknown;
}): Promise<GivePlan | {
    refusal: OperatorIsolatedGatewayAnswer;
}>;
export declare function operatorIsolatedGatewayConfig(input: {
    gatewayId: string;
    uid: string;
    slug: string;
    sizingKey: string;
    sizingTier: SizingTier;
    allocationId: string;
}): GatewayMutableConfig;
export declare function giveOperatorIsolatedGateway(store: PlatformStateStore, input: {
    uid: string;
    sizingProfile: unknown;
    actor: string;
    allocationId: string;
    now: number;
}): Promise<OperatorIsolatedGatewayAnswer>;
export declare function ownIsolatedGatewayTargetRefusal(reader: Pick<PlatformStateRepositories, "gateways">, uid: string, gatewayId: string): Promise<OperatorIsolatedGatewayAnswer | null>;
export declare function isolatedGatewayRetireRefusal(reader: Pick<PlatformStateRepositories, "gateways">, gatewayId: string, asked: {
    force: boolean;
    deleteHome: boolean;
    retainData: boolean;
}): Promise<Record<string, unknown> | null>;
export declare function movesTouchingGateway(reader: Pick<PlatformStateRepositories, "journal">, gatewayId: string): Promise<{
    waiting: string[];
    blocking: string | null;
}>;
export declare function failedRetirementOf(reader: Pick<PlatformStateRepositories, "journal">, root: {
    desiredStatus?: unknown;
    retirementClaim?: unknown;
}): Promise<string | null>;
export declare function rearmFailedRetirement(store: PlatformStateStore, operationId: string): Promise<void>;
export {};
