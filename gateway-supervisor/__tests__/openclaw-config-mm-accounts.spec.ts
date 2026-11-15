import { describe, it, expect, vi } from "vitest";
import {
  activeAgentProjectIds,
  buildUserAgent,
  buildMattermostAccounts,
  buildUserBindings,
  buildProjectAgentAccounts,
  buildProjectAgents,
  gatewayAgentRoster,
  gatewayAgentRosterUserSlug,
  mattermostAccountBindingsNeedActivation,
  mattermostAccountBindingsNeedingActivation,
  PRODUCTIVITY_TOOL_NAMES,
  PROJECT_AGENT_ALLOWED_TOOLS,
  PROJECT_AGENT_DENIED_TOOLS,
  SAFE_DEFAULT_AGENT_ID,
} from "../lib/openclaw-config-users.js";

const CHRIS_MM_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const SAM_MM_ID = "cccccccccccccccccccccccccc";
const PAT_MM_ID = "dddddddddddddddddddddddddd";

describe("buildUserAgent", () => {
  it("marks the isolated gateway user agent as OpenClaw's explicit default", () => {
    expect(buildUserAgent({
      uid: "uid-chris",
      slug: "chris",
      customerDir: "/customers/chris",
      agentDir: "/agents/octogee-chris-coach/agent",
      defaultAgent: { name: "Coach", emoji: "🤖", model: "house" },
      default: true,
    })).toMatchObject({ id: "octogee-chris-coach", default: true });
  });

  it("does not claim default routing for a shared-gateway user", () => {
    expect(buildUserAgent({
      uid: "uid-sam",
      slug: "sam",
      customerDir: "/customers/sam",
      agentDir: "/agents/octogee-sam-coach/agent",
      defaultAgent: { name: "Coach", emoji: "🤖", model: "house" },
    })).not.toHaveProperty("default");
  });

  it("keeps productivity tools catalog-visible for the workspace agent", () => {
    const agent = buildUserAgent({
      uid: "uid-chris",
      slug: "chris",
      customerDir: "/customers/chris",
      agentDir: "/agents/octogee-chris-coach/agent",
      defaultAgent: { name: "Coach", emoji: "🤖", model: "house" },
      customerMmUserId: CHRIS_MM_ID,
    });

    expect(agent.tools).toMatchObject({ toolsBySender: {} });
    expect((agent.tools as { alsoAllow: string[] }).alsoAllow).toEqual(
      expect.arrayContaining(PRODUCTIVITY_TOOL_NAMES),
    );
  });

  it("allows workspace and project-scoped commits for the workspace agent", () => {
    const agent = buildUserAgent({
      uid: "uid-chris",
      slug: "chris",
      customerDir: "/customers/chris",
      agentDir: "/agents/octogee-chris-coach/agent",
      defaultAgent: { name: "Coach", emoji: "🤖", model: "house" },
    });

    expect((agent.tools as { alsoAllow: string[] }).alsoAllow).toEqual(
      expect.arrayContaining(["workspace_commit", "octogee_project_commit"]),
    );
  });

  it("gives project agents native directory listing without custom search or direct terminal access", () => {
    expect(PROJECT_AGENT_ALLOWED_TOOLS).toEqual(
      expect.arrayContaining(["read", "ls"]),
    );
    expect(PROJECT_AGENT_ALLOWED_TOOLS).not.toContain("grep");
    expect(PROJECT_AGENT_ALLOWED_TOOLS).not.toContain("find");
    expect(PROJECT_AGENT_DENIED_TOOLS).toEqual(expect.arrayContaining(["exec", "process"]));
  });

  it("lets a project agent reach the Ops Agent on its own lane", () => {
    expect(PROJECT_AGENT_ALLOWED_TOOLS).toContain("octogee_ask_ops");
    expect(PROJECT_AGENT_DENIED_TOOLS).not.toContain("octogee_ask_ops");
  });

  it("exposes capability and isolated runs only through user project lanes", () => {
    const defaultAgent = buildUserAgent({
      uid: "uid-chris",
      slug: "chris",
      customerDir: "/customers/chris",
      agentDir: "/agents/octogee-chris-coach/agent",
      defaultAgent: { name: "Coach", emoji: "🤖", model: "house" },
    });
    const runTools = ["octogee_project_capability", "octogee_project_build", "octogee_project_test", "octogee_project_preview", "octogee_project_run_status"];
    expect((defaultAgent.tools as { alsoAllow: string[] }).alsoAllow).toEqual(expect.arrayContaining(runTools));
    expect(PROJECT_AGENT_ALLOWED_TOOLS).toEqual(expect.arrayContaining(runTools));
    expect(PROJECT_AGENT_DENIED_TOOLS).not.toEqual(expect.arrayContaining(runTools));
  });

  it("keeps recipe and Board workflows available to agents and project-locked agents", () => {
    const defaultAgent = buildUserAgent({
      uid: "uid-chris",
      slug: "chris",
      customerDir: "/customers/chris",
      agentDir: "/agents/octogee-chris-coach/agent",
      defaultAgent: { name: "Coach", emoji: "🤖", model: "house" },
    });
    const projectTools = [
      "octogee_project_set_recipe",
      "octogee_board_list",
      "octogee_board_card_read",
      "octogee_board_card_create",
      "octogee_board_card_update",
      "octogee_board_card_move",
      "octogee_board_card_comment",
    ];
    expect((defaultAgent.tools as { alsoAllow: string[] }).alsoAllow).toEqual(expect.arrayContaining(projectTools));
    expect(PROJECT_AGENT_ALLOWED_TOOLS).toEqual(expect.arrayContaining(projectTools));
    expect(PROJECT_AGENT_DENIED_TOOLS).not.toEqual(expect.arrayContaining(projectTools));
  });

  it("exposes publish only to the Workspace Agent", () => {
    const defaultAgent = buildUserAgent({
      uid: "uid-chris",
      slug: "chris",
      customerDir: "/customers/chris",
      agentDir: "/agents/octogee-chris-coach/agent",
      defaultAgent: { name: "Coach", emoji: "🤖", model: "house" },
    });
    expect((defaultAgent.tools as { alsoAllow: string[] }).alsoAllow).toContain("octogee_project_publish");
    expect(PROJECT_AGENT_ALLOWED_TOOLS).not.toContain("octogee_project_publish");
    expect(PROJECT_AGENT_DENIED_TOOLS).toContain("octogee_project_publish");
  });

  it("retires every in-gateway preview and publish tool", () => {
    const defaultAgent = buildUserAgent({
      uid: "uid-chris",
      slug: "chris",
      customerDir: "/customers/chris",
      agentDir: "/agents/octogee-chris-coach/agent",
      defaultAgent: { name: "Coach", emoji: "🤖", model: "house" },
    });
    const tools = defaultAgent.tools as { alsoAllow: string[]; deny: string[] };
    const retired = ["preview_start", "preview_stop", "preview_list", "octogee_publish"];
    expect(tools.alsoAllow).not.toEqual(expect.arrayContaining(retired));
    expect(tools.deny).toEqual(expect.arrayContaining(retired));
    expect(PROJECT_AGENT_DENIED_TOOLS).toEqual(expect.arrayContaining(retired));
  });

  it("keeps tool visibility independent of the inbound sender projection", () => {
    for (const customerMmUserId of [undefined, "mm-chris", "A".repeat(26)]) {
      const agent = buildUserAgent({
        uid: "uid-chris",
        slug: "chris",
        customerDir: "/customers/chris",
        agentDir: "/agents/octogee-chris-coach/agent",
        defaultAgent: { name: "Coach", emoji: "🤖", model: "house" },
        customerMmUserId,
      });
      expect(agent.tools).toMatchObject({ toolsBySender: {} });
      expect((agent.tools as { toolsBySender: Record<string, unknown> }).toolsBySender)
        .toEqual({});
    }
  });
});

