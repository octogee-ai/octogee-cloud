import { describe, expect, it, vi } from "vitest";

import { buildAgentImportConfigArtifacts } from "@octogee/shared/types/agent-import";
import {
  AgentImportService,
  type AgentImportRecord,
  type AgentImportServiceDeps,
  type StoredAgentImportPlan,
} from "./agent-import-service.js";

const SOURCE_HEAD = "a".repeat(40);
const DESTINATION_HEAD = "b".repeat(40);
const IMPORT_COMMIT = "c".repeat(40);
const DEFAULT_WORKSPACE_POLICY = { preserveConvergedContextFiles: false };

class TestAgentImportService extends AgentImportService {
  override previewGithub(
    input: Omit<Parameters<AgentImportService["previewGithub"]>[0], "workspacePolicy"> &
      Partial<Pick<Parameters<AgentImportService["previewGithub"]>[0], "workspacePolicy">>,
  ) {
    return super.previewGithub({ workspacePolicy: DEFAULT_WORKSPACE_POLICY, ...input });
  }

  override previewLocal(
    input: Omit<Parameters<AgentImportService["previewLocal"]>[0], "workspacePolicy"> &
      Partial<Pick<Parameters<AgentImportService["previewLocal"]>[0], "workspacePolicy">>,
  ) {
    return super.previewLocal({ workspacePolicy: DEFAULT_WORKSPACE_POLICY, ...input });
  }

  override apply(
    input: Omit<Parameters<AgentImportService["apply"]>[0], "workspacePolicy"> &
      Partial<Pick<Parameters<AgentImportService["apply"]>[0], "workspacePolicy">>,
  ) {
    return super.apply({ workspacePolicy: DEFAULT_WORKSPACE_POLICY, ...input });
  }
}

function artifacts() {
  return buildAgentImportConfigArtifacts({
    meta: { lastTouchedVersion: "2025.4.3" },
    agents: {
      list: [{
        id: "moof",
        name: "Moof",
        persona: "Jack's trusty sidekick.",
        identity: { emoji: "🐮" },
        timeoutSeconds: 300,
        model: "anthropic/claude-sonnet",
      }],
    },
    channels: { telegram: { token: "must-never-cross" } },
  }, "moof");
}

function openClawRuntimeHarness(initialConfig: Record<string, unknown> = {
  agents: { list: [{ id: "octogee-jack-coach", timeoutSeconds: 600 }] },
}) {
  const config = structuredClone(initialConfig);
  let revision = 0;
  const merge = (target: Record<string, unknown>, patch: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete target[key];
      } else if (
        typeof value === "object" && value !== null && !Array.isArray(value) &&
        typeof target[key] === "object" && target[key] !== null && !Array.isArray(target[key])
      ) {
        merge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        target[key] = structuredClone(value);
      }
    }
  };
  const invokeOpenClaw = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "config.get") {
      return { hash: `config-${revision}`, config: structuredClone(config) };
    }
    if (method === "config.patch") {
      const raw = JSON.parse(String(params.raw)) as {
        agents: {
          list?: Array<Record<string, unknown>>;
          entries?: Record<string, Record<string, unknown>>;
        };
      };
      const roster = config.agents as {
        list?: Array<Record<string, unknown>>;
        entries?: Record<string, Record<string, unknown>>;
      };
      if (raw.agents.entries) {
        // 2026.7.2 keyed roster: the key is the id and the entry carries none.
        if (!roster.entries) throw new Error("config has no keyed agent entries");
        for (const [agentId, entryPatch] of Object.entries(raw.agents.entries)) {
          const entry = roster.entries[agentId];
          if (!entry) throw new Error("missing agent");
          merge(entry, entryPatch);
        }
      } else {
        if (!roster.list) throw new Error("config has no agent list");
        for (const agentPatch of raw.agents.list ?? []) {
          const agent = roster.list.find((candidate) => candidate.id === agentPatch.id);
          if (!agent) throw new Error("missing agent");
          merge(agent, Object.fromEntries(Object.entries(agentPatch).filter(([key]) => key !== "id")));
        }
      }
      revision += 1;
      return { ok: true };
    }
    if (method === "health") return { status: "ok" };
    throw new Error(`unexpected OpenClaw method ${method}`);
  });
  return {
    invokeOpenClaw,
    config: () => structuredClone(config),
  };
}

