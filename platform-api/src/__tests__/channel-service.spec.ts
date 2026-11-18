import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDocumentPresentation } from "./helpers/project-presentation.js";
import { installProjectPresentation, NO_PROJECT_PRESENTATION } from "@octogee/core/identity/project-presentation";
import { MalformedRecordError } from "@octogee/core/platform-state";

type Write = {
  path: string;
  data: Record<string, unknown>;
  options?: Record<string, unknown>;
};

type Update = {
  path: string;
  data: Record<string, unknown>;
};

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  writes: [] as Write[],
  updates: [] as Update[],
  setError: null as Error | null,
  enrollWorkspaceChannelMembers: vi.fn(),
  getWorkspaceMmContext: vi.fn(),
  mmApi: vi.fn(),
  setStoredChannelArchived: vi.fn(),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

function docRef(path: string) {
  return {
    path,
    get: async () => {
      const data = h.docs.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    set: async (data: Record<string, unknown>, options?: Record<string, unknown>) => {
      if (h.setError) throw h.setError;
      h.writes.push({ path, data, options });
    },
    update: async (data: Record<string, unknown>) => {
      h.updates.push({ path, data });
    },
  };
}

vi.mock("@octogee/core/identity/platform-state-store", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});

vi.mock("@octogee/core/http/logging", () => ({
  logger: h.logger,
}));

vi.mock("../lib/mattermost.js", () => ({
  mmApi: (...args: unknown[]) => h.mmApi(...args),
}));

vi.mock("../lib/mattermost-context.js", () => ({
  getWorkspaceMmContext: (...args: unknown[]) => h.getWorkspaceMmContext(...args),
}));

vi.mock("../lib/workspace-channel-membership.js", () => ({
  enrollWorkspaceChannelMembers: (...args: unknown[]) => h.enrollWorkspaceChannelMembers(...args),
}));

vi.mock("../lib/channel-lifecycle.js", () => ({
  setStoredChannelArchived: (...args: unknown[]) => h.setStoredChannelArchived(...args),
}));

const {
  createSessionChannel,
  renameSessionChannel,
  archiveSessionChannel,
  createProjectSessionChannel,
  renameProjectSessionChannel,
  archiveProjectSessionChannel,
  listArchivedSessionChannels,
  restoreSessionChannel,
  sessionChannelNameAvailability,
} = await import("../lib/channel-service.js");
const { platformStateStore } = await import("@octogee/core/identity/platform-state-store");

installDocumentPresentation(docRef);

function actor(overrides: Record<string, unknown> = {}) {
  return {
    uid: "owner-1",
    userData: { username: "mira" },
    workspaceId: "mira",
    ...overrides,
  };
}

const DOC_PATH = "workspaces/mira/channels/patchroll";
const ARCHIVED_AT = 1_700_000_000_000;

// mmApi mock where GET /channels/channel-1 verifies as the caller's own
// session channel, plus per-path responses (an Error value → rejection).
function mockVerifiedMmChannel(responses: Record<string, unknown>) {
  h.mmApi.mockReset().mockImplementation(async (path: string, method?: string) => {
    if (path === "/channels/channel-1" && (method === undefined || method === "GET")) {
      return { id: "channel-1", name: "mira-patchroll" };
    }
    if (path in responses) {
      const value = responses[path];
      if (value instanceof Error) throw value;
      return value;
    }
    throw new Error(`unexpected Mattermost call: ${method ?? "GET"} ${path}`);
  });
}

function seedSessionDoc(extra: Record<string, unknown> = {}) {
  h.docs.set(DOC_PATH, {
    id: "patchroll",
    kind: "session",
    name: "patchroll",
    mattermost: {
      channelId: "channel-1",
    },
    ...extra,
  });
}

beforeEach(() => {
  h.docs.clear();
  h.writes.length = 0;
  h.updates.length = 0;
  h.setError = null;
  h.enrollWorkspaceChannelMembers.mockReset().mockResolvedValue(undefined);
  h.getWorkspaceMmContext.mockReset().mockResolvedValue({
    teamId: "team-1",
    userId: "owner-mm",
    coachUserId: "coach-mm",
  });
  h.mmApi.mockReset().mockImplementation(async (path: string, method?: string) => {
    if (method === "POST" && path === "/channels") return { id: "channel-1" };
    if (method === "POST" && path === "/channels/channel-1/members") return { ok: true };
    throw new Error(`unexpected Mattermost call: ${method ?? "GET"} ${path}`);
  });
  h.setStoredChannelArchived.mockReset().mockResolvedValue(undefined);
  h.logger.error.mockReset();
  h.logger.info.mockReset();
});

describe("sessionChannelNameAvailability", () => {
  it("rejects malformed names", () => {
    expect(sessionChannelNameAvailability("patch-roll")).toEqual({
      ok: false,
      reason: "Channel name must be 1-17 chars, lowercase letters and digits only.",
    });
    expect(sessionChannelNameAvailability("x".repeat(18))).toEqual({
      ok: false,
      reason: "Channel name must be 1-17 chars, lowercase letters and digits only.",
    });
    expect(sessionChannelNameAvailability("")).toEqual({
      ok: false,
      reason: "Channel name must be 1-17 chars, lowercase letters and digits only.",
    });
  });

  it("rejects reserved names", () => {
    for (const reserved of ["general", "coach", "admin", "proj", "community"]) {
      expect(sessionChannelNameAvailability(reserved)).toEqual({
        ok: false,
        reason: "That channel name is reserved.",
      });
    }
  });

  it("accepts valid names", () => {
    expect(sessionChannelNameAvailability("patchroll")).toEqual({ ok: true });
  });
});

