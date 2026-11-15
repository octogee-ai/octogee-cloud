import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  workspaceDefaultAgentChannelName,
  workspaceGeneralChannelName,
} from "@octogee/shared/types/identity";

interface MattermostBody {
  name?: string;
  purpose?: string;
  [field: string]: unknown;
}

const h = vi.hoisted(() => {
  const docs: Record<string, Record<string, unknown>> = {};
  const setSpy = vi.fn(async () => {});
  const docRef = (p: string) => ({
    get: async () => ({ exists: docs[p] !== undefined, data: () => docs[p] }),
    set: setSpy,
    collection: (sub: string) => collRef(`${p}/${sub}`),
  });
  const collRef = (p: string) => ({ doc: (id: string) => docRef(`${p}/${id}`) });
  return {
    db: { collection: (n: string) => collRef(n), doc: (p: string) => docRef(p) },
    setSpy,
    docs,
    setDocs: (d: Record<string, Record<string, unknown>>) => {
      for (const key of Object.keys(docs)) delete docs[key];
      Object.assign(docs, d);
    },
    mmApiCall: vi.fn<(method: string, endpoint: string, body?: MattermostBody) => Promise<unknown>>(),
    mintAndPersistDefaultAgentToken: vi.fn(),
    mmUploadAvatar: vi.fn(),
  };
});

vi.mock("../provisioner-platform-state.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { db: h.db, platformStateStore: createDocumentFixtureStore(h.docs) };
});
vi.mock("../mattermost/default-agent-pat.js", () => ({
  mintAndPersistDefaultAgentToken: h.mintAndPersistDefaultAgentToken,
}));
vi.mock("../mattermost/avatars.js", () => ({ mmUploadAvatar: h.mmUploadAvatar }));

import { createMattermostChannelHost } from "../channel-host/mattermost.js";
import { provisionMattermostUser } from "../mattermost/provision.js";
import { defaultAgentChannelPurpose, installAgentChannelPurpose } from "../mattermost/agent-channel-purpose.js";
import { DEFAULT_PLACEHOLDER_EMAIL_DOMAIN, installPlaceholderEmailDomain } from "../placeholder-email.js";

const host = createMattermostChannelHost({
  baseUrl: "http://mm.test",
  adminToken: "admin",
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input).replace("http://mm.test/api/v4", "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const result = await h.mmApiCall(init?.method ?? "GET", endpoint, body);
    return result === null || result === undefined
      ? new Response("", { status: 404 })
      : new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch,
});

interface ProvisionInput {
  uid: string;
  slug: string;
  firstName: string;
  email: string;
  vibe?: string | null;
  lastName?: string;
  photoURL?: string;
}

type StoredMattermostNames = Parameters<typeof provisionMattermostUser>[2];

const storedNames: StoredMattermostNames = async (uid, slug) => ({
  username: ((h.docs[`users/${uid}`]?.mattermost as { username?: string } | undefined)?.username) ?? null,
  coachChannelName: (h.docs[`workspaces/${slug}/channels/coach-dm`]?.name as string | undefined) ?? null,
});
const noStoredNames: StoredMattermostNames = async () => ({ username: null, coachChannelName: null });

const call = (i: ProvisionInput, names: StoredMattermostNames = storedNames) => provisionMattermostUser(i, host, names);

function withoutFirestore() {
  const firestoreUnavailable = () => {
    throw new Error("Firestore is not available");
  };
  const doc = vi.spyOn(h.db, "doc").mockImplementation(firestoreUnavailable);
  const collection = vi.spyOn(h.db, "collection").mockImplementation(firestoreUnavailable);
  return {
    expectUnread() {
      expect(doc).not.toHaveBeenCalled();
      expect(collection).not.toHaveBeenCalled();
    },
    restore() {
      doc.mockRestore();
      collection.mockRestore();
    },
  };
}

const HAPPY: ProvisionInput = {
  uid: "u1",
  slug: "acme",
  firstName: "Ada",
  email: "ada@example.com",
  vibe: "builder",
  lastName: "Lovelace",
  photoURL: "",
};

const seq = () => h.mmApiCall.mock.calls.map(([m, e]) => `${m} ${e}`);
const createdChannelNames = () =>
  h.mmApiCall.mock.calls
    .filter(([m, e]) => m === "POST" && e === "/channels")
    .map(([, , body]) => body?.name);

