import type { PlatformStateTransaction } from "../platform-state/store.js";
import { type CurrentSizingKey } from "../sizing-key.js";
import { type IsolatedLifecycleDeps, type LifecycleMode } from "./inputs.js";
export interface ReparkOwnedGatewayInput {
    uid: string;
    builderSlug: string;
    gatewayId: string;
    generation: number;
}
export declare function retainsEntitledParkedCohort(tx: PlatformStateTransaction, request: ReparkOwnedGatewayInput, current: CurrentSizingKey): Promise<boolean>;
export declare function reparkOwnedGateway(deps: Pick<IsolatedLifecycleDeps, "store" | "readSizingKey" | "requireOwner" | "now">, request: ReparkOwnedGatewayInput, mode?: LifecycleMode): Promise<boolean>;