describe("createSessionChannel", () => {
  it("returns the stored primary without requiring a sibling", async () => {
    seedSessionDoc({
      createdDisplayName: "Patch Roll",
      mattermost: {
        channelId: "channel-1",
      },
    });

    const result = await createSessionChannel(actor(), {
      name: "patchroll",
      displayName: "Patch Roll",
    });

    expect(result).toEqual({
      status: 200,
      body: { success: true, channelId: "channel-1", name: "patchroll" },
    });
    expect(h.setStoredChannelArchived).not.toHaveBeenCalled();
    expect(h.mmApi).not.toHaveBeenCalled();
  });

  const input = { name: "patchroll", displayName: "OpenClaw Patch Upgrade", purpose: "Roll OC patches" };

  it("rejects missing workspace before any writes", async () => {
    await expect(createSessionChannel(actor({ workspaceId: null }), input)).resolves.toEqual({
      status: 422,
      body: { error: "Workspace not provisioned" },
    });
    expect(h.writes).toEqual([]);
    expect(h.mmApi).not.toHaveBeenCalled();
  });

  it("rejects invalid and reserved names", async () => {
    await expect(
      createSessionChannel(actor(), { ...input, name: "patch-roll" }),
    ).resolves.toEqual({
      status: 400,
      body: { error: "Channel name must be 1-17 chars, lowercase letters and digits only." },
    });
    await expect(
      createSessionChannel(actor(), { ...input, name: "coach" }),
    ).resolves.toEqual({
      status: 400,
      body: { error: "That channel name is reserved." },
    });
    expect(h.mmApi).not.toHaveBeenCalled();
  });

  it("rejects a missing display name", async () => {
    await expect(
      createSessionChannel(actor(), { ...input, displayName: "  " }),
    ).resolves.toEqual({
      status: 400,
      body: { error: "Channel display name is required" },
    });
  });

  it("rejects display names and purposes over the Mattermost caps", async () => {
    await expect(
      createSessionChannel(actor(), { ...input, displayName: "x".repeat(65) }),
    ).resolves.toEqual({
      status: 400,
      body: { error: "Channel display name must be at most 64 characters" },
    });
    await expect(
      createSessionChannel(actor(), { ...input, purpose: "x".repeat(251) }),
    ).resolves.toEqual({
      status: 400,
      body: { error: "Channel purpose must be at most 250 characters" },
    });
  });

  it("returns the stored primary for a retry of the same create", async () => {
    seedSessionDoc({ createdDisplayName: input.displayName });
    await expect(createSessionChannel(actor(), input)).resolves.toEqual({
      status: 200,
      body: { success: true, channelId: "channel-1", name: "patchroll" },
    });
    expect(h.mmApi).not.toHaveBeenCalled();
  });

  it("refuses a different channel whose derived name collides with an existing one", async () => {
    seedSessionDoc({ createdDisplayName: "Patch Roll Q3" });
    await expect(createSessionChannel(actor(), { ...input, displayName: "Patch Roll Q4" })).resolves.toEqual({
      status: 409,
      body: {
        error: 'A channel already uses the name "patchroll". Choose a name that differs within its first 17 letters and numbers.',
      },
    });
    expect(h.mmApi).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("refuses an existing channel whose creation name is not recorded", async () => {
    seedSessionDoc();
    await expect(createSessionChannel(actor(), input)).resolves.toEqual({
      status: 409,
      body: {
        error: 'A channel already uses the name "patchroll". Choose a name that differs within its first 17 letters and numbers.',
      },
    });
    expect(h.mmApi).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("returns 409 with an archived hint when the existing doc is archived", async () => {
    seedSessionDoc({ archivedAt: ARCHIVED_AT });
    await expect(createSessionChannel(actor(), input)).resolves.toEqual({
      status: 409,
      body: { error: "A session with this name was archived; channel names cannot be reused" },
    });
  });

  it("fails loudly when the workspace has no Mattermost team", async () => {
    h.getWorkspaceMmContext.mockResolvedValueOnce(null);
    await expect(createSessionChannel(actor(), input)).resolves.toEqual({
      status: 502,
      body: { error: "Channel creation failed - workspace chat is not ready" },
    });
    expect(h.logger.error).toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("creates the MM channel with purpose, adds owner + defaultAgent, and writes the session doc", async () => {
    const result = await createSessionChannel(actor(), input);

    expect(result).toEqual({
      status: 200,
      body: { success: true, channelId: "channel-1", name: "patchroll" },
    });
    expect(h.mmApi).toHaveBeenCalledWith("/channels", "POST", {
      team_id: "team-1",
      name: "mira-patchroll",
      display_name: "OpenClaw Patch Upgrade",
      type: "P",
      purpose: "Roll OC patches",
    });
    expect(h.mmApi).toHaveBeenCalledWith("/channels/channel-1/members", "POST", { user_id: "owner-mm" });
    expect(h.mmApi).toHaveBeenCalledWith("/channels/channel-1/members", "POST", { user_id: "coach-mm" });
    expect(h.docs.get(DOC_PATH)).toMatchObject({
      id: "patchroll",
      kind: "session",
      mattermost: { channelId: "channel-1" },
      createdBy: "owner-1",
      createdAt: expect.any(Number),
    });
    expect(h.writes).toEqual([
      {
        path: DOC_PATH,
        data: {
          name: "patchroll",
          purpose: "Roll OC patches",
          createdDisplayName: "OpenClaw Patch Upgrade",
        },
        options: { merge: true },
      },
    ]);
    expect(h.logger.info).toHaveBeenCalledWith("[channels] Created session channel mira/patchroll", {
      uid: "owner-1",
    });
  });

  it("removes unexpected members and verifies the channel before adopting it", async () => {
    let memberReads = 0;
    h.mmApi.mockReset().mockImplementation(async (path: string, method?: string) => {
      if (method === "POST" && path === "/channels") {
        const err = new Error(
          'MM API 400: {"id":"store.sql_channel.save_channel.exists.app_error"}',
        ) as Error & { status: number };
        err.status = 400;
        throw err;
      }
      if (path === "/teams/team-1/channels/name/mira-patchroll") return { id: "channel-9" };
      if (path === "/channels/channel-9/members?page=0&per_page=200") {
        memberReads += 1;
        return memberReads === 1
          ? [{ user_id: "attacker-mm" }, { user_id: "owner-mm" }]
          : [{ user_id: "owner-mm" }];
      }
      if (method === "DELETE" && path === "/channels/channel-9/members/attacker-mm") return { ok: true };
      if (method === "PUT" && path === "/channels/channel-9/patch") return { id: "channel-9" };
      if (method === "POST" && path === "/channels/channel-9/members") return { ok: true };
      throw new Error(`unexpected Mattermost call: ${method ?? "GET"} ${path}`);
    });

    const result = await createSessionChannel(actor(), input);

    expect(result).toEqual({
      status: 200,
      body: { success: true, channelId: "channel-9", name: "patchroll" },
    });
    expect(h.mmApi).toHaveBeenCalledWith("/channels/channel-9/members/attacker-mm", "DELETE");
    expect(memberReads).toBe(2);
    expect(h.mmApi).toHaveBeenCalledWith("/channels/channel-9/patch", "PUT", {
      display_name: "OpenClaw Patch Upgrade",
      purpose: "Roll OC patches",
    });
    expect(h.docs.get(DOC_PATH)).toEqual(
      expect.objectContaining({ mattermost: { channelId: "channel-9" } }),
    );
  });

  it("reads every member page before removing an unexpected member", async () => {
    const firstPage = Array.from({ length: 200 }, () => ({ user_id: "owner-mm" }));
    let verificationReads = 0;
    h.mmApi.mockReset().mockImplementation(async (path: string, method?: string) => {
      if (method === "POST" && path === "/channels") {
        const err = new Error(
          'MM API 400: {"id":"store.sql_channel.save_channel.exists.app_error"}',
        ) as Error & { status: number };
        err.status = 400;
        throw err;
      }
      if (path === "/teams/team-1/channels/name/mira-patchroll") return { id: "channel-9" };
      if (path === "/channels/channel-9/members?page=0&per_page=200") {
        verificationReads += 1;
        return verificationReads === 1 ? firstPage : [{ user_id: "owner-mm" }];
      }
      if (path === "/channels/channel-9/members?page=1&per_page=200") {
        return [{ user_id: "attacker-mm" }];
      }
      if (method === "DELETE" && path === "/channels/channel-9/members/attacker-mm") {
        return { ok: true };
      }
      if (method === "PUT" && path === "/channels/channel-9/patch") return { id: "channel-9" };
      if (method === "POST" && path === "/channels/channel-9/members") return { ok: true };
      throw new Error(`unexpected Mattermost call: ${method ?? "GET"} ${path}`);
    });

    await expect(createSessionChannel(actor(), input)).resolves.toEqual({
      status: 200,
      body: { success: true, channelId: "channel-9", name: "patchroll" },
    });
    expect(h.mmApi).toHaveBeenCalledWith("/channels/channel-9/members?page=1&per_page=200");
    expect(h.mmApi).toHaveBeenCalledWith("/channels/channel-9/members/attacker-mm", "DELETE");
  });

  it("refuses adoption when an unexpected member appears during cleanup", async () => {
    let memberReads = 0;
    h.mmApi.mockReset().mockImplementation(async (path: string, method?: string) => {
      if (method === "POST" && path === "/channels") {
        const err = new Error(
          'MM API 400: {"id":"store.sql_channel.save_channel.exists.app_error"}',
        ) as Error & { status: number };
        err.status = 400;
        throw err;
      }
      if (path === "/teams/team-1/channels/name/mira-patchroll") return { id: "channel-9" };
      if (path === "/channels/channel-9/members?page=0&per_page=200") {
        memberReads += 1;
        return [{ user_id: memberReads === 1 ? "first-attacker-mm" : "late-attacker-mm" }];
      }
      if (method === "DELETE" && path === "/channels/channel-9/members/first-attacker-mm") {
        return { ok: true };
      }
      throw new Error(`unexpected Mattermost call: ${method ?? "GET"} ${path}`);
    });

    await expect(createSessionChannel(actor(), input)).resolves.toEqual({
      status: 502,
      body: { error: "Channel creation failed - could not create chat channel" },
    });
    expect(h.mmApi).not.toHaveBeenCalledWith(
      "/channels/channel-9/patch",
      "PUT",
      expect.anything(),
    );
    expect(h.writes).toEqual([]);
  });

  it("recovers a Firestore write failure by adopting the exact Mattermost Task on retry", async () => {
    let channelCreateAttempts = 0;
    h.mmApi.mockReset().mockImplementation(async (path: string, method?: string) => {
      if (method === "POST" && path === "/channels") {
        channelCreateAttempts += 1;
        if (channelCreateAttempts === 1) return { id: "channel-1" };
        const err = new Error(
          'MM API 400: {"id":"store.sql_channel.save_channel.exists.app_error"}',
        ) as Error & { status: number };
        err.status = 400;
        throw err;
      }
      if (path === "/teams/team-1/channels/name/mira-patchroll") {
        return { id: "channel-1" };
      }
      if (path === "/channels/channel-1/members?page=0&per_page=200") return [];
      if (method === "PUT" && path === "/channels/channel-1/patch") {
        return { id: "channel-1" };
      }
      if (method === "POST" && path === "/channels/channel-1/members") {
        return { ok: true };
      }
      throw new Error(`unexpected Mattermost call: ${method ?? "GET"} ${path}`);
    });
    const put = vi.spyOn(platformStateStore.workspaces.channels, "put").mockRejectedValueOnce(new Error("store unavailable"));

    await expect(createSessionChannel(actor(), input)).rejects.toThrow("store unavailable");
    expect(h.writes).toEqual([]);
    put.mockRestore();

  h.enrollWorkspaceChannelMembers.mockReset().mockResolvedValue(undefined);
    await expect(createSessionChannel(actor(), input)).resolves.toEqual({
      status: 200,
      body: { success: true, channelId: "channel-1", name: "patchroll" },
    });
    expect(h.mmApi).toHaveBeenCalledWith(
      "/channels/channel-1/patch",
      "PUT",
      {
        display_name: "OpenClaw Patch Upgrade",
        purpose: "Roll OC patches",
      },
    );
    expect(h.docs.get(DOC_PATH)).toEqual(
      expect.objectContaining({ mattermost: { channelId: "channel-1" } }),
    );
    expect(h.writes[0]?.data).toEqual(expect.objectContaining({ purpose: "Roll OC patches" }));
  });

  it("finishes the presentation write on retry without creating another Mattermost channel", async () => {
    h.setError = new Error("Firestore unavailable");

    await expect(createSessionChannel(actor(), input)).rejects.toThrow("Firestore unavailable");
    expect(h.docs.get(DOC_PATH)).toEqual(
      expect.objectContaining({ mattermost: { channelId: "channel-1" }, createdBy: "owner-1" }),
    );

    h.setError = null;
    h.mmApi.mockClear();

    await expect(createSessionChannel(actor(), input)).resolves.toEqual({
      status: 200,
      body: { success: true, channelId: "channel-1", name: "patchroll" },
    });
    expect(h.mmApi).not.toHaveBeenCalledWith("/channels", "POST", expect.anything());
    expect(h.writes).toEqual([
      {
        path: DOC_PATH,
        data: {
          name: "patchroll",
          purpose: "Roll OC patches",
          createdDisplayName: "OpenClaw Patch Upgrade",
        },
        options: { merge: true },
      },
    ]);
  });

  it("does not adopt another creator's channel whose presentation is missing", async () => {
    h.docs.set(DOC_PATH, {
      id: "patchroll",
      kind: "session",
      mattermost: { channelId: "channel-1" },
      createdBy: "someone-else",
    });

    const result = await createSessionChannel(actor(), input);

    expect(result.status).toBe(409);
    expect(h.writes).toEqual([]);
  });

  it("does not adopt on a non-conflict MM 400", async () => {
    h.mmApi.mockReset().mockImplementation(async (path: string, method?: string) => {
      if (method === "POST" && path === "/channels") {
        const err = new Error("MM API 400: model.channel.is_valid.purpose.app_error") as Error & {
          status: number;
        };
        err.status = 400;
        throw err;
      }
      throw new Error(`unexpected Mattermost call: ${method ?? "GET"} ${path}`);
    });

    const result = await createSessionChannel(actor(), input);

    expect(result).toEqual({
      status: 502,
      body: { error: "Channel creation failed - could not create chat channel" },
    });
    expect(h.mmApi).not.toHaveBeenCalledWith("/teams/team-1/channels/name/mira-patchroll");
    expect(h.writes).toEqual([]);
  });

  it("fails loudly when a member cannot be added and does not write the doc", async () => {
    h.mmApi.mockImplementationOnce(async () => ({ id: "channel-1" }))
      .mockRejectedValueOnce(new Error("membership unavailable"));

    const result = await createSessionChannel(actor(), input);

    expect(result).toEqual({
      status: 502,
      body: { error: "Channel creation failed - could not add channel members" },
    });
    expect(h.logger.error).toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });
});

describe("createSessionChannel without a product presentation store", () => {
  const input = { name: "patchroll", displayName: "OpenClaw Patch Upgrade", purpose: "Roll OC patches" };

  beforeEach(() => installProjectPresentation(NO_PROJECT_PRESENTATION));
  afterEach(() => installDocumentPresentation(docRef));

  it("creates the Mattermost channel and its platform record", async () => {
    await expect(createSessionChannel(actor(), input)).resolves.toEqual({
      status: 200,
      body: { success: true, channelId: "channel-1", name: "patchroll" },
    });
    expect(h.docs.get(DOC_PATH)).toMatchObject({
      mattermost: { channelId: "channel-1" },
      createdBy: "owner-1",
    });
    expect(h.writes).toEqual([]);
  });

  it("answers the creator's repeat create with the existing channel", async () => {
    await createSessionChannel(actor(), input);
    h.mmApi.mockClear();

    await expect(createSessionChannel(actor(), input)).resolves.toEqual({
      status: 200,
      body: { success: true, channelId: "channel-1", name: "patchroll" },
    });
    expect(h.mmApi).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("refuses another member's create of a taken name", async () => {
    await createSessionChannel(actor(), input);
    h.mmApi.mockClear();

    await expect(createSessionChannel(actor({ uid: "member-2" }), input)).resolves.toEqual({
      status: 409,
      body: {
        error: 'A channel already uses the name "patchroll". Choose a name that differs within its first 17 letters and numbers.',
      },
    });
    expect(h.mmApi).not.toHaveBeenCalled();
  });
});

describe("renameSessionChannel", () => {
  it("keeps Task purpose immutable after creation", async () => {
    seedSessionDoc({ purpose: "Standing context" });

    const result = await renameSessionChannel(actor(), "patchroll", {
      purpose: "Different context",
    });

    expect(result).toEqual({
      status: 400,
      body: { error: "Task purpose cannot be changed after creation" },
    });
    expect(h.mmApi).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
  });

  it("refuses when the doc's MM channel does not belong to the caller's workspace naming lane", async () => {
    // Channel docs are server-managed (rules deny client writes), but the
    // admin-token MM call must hold the boundary on its own: never act on a
    // channel whose live MM name isn't {slug}-{name}, even from a forged or
    // corrupted doc.
    seedSessionDoc({ mattermost: { channelId: "foreign-channel" } });
    h.mmApi.mockReset().mockImplementation(async (path: string, method?: string) => {
      if (path === "/channels/foreign-channel" && (method === undefined || method === "GET")) {
        return { id: "foreign-channel", name: "victim-proj-app-general" };
      }
      throw new Error(`unexpected Mattermost call: ${method ?? "GET"} ${path}`);
    });

    const result = await renameSessionChannel(actor(), "patchroll", { displayName: "X" });

    expect(result).toEqual({
      status: 404,
      body: { error: "Session channel not found" },
    });
    expect(h.mmApi).not.toHaveBeenCalledWith("/channels/foreign-channel/patch", "PUT", expect.anything());
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("404s when the doc is missing or not a session channel", async () => {
    await expect(
      renameSessionChannel(actor(), "patchroll", { displayName: "New" }),
    ).resolves.toEqual({
      status: 404,
      body: { error: "Session channel not found" },
    });

    h.docs.set(DOC_PATH, { id: "patchroll", kind: "general", mattermost: { channelId: "channel-1" } });
    await expect(
      renameSessionChannel(actor(), "patchroll", { displayName: "New" }),
    ).resolves.toEqual({
      status: 404,
      body: { error: "Session channel not found" },
    });
    expect(h.mmApi).not.toHaveBeenCalled();
  });

  it("400s when no display name is provided", async () => {
    seedSessionDoc();
    await expect(renameSessionChannel(actor(), "patchroll", {})).resolves.toEqual({
      status: 400,
      body: { error: "Nothing to update" },
    });
  });

  it("patches the MM channel display name", async () => {
    seedSessionDoc();
    mockVerifiedMmChannel({ "/channels/channel-1/patch": { id: "channel-1" } });

    const result = await renameSessionChannel(actor(), "patchroll", {
      displayName: "OC Patch Upgrade",
    });

    expect(result).toEqual({ status: 200, body: { success: true } });
    expect(h.mmApi).toHaveBeenCalledWith("/channels/channel-1/patch", "PUT", {
      display_name: "OC Patch Upgrade",
    });
    expect(h.updates).toEqual([]);
  });

  it("surfaces a failed MM binding lookup as 502", async () => {
    seedSessionDoc();
    h.mmApi.mockReset().mockRejectedValue(new Error("MM down"));

    const result = await renameSessionChannel(actor(), "patchroll", { displayName: "New" });

    expect(result).toEqual({
      status: 502,
      body: { error: "Channel lookup failed" },
    });
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("surfaces MM patch failures as 502", async () => {
    seedSessionDoc();
    mockVerifiedMmChannel({ "/channels/channel-1/patch": new Error("MM down") });

    const result = await renameSessionChannel(actor(), "patchroll", { displayName: "New" });

    expect(result).toEqual({
      status: 502,
      body: { error: "Channel update failed" },
    });
    expect(h.logger.error).toHaveBeenCalled();
  });
});

describe("archiveSessionChannel", () => {
  it("404s when the doc is missing or not a session channel", async () => {
    await expect(archiveSessionChannel(actor(), "patchroll")).resolves.toEqual({
      status: 404,
      body: { error: "Session channel not found" },
    });
    expect(h.mmApi).not.toHaveBeenCalled();
  });

  it("refuses when the doc's MM channel does not belong to the caller's workspace naming lane", async () => {
    seedSessionDoc({ mattermost: { channelId: "foreign-channel" } });
    h.mmApi.mockReset().mockResolvedValue({ id: "foreign-channel", name: "victim-general" });

    const result = await archiveSessionChannel(actor(), "patchroll");

    expect(result).toEqual({
      status: 404,
      body: { error: "Session channel not found" },
    });
    expect(h.mmApi).not.toHaveBeenCalledWith("/channels/foreign-channel", "DELETE");
    expect(h.logger.error).toHaveBeenCalled();
    expect(h.docs.get(DOC_PATH)?.archivedAt).toBeUndefined();
  });

  it("archives the MM channel and stamps the doc", async () => {
    seedSessionDoc();
    mockVerifiedMmChannel({ "/channels/channel-1": { status: "OK" } });

    const result = await archiveSessionChannel(actor(), "patchroll");

    expect(result).toEqual({ status: 200, body: { success: true } });
    expect(h.setStoredChannelArchived).toHaveBeenCalledWith(DOC_PATH, true);
    expect(h.docs.get(DOC_PATH)?.archivedAt).toEqual(expect.any(Number));
  });

  it("is idempotent for an already-archived channel", async () => {
    seedSessionDoc({ archivedAt: ARCHIVED_AT });

    const result = await archiveSessionChannel(actor(), "patchroll");

    expect(result).toEqual({ status: 200, body: { success: true } });
    expect(h.setStoredChannelArchived).not.toHaveBeenCalled();
    expect(h.mmApi).not.toHaveBeenCalled();
    expect(h.docs.get(DOC_PATH)?.archivedAt).toBe(ARCHIVED_AT);
  });

  it("fails closed on a channel record whose archive time is not a time", async () => {
    seedSessionDoc({ archivedAt: "yesterday" });

    await expect(archiveSessionChannel(actor(), "patchroll")).rejects.toThrow(MalformedRecordError);

    expect(h.setStoredChannelArchived).not.toHaveBeenCalled();
    expect(h.mmApi).not.toHaveBeenCalled();
  });

  it("surfaces MM archive failures as 502", async () => {
    seedSessionDoc();
    mockVerifiedMmChannel({ "/channels/channel-1": { status: "OK" } });
    h.setStoredChannelArchived.mockRejectedValueOnce(new Error("MM down"));

    const result = await archiveSessionChannel(actor(), "patchroll");

    expect(result).toEqual({
      status: 502,
      body: { error: "Channel archive failed" },
    });
    expect(h.logger.error).toHaveBeenCalled();
  });
});

const PROJECT_DOC_PATH = "workspaces/mira/projects/orbit";
const PROJECT_CHANNEL_DOC_PATH = "workspaces/mira/projects/orbit/channels/patchroll";

function seedProjectDoc() {
  h.docs.set(PROJECT_DOC_PATH, {
    id: "orbit",
    slug: "orbit",
    ownerUid: "owner-1",
    provisioningState: "active",
    agent: { mode: "scoped", enabled: false },
  });
  h.docs.set("users/owner-1/secrets/projectAgentMattermost-orbit", {
    personalToken: "project-agent-pat",
    mmUserId: "project-agent-mm",
  });
}

function seedProjectSessionDoc(extra: Record<string, unknown> = {}) {
  h.docs.set(PROJECT_CHANNEL_DOC_PATH, {
    id: "patchroll",
    kind: "session",
    name: "patchroll",
    mattermost: {
      channelId: "channel-1",
    },
    ...extra,
  });
}

describe("createProjectSessionChannel", () => {
  const input = { name: "patchroll", displayName: "OC Patch Upgrade", purpose: "Rolls" };

  it("rejects an invalid project id before any reads", async () => {
    await expect(
      createProjectSessionChannel(actor(), "not-a-project!", input),
    ).resolves.toEqual({
      status: 400,
      body: { error: "Invalid project" },
    });
    expect(h.mmApi).not.toHaveBeenCalled();
  });

  it("404s when the project does not exist", async () => {
    await expect(createProjectSessionChannel(actor(), "orbit", input)).resolves.toEqual({
      status: 404,
      body: { error: "Project not found" },
    });
    expect(h.mmApi).not.toHaveBeenCalled();
  });

  it("rejects reserved names in the project lane too", async () => {
    seedProjectDoc();
    await expect(
      createProjectSessionChannel(actor(), "orbit", { ...input, name: "general" }),
    ).resolves.toEqual({
      status: 400,
      body: { error: "That channel name is reserved." },
    });
  });

  it("returns the stored project primary when the channel doc already exists", async () => {
    seedProjectDoc();
    seedProjectSessionDoc({ createdDisplayName: input.displayName });
    await expect(createProjectSessionChannel(actor(), "orbit", input)).resolves.toEqual({
      status: 200,
      body: { success: true, channelId: "channel-1", name: "patchroll" },
    });
  });

  it("creates the MM channel in the project naming lane and writes the project channel doc", async () => {
    seedProjectDoc();

    const result = await createProjectSessionChannel(actor(), "orbit", input);

    expect(result).toEqual({
      status: 200,
      body: { success: true, channelId: "channel-1", name: "patchroll" },
    });
    expect(h.mmApi).toHaveBeenCalledWith("/channels", "POST", {
      team_id: "team-1",
      name: "mira-proj-orbit-patchroll",
      display_name: "OC Patch Upgrade",
      type: "P",
      purpose: "Rolls",
    });
    expect(h.mmApi).toHaveBeenCalledWith("/channels/channel-1/members", "POST", { user_id: "owner-mm" });
    expect(h.mmApi).toHaveBeenCalledWith("/channels/channel-1/members", "POST", { user_id: "project-agent-mm" });
    expect(h.mmApi).not.toHaveBeenCalledWith("/channels/channel-1/members", "POST", { user_id: "coach-mm" });
    expect(h.docs.get(PROJECT_CHANNEL_DOC_PATH)).toMatchObject({
      id: "patchroll",
      kind: "session",
      mattermost: { channelId: "channel-1" },
      createdBy: "owner-1",
      createdAt: expect.any(Number),
    });
    expect(h.writes).toEqual([
      {
        path: PROJECT_CHANNEL_DOC_PATH,
        data: {
          name: "patchroll",
          purpose: "Rolls",
          createdDisplayName: "OC Patch Upgrade",
        },
        options: { merge: true },
      },
    ]);
  });

  it("keeps human project chat working when the project has no agent record", async () => {
    h.docs.set(PROJECT_DOC_PATH, {
      id: "orbit",
      slug: "orbit",
      ownerUid: "owner-1",
      provisioningState: "active",
    });
    h.docs.set("users/owner-1/secrets/projectAgentMattermost-orbit", {
      personalToken: "stale-project-agent-pat",
      mmUserId: "stale-project-agent-mm",
    });

    const result = await createProjectSessionChannel(actor(), "orbit", input);

    expect(result.status).toBe(200);
    expect(h.mmApi).toHaveBeenCalledWith("/channels/channel-1/members", "POST", { user_id: "owner-mm" });
    expect(h.mmApi).not.toHaveBeenCalledWith("/channels/channel-1/members", "POST", { user_id: "coach-mm" });
    expect(h.mmApi).not.toHaveBeenCalledWith(
      "/channels/channel-1/members",
      "POST",
      { user_id: "stale-project-agent-mm" },
    );
  });
});

describe("renameProjectSessionChannel", () => {
  it("verifies the binding against the project naming lane", async () => {
    seedProjectSessionDoc();
    h.mmApi.mockReset().mockImplementation(async (path: string, method?: string) => {
      if (path === "/channels/channel-1" && (method === undefined || method === "GET")) {
        return { id: "channel-1", name: "mira-proj-orbit-patchroll" };
      }
      if (method === "PUT" && path === "/channels/channel-1/patch") return { id: "channel-1" };
      throw new Error(`unexpected Mattermost call: ${method ?? "GET"} ${path}`);
    });

    const result = await renameProjectSessionChannel(actor(), "orbit", "patchroll", {
      displayName: "Renamed",
    });

    expect(result).toEqual({ status: 200, body: { success: true } });
  });

  it("refuses a project channel doc pointing outside its naming lane", async () => {
    seedProjectSessionDoc();
    h.mmApi.mockReset().mockResolvedValue({ id: "channel-1", name: "mira-patchroll" });

    const result = await renameProjectSessionChannel(actor(), "orbit", "patchroll", {
      displayName: "Renamed",
    });

    expect(result).toEqual({
      status: 404,
      body: { error: "Session channel not found" },
    });
    expect(h.logger.error).toHaveBeenCalled();
  });
});

describe("archiveProjectSessionChannel", () => {
  it("archives through the project lane and stamps the doc", async () => {
    seedProjectSessionDoc();
    h.mmApi.mockReset().mockImplementation(async (path: string, method?: string) => {
      if (path === "/channels/channel-1" && (method === undefined || method === "GET")) {
        return { id: "channel-1", name: "mira-proj-orbit-patchroll" };
      }
      if (method === "DELETE" && path === "/channels/channel-1") return { status: "OK" };
      throw new Error(`unexpected Mattermost call: ${method ?? "GET"} ${path}`);
    });

    const result = await archiveProjectSessionChannel(actor(), "orbit", "patchroll");

    expect(result).toEqual({ status: 200, body: { success: true } });
    expect(h.setStoredChannelArchived).toHaveBeenCalledWith(PROJECT_CHANNEL_DOC_PATH, true);
    expect(h.docs.get(PROJECT_CHANNEL_DOC_PATH)?.archivedAt).toEqual(expect.any(Number));
  });

  it("is idempotent for an already-archived project channel", async () => {
    seedProjectSessionDoc({ archivedAt: ARCHIVED_AT });

    const result = await archiveProjectSessionChannel(actor(), "orbit", "patchroll");

    expect(result).toEqual({ status: 200, body: { success: true } });
    expect(h.mmApi).not.toHaveBeenCalled();
  });
});

describe("reserved names are refused on rename/archive too (forged-doc lane attack)", () => {
  it("archive of a forged kind:'session' doc named 'general' in the project lane is refused before any MM call", async () => {
    // Attack from review: rewrite projects/{pid}/channels/general to
    // kind:'session' pointing at the REAL general channel — the binding check
    // alone would pass because the live MM name IS {wid}-proj-{pid}-general.
    h.docs.set("workspaces/mira/projects/orbit/channels/general", {
      id: "general",
      kind: "session",
      name: "general",
      mattermost: { channelId: "real-general-chan" },
    });

    const result = await archiveProjectSessionChannel(actor(), "orbit", "general");

    expect(result).toEqual({
      status: 404,
      body: { error: "Session channel not found" },
    });
    expect(h.mmApi).not.toHaveBeenCalled();
  });

  it("rename of a reserved-name doc in the workspace lane is refused before any MM call", async () => {
    h.docs.set("workspaces/mira/channels/coach", {
      id: "coach",
      kind: "session",
      name: "coach",
      mattermost: { channelId: "real-coach-chan" },
    });

    const result = await renameSessionChannel(actor(), "coach", { displayName: "X" });

    expect(result).toEqual({
      status: 404,
      body: { error: "Session channel not found" },
    });
    expect(h.mmApi).not.toHaveBeenCalled();
  });
});


describe("workspace group enrollment during channel creation", () => {
  it("publishes the channel before enrolling current workspace members", async () => {
    h.enrollWorkspaceChannelMembers.mockImplementation(async () => {
      expect(h.writes).toContainEqual(expect.objectContaining({ path: DOC_PATH }));
    });
    const result = await createSessionChannel(actor(), { name: "patchroll", displayName: "Planning" });
    expect(result.status).toBe(200);
    expect(h.enrollWorkspaceChannelMembers).toHaveBeenCalledWith("mira", "patchroll");
  });

  it("reports failed enrollment and completes it when creation is retried", async () => {
    h.enrollWorkspaceChannelMembers.mockRejectedValueOnce(new Error("Mattermost unavailable"));
    expect((await createSessionChannel(actor(), { name: "patchroll", displayName: "Planning" })).status).toBe(502);
    seedSessionDoc({ createdDisplayName: "Planning" });
    expect((await createSessionChannel(actor(), { name: "patchroll", displayName: "Planning" })).status).toBe(200);
    expect(h.enrollWorkspaceChannelMembers).toHaveBeenCalledTimes(2);
  });
});

function seedArchivedTask(name: string, extra: Record<string, unknown> = {}) {
  h.docs.set(`workspaces/mira/channels/${name}`, {
    id: name,
    kind: "session",
    name,
    mattermost: { channelId: `${name}-channel` },
    createdBy: "owner-1",
    archivedAt: ARCHIVED_AT,
    ...extra,
  });
}

function mockMmChannels(channels: Record<string, { name: string; display_name: string } | Error>) {
  h.mmApi.mockReset().mockImplementation(async (path: string, method?: string) => {
    const id = path.replace(/^\/channels\//, "");
    if ((method === undefined || method === "GET") && id in channels) {
      const value = channels[id];
      if (value instanceof Error) throw value;
      return { id, ...value };
    }
    throw new Error(`unexpected Mattermost call: ${method ?? "GET"} ${path}`);
  });
}

describe("listArchivedSessionChannels", () => {
  it("lists the caller's archived tasks newest first with their Mattermost titles", async () => {
    seedArchivedTask("older", { archivedAt: ARCHIVED_AT - 1000 });
    seedArchivedTask("newer", { archivedAt: ARCHIVED_AT });
    seedArchivedTask("live", { archivedAt: null });
    seedArchivedTask("theirs", { createdBy: "someone-else" });
    mockMmChannels({
      "older-channel": { name: "mira-older", display_name: "Older Task" },
      "newer-channel": { name: "mira-newer", display_name: "Newer Task" },
    });

    const result = await listArchivedSessionChannels(actor());

    expect(result).toEqual({
      status: 200,
      body: {
        channels: [
          { name: "newer", displayName: "Newer Task", archivedAt: ARCHIVED_AT },
          { name: "older", displayName: "Older Task", archivedAt: ARCHIVED_AT - 1000 },
        ],
      },
    });
  });

  it("omits and logs a record whose Mattermost channel is outside the caller's lane", async () => {
    seedArchivedTask("forged");
    mockMmChannels({ "forged-channel": { name: "victim-general", display_name: "General" } });

    const result = await listArchivedSessionChannels(actor());

    expect(result).toEqual({ status: 200, body: { channels: [] } });
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("surfaces a Mattermost lookup failure as 502", async () => {
    seedArchivedTask("patchroll");
    mockMmChannels({ "patchroll-channel": new Error("MM down") });

    const result = await listArchivedSessionChannels(actor());

    expect(result).toEqual({ status: 502, body: { error: "Archived task lookup failed" } });
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("refuses an unprovisioned workspace", async () => {
    await expect(listArchivedSessionChannels(actor({ workspaceId: null }))).resolves.toEqual({
      status: 422,
      body: { error: "Workspace not provisioned" },
    });
  });
});

describe("restoreSessionChannel", () => {
  it("refuses a caller who is not the task's owner before any Mattermost call", async () => {
    seedSessionDoc({ createdBy: "someone-else", archivedAt: ARCHIVED_AT });

    const result = await restoreSessionChannel(actor(), "patchroll");

    expect(result).toEqual({ status: 403, body: { error: "Only the task's owner can restore it" } });
    expect(h.mmApi).not.toHaveBeenCalled();
    expect(h.setStoredChannelArchived).not.toHaveBeenCalled();
    expect(h.docs.get(DOC_PATH)?.archivedAt).toBe(ARCHIVED_AT);
  });

  it("404s when the task does not exist", async () => {
    await expect(restoreSessionChannel(actor(), "patchroll")).resolves.toEqual({
      status: 404,
      body: { error: "Session channel not found" },
    });
    expect(h.mmApi).not.toHaveBeenCalled();
  });

  it("refuses when the record's Mattermost channel is outside the caller's lane", async () => {
    seedSessionDoc({ createdBy: "owner-1", archivedAt: ARCHIVED_AT });
    h.mmApi.mockReset().mockResolvedValue({ id: "channel-1", name: "victim-general" });

    const result = await restoreSessionChannel(actor(), "patchroll");

    expect(result).toEqual({ status: 404, body: { error: "Session channel not found" } });
    expect(h.setStoredChannelArchived).not.toHaveBeenCalled();
    expect(h.docs.get(DOC_PATH)?.archivedAt).toBe(ARCHIVED_AT);
  });

  it("restores the Mattermost channel, re-enrolls workspace members, then clears the archive", async () => {
    seedSessionDoc({ createdBy: "owner-1", archivedAt: ARCHIVED_AT });
    mockVerifiedMmChannel({});
    h.enrollWorkspaceChannelMembers.mockImplementation(async () => {
      expect(h.setStoredChannelArchived).toHaveBeenCalledWith(DOC_PATH, false);
      expect(h.docs.get(DOC_PATH)?.archivedAt).toBe(ARCHIVED_AT);
    });

    const result = await restoreSessionChannel(actor(), "patchroll");

    expect(result).toEqual({
      status: 200,
      body: { success: true, channelId: "channel-1", name: "patchroll" },
    });
    expect(h.enrollWorkspaceChannelMembers).toHaveBeenCalledWith("mira", "patchroll");
    expect(h.docs.get(DOC_PATH)?.archivedAt).toBeNull();
  });

  it("is a no-op for a task that is not archived", async () => {
    seedSessionDoc({ createdBy: "owner-1", archivedAt: null });

    const result = await restoreSessionChannel(actor(), "patchroll");

    expect(result).toEqual({
      status: 200,
      body: { success: true, channelId: "channel-1", name: "patchroll" },
    });
    expect(h.mmApi).not.toHaveBeenCalled();
    expect(h.setStoredChannelArchived).not.toHaveBeenCalled();
  });

  it("keeps the task archived when the Mattermost restore fails", async () => {
    seedSessionDoc({ createdBy: "owner-1", archivedAt: ARCHIVED_AT });
    mockVerifiedMmChannel({});
    h.setStoredChannelArchived.mockRejectedValueOnce(new Error("MM down"));

    const result = await restoreSessionChannel(actor(), "patchroll");

    expect(result).toEqual({ status: 502, body: { error: "Channel restore failed" } });
    expect(h.enrollWorkspaceChannelMembers).not.toHaveBeenCalled();
    expect(h.docs.get(DOC_PATH)?.archivedAt).toBe(ARCHIVED_AT);
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("keeps the task archived when member enrollment fails, and completes on retry", async () => {
    seedSessionDoc({ createdBy: "owner-1", archivedAt: ARCHIVED_AT });
    mockVerifiedMmChannel({});
    h.enrollWorkspaceChannelMembers.mockRejectedValueOnce(new Error("MM down"));

    expect(await restoreSessionChannel(actor(), "patchroll")).toEqual({
      status: 502,
      body: { error: "Channel restore failed - could not add workspace members" },
    });
    expect(h.docs.get(DOC_PATH)?.archivedAt).toBe(ARCHIVED_AT);

    expect((await restoreSessionChannel(actor(), "patchroll")).status).toBe(200);
    expect(h.enrollWorkspaceChannelMembers).toHaveBeenCalledTimes(2);
    expect(h.docs.get(DOC_PATH)?.archivedAt).toBeNull();
  });
});
