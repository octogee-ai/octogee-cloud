import { type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { type DemandGuestSource } from "./isolated-gateway-lifecycle/prewarm.js";
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
type GuestReleaseRequest = Omit<ParkedGatewayPrewarmRequest, "bootImageId" | "sourceSha">;
export type ParkedGuestReleaseRequest = GuestReleaseRequest & {
    sourceSha: string;
};
type DemandGuestReleaseRequest = GuestReleaseRequest & {
    demandSource: DemandGuestSource;
};
export type ParkedGuestReleaseAdmission = Admission | {
    status: "already-current";
};
export declare function enqueueParkedGuestRelease(store: PlatformStateStore, request: ParkedGuestReleaseRequest): Promise<ParkedGuestReleaseAdmission>;
export declare function enqueueDemandGuestRelease(store: PlatformStateStore, request: DemandGuestReleaseRequest): Promise<ParkedGuestReleaseAdmission>;
export {};
