import { type Server } from "node:http";
export type SharedMaintenanceRole = "gateway" | "gateway-edge";
export interface SharedMaintenanceStartupEnrollment {
    namespace: "octogee-test";
    gatewayId: string;
    podUid: string;
    attemptId: string;
    role: SharedMaintenanceRole;
    buildId: string;
}
type Request = SharedMaintenanceStartupEnrollment & {
    nonce: string;
};
type Response = {
    raw: string;
    signature: string;
};
export declare function readSharedMaintenanceLaunch(enrollment: SharedMaintenanceStartupEnrollment): (request: Request, signal: AbortSignal) => Promise<Response | null>;
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
export declare function waitForInstalledSharedMaintenanceGate(role: SharedMaintenanceRole, env: NodeJS.ProcessEnv): Promise<void>;
export {};
