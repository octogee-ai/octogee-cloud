import { type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { PlatformStateStore } from "./platform-state/store.js";
export interface ParkedGatewayPrewarmRequest {
    gatewayId: string;
    uid: string;
    sourceSha: string;
    bootImageId: string;
    payload: ReleasePayload;
    createdBy: string;
}
type Admission = {
    status: "queued";
    operationId: string;
} | {
    status: "ineligible";
    reason: string;
};
export declare function enqueueParkedGatewayPrewarm(store: PlatformStateStore, request: ParkedGatewayPrewarmRequest): Promise<Admission>;
export {};