describe("gatewayAgentRoster", () => {
  it("uses a non-user sentinel without a legacy default marker on a shared gateway", () => {
    const roster = gatewayAgentRoster([
      { id: "octogee-mike-coach", default: true },
      { id: "octogee-ceckert-coach" },
    ], "");

    expect(roster[0]).toMatchObject({
      id: SAFE_DEFAULT_AGENT_ID,
    });
    expect(roster[0]).not.toHaveProperty("default");
    expect(roster[0]).not.toHaveProperty("heartbeat");
    expect(roster.slice(1)).toEqual([
      { id: "octogee-mike-coach" },
      { id: "octogee-ceckert-coach" },
    ]);
  });

  it("keeps a dedicated gateway free of legacy default markers", () => {
    expect(gatewayAgentRoster([
      { id: "octogee-mike-coach" },
      { id: "octogee-ceckert-coach" },
    ], "ceckert")).toEqual([
      { id: "octogee-mike-coach" },
      { id: "octogee-ceckert-coach" },
    ]);
  });

  it("strips retired default markers end to end", () => {
    expect(gatewayAgentRoster(
      [
        { id: "octogee-ops", default: true },
        { id: SAFE_DEFAULT_AGENT_ID, default: true },
      ],
      gatewayAgentRosterUserSlug({ GATEWAY_CLASS: "operator" }),
    )).toEqual([
      expect.objectContaining({ id: SAFE_DEFAULT_AGENT_ID }),
      { id: "octogee-ops" },
    ]);
  });

  it("treats shared class as authoritative over a stale user slug", () => {
    expect(gatewayAgentRosterUserSlug({
      GATEWAY_CLASS: "shared",
      GATEWAY_BUILDER_SLUG: "mike",
    })).toBe("");
  });

  it("fails a retired operator class closed to the shared routing sentinel", () => {
    expect(gatewayAgentRosterUserSlug({ GATEWAY_CLASS: "operator" })).toBe("");
  });
});

