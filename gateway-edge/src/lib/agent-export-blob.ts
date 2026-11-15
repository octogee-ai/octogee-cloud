import { manifestObjectPath, parseManifest, type ManifestEntry } from "@octogee/core/workspace-manifest";
import { isBlobObjectVersion, type FleetBrokerBlobSignedUrl } from "@octogee/shared/types/fleet-broker";
import { projectBlobHydrationClient, workspaceBlobReadClient } from "@octogee/core/workspace/project-blob-upload";

interface Input {
  baseUrl: string;
  endpoint: string;
  prefix: string;
  source: { slug: string; project: string | null };
  signal: AbortSignal;
}

async function boundedResponse(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error("authored export blob has no body");
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(parts, size);
      size += chunk.value.byteLength;
      if (size > limit) throw new Error("authored export blob exceeds its size limit");
      parts.push(Buffer.from(chunk.value));
    }
  } finally {
    await reader.cancel();
  }
}

export function createBrokeredExportAssets({ baseUrl, endpoint, prefix, source, signal }: Input) {
  const { slug, project } = source;
  const origin = new URL(endpoint).origin;
  const workspace = workspaceBlobReadClient(baseUrl);
  const projects = projectBlobHydrationClient(baseUrl);

  const read = (signed: FleetBrokerBlobSignedUrl, key: string) => {
    const url = new URL(signed.url);
    if (signed.storage !== "s3" || signed.method !== "GET" || signed.gcsPath !== key ||
      url.origin !== origin || url.username || url.password) {
      throw new Error("authored export blob capability does not match its object");
    }
    return fetch(url, { method: "GET", redirect: "error", signal });
  };

  return {
    async readManifest() {
      const key = manifestObjectPath(prefix);
      const signed = project ? await projects.workspaceManifestReadUrl({ slug, projectSlug: project }) : await workspace.manifestUrl(slug);
      const response = await read(signed, key);
      if (response.status === 404) return {};
      if (!response.ok) throw new Error(`authored export manifest read failed: HTTP ${response.status}`);
      return parseManifest(key, (await boundedResponse(response, 10 * 1024 * 1024)).toString("utf8"));
    },
    async readBlob(entry: ManifestEntry) {
      const path = entry.gcsPath.slice(`customers/${slug}/`.length);
      const materialization = project ? await projects.blobMaterializationReadUrl({
        slug, path: entry.sha256 ? `projects/${project}/asset` : path, size: entry.size, sha256: entry.sha256,
      }) : undefined;
      const signed = materialization?.download ?? await workspace.blobUrl(slug, path);
      const response = await read(signed, entry.gcsPath);
      if (!response.ok) throw new Error(`authored export blob read failed: HTTP ${response.status}`);
      const version = response.headers.get("x-amz-version-id");
      if (materialization && (!isBlobObjectVersion(version, signed.storage) || materialization.size !== entry.size || version !== materialization.generation)) {
        throw new Error("authored export blob version changed");
      }
      const bytes = await boundedResponse(response, entry.size);
      if (bytes.length !== entry.size) throw new Error("authored export blob size changed");
      return bytes;
    },
  };
}