beforeEach(() => {
  vi.clearAllMocks();
  installPlaceholderEmailDomain(DEFAULT_PLACEHOLDER_EMAIL_DOMAIN);
  installAgentChannelPurpose(defaultAgentChannelPurpose);
  h.setDocs({ "users/u1": {} });
  h.mmApiCall.mockImplementation(async (method: string, endpoint: string, body?: { name?: string }) => {
    if (method === "POST" && endpoint === "/users") return { id: "builder-1", delete_at: 0 };
    if (method === "POST" && endpoint === "/teams") return { id: "team-1" };
    if (method === "POST" && endpoint === "/channels") return { id: `ch:${body?.name}` };
    if (method === "POST" && endpoint === "/bots") return { user_id: "coach-1" };
    if (method === "POST" && endpoint === "/users/builder-1/tokens") return { token: "user-token" };
    if (method === "GET" && endpoint.includes("/channels/name/")) return null;
    if (method === "GET" && endpoint.startsWith("/commands?")) return [];
    return {};
  });
  h.mintAndPersistDefaultAgentToken.mockResolvedValue({ token: "default-agent-pat" });
  h.mmUploadAvatar.mockResolvedValue(true);
});

describe("provisionMattermostUser — new user (happy path)", () => {
  it("creates user, team, defaultAgent bot and returns the mattermost update map", async () => {
    const result = await call(HAPPY);

    expect(result["mattermost.userId"]).toBe("builder-1");
    expect(result["mattermost.username"]).toBe("acme");
    expect(result["mattermost.teamId"]).toBe("team-1");
    expect(result["mattermost.coachUserId"]).toBe("coach-1");
    expect(result["_coachPersonalToken"]).toBe("default-agent-pat");
    expect(result["mattermost.channelId"]).toBe(`ch:${workspaceDefaultAgentChannelName("acme")}`);
    expect(result["mattermost.dmChannelId"]).toBe(`ch:${workspaceDefaultAgentChannelName("acme")}`);
    expect(result["mattermost.generalChannelId"]).toBe(`ch:${workspaceGeneralChannelName("acme")}`);
    expect(result).not.toHaveProperty("mattermost.adminChannelId");
    expect(createdChannelNames()).toEqual([
      workspaceDefaultAgentChannelName("acme"),
      workspaceGeneralChannelName("acme"),
    ]);
  });

  it("describes the agent channel and the general channel by the user's name alone", async () => {
    await call(HAPPY);

    const purposes = Object.fromEntries(h.mmApiCall.mock.calls
      .filter(([m, e]) => m === "POST" && e === "/channels")
      .map(([, , body]) => [String(body?.name), body?.purpose]));
    expect(purposes).toEqual({
      [workspaceDefaultAgentChannelName("acme")]: "Ada's private channel with their agent",
      [workspaceGeneralChannelName("acme")]: "Ada's workspace — general discussion",
    });
  });

  it("describes the agent channel with an installed purpose", async () => {
    installAgentChannelPurpose((ownerLabel) => `${ownerLabel}'s studio`);

    await call(HAPPY);

    const agentChannel = h.mmApiCall.mock.calls.find(([m, e, body]) =>
      m === "POST" && e === "/channels" && body?.name === workspaceDefaultAgentChannelName("acme"));
    expect(agentChannel?.[2]).toMatchObject({ purpose: "Ada's studio" });
  });

  it("registers the /ui command in the new workspace team, pointed at the callback router", async () => {
    vi.stubEnv("K8S_NAMESPACE", "octogee-test");
    try {
      await call(HAPPY);
    } finally {
      vi.unstubAllEnvs();
    }

    const create = h.mmApiCall.mock.calls.find(([m, e]) => m === "POST" && e === "/commands");
    expect(create?.[2]).toMatchObject({
      team_id: "team-1",
      trigger: "ui",
      method: "P",
      url: "http://mattermost-callback-router.octogee-test.svc.cluster.local:3001/internal/mattermost/commands/control-ui",
    });
  });

  it("finishes provisioning when the /ui command cannot be registered", async () => {
    vi.stubEnv("K8S_NAMESPACE", "octogee-test");
    const fallback = h.mmApiCall.getMockImplementation()!;
    h.mmApiCall.mockImplementation(async (method: string, endpoint: string, body?: { name?: string }) =>
      endpoint === "/commands" ? null : fallback(method, endpoint, body));
    try {
      const result = await call(HAPPY);
      expect(result["mattermost.userId"]).toBe("builder-1");
      expect(result["mattermost.coachUserId"]).toBe("coach-1");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("creates the user MM user with the least-privilege system_user role", async () => {
    await call(HAPPY);
    const userCreate = h.mmApiCall.mock.calls.find(
      ([m, e]) => m === "POST" && e === "/users",
    );
    expect(userCreate?.[2]).toMatchObject({ username: "acme", roles: "system_user" });
  });

  it("creates the agent as a bot (POST /bots) and mints+persists its PAT", async () => {
    await call(HAPPY);
    expect(seq()).toContain("POST /bots");
    expect(seq()).toContain("POST /teams");
    expect(h.mintAndPersistDefaultAgentToken).toHaveBeenCalledWith(expect.anything(), "u1", "coach-1");
  });

  it("persists the user personal token to the user's mattermost secret", async () => {
    await call(HAPPY);
    expect(h.docs["users/u1/secrets/mattermost"]).toMatchObject({ personalToken: "user-token" });
  });

  it("never reads MM_COMMUNITY_TEAM_ID — community membership is reconciled separately, not during MM account provisioning", async () => {
    process.env.MM_COMMUNITY_TEAM_ID = "legacy-community-team";
    try {
      await call(HAPPY);
    } finally {
      delete process.env.MM_COMMUNITY_TEAM_ID;
    }

    expect(seq()).not.toContain("POST /teams/legacy-community-team/members");
  });

  it("provisions a user with no Mattermost account without reading Firestore", async () => {
    const firestore = withoutFirestore();
    try {
      const result = await call(HAPPY, noStoredNames);

      expect(result["mattermost.userId"]).toBe("builder-1");
      expect(result["mattermost.teamId"]).toBe("team-1");
      firestore.expectUnread();
    } finally {
      firestore.restore();
    }
  });
});

describe("provisionMattermostUser — already provisioned (idempotent backfill)", () => {
  beforeEach(() => {
    h.setDocs({
      "users/u1": {
        mattermost: {
          userId: "existing-user",
          username: "acme",
          teamId: "existing-team",
          coachUserId: "existing-coach",
        },
      },
      "workspaces/acme": { id: "acme", ownerUid: "u1", mattermost: { teamId: "existing-team" } },
      "agents/u1": { mattermost: { userId: "existing-coach" } },
      "workspaces/acme/channels/coach-dm": {
        name: "acme-coach",
        mattermost: { channelId: "existing-coach-ch" },
      },
      "workspaces/acme/channels/general": { mattermost: { channelId: "existing-general-ch" } },
      "workspaces/acme/channels/admin": { mattermost: { channelId: "existing-admin-ch" } },
      "users/u1/secrets/coachMattermost": { personalToken: "existing-coach-pat" },
    });
  });

  it("returns the complete persisted topology without creating a new user or team", async () => {
    const result = await call(HAPPY);
    expect(result["mattermost.userId"]).toBe("existing-user");
    expect(result["mattermost.teamId"]).toBe("existing-team");
    expect(result["mattermost.coachUserId"]).toBe("existing-coach");
    expect(result["mattermost.channelId"]).toBe("existing-coach-ch");
    expect(result["mattermost.generalChannelId"]).toBe("existing-general-ch");
    expect(result["mattermost.adminChannelId"]).toBe("existing-admin-ch");
    expect(result["_coachPersonalToken"]).toBe("existing-coach-pat");
    expect(seq()).not.toContain("POST /users");
    expect(seq()).not.toContain("POST /teams");
  });

  it("keeps the stored Mattermost username and agent channel name", async () => {
    h.docs["users/u1"] = { mattermost: { userId: "existing-user", username: "legacy-name" } };

    const result = await call(HAPPY);

    expect(result["mattermost.username"]).toBe("legacy-name");
    expect(result["mattermost.channelName"]).toBe("acme-coach");
  });

  it("re-provisions from platform state alone, naming the user and agent channel as provisioning created them", async () => {
    const firestore = withoutFirestore();
    try {
      const result = await call(HAPPY, noStoredNames);

      expect(result["mattermost.userId"]).toBe("existing-user");
      expect(result["mattermost.username"]).toBe("acme");
      expect(result["mattermost.channelName"]).toBe(workspaceDefaultAgentChannelName("acme"));
      expect(result["mattermost.channelId"]).toBe("existing-coach-ch");
      expect(seq()).not.toContain("POST /users");
      firestore.expectUnread();
    } finally {
      firestore.restore();
    }
  });

  it("keeps a new-style topology without an Admin channel idempotent", async () => {
    h.setDocs({
      "users/u1": {
        mattermost: {
          userId: "existing-user",
          username: "acme",
          teamId: "existing-team",
          coachUserId: "existing-coach",
        },
      },
      "workspaces/acme": { id: "acme", ownerUid: "u1", mattermost: { teamId: "existing-team" } },
      "agents/u1": { mattermost: { userId: "existing-coach" } },
      "workspaces/acme/channels/coach-dm": {
        name: "acme-coach",
        mattermost: { channelId: "existing-coach-ch" },
      },
      "workspaces/acme/channels/general": { mattermost: { channelId: "existing-general-ch" } },
      "users/u1/secrets/coachMattermost": { personalToken: "existing-coach-pat" },
    });

    const result = await call(HAPPY);

    expect(result["mattermost.channelId"]).toBe("existing-coach-ch");
    expect(result["mattermost.generalChannelId"]).toBe("existing-general-ch");
    expect(result).not.toHaveProperty("mattermost.adminChannelId");
    expect(seq()).not.toContain("POST /users");
    expect(seq()).not.toContain("POST /teams");
  });

  it("re-enters provisioning when the persisted topology has no team", async () => {
    h.setDocs({
      "users/u1": { mattermost: { userId: "existing-user", username: "acme" } },
      "workspaces/acme/channels/coach-dm": { mattermost: { channelId: "existing-coach-ch" } },
    });

    const result = await call(HAPPY);

    expect(result["mattermost.teamId"]).toBe("team-1");
    expect(seq()).toContain("POST /teams");
  });

  it("re-enters provisioning when a persisted team is missing canonical channels", async () => {
    h.setDocs({
      "users/u1": {
        mattermost: { userId: "existing-user", username: "acme", teamId: "existing-team" },
      },
      "workspaces/acme": { id: "acme", ownerUid: "u1", mattermost: { teamId: "existing-team" } },
      "agents/u1": { mattermost: { userId: "existing-coach" } },
      "workspaces/acme/channels/coach-dm": { mattermost: { channelId: "existing-coach-ch" } },
    });

    const result = await call(HAPPY);

    expect(result["mattermost.teamId"]).toBe("team-1");
    expect(seq()).toContain("POST /teams");
  });
});

describe("provisionMattermostUser — degraded paths", () => {
  it("reactivates and re-patches a soft-deleted user found by email", async () => {
    h.mmApiCall.mockImplementation(async (method: string, endpoint: string, body?: { name?: string }) => {
      if (method === "POST" && endpoint === "/users") return null; // create conflicts
      if (method === "POST" && endpoint === "/channels") return { id: `ch:${body?.name}` };
      if (method === "GET" && endpoint.startsWith("/users/username/")) return null; // username miss
      if (method === "GET" && endpoint.startsWith("/users/email/")) return { id: "user-existing", delete_at: 5 };
      if (method === "POST" && endpoint === "/teams") return { id: "team-1" };
      if (method === "POST" && endpoint === "/bots") return { user_id: "coach-1" };
      if (method === "POST" && endpoint === "/users/user-existing/tokens") return { token: "tok" };
      if (method === "GET" && endpoint.includes("/channels/name/")) return null;
      return {};
    });

    const result = await call(HAPPY);

    expect(result["mattermost.userId"]).toBe("user-existing");
    expect(seq()).toContain("PUT /users/user-existing/active");
    expect(seq()).toContain("PUT /users/user-existing/patch");
  });

  it("finds a user who has no email by the placeholder address at the installed domain", async () => {
    installPlaceholderEmailDomain("accounts.example");
    h.mmApiCall.mockImplementation(async (method: string, endpoint: string, body?: { name?: string }) => {
      if (method === "POST" && endpoint === "/users") return null;
      if (method === "POST" && endpoint === "/channels") return { id: `ch:${body?.name}` };
      if (method === "GET" && endpoint.startsWith("/users/username/")) return null;
      if (method === "GET" && endpoint === "/users/email/u1%40accounts.example") return { id: "user-existing", delete_at: 0 };
      if (method === "POST" && endpoint === "/teams") return { id: "team-1" };
      if (method === "POST" && endpoint === "/bots") return { user_id: "coach-1" };
      if (method === "GET" && endpoint.includes("/channels/name/")) return null;
      return {};
    });

    const result = await call({ ...HAPPY, email: "" });

    expect(h.mmApiCall).toHaveBeenCalledWith("POST", "/users", expect.objectContaining({ email: "u1@accounts.example" }));
    expect(result["mattermost.userId"]).toBe("user-existing");
  });

  it.each([
    ["the default domain", null, "u1@users.invalid"],
    ["an installed domain", "accounts.example", "u1@accounts.example"],
  ])("does not look up a Gravatar for a placeholder address at %s", async (_name, domain, email) => {
    if (domain) installPlaceholderEmailDomain(domain);

    await call({ ...HAPPY, email });

    expect(h.mmUploadAvatar).not.toHaveBeenCalled();
  });

  it("looks up a Gravatar for a real address", async () => {
    await call(HAPPY);

    expect(h.mmUploadAvatar).toHaveBeenCalledWith("builder-1", expect.stringMatching(/^https:\/\/gravatar\.com\/avatar\//));
  });

  it("keeps coachUserId but omits the agent token when the PAT mint fails", async () => {
    h.mintAndPersistDefaultAgentToken.mockResolvedValue(null);

    const result = await call(HAPPY);

    expect(result["mattermost.coachUserId"]).toBe("coach-1");
    expect(result).not.toHaveProperty("_coachPersonalToken");
  });
});