describe("mattermostAccountBindingsNeedActivation", () => {
  it("does not restart for a new peer channel once that account's stable route is already live", () => {
    const account = {
      agentId: "octogee-ceckert-coach",
      match: { channel: "mattermost" as const, accountId: "ceckert-coach" },
    };
    const newPeer = {
      agentId: "octogee-ceckert-coach",
      match: {
        channel: "mattermost" as const,
        accountId: "ceckert-coach",
        peer: { kind: "group" as const, id: "new-project-channel" },
      },
    };

    expect(mattermostAccountBindingsNeedActivation([account], [account, newPeer])).toBe(false);
  });

  it("requires activation when a new project bot account route is introduced", () => {
    const current = [{
      agentId: "octogee-ceckert-coach",
      match: { channel: "mattermost", accountId: "ceckert-coach" },
    }];
    const desired = buildUserBindings([{
      slug: "ceckert",
      channels: [],
      agentProjects: new Set(["gardyn"]),
    }]);

    expect(mattermostAccountBindingsNeedActivation(current, desired)).toBe(true);
  });

  it("requires activation when a foreign agent still owns a desired account route", () => {
    const desired = buildUserBindings([{
      slug: "ceckert",
      channels: [{ channelId: "gardyn" }],
    }]);
    const current = [
      ...desired,
      {
        agentId: "octogee-mike-coach",
        match: {
          channel: "mattermost",
          accountId: "ceckert-coach",
          peer: { kind: "group", id: "gardyn" },
        },
      },
    ];

    expect(mattermostAccountBindingsNeedActivation(current, desired)).toBe(true);
  });

  it("marks a still-configured foreign account when its poisoned user route is removed", () => {
    const desired = buildUserBindings([{
      slug: "ceckert",
      channels: [{ channelId: "gardyn" }],
    }]);
    const current = [
      ...desired,
      {
        agentId: "octogee-mike-coach",
        match: { channel: "mattermost", accountId: "mike-coach" },
      },
      {
        agentId: "octogee-ceckert-coach",
        match: {
          channel: "mattermost",
          accountId: "mike-coach",
          peer: { kind: "group", id: "mike-general" },
        },
      },
      {
        agentId: "octogee-jack-coach",
        match: { channel: "mattermost", accountId: "jack-coach" },
      },
      {
        agentId: "octogee-ceckert-proj-retired-coach",
        match: {
          channel: "mattermost",
          accountId: "jack-coach",
          peer: { kind: "group", id: "jack-general" },
        },
      },
    ];

    expect(mattermostAccountBindingsNeedingActivation(current, desired)).toEqual([
      "jack-coach",
      "mike-coach",
    ]);
  });
});