function harness(overrides: Partial<AgentImportServiceDeps> = {}) {
  const records = new Map<string, AgentImportRecord>();
  const plans = new Map<string, StoredAgentImportPlan>();
  const archives = new Map<string, Buffer>();
  const cleanup = vi.fn();
  const openClaw = openClawRuntimeHarness();
  const deps: AgentImportServiceDeps = {
    newId: () => "import-1",
    now: () => new Date("2026-07-20T12:00:00.000Z"),
    readGithubToken: vi.fn(async () => "github-oauth"),
    readGithubRepoSize: vi.fn(async () => 12),
    cloneGithubSource: vi.fn(async () => ({ repoDir: "/source", sourceHead: SOURCE_HEAD, cleanup })),
    extractLocalSource: vi.fn(async () => ({
      repoDir: "/source",
      sourceHead: SOURCE_HEAD,
      artifacts: artifacts(),
      manifest: { formatVersion: 1 as const, sourceAgentId: "moof", hadGit: true, uncommittedFileCount: 0 },
      cleanup,
    })),
    inspectSource: vi.fn(async () => ({
      head: SOURCE_HEAD,
      commitCount: 14,
      fileCount: 9,
      totalBytes: 4200,
      workspaceDigest: `sha256:${"d".repeat(64)}`,
      secretFindings: [],
    })),
    compareWorkspaces: vi.fn(async () => ({
      conflicts: [], conflictCount: 0, conflictDigest: `sha256:${"0".repeat(64)}`,
      preservedPaths: [".files", "openclaw-workspace-state.json", "projects"],
    })),
    workspaceState: vi.fn(async () => ({ targetDir: "/target", head: DESTINATION_HEAD, clean: true })),
    runDoctor: vi.fn(async () => ({
      outcome: "migrated" as const,
      doctorVersion: "2026.7.2",
      changedPaths: ["agents.list"],
      diagnostics: [],
      repairedCandidate: artifacts().doctorCandidate,
    })),
    putRecord: vi.fn(async (record) => { records.set(record.id, structuredClone(record)); }),
    getRecord: vi.fn(async (id) => records.get(id) ? structuredClone(records.get(id)!) : null),
    getLatestRecord: vi.fn(async () => {
      const record = [...records.values()].at(-1);
      return record ? structuredClone(record) : null;
    }),
    putPlan: vi.fn(async (id, plan) => { plans.set(id, structuredClone(plan)); }),
    getPlan: vi.fn(async (id) => plans.get(id) ? structuredClone(plans.get(id)!) : null),
    putArchive: vi.fn(async (id, archive) => { archives.set(id, Buffer.from(archive)); }),
    getArchive: vi.fn(async (id) => archives.get(id) ? Buffer.from(archives.get(id)!) : null),
    deleteStaging: vi.fn(async (id) => { plans.delete(id); archives.delete(id); }),
    deleteImportBlobs: vi.fn(async () => undefined),
    abandonRecord: vi.fn(async (record) => { records.set(record.id, structuredClone(record)); }),
    hasRepositoryImport: vi.fn(async () => false),
    applyRepository: vi.fn(async () => ({ importCommit: IMPORT_COMMIT, sourceRef: "refs/octogee/imports/import-1/source" })),
    rollbackRepository: vi.fn(async () => ({ rollbackCommit: "e".repeat(40) })),
    readIdentity: vi.fn(async () => ({ name: "Octo", persona: "Default", emoji: "🐙" })),
    syncIdentity: vi.fn(async () => undefined),
    replaceIdentity: vi.fn(async () => undefined),
    withConfigLock: vi.fn(async (work) => work()),
    invokeOpenClaw: openClaw.invokeOpenClaw,
    ...overrides,
  };
  return { service: new TestAgentImportService(deps), deps, records, plans, archives, cleanup };
}

