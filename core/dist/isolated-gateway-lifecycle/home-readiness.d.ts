import type { GatewaySizingProfile } from "@octogee/shared/types/sizing-profile";
import type { PlatformUserRecord } from "../platform-state/users.js";
import { type AllocateIsolatedGatewayInput } from "./inputs.js";
export interface HomeReadinessInput {
    user: PlatformUserRecord;
    request: AllocateIsolatedGatewayInput;
    sizingProfile: GatewaySizingProfile | null;
}
export type HomeReadinessFence = (input: HomeReadinessInput) => void;
export interface HomePreparedFor {
    leaseId: string;
    generation: number;
    sizingKey: string;
}
export declare function sizingProfileNeedsVmHome(profile: GatewaySizingProfile | null): boolean;
export declare function homePreparedForAllocation(input: HomeReadinessInput): boolean;
export declare const requireStoredHomeReadiness: HomeReadinessFence;
export declare const homePreparedBeforeAllocation: HomeReadinessFence;