describe("buildMattermostAccounts", () => {
  it("gives accounts mounted after empty-account Doctor normalization their own endpoint", () => {
    const mattermost: { baseUrl?: string; accounts: Record<string, unknown> } = {
      accounts: { default: { baseUrl: "${MM_URL}" } },
    };
    Object.assign(mattermost.accounts,
      buildMattermostAccounts(
        [{ uid: "uid-a", slug: "chris", customerMmUserId: CHRIS_MM_ID }],
        new Map([["uid-a", "tok-chris"]]),
      ),
      buildProjectAgentAccounts("chris", [
        { projectId: "orbit", enabled: true, token: "pat-1", mmUserId: "bot-1" },
      ], CHRIS_MM_ID),
    );

    expect(mattermost).not.toHaveProperty("baseUrl");
    for (const accountId of ["chris-coach", "chris-proj-orbit"]) {
      expect(mattermost.accounts[accountId]).toHaveProperty("baseUrl", "${MM_URL}");
    }
  });

  it("emits NO entries on empty input — no admin, no placeholders", () => {
    const accounts = buildMattermostAccounts([], new Map());
    expect(accounts).toEqual({});
  });

  it("NEVER emits an `admin` account (root cause of silent channel-start failure)", () => {
    const accounts = buildMattermostAccounts(
      [{ uid: "uid-a", slug: "chris", customerMmUserId: CHRIS_MM_ID }],
      new Map([["uid-a", "tok-chris"]]),
    );
    expect(accounts.admin).toBeUndefined();
  });

  it("lets channel members trigger ordinary work, reserves approvals for each owner, and accepts no DMs", () => {
    const accounts = buildMattermostAccounts(
      [
        { uid: "uid-a", slug: "chris", customerMmUserId: CHRIS_MM_ID },
        { uid: "uid-b", slug: "sam", customerMmUserId: SAM_MM_ID },
      ],
      new Map([
        ["uid-a", "tok-chris"],
        ["uid-b", "tok-sam"],
      ]),
    );
    expect(accounts["chris-coach"]).toEqual({
      baseUrl: "${MM_URL}",
      botToken: { source: "file", provider: "octogee-mattermost", id: "/chris-coach" },
      dmPolicy: "disabled",
      allowFrom: [CHRIS_MM_ID],
      groupAllowFrom: [CHRIS_MM_ID],
      groupPolicy: "open",
      threadSessionScope: "channel",
      groups: null,
      commands: { native: false },
    });
    expect(accounts["sam-coach"]).toEqual({
      baseUrl: "${MM_URL}",
      botToken: { source: "file", provider: "octogee-mattermost", id: "/sam-coach" },
      dmPolicy: "disabled",
      allowFrom: [SAM_MM_ID],
      groupAllowFrom: [SAM_MM_ID],
      groupPolicy: "open",
      threadSessionScope: "channel",
      groups: null,
      commands: { native: false },
    });
  });

  it("OMITS users without a PAT — never emits a null/empty botToken", () => {
    const accounts = buildMattermostAccounts(
      [
        { uid: "uid-a", slug: "chris", customerMmUserId: CHRIS_MM_ID },
        { uid: "uid-b", slug: "sam" },
      ],
      new Map([["uid-a", "tok-chris"]]),
    );
    expect(accounts["chris-coach"]).toMatchObject({
      baseUrl: "${MM_URL}",
      botToken: { source: "file", provider: "octogee-mattermost", id: "/chris-coach" },
      groupPolicy: "open",
    });
    expect(accounts["sam-coach"]).toBeUndefined();
    expect(Object.values(accounts).every((a) => a.botToken.source === "file")).toBe(true);
  });

  it("routes tokens and owner approval ids per uid without cross-workspace bleed", () => {
    const accounts = buildMattermostAccounts(
      [
        { uid: "uid-a", slug: "chris", customerMmUserId: CHRIS_MM_ID },
        { uid: "uid-b", slug: "sam", customerMmUserId: SAM_MM_ID },
        { uid: "uid-c", slug: "pat", customerMmUserId: PAT_MM_ID },
      ],
      new Map([
        ["uid-a", "tok-A"],
        ["uid-b", "tok-B"],
        ["uid-c", "tok-C"],
      ]),
    );
    expect(accounts["chris-coach"].allowFrom).toEqual([CHRIS_MM_ID]);
    expect(accounts["sam-coach"].allowFrom).toEqual([SAM_MM_ID]);
    expect(accounts["pat-coach"].allowFrom).toEqual([PAT_MM_ID]);
    expect(Object.values(accounts).every((account) => account.groupPolicy === "open")).toBe(true);
  });

  it("skips the account when the owner Mattermost id is unavailable", () => {
    const warn = vi.fn();
    const accounts = buildMattermostAccounts(
      [{ uid: "uid-a", slug: "chris" }],
      new Map([["uid-a", "tok-chris"]]),
      warn,
    );
    expect(accounts).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("owner Mattermost id is unavailable"));
  });

  it("clears mention overrides because project replies are blocked at dispatch", () => {
    const accounts = buildMattermostAccounts(
      [
        {
          uid: "uid-a",
          slug: "chris",
          customerMmUserId: CHRIS_MM_ID,
          channels: [
            { channelId: "ws-general", scope: "workspace" },
            { channelId: "proj-orbit", scope: "project", projectId: "orbit" },
            { channelId: "proj-nova", scope: "project", projectId: "nova" },
          ],
          agentProjects: new Set(["orbit"]),
        },
      ],
      new Map([["uid-a", "tok-chris"]]),
    );

    expect(accounts["chris-coach"].groups).toBeNull();
    expect(JSON.stringify(accounts["chris-coach"])).not.toContain("enabled");
  });

  it("clears stale mention overrides even when no project agent remains active", () => {
    const accounts = buildMattermostAccounts(
      [
        {
          uid: "uid-a",
          slug: "chris",
          customerMmUserId: CHRIS_MM_ID,
          channels: [{ channelId: "proj-orbit", scope: "project", projectId: "orbit" }],
          agentProjects: new Set(),
        },
      ],
      new Map([["uid-a", "tok-chris"]]),
    );

    expect(accounts["chris-coach"].groups).toBeNull();
  });
});

