import type { Manifest, ManifestEntry } from "../../workspace-manifest.js";
export interface AgentExportFile {
    path: string;
    content: string;
    sha256: string;
    size: number;
    mode: "100644" | "100755";
}
export interface AgentExportSnapshot {
    files: AgentExportFile[];
    digest: string;
    assetIdentity: string;
}
export interface AgentExportCaptureDeps {
    defaultAgentWorkspace: boolean;
    assertCurrent(): Promise<void>;
    readAssets(directory?: {
        root: string;
        parent: string;
        name: string;
    }): Promise<{
        manifest: Manifest;
        deleted: string[];
    }>;
    readBlob(entry: ManifestEntry): Promise<Buffer>;
    scan(directory: string): Promise<unknown[]>;
    gitDir?: string;
}
export declare const MAX_AGENT_EXPORT_FILES = 100;
export declare function authoredAgentPath(name: string, defaultAgentWorkspace: boolean): boolean;
export declare function exportDigest(value: unknown): string;
export declare function captureAgentExport(root: string, deps: AgentExportCaptureDeps): Promise<AgentExportSnapshot>;
