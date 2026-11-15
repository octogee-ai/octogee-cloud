import { describe, expect, it } from "vitest";
import {
  configuredUserManagedProjectIds,
  configuredUserOwnerAuthorityPatch,
  configuredUserProjectAgentPatch,
  configuredUserWorkspacePatch,
} from "../lib/configured-user-project-agents.js";
import { mattermostAccountSecretRef } from "../lib/mattermost-account-secrets.js";
import { buildUserBindings, buildProjectAgentAccounts, buildProjectAgents } from "../lib/openclaw-config-users.js";

const slug = "alice";
const projectId = "launch";
const agentId = "octogee-alice-proj-launch-coach";
const ownerMmUserId = "a".repeat(26);
const projectAgents = [{ projectId, enabled: true, mmUserId: "b".repeat(26), token: "project-pat" }];
const channels = [
  { channelId: "workspace-channel", scope: "workspace" as const },
  { channelId: "launch-channel", scope: "project" as const, projectId },
  { channelId: "retired-channel", scope: "project" as const, projectId: "retired" },
];
const desired = {
  slug,
  managedProjectIds: [projectId, "retired"],
  activationProjectIds: [projectId],
  projectAgentEntries: buildProjectAgents({
    slug,
    customerDir: "/customers/alice",
    agentsDir: "/agents",
    defaultAgent: { name: "Coach", emoji: "🐙", model: "seed-model" },
    projectAgents,
    hostCode: "builder-full",
  }),
  projectAccounts: buildProjectAgentAccounts(slug, projectAgents, ownerMmUserId),
  channels,
  ownerMmUserId,
};
const customDefaultAgent = { id: "octogee-alice-coach", workspace: "/owner/workspace", model: "owner-model", tools: { allow: ["custom-tool"] } };
const importedProject = { id: "octogee-alice-proj-imported-coach", workspace: "/owner/imported-project", model: "owner-import-model" };
const retiredProject = { id: "octogee-alice-proj-retired-coach", workspace: "/customers/alice/projects/retired" };
const existingBindings = [
  ...buildUserBindings([{ slug, channels, agentProjects: new Set(["retired", "imported"]) }]),
  { agentId: importedProject.id, match: { channel: "mattermost", accountId: "alice-proj-imported", peer: { kind: "group", id: "imported-channel" } } },
  { agentId: "personal", match: { channel: "telegram", peer: { kind: "direct", id: "owner" } } },
];

function currentConfig(representation: "list" | "entries", extraAgents: Record<string, unknown>[] = []) {
  const roster = [customDefaultAgent, importedProject, retiredProject, ...extraAgents];
  return {
    agents: {
      defaults: { workspace: "/owner/default", model: "custom-default" },
      ...(representation === "list" ? { list: roster } : { entries: Object.fromEntries(roster.map(({ id, ...entry }) => [id, entry])) }),
    },
    tools: { allow: ["owner-tool"] },
    commands: { ownerAllowFrom: [`mattermost:${ownerMmUserId}`] },
    bindings: existingBindings,
    channels: { mattermost: { accounts: {
      "alice-coach": { allowFrom: ["owner"], custom: { list: ["coach-preference"] } },
      "alice-proj-retired": { allowFrom: ["old-owner"], groups: ["retired-channel"] },
      "alice-proj-imported": { allowFrom: ["custom-owner"], custom: { list: ["imported-preference"] } },
      "bob-proj-launch": { allowFrom: ["bob"] },
    } } },
  };
}

describe("configuredUserWorkspacePatch", () => {
  it("adds only missing workspace peers, preserves custom routing and stops patching after convergence", () => {
    const current = currentConfig("entries");
    const task = { channelId: "task-channel", scope: "workspace" as const, kind: "session" };
    const admin = { channelId: "admin-channel", scope: "workspace" as const, kind: "admin" };
    const patch = configuredUserWorkspacePatch(current, slug, ownerMmUserId, [...channels, task, admin]);
    expect(patch).toEqual({ bindings: [...existingBindings, {
      agentId: "octogee-alice-coach",
      match: { channel: "mattermost", accountId: "alice-coach", peer: { kind: "group", id: "task-channel" } },
    }] });
    expect(configuredUserWorkspacePatch({ ...current, ...patch }, slug, ownerMmUserId, [...channels, task, admin])).toEqual({});
  });
});

