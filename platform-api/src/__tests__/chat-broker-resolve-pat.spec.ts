import { describe, expect, it } from "vitest";
import { DuplicateRecordError, MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import {
  ChatPatError,
  resolveChatIdentity,
} from "../lib/chat-broker/resolve-pat.js";

type Docs = Record<string, Record<string, unknown>>;

function dbOf(docs: Docs) {
  return {
    readAccount: async (uid: string) => docs[`users/${uid}`],
    store: createDocumentFixtureStore(docs),
  };
}

const UID = "uid-1";
const SLUG = "alice";

describe("resolveChatIdentity", () => {
  it("keeps the user context but admits only canonical non-admin channels", async () => {
    const generalId = "g".repeat(26);
    const adminId = "a".repeat(26);
    const joinedProjectId = "j".repeat(26);
    const foreignProjectId = "f".repeat(26);
    const db = dbOf({
      [`users/${UID}/secrets/mattermost`]: { personalToken: "user-pat" },
      [`users/${UID}/secrets/coachMattermost`]: {
        personalToken: "default-agent-pat",
        coachMmUserId: "mm-coach-bot",
      },
      [`workspaces/${SLUG}/channels/general`]: {
        mattermost: { channelId: generalId },
      },
      [`workspaces/${SLUG}/channels/admin`]: {
        mattermost: { channelId: adminId },
      },
      "workspaces/bob/projects/roadmap": {
        ownerUid: "uid-bob",
      },
      [`workspaces/bob/projects/roadmap/members/${UID}`]: {
        id: UID,
        role: "member",
      },
      "workspaces/bob/projects/roadmap/channels/general": {
        mattermost: { channelId: joinedProjectId },
      },
      "workspaces/carol/projects/private": {
        ownerUid: "uid-carol",
      },
      "workspaces/carol/projects/private/channels/general": {
        mattermost: { channelId: foreignProjectId },
      },
    });
    const identity = await resolveChatIdentity(db, {
      uid: UID,
      slug: SLUG,
      agentId: "octogee-alice-coach",
    });
    expect(identity).toMatchObject({
      lane: "workspace",
      pat: "user-pat",
      defaultAgentMmUserId: "mm-coach-bot",
      unread: { pat: "default-agent-pat", mmUserId: "mm-coach-bot" },
    });
    expect(await identity.canReadChannel(generalId)).toBe(true);
    expect(await identity.canReadChannel(adminId)).toBe(false);
    expect(await identity.canReadChannel(joinedProjectId)).toBe(true);
    expect(await identity.canReadChannel(foreignProjectId)).toBe(false);
    expect(await identity.canReadChannel("d".repeat(26))).toBe(false);
  });

  it("lets only the workspace agent retrieve archived project history before the deadline", async () => {
    const db = dbOf({
      [`users/${UID}`]: {
        projectRetention: {
          schemaVersion: 1,
          status: "archived",
          archivedAt: "2026-07-01T00:00:00.000Z",
          deleteAfter: "2099-09-29T00:00:00.000Z",
          warnedAt: null,
        },
      },
      [`users/${UID}/secrets/mattermost`]: { personalToken: "user-pat" },
      [`users/${UID}/secrets/coachMattermost`]: {
        personalToken: "default-agent-pat",
        coachMmUserId: "mm-coach-bot",
      },
    });

    await expect(resolveChatIdentity(db, {
      uid: UID,
      slug: SLUG,
      agentId: "octogee-alice-coach",
    })).resolves.toMatchObject({
      lane: "workspace",
      includeArchivedProjectHistory: true,
    });

    await expect(resolveChatIdentity(db, {
      uid: UID,
      slug: SLUG,
      agentId: "octogee-alice-proj-camp-coach",
    })).rejects.toMatchObject({ code: "project-archived" });
  });

  it("stops archived history reads when the retention deadline has passed", async () => {
    const db = dbOf({
      [`users/${UID}`]: {
        projectRetention: {
          schemaVersion: 1,
          status: "archived",
          archivedAt: "2020-01-01T00:00:00.000Z",
          deleteAfter: "2020-03-31T00:00:00.000Z",
          warnedAt: null,
        },
      },
      [`users/${UID}/secrets/mattermost`]: { personalToken: "user-pat" },
      [`users/${UID}/secrets/coachMattermost`]: {
        personalToken: "default-agent-pat",
        coachMmUserId: "mm-coach-bot",
      },
    });

    await expect(resolveChatIdentity(db, {
      uid: UID,
      slug: SLUG,
      agentId: "octogee-alice-coach",
    })).resolves.not.toHaveProperty("includeArchivedProjectHistory");
  });

  it("project agent reads with ITS OWN bot PAT (channel membership = the capability boundary)", async () => {
    const db = dbOf({
      [`users/${UID}/secrets/projectAgentMattermost-camp`]: {
        personalToken: "proj-pat",
        mmUserId: "mm-proj-bot",
      },
    });
    const identity = await resolveChatIdentity(db, {
      uid: UID,
      slug: SLUG,
      agentId: "octogee-alice-proj-camp-coach",
    });
    expect(identity).toEqual({
      lane: "project",
      pat: "proj-pat",
      defaultAgentMmUserId: "mm-proj-bot",
      unread: { pat: "proj-pat", mmUserId: "mm-proj-bot" },
    });
  });

  it("rejects an agent id whose slug does not match the assigned workspace", async () => {
    await expect(
      resolveChatIdentity(dbOf({}), {
        uid: UID,
        slug: SLUG,
        agentId: "octogee-bob-coach",
      }),
    ).rejects.toMatchObject({ code: "foreign-agent" });
  });

  it("rejects an unparseable agent id", async () => {
    await expect(
      resolveChatIdentity(dbOf({}), { uid: UID, slug: SLUG, agentId: "not-an-agent" }),
    ).rejects.toMatchObject({ code: "invalid-agent" });
  });

  it("fails loud when the user PAT is missing", async () => {
    const db = dbOf({
      [`users/${UID}/secrets/coachMattermost`]: {
        personalToken: "default-agent-pat",
        coachMmUserId: "mm-coach-bot",
      },
    });
    await expect(
      resolveChatIdentity(db, { uid: UID, slug: SLUG, agentId: "octogee-alice-coach" }),
    ).rejects.toMatchObject({ code: "no-builder-pat" });
  });

  it("fails loud when the project agent secret is missing — a disabled agent has NO read capability", async () => {
    await expect(
      resolveChatIdentity(dbOf({}), {
        uid: UID,
        slug: SLUG,
        agentId: "octogee-alice-proj-camp-coach",
      }),
    ).rejects.toMatchObject({ code: "no-project-pat" });
  });

  it("fails loud when the agent bot's exclusion id is unavailable", async () => {
    const db = dbOf({
      [`users/${UID}/secrets/mattermost`]: { personalToken: "user-pat" },
    });
    await expect(
      resolveChatIdentity(db, { uid: UID, slug: SLUG, agentId: "octogee-alice-coach" }),
    ).rejects.toMatchObject({ code: "no-coach-identity" });
  });

  it("fails closed when the agent bot's secret stores no PAT (the unread cursor has no credential)", async () => {
    const db = dbOf({
      [`users/${UID}/secrets/mattermost`]: { personalToken: "user-pat" },
      [`users/${UID}/secrets/coachMattermost`]: { coachMmUserId: "mm-coach-bot" },
    });
    await expect(
      resolveChatIdentity(db, { uid: UID, slug: SLUG, agentId: "octogee-alice-coach" }),
    ).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("fails loud when the agent bot's PAT is blank (the unread cursor has no credential)", async () => {
    const db = dbOf({
      [`users/${UID}/secrets/mattermost`]: { personalToken: "user-pat" },
      [`users/${UID}/secrets/coachMattermost`]: { personalToken: "", coachMmUserId: "mm-coach-bot" },
    });
    await expect(
      resolveChatIdentity(db, { uid: UID, slug: SLUG, agentId: "octogee-alice-coach" }),
    ).rejects.toMatchObject({ code: "no-coach-identity" });
  });

  it("fails closed when two canonical channels claim one Mattermost channel", async () => {
    const sharedId = "s".repeat(26);
    const db = dbOf({
      [`users/${UID}/secrets/mattermost`]: { personalToken: "user-pat" },
      [`users/${UID}/secrets/coachMattermost`]: {
        personalToken: "default-agent-pat",
        coachMmUserId: "mm-coach-bot",
      },
      [`workspaces/${SLUG}/channels/general`]: { mattermost: { channelId: sharedId } },
      "workspaces/carol/channels/general": { mattermost: { channelId: sharedId } },
    });
    const identity = await resolveChatIdentity(db, {
      uid: UID,
      slug: SLUG,
      agentId: "octogee-alice-coach",
    });
    await expect(identity.canReadChannel(sharedId)).rejects.toBeInstanceOf(DuplicateRecordError);
  });

  it("errors are ChatPatError instances carrying a bounded code", async () => {
    const err = await resolveChatIdentity(dbOf({}), {
      uid: UID,
      slug: SLUG,
      agentId: "octogee-alice-proj-camp-coach",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatPatError);
  });
});
