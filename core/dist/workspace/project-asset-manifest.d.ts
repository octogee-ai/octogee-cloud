import type { ManifestEntry } from "../workspace-manifest.js";
export { withProjectAssetManifest } from "../project-asset-state.js";
export declare function projectAssetEntry(input: {
    gcsPath: string;
    sha256?: string;
    size: number;
}, mimeType: string): ManifestEntry;
