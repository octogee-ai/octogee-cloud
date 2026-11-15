import type { Request } from "express";
export interface WorkspaceCommitProofTarget {
    agentId: string;
    slug: string;
    project: string | null;
}
export declare class WorkspaceCommitProofBrokerError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
export declare function verifyWorkspaceCommitProofViaBroker(req: Request, target: WorkspaceCommitProofTarget, env?: Record<string, string | undefined>): Promise<boolean>;