describe("buildUserBindings", () => {
  it("pins the user account before its peer bindings so a new channel cannot fall through to another tenant", () => {
    const bindings = buildUserBindings([
      {
        slug: "chris",
        channels: [{ channelId: "ch-general-1" }, { channelId: "ch-coach-1" }],
      },
    ]);
    expect(bindings).toEqual([
      {
        agentId: "octogee-chris-coach",
        match: {
          channel: "mattermost",
          accountId: "chris-coach",
        },
      },
      {
        agentId: "octogee-chris-coach",
        match: {
          channel: "mattermost",
          accountId: "chris-coach",
          peer: { kind: "group", id: "ch-general-1" },
        },
      },
      {
        agentId: "octogee-chris-coach",
        match: {
          channel: "mattermost",
          accountId: "chris-coach",
          peer: { kind: "group", id: "ch-coach-1" },
        },
      },
    ]);
  });

  it("NEVER emits a binding without accountId (multi-tenant isolation lock)", () => {
    const bindings = buildUserBindings([
      { slug: "chris", channels: [{ channelId: "ch-1" }] },
      { slug: "sam", channels: [{ channelId: "ch-2" }] },
    ]);
    for (const b of bindings) {
      expect(b.match.accountId).toBeTruthy();
      expect(b.match.accountId).toMatch(/-coach$/);
    }
  });

  it("routes each user's channels to their own accountId — no cross-tenant bleed", () => {
    const bindings = buildUserBindings([
      { slug: "chris", channels: [{ channelId: "chris-general" }] },
      { slug: "sam", channels: [{ channelId: "sam-general" }] },
    ]);
    const chrisBinding = bindings.find(
      (b) => "peer" in b.match && b.match.peer.id === "chris-general",
    );
    const samBinding = bindings.find(
      (b) => "peer" in b.match && b.match.peer.id === "sam-general",
    );
    expect(chrisBinding?.match.accountId).toBe("chris-coach");
    expect(samBinding?.match.accountId).toBe("sam-coach");
    expect(chrisBinding?.agentId).toBe("octogee-chris-coach");
    expect(samBinding?.agentId).toBe("octogee-sam-coach");
  });

  it("still pins a provisioned user account when it has no discovered channels yet", () => {
    const bindings = buildUserBindings([
      { slug: "chris", channels: [] },
    ]);
    expect(bindings).toEqual([
      {
        agentId: "octogee-chris-coach",
        match: { channel: "mattermost", accountId: "chris-coach" },
      },
    ]);
  });

  it("leaves the retired Admin channel unbound while retaining the user Agent channel", () => {
    const bindings = buildUserBindings([
      {
        slug: "chris",
        channels: [
          { channelId: "ch-admin", scope: "workspace", kind: "admin" },
          { channelId: "ch-coach", scope: "workspace", kind: "coach-dm" },
        ],
      },
    ]);

    expect(bindings.map((binding) =>
      "peer" in binding.match ? binding.match.peer.id : null)).not.toContain("ch-admin");
    expect(bindings).toContainEqual({
      agentId: "octogee-chris-coach",
      match: {
        channel: "mattermost",
        accountId: "chris-coach",
        peer: { kind: "group", id: "ch-coach" },
      },
    });
  });
});