describe("AgentImportService preview", () => {
  it("keeps retired heartbeat visible after Doctor migration without importing temporary schedules", async () => {
    const original = buildAgentImportConfigArtifacts({
      agents: { list: [{ id: "moof", heartbeat: { every: "30m", lightContext: true } }] },
    }, "moof");
    const h = harness({
      runDoctor: vi.fn(async () => ({
        outcome: "migrated" as const, doctorVersion: "2026.10.5", changedPaths: ["agents.list"], diagnostics: [],
        repairedCandidate: { agents: { entries: { moof: {} } } },
      })),
    });
    const preview = await h.service.previewGithub({
      uid: "uid-jack", slug: "jack", gatewayId: "shared-1", owner: "jack", repo: "moof", branch: "main",
      artifacts: original,
    });
    expect(preview.doctor.outcome).toBe("migrated");
    expect(preview.config.runtimePatch).toEqual({});
    expect(preview.config.effectiveOutcome).toBe("safe_baseline");
    expect(preview.config.decisions).toContainEqual(expect.objectContaining({
      path: "heartbeat.every", disposition: "manual_review",
      reason: expect.stringMatching(/native Doctor.*Automations.*not transfer schedules/),
    }));
    expect(h.plans.get(preview.id)?.artifacts).toEqual(original);
    const completed = await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });
    expect(completed.configOutcome).toBe("safe_baseline");
    expect(completed.warnings).not.toContain("config_delta_rejected");
    const patches = vi.mocked(h.deps.invokeOpenClaw).mock.calls.filter(([method]) => method === "config.patch");
    expect(patches).toHaveLength(1);
    expect(JSON.parse(String(patches[0][1].raw))).toEqual({
      agents: { list: [{ id: "octogee-jack-coach", skipBootstrap: true }] },
    });
    expect(h.deps.invokeOpenClaw).not.toHaveBeenCalledWith("cron.migration", expect.anything());
  });

  it("uses the authorized workspace ownership policy for preview and apply", async () => {
    const compareWorkspaces = vi.fn(async () => ({
      conflicts: [],
      conflictCount: 0,
      conflictDigest: `sha256:${"f".repeat(64)}`,
      preservedPaths: ["openclaw-workspace-state.json"],
    }));
    const h = harness({ compareWorkspaces });
    const workspacePolicy = { preserveConvergedContextFiles: false };

    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      workspacePolicy,
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });
    await h.service.apply({
      uid: "uid-jack",
      importId: preview.id,
      approvalHash: preview.approvalHash,
    });

    expect(compareWorkspaces).toHaveBeenCalledWith("/source", "/target", workspacePolicy);
    expect(h.deps.applyRepository).toHaveBeenCalledWith(expect.objectContaining({ workspacePolicy }));
  });

  it("rejects an oversized GitHub repository before starting a clone", async () => {
    const h = harness({ readGithubRepoSize: vi.fn(async () => 128 * 1024 + 1) });

    await expect(h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    })).rejects.toMatchObject({ code: "archive_too_large" });
    expect(h.deps.cloneGithubSource).not.toHaveBeenCalled();
  });

  it("previews GitHub history with current Doctor and stores no OAuth token or source credential", async () => {
    const h = harness({ compareWorkspaces: vi.fn(async () => ({
      conflicts: ["overwrite:README.md", "delete:NOTES.md"],
      conflictCount: 2,
      conflictDigest: `sha256:${"f".repeat(64)}`,
      preservedPaths: [".files", "openclaw-workspace-state.json", "projects"],
    })) });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });

    expect(preview).toMatchObject({
      id: "import-1",
      source: { kind: "github", owner: "jack", repo: "moof", branch: "main", head: SOURCE_HEAD },
      workspace: {
        commitCount: 14,
        fileCount: 9,
        historyPreserved: true,
        conflicts: ["overwrite:README.md", "delete:NOTES.md"],
        conflictCount: 2,
      },
      doctor: { outcome: "migrated" as const, doctorVersion: "2026.7.2" },
    });
    expect(preview.approvalHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(preview.config.decisions).toContainEqual(expect.objectContaining({
      path: "model.primary",
      disposition: "reauth_then_apply",
    }));
    expect(JSON.stringify([...h.records.values()])).not.toContain("github-oauth");
    expect(JSON.stringify([...h.plans.values()])).not.toContain("must-never-cross");
    expect(h.cleanup).toHaveBeenCalledOnce();
  });

  it("falls back to the safe config when Doctor cannot migrate the source", async () => {
    const h = harness({
      runDoctor: vi.fn(async () => ({
        outcome: "unsupported" as const,
        doctorVersion: "2026.7.2",
        changedPaths: [],
        diagnostics: ["doctor_exit_2"],
      })),
    });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });

    expect(preview.config.effectiveOutcome).toBe("safe_baseline");
    expect(preview.config.runtimePatch).toEqual({});
    expect(preview.workspace.historyPreserved).toBe(true);
  });

  it("lets current Doctor migrate a legacy agent field before portable planning", async () => {
    const legacy = buildAgentImportConfigArtifacts({
      meta: { lastTouchedVersion: "2026.5.5" },
      agents: { defaults: { llm: "openai-codex/gpt-5.5" }, list: [{ id: "moof" }] },
    }, "moof");
    const repairedCandidate = {
      meta: { lastTouchedVersion: "2026.7.2" },
      agents: { defaults: { model: "openai/gpt-5.5" }, list: [{ id: "moof" }] },
    };
    const runDoctor = vi.fn(async () => ({
      outcome: "migrated" as const,
      doctorVersion: "2026.7.2",
      changedPaths: ["agents.defaults.llm", "agents.defaults.model"],
      diagnostics: [],
      repairedCandidate,
    }));
    const h = harness({ runDoctor });

    const preview = await h.service.previewGithub({
      uid: "uid-jack", slug: "jack", gatewayId: "shared-1", owner: "jack", repo: "moof", branch: "main",
      artifacts: legacy,
    });

    expect(runDoctor).toHaveBeenCalledWith(expect.objectContaining({
      agents: { defaults: { llm: "openai-codex/gpt-5.5" }, list: [{ id: "moof" }] },
    }));
    expect(preview.config.decisions).toContainEqual(expect.objectContaining({
      path: "model.primary",
      disposition: "reauth_then_apply",
    }));
  });

  it("falls back to the safe config when the current Doctor is unavailable", async () => {
    const h = harness({
      runDoctor: vi.fn(async () => { throw new Error("doctor unavailable"); }),
    });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });

    expect(preview.doctor).toMatchObject({
      outcome: "failed",
      doctorVersion: "unavailable",
      diagnostics: ["doctor_unavailable"],
    });
    expect(preview.config.effectiveOutcome).toBe("safe_baseline");
  });

  it("stages a normalized local archive and uses its locally reduced artifacts", async () => {
    const h = harness();
    const archive = Buffer.from("normalized zip bytes");
    const preview = await h.service.previewLocal({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      archive,
    });

    expect(preview.source.kind).toBe("local");
    expect(h.deps.putArchive).toHaveBeenCalledWith("import-1", archive);
    expect(h.archives.get("import-1")).toEqual(archive);
  });

  it("reports new history when the browser did not provide local Git metadata", async () => {
    const h = harness({
      extractLocalSource: vi.fn(async () => ({
        repoDir: "/source", sourceHead: SOURCE_HEAD, artifacts: artifacts(),
        manifest: { formatVersion: 1 as const, sourceAgentId: "moof", hadGit: false, uncommittedFileCount: 0 },
        cleanup: vi.fn(),
      })),
    });

    const preview = await h.service.previewLocal({
      uid: "uid-jack", slug: "jack", gatewayId: "shared-1", archive: Buffer.from("zip"),
    });

    expect(preview.workspace.historyPreserved).toBe(false);
  });

  it("publishes no preview record when durable local archive staging fails", async () => {
    const h = harness({
      putArchive: vi.fn(async () => { throw new Error("GCS unavailable"); }),
    });
    await expect(h.service.previewLocal({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      archive: Buffer.from("normalized zip bytes"),
    })).rejects.toThrow("GCS unavailable");
    expect(h.records.size).toBe(0);
    expect(h.deps.deleteStaging).toHaveBeenCalledWith("import-1");
  });
});

