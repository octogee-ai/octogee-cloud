import { createBrokeredExportAssets } from "./agent-export-blob.js";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { readMaterializedProjectAssets, readProjectAssetManifest } from "@octogee/core/project-asset-state";
import { manifestObjectPath, parseManifest } from "@octogee/core/workspace-manifest";
import { createAgentImportStore, agentImportBrokerBaseUrlFromEnv } from "./agent-import-store.js";
import { scanAgentImportSecrets } from "./agent-import-git.js";
import { resolveUserDir, resolveProjectDir, workspaceMutationLeaseGitDir } from "./workspace-git.js";
import { getManifestForQuota } from "./manifest.js";
import { gcsBucket } from "./gcs-bucket.js";
import { withinAgentExportDeadline, AgentExportService, type AgentExportSource, type AgentExportRecord } from "./agent-export-service.js";
import { captureAgentExport, exportDigest, type AgentExportSnapshot } from "./agent-export-snapshot.js";
import { agentExportGithub } from "./agent-export-github.js";

export function createAgentExportRuntime(input: { authorization: string; gatewayId: string }) {
  const deadline = AbortSignal.timeout(90_000);
  const baseUrl = agentImportBrokerBaseUrlFromEnv();
  const store = createAgentImportStore({ ...input, signal: deadline, baseUrl });
  const json = (value: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const authorize = async (agentId: string): Promise<AgentExportSource> => store.exportRequest("/exports/authorize", json({ agentId })) as Promise<AgentExportSource>;
  const github = agentExportGithub(async () => { const token = await store.readGithubToken(); if (!token) { throw new Error("Reconnect GitHub before exporting"); } return token; }, deadline);
  const capture = async (source: AgentExportSource): Promise<AgentExportSnapshot> => {
    const root = process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers";
    const parts = [root, path.join(root, source.slug), ...(source.project ? [path.join(root, source.slug, "projects"), path.join(root, source.slug, "projects", source.project)] : [])];
    const assertCurrent = async () => {
      if (exportDigest(await authorize(source.agentId)) !== exportDigest(source)) throw new Error("authored export source authority changed");
      for (const directory of parts) if (!(await lstat(directory)).isDirectory()) throw new Error("authored workspace root is not confined");
    };
    await assertCurrent();
    const directory = source.project ? await resolveProjectDir(root, source.slug, source.project) : await resolveUserDir(root, source.slug);
    if (!directory) throw new Error("agent workspace is not available on this gateway");
    const prefix = source.project ? `customers/${source.slug}/projects/${source.project}` : `customers/${source.slug}`;
    const gitDir = workspaceMutationLeaseGitDir(directory);
    const endpoint = process.env.BLOB_S3_PUBLIC_ENDPOINT;
    const brokered = endpoint && createBrokeredExportAssets({ baseUrl, endpoint, source, prefix, signal: deadline });
    const readManifest = brokered ? brokered.readManifest : () => getManifestForQuota(prefix);
    return captureAgentExport(directory, {
      defaultAgentWorkspace: source.project === null, assertCurrent, gitDir,
      readAssets: async pinned => {
        if (!pinned) throw new Error("authored workspace capture is not pinned");
        const manifest = source.project ? await readProjectAssetManifest(pinned.root, prefix) ?? await readManifest() : await readManifest();
        parseManifest(manifestObjectPath(prefix), JSON.stringify(manifest));
        const materialized = source.project ? await readMaterializedProjectAssets(pinned.root, prefix, { parent: pinned.parent, name: pinned.name }) : {};
        const deleted: string[] = [];
        for (const [name, prior] of Object.entries(materialized)) {
          if (!manifest[name] || exportDigest(prior) !== exportDigest(manifest[name])) continue;
          try { await lstat(path.join(pinned.root, name)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") deleted.push(name); else throw error; }
        }
        return { manifest, deleted: deleted.sort() };
      },
      readBlob: brokered ? brokered.readBlob : async entry => {
        const file = gcsBucket().file(entry.gcsPath);
        const [metadata] = await file.getMetadata();
        if (!metadata.generation || Number(metadata.size) !== entry.size) throw new Error("authored asset generation or size changed");
        const [contents] = await gcsBucket().file(entry.gcsPath, { generation: metadata.generation }).download({ validation: "crc32c" });
        return contents;
      },
      scan: directory => scanAgentImportSecrets(directory, { currentOnly: true }),
    });
  };
  const service = new AgentExportService({ authorize, capture, ...github,
    put: async record => { await store.exportRequest(`/exports/records/${record.id}`, { ...json(record), method: "PUT" }); },
    get: id => store.exportRequest(`/exports/records/${encodeURIComponent(id)}`) as Promise<AgentExportRecord | null>,
    putSnapshot: async (id, snapshot) => { await store.exportRequest(`/exports/snapshots/${id}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: JSON.stringify(snapshot) }); },
    getSnapshot: id => store.exportRequest(`/exports/snapshots/${id}`) as Promise<AgentExportSnapshot>,
    now: () => new Date(), id: () => `export-${randomUUID()}`,
  });
  return { service: {
    preview: (...args: Parameters<AgentExportService["preview"]>) => withinAgentExportDeadline(service.preview(...args), deadline),
    apply: (...args: Parameters<AgentExportService["apply"]>) => withinAgentExportDeadline(service.apply(...args), deadline),
  },
    agents: () => store.exportRequest("/exports/agents"),
    repos: async () => { await store.exportRequest("/exports/agents"); return store.listGithubSources(); },
    latest: () => store.exportRequest("/exports/records/latest"),
  };
}