describe("activeAgentProjectIds", () => {
  it("selects only enabled agents that hold a minted token", () => {
    expect(
      activeAgentProjectIds([
        { projectId: "orbit", enabled: true, token: "pat-1", mmUserId: "bot-1" },
        { projectId: "unminted", enabled: true, token: null, mmUserId: null },
        { projectId: "retired", enabled: false, token: "pat-2", mmUserId: "bot-2" },
      ]),
    ).toEqual(new Set(["orbit"]));
  });
});

describe("buildProjectAgents", () => {
  it("uses the project's identity independently of the workspace agent", () => {
    const [agent] = buildProjectAgents({ slug: "chris", customerDir: "/customers/chris", agentsDir: "/agents",
      defaultAgent: { name: "Piper", emoji: "🧭", model: "house" },
      projectAgents: [{ projectId: "fairway", enabled: true, token: "pat", mmUserId: "bot",
        identity: { name: "Chip", emoji: "⛳", persona: "Friendly caddie" } }],
    });
    expect(agent).toMatchObject({ name: "Chip (chris/fairway)", identity: { name: "Chip", emoji: "⛳" } });
  });

  it.each([
    { hostCode: "builder-full", checkoutEnabled: true, sandboxMode: "off", cwd: "/customers/chris/projects/orbit" },
    { hostCode: "builder-full", checkoutEnabled: false, sandboxMode: "off" },
    { hostCode: "builder-full", checkoutEnabled: true, sandboxMode: "all" },
    { hostCode: "customer-restricted", checkoutEnabled: true, sandboxMode: "off" },
  ] as const)("keeps GitHub agent files private with $hostCode, checkout=$checkoutEnabled, sandbox=$sandboxMode", row => {
    const [agent] = buildProjectAgents({ slug: "chris", customerDir: "/customers/chris", agentsDir: "/agents",
      defaultAgent: { name: "Piper", emoji: "🧭", model: "house" }, hostCode: row.hostCode,
      projectAgents: [{ projectId: "orbit", enabled: true, token: "pat", mmUserId: "bot" }],
      githubWorkspaces: new Map([["orbit", { checkoutReady: row.checkoutEnabled, sandboxMode: row.sandboxMode }]]),
    });
    expect(agent.workspace).toBe("/customers/chris/.system/project-coaches/orbit");
    expect(agent.cwd).toBe("cwd" in row ? row.cwd : undefined);
    expect(agent.agentDir).toBe("/agents/octogee-chris-proj-orbit-coach/agent");
  });

  const projectAgents = [
    { projectId: "orbit", enabled: true, token: "pat-1", mmUserId: "bot-1" },
    { projectId: "unminted", enabled: true, token: null, mmUserId: null },
    { projectId: "retired", enabled: false, token: "pat-2", mmUserId: "bot-2" },
  ];

  it("emits one agent entry per ACTIVE project agent, workspace pinned to the project clone", () => {
    const agents = buildProjectAgents({
      slug: "chris",
      customerDir: "/customers/chris",
      agentsDir: "/agents",
      defaultAgent: { name: "BenderEcho", emoji: "🤖", model: "anthropic/claude-sonnet-4-6" },
      projectAgents,
      ownerMmUserId: CHRIS_MM_ID,
    });

    expect(agents).toEqual([
      {
        id: "octogee-chris-proj-orbit-coach",
        name: "Orbit (chris/orbit)",
        workspace: "/customers/chris/projects/orbit",
        agentDir: "/agents/octogee-chris-proj-orbit-coach/agent",
        model: "anthropic/claude-sonnet-4-6",
        identity: { name: "Orbit", emoji: "🤖" },
        tools: {
          profile: "minimal",
          alsoAllow: PROJECT_AGENT_ALLOWED_TOOLS,
          deny: PROJECT_AGENT_DENIED_TOOLS,
          exec: { mode: "deny", host: "node" },
          fs: { workspaceOnly: true },
          toolsBySender: { "*": { deny: [...PRODUCTIVITY_TOOL_NAMES] } },
        },
      },
    ]);
    expect(agents[0].tools).toMatchObject({
      alsoAllow: expect.arrayContaining(["octogee_project_commit"]),
      deny: expect.arrayContaining([
        "exec",
        "process",
        "terminal",
        "subagents",
        "sessions_spawn",
        "preview_start",
        "octogee_publish",
        "bundle-mcp",
        "browser",
        "automations",
        "skill_workshop",
        "skill_library",
        "octogee_status",
      ]),
    });
    expect(agents[0].tools.alsoAllow).not.toContain("workspace_commit");
    expect(agents[0].tools.deny).toContain("workspace_commit");
    expect(agents[0].tools.deny).not.toContain("octogee_project_commit");
  });

  it("lets project agents inherit the full-power tool policy on a isolated gateway", () => {
    const [agent] = buildProjectAgents({
      slug: "chris",
      customerDir: "/customers/chris",
      agentsDir: "/agents",
      defaultAgent: { name: "BenderEcho", emoji: "🤖", model: "anthropic/claude-sonnet-4-6" },
      projectAgents,
      ownerMmUserId: CHRIS_MM_ID,
      hostCode: "builder-full",
    });

    expect(agent).not.toHaveProperty("tools");
  });

});

