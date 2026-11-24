import { type NativeScheduleCheckpoint } from "@octogee/shared/types/fleet-controller";
import type { EphemeralGatewayWriter, PlatformStateStore } from "./platform-state/index.js";
export type GatewayCheckpointRefusal = "report_stale" | "gateway_missing" | "user_missing" | "assignment_missing" | "gateway_not_serving" | "ephemeral_writer_mismatch" | "vm_writer_mismatch" | "kubernetes_writer_unobserved" | "kubernetes_observation_stale" | "kubernetes_writer_mismatch" | "assignment_not_owned" | "assignment_not_serving" | "user_fenced" | "foreign_schedules";
export type GatewayCheckpointResult = "accepted" | GatewayCheckpointRefusal;
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
export declare function recordGatewayScheduleCheckpoint(input: CheckpointRequest): Promise<GatewayCheckpointResult>;
export declare function parseWorkspaceCheckpoint(value: unknown): Readonly<Record<string, string>> | null;
export declare function recordGatewayWorkspaceCheckpoint(input: GatewayCheckpointScope & {
    commits: Readonly<Record<string, string>>;
}): Promise<GatewayCheckpointResult>;
export {};
