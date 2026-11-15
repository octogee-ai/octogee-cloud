import { type AgentExportSnapshot } from "./agent-export-snapshot.js";
export interface AgentExportSource {
    uid: string;
    slug: string;
    gatewayId: string;
    epoch: number;
    agentId: string;
    project: string | null;
}
export interface AgentExportDestination {
    owner: string;
    repo: string;
    branch: string;
    head: string;
    tree: string;
    files: Array<{
        path: string;
        mode: string;
        type: string;
        sha: string;
    }>;
}
export interface AgentExportRecord {
    kind: "authored-agent-export";
    id: string;
    uid: string;
    slug: string;
    gatewayId: string;
    source: AgentExportSource;
    destination: Omit<AgentExportDestination, "files">;
    status: "previewed" | "publishing" | "complete";
    changes: Array<{
        path: string;
        action: "add" | "overwrite";
        size: number;
    }>;
    sourceDigest: string;
    assetIdentity: string;
    approvalHash: string;
    createdAt: string;
    updatedAt: string;
    expectedCommit?: string;
    commitUrl?: string;
}
export interface AgentExportDeps {
    authorize(agentId: string): Promise<AgentExportSource>;
    capture(source: AgentExportSource): Promise<AgentExportSnapshot>;
    destination(repo: {
        owner: string;
        repo: string;
    }): Promise<AgentExportDestination>;
    prepareCommit(record: AgentExportRecord, snapshot: AgentExportSnapshot): Promise<string>;
    readHead(record: AgentExportRecord): Promise<string>;
    publish(record: AgentExportRecord, assertCurrent: () => Promise<void>): Promise<void>;
    put(record: AgentExportRecord): Promise<void>;
    get(id: string): Promise<AgentExportRecord | null>;
    putSnapshot(id: string, snapshot: AgentExportSnapshot): Promise<void>;
    getSnapshot(id: string): Promise<AgentExportSnapshot>;
    now(): Date;
    id(): string;
}
export declare function agentExportApproval(record: AgentExportRecord): string;
export declare class AgentExportService {
    private readonly deps;
    constructor(deps: AgentExportDeps);
    preview(agentId: string, repo: {
        owner: string;
        repo: string;
    }): Promise<AgentExportRecord>;
    apply(id: string, approvalHash: string): Promise<AgentExportRecord>;
    private publishAndVerify;
    private prepare;
    private savedSnapshot;
    private complete;
}
export declare function withinAgentExportDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T>;
