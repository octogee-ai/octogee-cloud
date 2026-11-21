import type { GatewayDoc } from "@octogee/shared/types/gateway-releases";
import type { GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
import type { PlatformStateRepositories } from "./platform-state/store.js";
type DurableGateway = GatewayDoc & GatewayMutableConfig;
export type PrelaunchAuthorityReader = Pick<PlatformStateRepositories, "users" | "gateways"> & Partial<Pick<PlatformStateRepositories, "journal">>;
export declare function isolatedPrelaunchReserved(input: {
    reader: PrelaunchAuthorityReader;
    gateway: DurableGateway;
    expectedGateway?: DurableGateway;
    activationBoot?: true;
}): Promise<boolean>;
type IsolatedBootInput = {
    reader: PrelaunchAuthorityReader;
    gateway: DurableGateway;
};
type IsolatedBootMode = {
    mode: "prelaunch" | "normal" | "activating";
    migrationId?: string;
};
export declare function isolatedBootMode(input: IsolatedBootInput): Promise<IsolatedBootMode>;
export {};
