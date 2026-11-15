import { type AgentImportConfigArtifacts, type AgentImportConfigPlan, type AgentImportDoctorOutcome, type AgentImportWorkspacePolicy } from "@octogee/shared/types/agent-import";
import type { AgentImportRepositoryInspection, AgentImportWorkspaceComparison } from "./agent-import-git.js";
import type { ExtractedAgentImportSource } from "./agent-import-source.js";
type JsonObject = Record<string, unknown>;
export interface AgentImportDoctorResult {
    outcome: AgentImportDoctorOutcome;
    doctorVersion: string;
    changedPaths: string[];
    diagnostics: string[];
    repairedCandidate?: JsonObject;
}
export type AgentImportSource = {
    kind: "github";
    owner: string;
    repo: string;
    branch: string;
    head: string;
} | {
    kind: "local";
    head: string;
    archiveDigest: string;
    hadGit: boolean;
    uncommittedFileCount: number;
};
export interface AgentImportPreview {
    id: string;
    source: AgentImportSource;
    destinationHead: string;
    workspace: {
        commitCount: number;
        fileCount: number;
        totalBytes: number;
        workspaceDigest: string;
        historyPreserved: boolean;
        conflicts: string[];
        conflictCount: number;
        conflictDigest: string;
        preservedPaths: string[];
    };
    doctor: AgentImportDoctorResult;
    config: AgentImportConfigPlan;
    workspacePolicy: AgentImportWorkspacePolicy;
    approvalHash: string;
}
export type AgentImportStatus = "previewed" | "workspace" | "identity" | "config" | "verifying" | "complete" | "failed" | "rolling_back" | "rollback_failed" | "rolled_back" | "abandoned";
export interface AgentImportRecord {
    id: string;
    uid: string;
    slug: string;
    gatewayId: string;
    status: AgentImportStatus;
    source: AgentImportSource;
    destinationHead: string;
    approvalHash: string;
    preview: AgentImportPreview;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    importCommit?: string;
    rollbackCommit?: string;
    configOutcome?: "applied" | "safe_baseline" | "unchanged";
    warnings: string[];
    previousIdentity?: AgentImportIdentitySnapshot;
    previousRuntime?: JsonObject;
    error?: {
        code: string;
        message: string;
    };
}
export interface StoredAgentImportPlan {
    uid: string;
    slug: string;
    gatewayId: string;
    source: AgentImportSource;
    destinationHead: string;
    approvalHash: string;
    artifacts: AgentImportConfigArtifacts;
    config: AgentImportConfigPlan;
    workspacePolicy: AgentImportWorkspacePolicy;
}
export interface AgentImportIdentity {
    name?: string;
    persona?: string;
    emoji?: string;
}
export interface AgentImportIdentitySnapshot {
    name: string | null;
    persona: string | null;
    emoji: string | null;
}
export interface AgentImportServiceDeps {
    newId(): string;
    now(): Date;
    readGithubToken(uid: string): Promise<string | null>;
    readGithubRepoSize(owner: string, repo: string): Promise<number>;
    cloneGithubSource(input: {
        owner: string;
        repo: string;
        branch: string;
        token: string;
    }): Promise<{
        repoDir: string;
        sourceHead: string;
        cleanup(): void;
    }>;
    extractLocalSource(archive: Buffer): Promise<ExtractedAgentImportSource>;
    inspectSource(repoDir: string): Promise<AgentImportRepositoryInspection>;
    compareWorkspaces(sourceDir: string, targetDir: string, workspacePolicy: AgentImportWorkspacePolicy): Promise<AgentImportWorkspaceComparison>;
    workspaceState(slug: string): Promise<{
        targetDir: string;
        head: string;
        clean: boolean;
    }>;
    runDoctor(candidate: JsonObject): Promise<AgentImportDoctorResult>;
    putRecord(record: AgentImportRecord): Promise<void>;
    getRecord(id: string): Promise<AgentImportRecord | null>;
    getLatestRecord(): Promise<AgentImportRecord | null>;
    putPlan(id: string, plan: StoredAgentImportPlan): Promise<void>;
    getPlan(id: string): Promise<StoredAgentImportPlan | null>;
    putArchive(id: string, archive: Buffer): Promise<void>;
    getArchive(id: string): Promise<Buffer | null>;
    deleteStaging(id: string): Promise<void>;
    deleteImportBlobs(id: string): Promise<void>;
    abandonRecord(record: AgentImportRecord): Promise<void>;
    hasRepositoryImport(input: {
        targetDir: string;
        importId: string;
    }): Promise<boolean>;
    applyRepository(input: {
        sourceDir: string;
        sourceHead: string;
        targetDir: string;
        destinationHead: string;
        importId: string;
        slug: string;
        workspacePolicy: AgentImportWorkspacePolicy;
    }): Promise<{
        importCommit: string;
        sourceRef: string;
    }>;
    rollbackRepository(input: {
        targetDir: string;
        importCommit: string;
        destinationHead: string;
        importId: string;
    }): Promise<{
        rollbackCommit: string;
    }>;
    readIdentity(uid: string): Promise<AgentImportIdentitySnapshot>;
    syncIdentity(uid: string, identity: AgentImportIdentity): Promise<void>;
    replaceIdentity(uid: string, identity: AgentImportIdentitySnapshot): Promise<void>;
    withConfigLock<T>(work: () => Promise<T>): Promise<T>;
    invokeOpenClaw(method: string, params: Record<string, unknown>): Promise<unknown>;
}
export declare class AgentImportServiceError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class AgentImportService {
    private readonly deps;
    private static readonly activeMutations;
    constructor(deps: AgentImportServiceDeps);
    private serializeMutation;
    previewGithub(input: {
        uid: string;
        slug: string;
        gatewayId: string;
        workspacePolicy: AgentImportWorkspacePolicy;
        owner: string;
        repo: string;
        branch: string;
        artifacts: AgentImportConfigArtifacts;
    }): Promise<AgentImportPreview>;
    previewLocal(input: {
        uid: string;
        slug: string;
        gatewayId: string;
        workspacePolicy: AgentImportWorkspacePolicy;
        archive: Buffer;
    }): Promise<AgentImportPreview>;
    private persistPreview;
    apply(input: {
        uid: string;
        importId: string;
        approvalHash: string;
        workspacePolicy: AgentImportWorkspacePolicy;
    }): Promise<AgentImportRecord>;
    private applyOnce;
    private applyWorkspace;
    private applyIdentity;
    private applyConfig;
    private applyRequiredRuntimeConfig;
    private completeApply;
    rollback(input: {
        uid: string;
        importId: string;
    }): Promise<AgentImportRecord>;
    abandon(input: {
        uid: string;
        importId: string;
    }): Promise<AgentImportRecord>;
    private abandonOnce;
    private rollbackOnce;
    get(input: {
        uid: string;
        importId: string;
    }): Promise<AgentImportRecord>;
    latest(input: {
        uid: string;
    }): Promise<AgentImportRecord | null>;
    private sourceForPlan;
    private applyRuntimeConfig;
    private patchRuntime;
    private ownedRecord;
    private update;
}
export {};
