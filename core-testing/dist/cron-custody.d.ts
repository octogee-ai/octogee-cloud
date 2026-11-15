import { type MigrationClient } from "@octogee/core/fleet-migration-client";
export interface CustodyJob {
    id: string;
    agentId: string;
    name: string;
    enabled: boolean;
    schedule: {
        kind: string;
    };
    runtimeAuthority?: true;
    declarationKey?: string;
    running?: true;
}
type Phase = "hold" | "export" | "stage" | "activate" | "resume" | "retire" | "abort";
export type CustodyStatus = "held" | "exported" | "staged" | "activated" | "resumed" | "retired" | "aborted";
interface Snapshot {
    version: 1;
    operationId: string;
    agentIds: string[];
    jobs: CustodyJob[];
    scratch: unknown[];
    retainedJobIds?: string[];
}
interface Migration {
    status: CustodyStatus;
    agentIds: string[];
    snapshot: Snapshot | null;
    digest: string | null;
}
export interface CustodyRequest {
    operationId: string;
    phase: Phase;
    agentIds?: string[];
    snapshot?: unknown;
    retainNonportable?: boolean;
}
export interface CustodyResult {
    operationId: string;
    phase: Phase;
    agentIds: string[];
    drained: boolean;
    snapshot?: Snapshot;
}
export declare class CronAgentMigrationHeldError extends Error {
    readonly agentId: string;
    readonly operationId: string;
    constructor(agentId: string, operationId: string);
}
export declare class CronCustodyStore {
    readonly jobs: Map<string, CustodyJob>;
    readonly migrations: Map<string, Migration>;
    readonly fences: Map<string, string>;
    readonly runningAgents: Set<string>;
    private nextId;
    add(job: Omit<CustodyJob, "id" | "schedule"> & {
        id?: string;
        schedule?: {
            kind: string;
        };
    }): CustodyJob;
    agentJobs(agentId: string): CustodyJob[];
    status(operationId: string): CustodyStatus | undefined;
    runnable(jobId: string): boolean;
    assertAgentAdmitted(agentId: string): void;
    cronAdd(job: Omit<CustodyJob, "id">): CustodyJob;
    cronUpdate(id: string, patch: {
        enabled: boolean;
    }): void;
    cronRemove(id: string): void;
    migrate(request: CustodyRequest): CustodyResult;
    private apply;
    private readonly phases;
    private settleUnknown;
    private repeatSettled;
    private acquire;
    private hold;
    private export;
    private stage;
    private assertTargetRetained;
    private activate;
    private resume;
    private retireOrAbort;
    private drained;
    private owned;
    private retiredMigrations;
    private release;
}
export interface CronCustodyGateways {
    store(gatewayId: string): CronCustodyStore;
    calls: string[];
    fetch: typeof globalThis.fetch;
    client(base: MigrationClient, resolveGatewayUrl: (transportId: string) => string): MigrationClient;
}
export declare function createCronCustodyGateways(agentScopes: Record<string, string[]>): CronCustodyGateways;
export {};
