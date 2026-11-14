import { execFileSync } from "node:child_process";
import { acquireWorkspaceMutationLeaseSync } from "@octogee/core/workspace-mutation-lease";
import { workspaceMutationLeaseGitDir } from "./workspace-git.js";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, chmod, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withMaterializedProjectAssets } from "@octogee/core/project-asset-state";
import { createAgentExportRuntime } from "./agent-export-runtime.js";
const mocks = vi.hoisted(() => ({ broker: vi.fn(), manifest: vi.fn(), file: vi.fn(), download: vi.fn(), metadata: vi.fn() }));
vi.mock("./agent-import-store.js", () => ({ agentImportBrokerBaseUrlFromEnv: () => "http://localhost", createAgentImportStore: () => ({ exportRequest: mocks.broker, readGithubToken: vi.fn(), listGithubSources: vi.fn() }) }));
vi.mock("./manifest.js", () => ({ getManifestForQuota: mocks.manifest }));
vi.mock("./gcs-bucket.js", () => ({ gcsBucket: () => ({ file: mocks.file }) }));
vi.mock("./agent-import-git.js", () => ({ scanAgentImportSecrets: async () => [] }));
vi.mock("./agent-export-github.js", () => ({ agentExportGithub: () => ({ destination: async () => ({ owner: "alice", repo: "agent", branch: "main", head: "a".repeat(40), tree: "b".repeat(40), files: [] }) }) }));
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe.skipIf(process.platform !== "linux")("runtime logical workspace capture", () => {
  it.each(["available", "busy", "redirected", "symlink"])("uses the provisioned agent metadata and mutation lease (%s)", async scenario => {
    vi.clearAllMocks();
    const base = await mkdtemp(join(tmpdir(), "export-coach-")); roots.push(base);
    const users = join(base, "customers"), directory = join(users, "alice");
    const metadata = join(base, "git-metadata/alice/workspace.git");
    await mkdir(directory, { recursive: true }); await mkdir(join(base, "git-metadata/alice"), { recursive: true });
    execFileSync("git", ["init", "--quiet", "--separate-git-dir", metadata, directory]);
    await chmod(join(directory, ".git"), 0o444); await writeFile(join(directory, "SOUL.md"), "authored agent");
    vi.stubEnv("CUSTOMERS_DIR", users);
    const source = { uid: "u1", slug: "alice", gatewayId: "shared-a", epoch: 7, agentId: "octogee-alice-coach", project: null };
    mocks.manifest.mockResolvedValue({}); mocks.broker.mockImplementation(async route => route === "/exports/authorize" ? source : null);
    const lease = ["busy", "redirected"].includes(scenario) ? acquireWorkspaceMutationLeaseSync({ workspaceDir: directory, gitDir: workspaceMutationLeaseGitDir(directory) }) : null;
    try {
      if (scenario === "redirected") {
        await chmod(join(directory, ".git"), 0o644);
        await writeFile(join(directory, ".git"), `gitdir: ${join(base, "foreign.git")}\n`);
      }
      if (scenario === "symlink") { await rename(metadata, `${metadata}-held`); await symlink(`${metadata}-held`, metadata); }
      const result = createAgentExportRuntime({ gatewayId: source.gatewayId, authorization: "Bearer synthetic" }).service.preview(source.agentId, { owner: "alice", repo: "agent" });
      if (scenario === "available") expect((await result).changes.map(file => file.path)).toEqual(["SOUL.md"]);
      else await expect(result).rejects.toThrow(scenario === "symlink" ? undefined : "workspace mutation is in progress");
    } finally { lease?.release(); }
  });
  it.each([false, true])("includes never-materialized bytes but preserves recorded deletion (materialized=%s)", async materialized => {
    vi.clearAllMocks();
    const base = await mkdtemp(join(tmpdir(), "export-runtime-")); roots.push(base);
    const users = join(base, "customers"), directory = join(users, "alice/projects/demo");
    await mkdir(join(directory, ".git"), { recursive: true }); await writeFile(join(directory, "SOUL.md"), "authored");
    await mkdir(join(directory, "projects")); await writeFile(join(directory, "projects/local.ts"), "authored code");
    vi.stubEnv("CUSTOMERS_DIR", users);
    const prefix = "customers/alice/projects/demo", bytes = Buffer.from([0, 1, 2]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const entry = { type: "blob" as const, gcsPath: `${prefix}/.objects/${sha256}`, sha256, size: 3, mimeType: "image/png", uploadedAt: "2026-10-23T00:00:00Z" };
    mocks.manifest.mockResolvedValue({ "portrait.png": entry });
    if (materialized) await withMaterializedProjectAssets(directory, prefix, async files => { files["portrait.png"] = entry; });
    mocks.metadata.mockResolvedValue([{ generation: "42", size: "3" }]); mocks.download.mockResolvedValue([bytes]);
    mocks.file.mockImplementation(() => ({ getMetadata: mocks.metadata, download: mocks.download }));
    const source = { uid: "u1", slug: "alice", gatewayId: "shared-a", epoch: 7, agentId: "octogee-alice-demo", project: "demo" };
    mocks.broker.mockImplementation(async route => route === "/exports/authorize" ? source : null);
    const preview = await createAgentExportRuntime({ gatewayId: source.gatewayId, authorization: "Bearer synthetic" }).service.preview(source.agentId, { owner: "alice", repo: "agent" });
    expect(preview.changes.map(file => file.path)).toEqual(materialized ? ["SOUL.md", "projects/local.ts"] : ["SOUL.md", "portrait.png", "projects/local.ts"]);
    expect(mocks.manifest).toHaveBeenCalledWith(prefix);
    if (materialized) expect(mocks.file).not.toHaveBeenCalled();
    else {
      expect(mocks.file).toHaveBeenCalledWith(entry.gcsPath, { generation: "42" });
      expect(mocks.download).toHaveBeenCalledWith({ validation: "crc32c" });
      const saved = mocks.broker.mock.calls.find(call => String(call[0]).includes("/snapshots/"));
      expect(JSON.parse(saved![1].body).files.find((file: { path: string }) => file.path === "portrait.png").content).toBe(bytes.toString("base64"));
    }
  });
});
