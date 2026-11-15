import { type AgentImportWorkspacePolicy } from "@octogee/shared/types/agent-import";
export interface AgentImportSecretFinding {
    ruleId: string;
    path: string;
    commit: string | null;
}
export interface AgentImportRepositoryInspection {
    head: string;
    commitCount: number;
    fileCount: number;
    totalBytes: number;
    workspaceDigest: string;
    secretFindings: AgentImportSecretFinding[];
}
export interface AgentImportManifestEntry {
    type: "blob";
    gcsPath: string;
    size: number;
    mimeType: string;
    uploadedAt: string;
    thumbnailUrl?: string;
}
export interface AgentImportWorkspaceComparison {
    conflicts: string[];
    conflictCount: number;
    conflictDigest: string;
    preservedPaths: string[];
}
export declare function compareAgentImportWorkspaces(sourceDir: string, targetDir: string, workspacePolicy: AgentImportWorkspacePolicy): Promise<AgentImportWorkspaceComparison>;
interface CommandResult {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
}
type CommandRunner = (command: string, args: string[], options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string | Buffer;
    maxOutput?: number;
}) => CommandResult | Promise<CommandResult>;
export declare function buildAgentImportGitEnvironment(source?: NodeJS.ProcessEnv, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare class AgentImportGitError extends Error {
    readonly code: string;
    readonly findings?: AgentImportSecretFinding[] | undefined;
    constructor(code: string, message: string, findings?: AgentImportSecretFinding[] | undefined);
}
export declare function agentImportRepositoryApplied(targetDir: string, importId: string): Promise<boolean>;
interface RepositoryExpansionLimits {
    maxBlobBytes?: number;
    maxReachableBlobBytes?: number;
    maxTipBytes?: number;
    maxObjects?: number;
}
export declare function assertAgentImportRepositoryExpansionSafe(repoDir: string, head: string, limits?: RepositoryExpansionLimits): Promise<void>;
export declare function inspectAgentImportRepository(repoDir: string, options?: {
    head?: string;
    scanSecrets?: (repoDir: string) => Promise<AgentImportSecretFinding[]>;
}): Promise<AgentImportRepositoryInspection>;
export declare function sanitizeAgentImportRepositoryHistory(repoDir: string, head: string): Promise<string>;
interface WorkspaceMutationLease {
    release(): void;
}
type WorkspaceMutationLeaseFactory = (workspaceDir: string) => WorkspaceMutationLease | null;
interface ApplyAgentImportRepositoryOptions {
    sourceDir: string;
    sourceHead: string;
    targetDir: string;
    destinationHead: string;
    importId: string;
    slug: string;
    workspacePolicy: AgentImportWorkspacePolicy;
    storeBlob: (filePath: string, contents: Buffer, mimeType: string) => Promise<AgentImportManifestEntry>;
    cleanupBlobs: () => Promise<void>;
    push?: boolean;
    acquireMutationLease?: WorkspaceMutationLeaseFactory;
    beforeTargetUpdate?: () => void;
}
export declare function applyAgentImportRepository(options: ApplyAgentImportRepositoryOptions): Promise<{
    importCommit: string;
    sourceRef: string;
}>;
export declare function rollbackAgentImportRepository(options: {
    targetDir: string;
    importCommit: string;
    destinationHead: string;
    importId: string;
    push?: boolean;
    acquireMutationLease?: WorkspaceMutationLeaseFactory;
    beforeTargetUpdate?: () => void;
}): Promise<{
    rollbackCommit: string;
}>;
export declare function scanAgentImportSecrets(repoDir: string, options?: {
    currentOnly?: boolean;
    run?: CommandRunner;
    configPath?: string;
}): Promise<AgentImportSecretFinding[]>;
export {};