describe("buildProjectAgentAccounts", () => {
  it("emits shared accounts only for active agents, keyed {slug}-proj-{pid}", () => {
    const accounts = buildProjectAgentAccounts("chris", [
      { projectId: "orbit", enabled: true, token: "pat-1", mmUserId: "bot-1" },
      { projectId: "unminted", enabled: true, token: null, mmUserId: null },
      { projectId: "retired", enabled: false, token: "pat-2", mmUserId: "bot-2" },
    ], CHRIS_MM_ID);

    expect(accounts).toEqual({
      "chris-proj-orbit": {
        baseUrl: "${MM_URL}",
        botToken: { source: "file", provider: "octogee-mattermost", id: "/chris-proj-orbit" },
        allowFrom: [CHRIS_MM_ID],
        groupAllowFrom: [CHRIS_MM_ID],
        dmPolicy: "disabled",
        groupPolicy: "open",
        threadSessionScope: "channel",
        commands: { native: false },
      },
    });
  });

  it("disables project-agent DMs on isolated gateways while keeping owner approval identity", () => {
    const accounts = buildProjectAgentAccounts("chris", [
      { projectId: "orbit", enabled: true, token: "pat-1", mmUserId: "bot-1" },
    ], CHRIS_MM_ID);

    expect(accounts["chris-proj-orbit"].dmPolicy).toBe("disabled");
    expect(accounts["chris-proj-orbit"].allowFrom).toEqual([CHRIS_MM_ID]);
  });

  it("does not emit a project account without an exact owner Mattermost id", () => {
    const accounts = buildProjectAgentAccounts("chris", [
      { projectId: "orbit", enabled: true, token: "pat-1", mmUserId: "bot-1" },
    ]);

    expect(accounts).toEqual({});
  });
});

