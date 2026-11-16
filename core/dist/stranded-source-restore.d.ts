import type { PlatformStateStore, PlatformStateTransaction } from "./platform-state/index.js";
export interface StrandedSource {
    uid: string;
    slug: string;
    gatewayId: string;
    epoch: number;
    assignmentUpdatedAt: number;
    operationId: string;
    targetGatewayId: string;
}
export interface StrandedSourceRestored {
    uid: string;
    slug: string;
    gatewayId: string;
    operationId: string;
    targetGatewayId: string;
    state: "serving";
}
export type ResumeSourceIngress = (input: {
    operationId: string;
    gatewayId: string;
    slug: string;
}) => Promise<void>;
export interface StrandedSourceRestoreDeps {
    store: PlatformStateStore;
    resumeSourceIngress: ResumeSourceIngress;
    log: (message: string) => void;
    now?: () => Date;
}
export declare class StrandedSourceResumeFailed extends Error {
    readonly gatewayId: string;
    readonly operationId: string;
    readonly gatewayAnswered: boolean;
    constructor(source: StrandedSource, cause: unknown);
}
export declare function strandedSourceInTransaction(tx: PlatformStateTransaction, uid: string): Promise<StrandedSource>;
export declare function readStrandedSource(store: PlatformStateStore, uid: string): Promise<StrandedSource>;
export declare function restoreStrandedSourceServing(deps: StrandedSourceRestoreDeps, input: {
    uid: string;
}): Promise<StrandedSourceRestored>;
