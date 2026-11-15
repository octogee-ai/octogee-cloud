import type { ManifestEntry } from "../workspace-manifest.js";
export { withProjectAssetManifest } from "../project-asset-state.js";

export function projectAssetEntry(input: { gcsPath: string; sha256?: string; size: number }, mimeType: string): ManifestEntry {
  if (!input.sha256) throw new Error("project asset upload has no immutable identity");
  return { type: "blob", gcsPath: input.gcsPath, sha256: input.sha256, size: input.size, mimeType, uploadedAt: new Date().toISOString() };
}