describe("configuredUserProjectAgentPatch", () => {
  it.each(["list", "entries"] as const)("moves the managed agent without changing the owner sandbox or model (%s)", representation => {
    const old = { ...desired.projectAgentEntries[0], cwd: "/customers/alice/projects/launch", sandbox: { mode: "all" }, model: "custom" };
    const current = currentConfig(representation, [old]);
    const privateWorkspace = "/customers/alice/.system/project-coaches/launch";
    const patch = configuredUserProjectAgentPatch(current, { ...desired, activationProjectIds: [],
      projectAgentEntries: [{ ...desired.projectAgentEntries[0], workspace: privateWorkspace }] }).patch.agents;
    const entry = "entries" in patch ? patch.entries[agentId] : patch.list.find((entry: any) => entry.id === agentId);
    expect(entry).toMatchObject({ workspace: privateWorkspace, sandbox: { mode: "all" }, model: "custom" });
    expect((entry as Record<string, unknown>).cwd).toBe(representation === "entries" ? null : undefined);
  });

  it.each(["list", "entries"] as const)("binds new sessions of a ready project without replacing its account or existing routes (%s)", (representation) => {
    const current = currentConfig(representation, desired.projectAgentEntries);
    const customAccount = { baseUrl: "https://builder-mattermost.example", botToken: "owner-managed-token", allowFrom: ["custom-owner"], groupPolicy: "allowlist" };
    current.channels.mattermost.accounts = { ...current.channels.mattermost.accounts, "alice-proj-launch": customAccount };
    const projectRoutes = buildUserBindings([{ slug, channels, agentProjects: new Set([projectId]) }]).filter(binding => binding.agentId === agentId);
    current.bindings = [...current.bindings, ...projectRoutes];
    const session = { channelId: "project-session", scope: "project" as const, projectId, kind: "session" };
    const input = { ...desired, activationProjectIds: [], channels: [...channels, session] };
    const before = structuredClone(current);
    const first = configuredUserProjectAgentPatch(current, input).patch;
    const expected = { agentId, match: { channel: "mattermost", accountId: "alice-proj-launch", peer: { kind: "group", id: "project-session" } } };

    expect(current).toEqual(before);
    expect(first.bindings).toContainEqual(expected);
    for (const route of projectRoutes) expect(first.bindings).toContainEqual(route);
    expect(first.channels.mattermost.accounts["alice-proj-launch"]).toEqual(customAccount);
    const second = configuredUserProjectAgentPatch({ ...current, bindings: first.bindings }, input).patch;
    expect(second.bindings).toBe(first.bindings);
    expect(second.bindings.filter(binding => JSON.stringify(binding) === JSON.stringify(expected))).toHaveLength(1);
  });

  it("preserves a ready project's custom session route while adding only its missing peers", () => {
    const custom = { agentId: "owner-agent", match: { channel: "mattermost", accountId: "alice-proj-launch", peer: { kind: "group", id: "custom-session" } } };
    const current = currentConfig("entries", desired.projectAgentEntries);
    current.channels.mattermost.accounts = { ...current.channels.mattermost.accounts, ...desired.projectAccounts };
    current.bindings = [custom];
    const input = { ...desired, activationProjectIds: [], channels: [
      { channelId: "custom-session", scope: "project" as const, projectId, kind: "session" },
      { channelId: "missing-session", scope: "project" as const, projectId, kind: "session" },
    ] };
    const { patch } = configuredUserProjectAgentPatch(current, input);

    expect(patch.bindings).toEqual([custom, { agentId, match: { channel: "mattermost", accountId: "alice-proj-launch", peer: { kind: "group", id: "missing-session" } } }]);
    expect(patch.bindings).not.toContainEqual({ agentId, match: { channel: "mattermost", accountId: "alice-proj-launch" } });
  });

  it.each(["list", "entries"] as const)("keeps a custom direct peer without suppressing the same ID's project group route (%s)", (representation) => {
    const custom = { agentId: "owner-agent", match: { channel: "mattermost", accountId: "alice-proj-launch", peer: { kind: "direct", id: "project-session" } } };
    const current = currentConfig(representation, desired.projectAgentEntries);
    current.channels.mattermost.accounts = { ...current.channels.mattermost.accounts, ...desired.projectAccounts };
    current.bindings = [custom];
    const input = { ...desired, activationProjectIds: [], channels: [
      { channelId: "project-session", scope: "project" as const, projectId, kind: "session" },
    ] };
    const expected = { agentId, match: { channel: "mattermost", accountId: "alice-proj-launch", peer: { kind: "group", id: "project-session" } } };
    const first = configuredUserProjectAgentPatch(current, input).patch;

    expect(first.bindings).toEqual([custom, expected]);
    const second = configuredUserProjectAgentPatch({ ...current, bindings: first.bindings }, input).patch;
    expect(second.bindings).toBe(first.bindings);
    expect(second.bindings.filter(binding => JSON.stringify(binding) === JSON.stringify(expected))).toHaveLength(1);
  });

  it("removes agent project bindings even when no project activation is pending", () => {
    const current = currentConfig("entries", desired.projectAgentEntries);
    current.channels.mattermost.accounts = { ...current.channels.mattermost.accounts, ...desired.projectAccounts };
    const stale = { agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach", peer: { kind: "group", id: "launch-channel" } } };
    current.bindings = [...current.bindings, stale];
    const result = configuredUserProjectAgentPatch(current, { ...desired, activationProjectIds: [] });
    expect(result.patch.bindings).not.toContainEqual(stale);
    expect(result.patch.bindings).toContainEqual(existingBindings.find(binding => binding.match.peer?.id === "workspace-channel"));
  });

  it("retires a deleted platform project while preserving imported and customized accounts", () => {
    const config = currentConfig("entries");
    const accounts = {
      ...config.channels.mattermost.accounts,
      "alice-proj-retired": { botToken: mattermostAccountSecretRef("alice-proj-retired"), allowFrom: ["owner"] },
      "alice-proj-imported": { botToken: "owner-managed-token", allowFrom: ["owner"] },
      "alice-proj-customref": { botToken: { source: "file", provider: "owner", id: "/alice-proj-customref" } },
      "bob-proj-launch": { botToken: mattermostAccountSecretRef("bob-proj-launch") },
    };
    const current = { ...config, channels: { mattermost: { accounts } } };
    const managedProjectIds = configuredUserManagedProjectIds(current, slug, []);
    expect(managedProjectIds).toEqual(["retired"]);
    const result = configuredUserProjectAgentPatch(current, {
      slug, managedProjectIds, activationProjectIds: [], projectAgentEntries: [], projectAccounts: {}, channels: [], ownerMmUserId,
    });
    expect(result.retiredAgentIds).toEqual([retiredProject.id]);
    expect(result.patch.channels.mattermost.accounts).toEqual({ "alice-proj-retired": null });
    expect(result.patch.bindings.some((binding: { agentId: string }) => binding.agentId === retiredProject.id)).toBe(false);
    expect(result.patch.bindings).toContainEqual(existingBindings.find((binding) => binding.match.peer?.id === "imported-channel"));
  });

  it("discovers only valid project IDs with the exact platform account secret reference", () => {
    const accounts = Object.fromEntries([
      ["alice-proj-valid", mattermostAccountSecretRef("alice-proj-valid")],
      ["alice-proj-bad-id", mattermostAccountSecretRef("alice-proj-bad-id")],
      [`alice-proj-${"x".repeat(17)}`, mattermostAccountSecretRef(`alice-proj-${"x".repeat(17)}`)],
      ["alice-proj-wrong", mattermostAccountSecretRef("alice-proj-another")],
      ["alice-proj-extra", { ...mattermostAccountSecretRef("alice-proj-extra"), custom: true }],
      ["alice-proj-exec", { ...mattermostAccountSecretRef("alice-proj-exec"), source: "exec" }],
      ["alice-coach", mattermostAccountSecretRef("alice-coach")],
    ].map(([id, botToken]) => [id, { botToken }]));
    expect(configuredUserManagedProjectIds({ channels: { mattermost: { accounts } } }, slug, ["launch", "valid"])).toEqual(["launch", "valid"]);
  });

  it.each(["list", "entries"] as const)("adds a project account and routing while retaining customized user config (%s)", (representation) => {
    const current = currentConfig(representation);
    const before = structuredClone(current);
    const { patch, replacePaths, retiredAgentIds } = configuredUserProjectAgentPatch(current, desired);

    expect(current).toEqual(before);
    expect(Object.keys(patch).sort()).toEqual(["agents", "bindings", "channels"]);
    expect(patch.agents).not.toHaveProperty("defaults");
    if (representation === "entries") {
      expect(Object.keys(patch.agents.entries)).toEqual([agentId]);
      expect(patch.agents.entries[agentId]).toMatchObject({ workspace: "/customers/alice/projects/launch", model: "seed-model" });
    } else {
      expect(patch.agents.list).toContainEqual(customDefaultAgent);
      expect(patch.agents.list).toContainEqual(importedProject);
      expect(patch.agents.list).toContainEqual(desired.projectAgentEntries[0]);
    }
    expect(patch.channels).toEqual({ mattermost: { accounts: {
      ...desired.projectAccounts,
      "alice-proj-retired": null,
    } } });
    expect(patch.bindings).toContainEqual({ agentId, match: { channel: "mattermost", accountId: "alice-proj-launch" } });
    expect(patch.bindings).toContainEqual({ agentId, match: { channel: "mattermost", accountId: "alice-proj-launch", peer: { kind: "group", id: "launch-channel" } } });
    expect(patch.bindings).toContainEqual(existingBindings.at(-1));
    expect(patch.bindings).toContainEqual(existingBindings.find((binding) => binding.match.peer?.id === "workspace-channel"));
    expect(patch.bindings).toContainEqual(existingBindings.find((binding) => binding.match.peer?.id === "imported-channel"));
    expect(patch.bindings).not.toContainEqual(existingBindings.find((binding) => binding.match.peer?.id === "launch-channel"));
    expect(patch.bindings.some((binding: { match: { peer?: { id: string } } }) => binding.match.peer?.id === "retired-channel")).toBe(false);
    expect(retiredAgentIds).toEqual([retiredProject.id]);
    expect(replacePaths).toEqual(["bindings", "channels.mattermost.accounts.alice-proj-retired.allowFrom", "channels.mattermost.accounts.alice-proj-retired.groups"]);
  });

  it.each(["list", "entries"] as const)("keeps owner changes to existing project agents when reconciling credentials (%s)", (representation) => {
    const customized = { id: agentId, workspace: "/owner/project", model: { primary: "custom-project", fallbacks: ["backup"] }, identity: { name: "Custom" }, tools: { allow: ["owner-tool"] } };
    const { patch } = configuredUserProjectAgentPatch(currentConfig(representation, [customized]), desired);
    const entry = representation === "entries" ? { ...patch.agents.entries[agentId], id: agentId } : patch.agents.list.find((agent: { id: string }) => agent.id === agentId);
    expect(entry).toEqual({ ...desired.projectAgentEntries[0], ...customized, name: desired.projectAgentEntries[0].name, identity: desired.projectAgentEntries[0].identity });
  });

  it("leaves projects without an active agent unbound instead of restoring a agent fallback", () => {
    const current = currentConfig("entries");
    const { patch, retiredAgentIds } = configuredUserProjectAgentPatch(current, {
      ...desired,
      projectAgentEntries: [],
      projectAccounts: {},
    });
    expect(patch.agents).toEqual({ entries: {} });
    expect(patch.channels.mattermost.accounts).toEqual({ "alice-proj-launch": null, "alice-proj-retired": null });
    expect(patch.bindings.some((binding: { match: { peer?: { id: string } } }) => ["launch-channel", "retired-channel"].includes(binding.match.peer?.id ?? ""))).toBe(false);
    expect(retiredAgentIds).toEqual([retiredProject.id]);
  });

  it("binds the workspace agent to a Task channel created after the user overlay was configured", () => {
    const task = { channelId: "task-channel", scope: "workspace" as const, kind: "session" };
    const current = currentConfig("entries", desired.projectAgentEntries);
    current.channels.mattermost.accounts = { ...current.channels.mattermost.accounts, ...desired.projectAccounts };
    const { patch } = configuredUserProjectAgentPatch(current, { ...desired, activationProjectIds: [], channels: [...channels, task] });
    expect(patch.bindings).toContainEqual({
      agentId: "octogee-alice-coach",
      match: { channel: "mattermost", accountId: "alice-coach", peer: { kind: "group", id: "task-channel" } },
    });
    expect(patch.bindings.filter((binding: { match: { peer?: { id: string } } }) => binding.match.peer?.id === "workspace-channel")).toHaveLength(1);
  });

  it("leaves an owner-customized route for a workspace channel alone", () => {
    const custom = { agentId: "owner-agent", match: { channel: "mattermost", accountId: "alice-coach", peer: { kind: "group", id: "workspace-channel" } } };
    const current = { ...currentConfig("entries"), bindings: [custom] };
    const { patch } = configuredUserProjectAgentPatch(current, { ...desired, projectAgentEntries: [], projectAccounts: {} });
    expect(patch.bindings.filter((binding: { match: { peer?: { id: string } } }) => binding.match.peer?.id === "workspace-channel")).toEqual([custom]);
  });

  it("never binds the workspace agent to the admin channel or to a project channel without an active agent", () => {
    const admin = { channelId: "admin-channel", scope: "workspace" as const, kind: "admin" };
    const { patch } = configuredUserProjectAgentPatch(currentConfig("entries"), {
      ...desired, projectAgentEntries: [], projectAccounts: {}, channels: [...channels, admin],
    });
    const defaultAgentPeers = patch.bindings
      .filter((binding: { agentId: string; match: { peer?: { id: string } } }) => binding.agentId === "octogee-alice-coach" && binding.match.peer)
      .map((binding: { match: { peer?: { id: string } } }) => binding.match.peer?.id);
    expect(defaultAgentPeers).toEqual(["workspace-channel"]);
  });

  it("retains binding order when desired project routes are already present", () => {
    const first = configuredUserProjectAgentPatch(currentConfig("entries"), desired);
    const current = { ...currentConfig("entries"), bindings: [...first.patch.bindings].reverse() };
    expect(configuredUserProjectAgentPatch(current, desired).patch.bindings).toEqual(current.bindings);
  });

  it("preserves already-ready project credentials and routing customized by the owner", () => {
    const customized = { id: agentId, workspace: "/owner/project", model: "owner-model" };
    const customAccount = { baseUrl: "https://builder-mattermost.example", botToken: "owner-managed-token", allowFrom: ["custom-owner"], groupPolicy: "allowlist" };
    const customBinding = { agentId: "owner-agent", match: { channel: "mattermost", accountId: "alice-proj-launch", peer: { kind: "group", id: "launch-channel" } } };
    const current = currentConfig("entries", [customized]);
    const config = {
      ...current,
      bindings: [customBinding],
      channels: { mattermost: { accounts: { ...current.channels.mattermost.accounts, "alice-proj-launch": customAccount } } },
    };
    const ready = configuredUserProjectAgentPatch(config, { ...desired, activationProjectIds: [] }).patch;
    expect(ready.agents.entries[agentId]).toEqual({ workspace: "/owner/project", model: "owner-model", name: desired.projectAgentEntries[0].name, identity: desired.projectAgentEntries[0].identity });
    expect(ready.channels.mattermost.accounts["alice-proj-launch"]).toEqual(customAccount);
    expect(ready.bindings.filter((binding: { match: { peer?: { id: string } } }) => binding.match.peer?.id === "launch-channel")).toEqual([customBinding]);
    expect(ready.bindings.some((binding: { agentId: string }) => binding.agentId === agentId)).toBe(false);

    const activating = configuredUserProjectAgentPatch(config, desired).patch;
    expect(activating.channels.mattermost.accounts["alice-proj-launch"]).toEqual({
      ...desired.projectAccounts["alice-proj-launch"],
      ...customAccount,
      botToken: desired.projectAccounts["alice-proj-launch"].botToken,
    });
    expect(activating.bindings).not.toContainEqual(customBinding);
    expect(activating.bindings).toContainEqual({ agentId, match: { channel: "mattermost", accountId: "alice-proj-launch" } });
  });

  it("restores the user's owner, command and approval authority on a configured user that lost it", () => {
    const current = currentConfig("entries", desired.projectAgentEntries);
    const { allowFrom: _defaultAgentOwner, ...defaultAgentWithoutOwner } = current.channels.mattermost.accounts["alice-coach"];
    const { allowFrom: _projectOwner, ...projectWithoutOwner } = desired.projectAccounts["alice-proj-launch"];
    current.channels.mattermost.accounts = {
      ...current.channels.mattermost.accounts,
      "alice-coach": defaultAgentWithoutOwner,
      "alice-proj-launch": projectWithoutOwner,
    };

    const { commands: _commands, ...withoutOwner } = current;

    const { patch } = configuredUserProjectAgentPatch(withoutOwner, { ...desired, activationProjectIds: [] });

    expect(patch.commands).toEqual({ ownerAllowFrom: [`mattermost:${ownerMmUserId}`] });
    expect(patch.channels.mattermost.accounts["alice-coach"]).toEqual({ allowFrom: [ownerMmUserId] });
    expect(patch.channels.mattermost.accounts["alice-proj-launch"]).toEqual({ ...projectWithoutOwner, allowFrom: [ownerMmUserId] });
  });

  it("makes the user the native OpenClaw owner and agent approver only where that authority is missing", () => {
    const defaultAgent = { botToken: mattermostAccountSecretRef("alice-coach"), groupPolicy: "open" };
    const config = (account?: Record<string, unknown>, commands?: Record<string, unknown>) => ({
      ...(commands ? { commands } : {}),
      channels: { mattermost: { accounts: account ? { "alice-coach": account } : {} } },
    });

    expect(configuredUserOwnerAuthorityPatch(config(defaultAgent), slug, ownerMmUserId)).toEqual({
      commands: { ownerAllowFrom: [`mattermost:${ownerMmUserId}`] },
      channels: { mattermost: { accounts: { "alice-coach": { allowFrom: [ownerMmUserId] } } } },
    });
    expect(configuredUserOwnerAuthorityPatch(
      config({ ...defaultAgent, allowFrom: ["b".repeat(26)] }, { ownerAllowFrom: ["mattermost:" + "b".repeat(26)] }),
      slug,
      ownerMmUserId,
    )).toEqual({});
    expect(configuredUserOwnerAuthorityPatch(config(undefined, { ownerAllowFrom: [] }), slug, ownerMmUserId)).toEqual({});
    expect(() => configuredUserOwnerAuthorityPatch(config(defaultAgent), slug, null)).toThrow("owner Mattermost id");
  });

  it("rejects account or agent entries that are outside the authoritative project snapshot", () => {
    expect(() => configuredUserProjectAgentPatch(currentConfig("entries"), { ...desired, projectAccounts: { ...desired.projectAccounts, "alice-proj-imported": {} } })).toThrow("unmanaged project account");
    expect(() => configuredUserProjectAgentPatch(currentConfig("entries"), { ...desired, projectAgentEntries: [...desired.projectAgentEntries, importedProject] })).toThrow("unmanaged project agent");
    expect(() => configuredUserProjectAgentPatch(currentConfig("entries"), { ...desired, projectAccounts: {} })).toThrow("project agent account is missing");
    expect(() => configuredUserProjectAgentPatch(currentConfig("entries"), { ...desired, activationProjectIds: ["imported"] })).toThrow("unmanaged project activation");
  });
});