describe("buildUserBindings — multi-agent partition", () => {
  const channels = [
    { channelId: "ws-general", scope: "workspace" as const },
    { channelId: "proj-orbit-gen", scope: "project" as const, projectId: "orbit" },
    { channelId: "proj-nova-gen", scope: "project" as const, projectId: "nova" },
  ];

  it("routes only workspace channels to the agent and leaves projects without an active agent unbound", () => {
    const bindings = buildUserBindings([
      { slug: "chris", channels, agentProjects: new Set(["orbit"]) },
    ]);

    expect(bindings).toEqual([
      {
        agentId: "octogee-chris-coach",
        match: { channel: "mattermost", accountId: "chris-coach" },
      },
      {
        agentId: "octogee-chris-proj-orbit-coach",
        match: { channel: "mattermost", accountId: "chris-proj-orbit" },
      },
      {
        agentId: "octogee-chris-coach",
        match: {
          channel: "mattermost",
          accountId: "chris-coach",
          peer: { kind: "group", id: "ws-general" },
        },
      },
      {
        agentId: "octogee-chris-proj-orbit-coach",
        match: {
          channel: "mattermost",
          accountId: "chris-proj-orbit",
          peer: { kind: "group", id: "proj-orbit-gen" },
        },
      },
    ]);
  });

  it("partition invariant: exactly one binding per channel; workspace channels never bind to a project agent", () => {
    const bindings = buildUserBindings([
      { slug: "chris", channels, agentProjects: new Set(["orbit", "nova"]) },
    ]);

    const byChannel = new Map<string, string[]>();
    for (const b of bindings) {
      if (!("peer" in b.match)) continue;
      const list = byChannel.get(b.match.peer.id) ?? [];
      list.push(b.agentId);
      byChannel.set(b.match.peer.id, list);
    }
    for (const agents of byChannel.values()) {
      expect(agents).toHaveLength(1);
    }
    expect(byChannel.get("ws-general")).toEqual(["octogee-chris-coach"]);
  });

  it("never falls back to the workspace agent for projects without an active agent", () => {
    const bindings = buildUserBindings([{ slug: "chris", channels }]);
    expect(bindings.flatMap(b => b.match.peer ? [b.match.peer.id] : [])).toEqual(["ws-general"]);
    for (const b of bindings) {
      expect(b.agentId).toBe("octogee-chris-coach");
      expect(b.match.accountId).toBe("chris-coach");
    }
  });

  it("pins every active project bot account even before its channel-specific binding is live", () => {
    const bindings = buildUserBindings([
      {
        slug: "chris",
        channels: [],
        agentProjects: new Set(["orbit", "nova"]),
      },
    ]);

    expect(bindings).toEqual([
      {
        agentId: "octogee-chris-coach",
        match: { channel: "mattermost", accountId: "chris-coach" },
      },
      {
        agentId: "octogee-chris-proj-nova-coach",
        match: { channel: "mattermost", accountId: "chris-proj-nova" },
      },
      {
        agentId: "octogee-chris-proj-orbit-coach",
        match: { channel: "mattermost", accountId: "chris-proj-orbit" },
      },
    ]);
  });
});

it('excludes an agent in error from all runtime accounts and bindings without using a fallback identity', () => {
  const projectAgents = [{ projectId: 'broken', enabled: true, status: 'error' as const, mmUserId: 'bot', token: 'pat' }];
  expect([...activeAgentProjectIds(projectAgents)]).toEqual([]);
  expect(buildProjectAgentAccounts('chris', projectAgents, CHRIS_MM_ID)).toEqual({});
  expect(buildProjectAgents({ slug: 'chris', customerDir: '/customers/chris', agentsDir: '/agents',
    defaultAgent: { name: 'Piper', emoji: '🤖', model: 'house' }, projectAgents })).toEqual([]);
});