describe("AgentImportService apply and rollback", () => {
  it("abandons an unrecoverable pre-commit failure and clears its staged state", async () => {
    const h = harness();
    const preview = await h.service.previewGithub({
      uid: "uid-jack", slug: "jack", gatewayId: "shared-1", owner: "jack", repo: "moof", branch: "main",
      artifacts: artifacts(),
    });
    const failed = h.records.get(preview.id)!;
    h.records.set(preview.id, {
      ...failed,
      status: "failed",
      error: { code: "source_changed", message: "source changed after preview" },
    });

    const abandoned = await h.service.abandon({ uid: "uid-jack", importId: preview.id });

    expect(abandoned).toMatchObject({ id: preview.id, status: "abandoned" });
    expect(h.deps.deleteStaging).toHaveBeenCalledWith(preview.id);
    expect(h.deps.deleteImportBlobs).toHaveBeenCalledWith(preview.id);
    expect(h.deps.abandonRecord).toHaveBeenCalledWith(expect.objectContaining({ status: "abandoned" }));
  });

  it("refuses to abandon after the workspace import commit exists", async () => {
    const h = harness();
    const preview = await h.service.previewGithub({
      uid: "uid-jack", slug: "jack", gatewayId: "shared-1", owner: "jack", repo: "moof", branch: "main",
      artifacts: artifacts(),
    });
    h.records.set(preview.id, {
      ...h.records.get(preview.id)!,
      status: "failed",
      importCommit: IMPORT_COMMIT,
    });

    await expect(h.service.abandon({ uid: "uid-jack", importId: preview.id }))
      .rejects.toMatchObject({ code: "invalid_import_state" });
    expect(h.deps.deleteStaging).not.toHaveBeenCalled();
  });

  it("refuses to abandon when repository provenance exists before the checkpoint is stored", async () => {
    const h = harness({ hasRepositoryImport: vi.fn(async () => true) });
    const preview = await h.service.previewGithub({
      uid: "uid-jack", slug: "jack", gatewayId: "shared-1", owner: "jack", repo: "moof", branch: "main",
      artifacts: artifacts(),
    });
    h.records.set(preview.id, {
      ...h.records.get(preview.id)!,
      status: "failed",
      error: { code: "checkpoint_failed", message: "checkpoint write failed" },
    });

    await expect(h.service.abandon({ uid: "uid-jack", importId: preview.id }))
      .rejects.toMatchObject({ code: "invalid_import_state" });
    expect(h.deps.hasRepositoryImport).toHaveBeenCalledWith({ targetDir: "/target", importId: preview.id });
    expect(h.deps.deleteStaging).not.toHaveBeenCalled();
    expect(h.deps.deleteImportBlobs).not.toHaveBeenCalled();
  });

  it("rechecks GitHub repository size before the apply clone", async () => {
    const readGithubRepoSize = vi.fn()
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(128 * 1024 + 1);
    const h = harness({ readGithubRepoSize });
    const preview = await h.service.previewGithub({
      uid: "uid-jack", slug: "jack", gatewayId: "shared-1", owner: "jack", repo: "moof", branch: "main",
      artifacts: artifacts(),
    });

    await expect(h.service.apply({
      uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash,
    })).rejects.toMatchObject({ code: "archive_too_large" });
    expect(h.deps.cloneGithubSource).toHaveBeenCalledOnce();
  });

  it("requires a fresh preview when live workspace ownership changes", async () => {
    const h = harness();
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      workspacePolicy: { preserveConvergedContextFiles: false },
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });

    await expect(h.service.apply({
      uid: "uid-jack",
      importId: preview.id,
      approvalHash: preview.approvalHash,
      workspacePolicy: { preserveConvergedContextFiles: true },
    })).rejects.toMatchObject({ code: "workspace_policy_changed" });

    expect(h.records.get(preview.id)).toMatchObject({ status: "previewed" });
    expect(h.deps.applyRepository).not.toHaveBeenCalled();
    expect(h.deps.syncIdentity).not.toHaveBeenCalled();
    expect(h.deps.invokeOpenClaw).not.toHaveBeenCalled();
  });

  it("serializes rollback behind an in-flight apply for the same import", async () => {
    let releaseIdentity!: () => void;
    const identityBlocked = new Promise<void>((resolve) => { releaseIdentity = resolve; });
    const syncIdentity = vi.fn(async () => identityBlocked);
    const h = harness({ syncIdentity });
    const preview = await h.service.previewGithub({
      uid: "uid-jack", slug: "jack", gatewayId: "shared-1", owner: "jack", repo: "moof", branch: "main",
      artifacts: artifacts(),
    });

    const applying = h.service.apply({
      uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash,
    });
    await vi.waitFor(() => expect(syncIdentity).toHaveBeenCalledOnce());
    const rollingBack = h.service.rollback({ uid: "uid-jack", importId: preview.id });
    await Promise.resolve();
    expect(h.deps.rollbackRepository).not.toHaveBeenCalled();

    releaseIdentity();
    await expect(applying).resolves.toMatchObject({ status: "complete" });
    await expect(rollingBack).resolves.toMatchObject({ status: "rolled_back" });
    expect(h.records.get(preview.id)).toMatchObject({ status: "rolled_back" });
  });

  it("treats an empty portable runtime patch as unchanged without warning", async () => {
    const emptyArtifacts = buildAgentImportConfigArtifacts({
      agents: { list: [{ id: "moof", name: "Moof" }] },
    }, "moof");
    const h = harness({
      runDoctor: vi.fn(async () => ({
        outcome: "unchanged" as const,
        doctorVersion: "2026.7.2",
        changedPaths: [],
        diagnostics: [],
        repairedCandidate: emptyArtifacts.doctorCandidate,
      })),
    });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: emptyArtifacts,
    });

    const completed = await h.service.apply({
      uid: "uid-jack",
      importId: preview.id,
      approvalHash: preview.approvalHash,
    });

    expect(completed.configOutcome).toBe("unchanged");
    expect(completed.warnings).not.toContain("config_delta_rejected");
    expect(h.deps.invokeOpenClaw).toHaveBeenCalledTimes(4);
    expect(h.deps.invokeOpenClaw).toHaveBeenNthCalledWith(2, "config.patch", expect.objectContaining({
      raw: JSON.stringify({
        agents: { list: [{ id: "octogee-jack-coach", skipBootstrap: true }] },
      }),
    }));
  });

  it("patches only the agent and verifies redacted siblings and unpatched agent fields", async () => {
    const before = {
      agents: { list: [
        { id: "other", name: "Other", apiKey: "__OPENCLAW_REDACTED__", tools: { profile: "full" } },
        { id: "octogee-jack-coach", name: "Octo", tools: { profile: "safe" }, timeoutSeconds: 600, thinkingDefault: "medium" },
      ] },
    };
    const runtime = openClawRuntimeHarness(before);
    const invokeOpenClaw = runtime.invokeOpenClaw;
    const h = harness({ invokeOpenClaw });
    const preview = await h.service.previewGithub({
      uid: "uid-jack", slug: "jack", gatewayId: "shared-1", owner: "jack", repo: "moof", branch: "main",
      artifacts: artifacts(),
    });

    await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });

    expect(invokeOpenClaw).toHaveBeenNthCalledWith(6, "config.patch", {
      raw: JSON.stringify({
        agents: { list: [{ id: "octogee-jack-coach", timeoutSeconds: 300 }] },
      }),
      baseHash: "config-1",
    });
    expect(runtime.config()).toEqual({
      agents: { list: [
        before.agents.list[0],
        {
          ...before.agents.list[1],
          skipBootstrap: true,
          timeoutSeconds: 300, thinkingDefault: "medium",
        },
      ] },
    });
  });

  // openclaw 2026.7.2 migrates agents.list into keyed agents.entries at pre-boot.
  // A patch that still ships agents.list is at best canonicalized and at worst
  // inert, so the import would report success over a agent it never touched.
  it("patches a migrated keyed roster through agents.entries, preserving the same field content", async () => {
    const before = {
      agents: {
        entries: {
          other: { name: "Other", tools: { profile: "full" } },
          "octogee-jack-coach": {
            name: "Octo",
            tools: { profile: "safe" },
            timeoutSeconds: 600, thinkingDefault: "medium",
          },
        },
      },
    };
    const runtime = openClawRuntimeHarness(before);
    const invokeOpenClaw = runtime.invokeOpenClaw;
    const h = harness({ invokeOpenClaw });
    const preview = await h.service.previewGithub({
      uid: "uid-jack", slug: "jack", gatewayId: "shared-1", owner: "jack", repo: "moof", branch: "main",
      artifacts: artifacts(),
    });

    await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });

    expect(invokeOpenClaw).toHaveBeenNthCalledWith(2, "config.patch", expect.objectContaining({
      raw: JSON.stringify({
        agents: { entries: { "octogee-jack-coach": { skipBootstrap: true } } },
      }),
    }));
    expect(invokeOpenClaw).toHaveBeenNthCalledWith(6, "config.patch", {
      raw: JSON.stringify({
        agents: {
          entries: {
            "octogee-jack-coach": { timeoutSeconds: 300 },
          },
        },
      }),
      baseHash: "config-1",
    });
    expect(runtime.config()).toEqual({
      agents: {
        entries: {
          other: before.agents.entries.other,
          "octogee-jack-coach": {
            ...before.agents.entries["octogee-jack-coach"],
            skipBootstrap: true,
            timeoutSeconds: 300, thinkingDefault: "medium",
          },
        },
      },
    });
  });

  it("fails when the required workspace policy cannot safely patch an id-less sibling", async () => {
    const invokeOpenClaw = vi.fn().mockResolvedValueOnce({
      hash: "before",
      config: { agents: { list: [
        { name: "Legacy", apiKey: "__OPENCLAW_REDACTED__" },
        { id: "octogee-jack-coach", timeoutSeconds: 600 },
      ] } },
    });
    const h = harness({ invokeOpenClaw });
    const preview = await h.service.previewGithub({
      uid: "uid-jack", slug: "jack", gatewayId: "shared-1", owner: "jack", repo: "moof", branch: "main",
      artifacts: artifacts(),
    });

    await expect(h.service.apply({
      uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash,
    })).rejects.toMatchObject({ code: "workspace_runtime_policy_failed" });
    expect(invokeOpenClaw).toHaveBeenCalledTimes(1);
  });
  it("requires the exact preview hash, imports history, updates identity, and patches only the Octogee agent", async () => {
    const h = harness();
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });

    await expect(h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: "wrong" }))
      .rejects.toMatchObject({ code: "approval_mismatch" });
    const completed = await h.service.apply({
      uid: "uid-jack",
      importId: preview.id,
      approvalHash: preview.approvalHash,
    });

    expect(h.deps.applyRepository).toHaveBeenCalledWith(expect.objectContaining({
      sourceHead: SOURCE_HEAD,
      destinationHead: DESTINATION_HEAD,
      importId: "import-1",
      slug: "jack",
    }));
    expect(h.deps.syncIdentity).toHaveBeenCalledWith("uid-jack", {
      name: "Moof",
      persona: "Jack's trusty sidekick.",
      emoji: "🐮",
    });
    const identityCheckpointCall = vi.mocked(h.deps.putRecord).mock.calls.findIndex(([record]) =>
      record.previousIdentity?.name === "Octo"
    );
    expect(vi.mocked(h.deps.putRecord).mock.invocationCallOrder[identityCheckpointCall])
      .toBeLessThan(vi.mocked(h.deps.syncIdentity).mock.invocationCallOrder[0]);
    expect(h.deps.invokeOpenClaw).toHaveBeenNthCalledWith(2, "config.patch", {
      raw: JSON.stringify({
        agents: { list: [{ id: "octogee-jack-coach", skipBootstrap: true }] },
      }),
      baseHash: "config-0",
    });
    expect(h.deps.invokeOpenClaw).toHaveBeenNthCalledWith(6, "config.patch", {
      raw: JSON.stringify({
        agents: { list: [{ id: "octogee-jack-coach", timeoutSeconds: 300 }] },
      }),
      baseHash: "config-1",
    });
    const runtimeCheckpointCall = vi.mocked(h.deps.putRecord).mock.calls.findIndex(([record]) =>
      record.previousRuntime?.timeoutSeconds !== undefined
    );
    expect(vi.mocked(h.deps.putRecord).mock.invocationCallOrder[runtimeCheckpointCall])
      .toBeLessThan(vi.mocked(h.deps.invokeOpenClaw).mock.invocationCallOrder[5]);
    expect(completed).toMatchObject({
      status: "complete",
      importCommit: IMPORT_COMMIT,
      configOutcome: "applied",
    });
    expect(h.deps.deleteStaging).toHaveBeenCalledWith("import-1");
  });

  it("completes on the safe baseline when local config RPC rejects the optional delta", async () => {
    const invokeOpenClaw = vi.fn()
      .mockResolvedValueOnce({
        hash: "config-before",
        config: { agents: { list: [{ id: "octogee-jack-coach", timeoutSeconds: 600 }] } },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        hash: "config-platform",
        config: { agents: { list: [{
          id: "octogee-jack-coach", skipBootstrap: true, timeoutSeconds: 600,
        }] } },
      })
      .mockResolvedValueOnce({ status: "ok" })
      .mockResolvedValueOnce({
        hash: "config-optional-before",
        config: { agents: { list: [{
          id: "octogee-jack-coach", skipBootstrap: true, timeoutSeconds: 600,
        }] } },
      })
      .mockRejectedValueOnce(new Error("config patch rejected"))
      .mockResolvedValueOnce({
        hash: "config-rollback",
        config: { agents: { list: [{
          id: "octogee-jack-coach", skipBootstrap: true,
          timeoutSeconds: 300,
        }] } },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        hash: "config-restored",
        config: { agents: { list: [{
          id: "octogee-jack-coach", skipBootstrap: true, timeoutSeconds: 600,
        }] } },
      })
      .mockResolvedValueOnce({ status: "ok" });
    const h = harness({ invokeOpenClaw });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });
    const completed = await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });

    expect(completed.status).toBe("complete");
    expect(completed.configOutcome).toBe("safe_baseline");
    expect(completed.warnings).toContain("config_delta_rejected");
    expect(invokeOpenClaw).toHaveBeenNthCalledWith(8, "config.patch", expect.objectContaining({
      raw: JSON.stringify({
        agents: { list: [{ id: "octogee-jack-coach", timeoutSeconds: 600 }] },
      }),
    }));
  });

  it("fails instead of claiming a safe baseline when reverse-patch readback is wrong", async () => {
    const invokeOpenClaw = vi.fn()
      .mockResolvedValueOnce({
        hash: "config-before",
        config: { agents: { list: [{ id: "octogee-jack-coach", timeoutSeconds: 600 }] } },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        hash: "config-platform",
        config: { agents: { list: [{
          id: "octogee-jack-coach", skipBootstrap: true, timeoutSeconds: 600,
        }] } },
      })
      .mockResolvedValueOnce({ status: "ok" })
      .mockResolvedValueOnce({
        hash: "config-optional-before",
        config: { agents: { list: [{
          id: "octogee-jack-coach", skipBootstrap: true, timeoutSeconds: 600,
        }] } },
      })
      .mockRejectedValueOnce(new Error("config patch rejected"))
      .mockResolvedValueOnce({
        hash: "config-rollback",
        config: { agents: { list: [{
          id: "octogee-jack-coach", skipBootstrap: true,
          timeoutSeconds: 300,
        }] } },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        hash: "config-still-wrong",
        config: { agents: { list: [{
          id: "octogee-jack-coach", skipBootstrap: true,
          timeoutSeconds: 300,
        }] } },
      });
    const h = harness({ invokeOpenClaw });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });

    await expect(h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash }))
      .rejects.toMatchObject({ code: "config_readback_failed" });
    expect(h.records.get(preview.id)?.status).toBe("failed");
  });

  it("does not overwrite a concurrent agent edit after a rejected config patch", async () => {
    const invokeOpenClaw = vi.fn()
      .mockResolvedValueOnce({
        hash: "before",
        config: { agents: { list: [{ id: "octogee-jack-coach", timeoutSeconds: 600 }] } },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        hash: "platform",
        config: { agents: { list: [{
          id: "octogee-jack-coach", skipBootstrap: true, timeoutSeconds: 600,
        }] } },
      })
      .mockResolvedValueOnce({ status: "ok" })
      .mockResolvedValueOnce({
        hash: "optional-before",
        config: { agents: { list: [{
          id: "octogee-jack-coach", skipBootstrap: true, timeoutSeconds: 600,
        }] } },
      })
      .mockRejectedValueOnce(new Error("base hash mismatch"))
      .mockResolvedValueOnce({
        hash: "concurrent",
        config: { agents: { list: [{
          id: "octogee-jack-coach", skipBootstrap: true, timeoutSeconds: 450,
        }] } },
      });
    const h = harness({ invokeOpenClaw });
    const preview = await h.service.previewGithub({
      uid: "uid-jack", slug: "jack", gatewayId: "shared-1", owner: "jack", repo: "moof", branch: "main",
      artifacts: artifacts(),
    });

    await expect(h.service.apply({
      uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash,
    })).rejects.toMatchObject({ code: "config_changed" });
    expect(invokeOpenClaw).toHaveBeenCalledTimes(7);
  });

  it("resumes from the durable workspace checkpoint after an interrupted apply", async () => {
    const syncIdentity = vi.fn()
      .mockRejectedValueOnce(new Error("Firestore temporarily unavailable"))
      .mockResolvedValue(undefined);
    const h = harness({ syncIdentity });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });
    await expect(h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash }))
      .rejects.toThrow("Firestore temporarily unavailable");

    const completed = await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });
    expect(completed.status).toBe("complete");
    expect(completed.error).toBeUndefined();
    expect(h.deps.applyRepository).toHaveBeenCalledTimes(1);
  });

  it("reconverges a verified import when the process exits before its completion checkpoint", async () => {
    const h = harness();
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });
    const putRecord = h.deps.putRecord;
    h.deps.putRecord = vi.fn(async (record) => {
      if (record.status === "complete" || record.status === "failed") {
        throw new Error("process exited before completion checkpoint");
      }
      await putRecord(record);
    });

    await expect(h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash }))
      .rejects.toThrow("process exited before completion checkpoint");
    expect(h.records.get(preview.id)?.status).toBe("verifying");

    h.deps.putRecord = putRecord;
    h.deps.invokeOpenClaw = openClawRuntimeHarness({
      agents: { list: [{
        id: "octogee-jack-coach",
        skipBootstrap: true,
        timeoutSeconds: 300,
      }] },
    }).invokeOpenClaw;

    const completed = await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });

    expect(completed.status).toBe("complete");
    expect(h.deps.applyRepository).toHaveBeenCalledOnce();
    expect(h.deps.syncIdentity).toHaveBeenCalledTimes(2);
    expect(h.deps.invokeOpenClaw).toHaveBeenCalledWith("health", {});
  });

  it("reconciles an exact prior Git import when its checkpoint write was interrupted", async () => {
    let workspaceHead = DESTINATION_HEAD;
    const applyRepository = vi.fn(async () => {
      workspaceHead = IMPORT_COMMIT;
      return { importCommit: IMPORT_COMMIT, sourceRef: "refs/octogee/imports/import-1/source" };
    });
    const h = harness({
      workspaceState: vi.fn(async () => ({ targetDir: "/target", head: workspaceHead, clean: true })),
      applyRepository,
    });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });
    const putRecord = h.deps.putRecord;
    let interruptCheckpoint = true;
    h.deps.putRecord = vi.fn(async (record) => {
      if (record.importCommit && interruptCheckpoint) {
        interruptCheckpoint = false;
        throw new Error("Firestore checkpoint unavailable");
      }
      await putRecord(record);
    });

    await expect(h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash }))
      .rejects.toThrow("Firestore checkpoint unavailable");
    const completed = await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });

    expect(completed.status).toBe("complete");
    expect(completed.importCommit).toBe(IMPORT_COMMIT);
    expect(applyRepository).toHaveBeenCalledTimes(2);
  });

  it("keeps a completed import complete when staging cleanup must be retried", async () => {
    const h = harness({
      deleteStaging: vi.fn(async () => { throw new Error("GCS cleanup unavailable"); }),
    });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });

    const completed = await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });

    expect(completed.status).toBe("complete");
    expect(completed.warnings).toContain("staging_cleanup_pending");
  });

  it("coalesces concurrent apply requests for the same approved import", async () => {
    let releaseApply!: () => void;
    const applyStarted = new Promise<void>((resolve) => { releaseApply = resolve; });
    let continueApply!: () => void;
    const applyRepository = vi.fn(async () => {
      releaseApply();
      await new Promise<void>((resolve) => { continueApply = resolve; });
      return { importCommit: IMPORT_COMMIT, sourceRef: "refs/octogee/imports/import-1/source" };
    });
    const h = harness({ applyRepository });
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });

    const first = h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });
    await applyStarted;
    const second = h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });
    continueApply();
    const [left, right] = await Promise.all([first, second]);

    expect(left).toEqual(right);
    expect(applyRepository).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent apply requests across request-scoped service instances", async () => {
    let release!: () => void;
    const blocked = new Promise<{ importCommit: string; sourceRef: string }>((resolve) => {
      release = () => resolve({ importCommit: IMPORT_COMMIT, sourceRef: "refs/octogee/imports/import-1/source" });
    });
    const applyRepository = vi.fn(() => blocked);
    const h = harness({ applyRepository });
    const preview = await h.service.previewGithub({
      uid: "uid-jack", slug: "jack", gatewayId: "shared-1", owner: "jack", repo: "moof", branch: "main",
      artifacts: artifacts(),
    });
    const secondService = new TestAgentImportService(h.deps);

    const first = h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });
    while (applyRepository.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = secondService.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });
    expect(applyRepository).toHaveBeenCalledOnce();
    release();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(applyRepository).toHaveBeenCalledOnce();
  });

  it("rolls back the workspace and prior identity without deleting imported history", async () => {
    const h = harness();
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });
    await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });
    const rolledBack = await h.service.rollback({ uid: "uid-jack", importId: preview.id });

    expect(h.deps.rollbackRepository).toHaveBeenCalledWith(expect.objectContaining({
      importCommit: IMPORT_COMMIT,
      destinationHead: DESTINATION_HEAD,
    }));
    expect(h.deps.replaceIdentity).toHaveBeenCalledWith("uid-jack", {
      name: "Octo",
      persona: "Default",
      emoji: "🐙",
    });
    expect(rolledBack.status).toBe("rolled_back");
    expect(h.deps.deleteImportBlobs).toHaveBeenCalledWith("import-1");
  });

  it("removes imported identity fields that were absent before rollback", async () => {
    const replaceIdentity = vi.fn(async () => undefined);
    const h = harness({
      readIdentity: vi.fn(async () => ({ name: "Octo", persona: null, emoji: null })),
      replaceIdentity,
    });
    const preview = await h.service.previewGithub({
      uid: "uid-jack", slug: "jack", gatewayId: "shared-1", owner: "jack", repo: "moof", branch: "main",
      artifacts: artifacts(),
    });
    await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });

    const rolledBack = await h.service.rollback({ uid: "uid-jack", importId: preview.id });

    expect(replaceIdentity).toHaveBeenCalledWith("uid-jack", {
      name: "Octo",
      persona: null,
      emoji: null,
    });
    const rolledBackCheckpoint = vi.mocked(h.deps.putRecord).mock.calls.findIndex(([record]) =>
      record.status === "rolled_back"
    );
    expect(replaceIdentity.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(h.deps.putRecord).mock.invocationCallOrder[rolledBackCheckpoint]);
    expect(rolledBack.status).toBe("rolled_back");
  });

  it("rolls back a partial apply after the workspace commit and identity checkpoint", async () => {
    const replaceIdentity = vi.fn(async () => undefined);
    const h = harness({
      syncIdentity: vi.fn(async () => { throw new Error("identity write permanently failed"); }),
      readIdentity: vi.fn(async () => ({ name: "Octo", persona: null, emoji: null })),
      replaceIdentity,
    });
    const preview = await h.service.previewGithub({
      uid: "uid-jack", slug: "jack", gatewayId: "shared-1", owner: "jack", repo: "moof", branch: "main",
      artifacts: artifacts(),
    });

    await expect(h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash }))
      .rejects.toThrow("identity write permanently failed");
    expect(h.records.get(preview.id)).toMatchObject({
      status: "failed",
      importCommit: IMPORT_COMMIT,
      completedAt: null,
      previousIdentity: { name: "Octo", persona: null, emoji: null },
    });

    await expect(h.service.rollback({ uid: "uid-jack", importId: preview.id }))
      .resolves.toMatchObject({ status: "rolled_back" });
    expect(h.deps.rollbackRepository).toHaveBeenCalledOnce();
    expect(replaceIdentity).toHaveBeenCalledWith("uid-jack", {
      name: "Octo", persona: null, emoji: null,
    });
  });

  it("rolls back an interrupted identity checkpoint before failure status was persisted", async () => {
    const h = harness();
    const preview = await h.service.previewGithub({
      uid: "uid-jack", slug: "jack", gatewayId: "shared-1", owner: "jack", repo: "moof", branch: "main",
      artifacts: artifacts(),
    });
    h.records.set(preview.id, {
      ...h.records.get(preview.id)!, status: "identity", importCommit: IMPORT_COMMIT,
    });

    await expect(h.service.rollback({ uid: "uid-jack", importId: preview.id }))
      .resolves.toMatchObject({ status: "rolled_back" });
    expect(h.deps.rollbackRepository).toHaveBeenCalledOnce();
  });

  it("resumes rollback after Git succeeded but its checkpoint write was interrupted", async () => {
    const h = harness();
    const preview = await h.service.previewGithub({
      uid: "uid-jack",
      slug: "jack",
      gatewayId: "shared-1",
      owner: "jack",
      repo: "moof",
      branch: "main",
      artifacts: artifacts(),
    });
    await h.service.apply({ uid: "uid-jack", importId: preview.id, approvalHash: preview.approvalHash });
    const putRecord = h.deps.putRecord;
    let interruptCheckpoint = true;
    h.deps.putRecord = vi.fn(async (record) => {
      if (record.rollbackCommit && interruptCheckpoint) {
        interruptCheckpoint = false;
        throw new Error("rollback checkpoint unavailable");
      }
      await putRecord(record);
    });

    await expect(h.service.rollback({ uid: "uid-jack", importId: preview.id }))
      .rejects.toThrow("rollback checkpoint unavailable");
    const rolledBack = await h.service.rollback({ uid: "uid-jack", importId: preview.id });

    expect(rolledBack.status).toBe("rolled_back");
    expect(h.deps.rollbackRepository).toHaveBeenCalledTimes(2);
  });
});
