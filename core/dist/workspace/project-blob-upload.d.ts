import type { FleetBrokerBlobSignedUrl } from "@octogee/shared/types/fleet-broker";
import type { ProjectBlobHydrationClient } from "../project-blob-materialization.js";
import type { StoredWorkspaceBlob, WorkspaceBlobTarget } from "./workspace-blob.js";
export declare function uploadProjectBlobViaBroker(base: string, target: WorkspaceBlobTarget, contents: Buffer, mimeType: string): Promise<StoredWorkspaceBlob>;
export declare function uploadWorkspaceBlobViaBroker(base: string, target: WorkspaceBlobTarget, filePath: string, contents: Buffer, mimeType: string): Promise<StoredWorkspaceBlob>;
export declare function projectBlobHydrationClient(base: string): ProjectBlobHydrationClient;
export declare function workspaceBlobReadClient(base: string): {
    manifestUrl: (slug: string) => Promise<FleetBrokerBlobSignedUrl>;
    blobUrl: (slug: string, path: string) => Promise<FleetBrokerBlobSignedUrl>;
};
