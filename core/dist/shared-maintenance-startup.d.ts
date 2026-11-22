import { type Server } from "node:http";
export type SharedMaintenanceRole = "gateway" | "gateway-edge";
export interface SharedMaintenanceStartupEnrollment {
    namespace: string;
    gatewayId: string;
    podUid: string;
    attemptId: string;
    role: SharedMaintenanceRole;
    buildId: string;
    artifactSetId: string;
}
type Request = SharedMaintenanceStartupEnrollment & {
    nonce: string;
};
type Response = {
    raw: string;
    signature: string;
};
export declare function allowSharedMaintenanceLaunch(input: {
    request: Request;
    proof: Response;
    publicKey: string;
    now: number;
}): boolean;
interface Startup {
    enrollment?: SharedMaintenanceStartupEnrollment;
    local: {
        namespace: string;
        gatewayId: string;
        role: SharedMaintenanceRole;
    };
    publicKey: string;
    signal: AbortSignal;
    launch(): Promise<void>;
    observeProbes?(health: Server, readiness: Server | null): void;
    read: (request: Request, signal: AbortSignal) => Promise<Response | null>;
    onUnavailable(): void;
    probePort?: number;
    readinessPort?: number;
    probeHost?: string;
    retryMs?: number;
}
export declare function runSharedMaintenanceStartup(input: Startup): Promise<void>;
interface InertOperatorOptions {
    publicKey: string;
    directory?: string;
    onSocket?(path: string): void;
}
export declare function openSharedMaintenancePermitSocket({ publicKey, directory, onSocket }: InertOperatorOptions): Promise<{
    socket: string;
    read(request: Request, signal: AbortSignal): Promise<Response>;
    close(): Promise<void>;
}>;
export type SharedMaintenanceStartupScope = Omit<SharedMaintenanceStartupEnrollment, "role">;
export interface SharedMaintenancePublishedRelease {
    release: number;
    payloadHash: string;
    publishedAt: number;
}
export interface SharedMaintenanceCompletionReceipt {
    scope: SharedMaintenanceStartupScope;
    images: Record<SharedMaintenanceRole, string>;
    restoredArchiveSha256: string;
    publication: SharedMaintenancePublishedRelease;
}
export declare function sharedMaintenanceCompletionPurpose(scope: SharedMaintenanceStartupScope): string;
export declare function isSharedMaintenancePublication(publication: SharedMaintenancePublishedRelease | undefined, now: number): boolean;
export declare function allowSharedMaintenanceRestart(input: {
    scope: SharedMaintenanceStartupScope;
    localBoundPodUid: string | null;
    proof: Response;
    publicKey: string;
    now: number;
}): boolean;
export declare function projectedSharedMaintenancePodUid(token: string, namespace: string): string | null;
export declare function waitForInstalledSharedMaintenanceGate(role: SharedMaintenanceRole, env: NodeJS.ProcessEnv): Promise<void>;
export {};
