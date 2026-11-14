// Issue attachments live in GCS, not in the git provider: Gitea has an asset
// API but GitHub exposes none, so provider-side attachments would break the
// Board's Gitea/GitHub abstraction. Objects sit under a reserved dot-prefix in
// the target's GCS namespace (never in the repo or the workspace-file
// manifest) and are served through short-lived signed URLs.
import { randomUUID } from "node:crypto";
import { gcsBucket } from "./gcs-bucket.js";
import type { FileTarget } from "./fileTarget.js";

export const MAX_ISSUE_ASSET_BYTES = 25 * 1024 * 1024;
const SIGNED_URL_TTL_MS = 60 * 60 * 1000;
const ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_NAME_LENGTH = 120;

export interface IssueAsset {
  id: string;
  name: string;
  size: number;
  contentType: string;
  createdAt: string;
  url: string;
}

export class IssueAssetTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`attachment exceeds ${MAX_ISSUE_ASSET_BYTES} bytes`);
    this.name = "IssueAssetTooLargeError";
  }
}

export function isValidAssetId(id: string): boolean {
  return ASSET_ID_RE.test(id);
}

export function sanitizeAssetName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f?#%]/g, "")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
}

export function issueAssetsPrefix(target: Pick<FileTarget, "gcsPrefix">, num: number): string {
  return `${target.gcsPrefix}/.issue-assets/${num}/`;
}

export function parseAssetObjectPath(
  prefix: string,
  objectPath: string,
): { id: string; name: string } | null {
  if (!objectPath.startsWith(prefix)) return null;
  const rest = objectPath.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const id = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  if (!isValidAssetId(id) || name.length === 0 || name.includes("/")) return null;
  return { id, name };
}

async function signedAssetUrl(file: { getSignedUrl: (opts: { action: "read"; expires: number }) => Promise<[string]> }): Promise<string> {
  const [url] = await file.getSignedUrl({ action: "read", expires: Date.now() + SIGNED_URL_TTL_MS });
  return url;
}

export interface StoreIssueAssetInput {
  name: string;
  content: Buffer;
  contentType: string;
}

export async function storeIssueAsset(
  target: FileTarget,
  num: number,
  input: StoreIssueAssetInput,
): Promise<IssueAsset> {
  if (input.content.length > MAX_ISSUE_ASSET_BYTES) throw new IssueAssetTooLargeError(input.content.length);
  const id = randomUUID();
  const name = sanitizeAssetName(input.name);
  const objectPath = `${issueAssetsPrefix(target, num)}${id}/${name}`;
  const file = gcsBucket().file(objectPath);
  await file.save(input.content, {
    contentType: input.contentType || "application/octet-stream",
    resumable: false,
  });
  return {
    id,
    name,
    size: input.content.length,
    contentType: input.contentType || "application/octet-stream",
    createdAt: new Date().toISOString(),
    url: await signedAssetUrl(file),
  };
}

interface AssetFileMetadata {
  size?: string | number;
  contentType?: string;
  timeCreated?: string;
}

export async function listIssueAssets(target: FileTarget, num: number): Promise<IssueAsset[]> {
  const prefix = issueAssetsPrefix(target, num);
  const [files] = await gcsBucket().getFiles({ prefix });
  const assets = await Promise.all(
    files.map(async (file) => {
      const parsed = parseAssetObjectPath(prefix, file.name);
      if (!parsed) return null;
      const metadata = (file.metadata ?? {}) as AssetFileMetadata;
      return {
        id: parsed.id,
        name: parsed.name,
        size: Number(metadata.size) || 0,
        contentType: metadata.contentType ?? "application/octet-stream",
        createdAt: metadata.timeCreated ?? "",
        url: await signedAssetUrl(file),
      };
    }),
  );
  return assets
    .filter((a): a is IssueAsset => a !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function deleteIssueAsset(target: FileTarget, num: number, id: string): Promise<boolean> {
  if (!isValidAssetId(id)) return false;
  const prefix = `${issueAssetsPrefix(target, num)}${id}/`;
  const [files] = await gcsBucket().getFiles({ prefix });
  if (files.length === 0) return false;
  await Promise.all(files.map((file) => file.delete()));
  return true;
}
