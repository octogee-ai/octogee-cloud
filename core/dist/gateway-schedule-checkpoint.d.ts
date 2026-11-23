import type { NativeScheduleCheckpoint } from "@octogee/shared/types/fleet-controller";
import type { EphemeralGatewayWriter, PlatformStateStore } from "./platform-state/index.js";
export declare function parseScheduleCheckpoint(value: unknown): NativeScheduleCheckpoint | null;
interface GatewayCheckpointScope {
    store: PlatformStateStore;
    gatewayId: string;
    uid: string;
    assignmentEpoch: number;
    pod: EphemeralGatewayWriter;
    now: number;
    observedAt: number;
}
interface CheckpointRequest extends GatewayCheckpointScope {
    snapshot: NativeScheduleCheckpoint;
}
export declare function recordGatewayScheduleCheckpoint(input: CheckpointRequest): Promise<boolean>;
export declare function parseWorkspaceCheckpoint(value: unknown): Readonly<Record<string, string>> | null;
export declare function recordGatewayWorkspaceCheckpoint(input: GatewayCheckpointScope & {
    commits: Readonly<Record<string, string>>;
}): Promise<boolean>;
export {};
