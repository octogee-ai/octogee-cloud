import { AGENT_IMPORT_FORMAT_VERSION, type AgentImportConfigArtifacts } from "@octogee/shared/types/agent-import";
export interface LocalAgentImportManifest {
    formatVersion: typeof AGENT_IMPORT_FORMAT_VERSION;
    sourceAgentId: string;
    hadGit: boolean;
    uncommittedFileCount: number;
}
export interface ExtractedAgentImportSource {
    repoDir: string;
    sourceHead: string;
    artifacts: AgentImportConfigArtifacts;
    manifest: LocalAgentImportManifest;
    cleanup(): void;
}
export interface ClonedGithubAgentImportSource {
    repoDir: string;
    sourceHead: string;
    cleanup(): void;
}
export declare class AgentImportSourceError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function githubAgentImportCloneUrl(owner: string, repo: string): string;
export declare function githubAgentImportCloneCommandArgs(args: ReadonlyArray<string>): string[];
export declare function githubAgentImportCloneEnvironment(token: string, source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function cloneGithubAgentImportSource(options: {
    owner: string;
    repo: string;
    branch: string;
    token: string;
    tmpRoot?: string;
}): Promise<ClonedGithubAgentImportSource>;
export declare function extractLocalAgentImportArchive(buffer: Buffer, options?: {
    tmpRoot?: string;
    maxEntryBytes?: number;
    maxUnpackedBytes?: number;
    maxGitBlobBytes?: number;
}): Promise<ExtractedAgentImportSource>;
