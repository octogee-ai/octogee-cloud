import { afterEach, describe, expect, it, vi } from "vitest";

import { createMattermostChannelHost } from "@octogee/core/channel-host";
import { controlUiCommandUrl } from "@octogee/core/mattermost/control-ui-command";
import { provisionMattermostUser } from "@octogee/core/mattermost/provision";
import { computeWorkspaceDisplayName } from "@octogee/shared/types/display-names";

import { createMattermostChatHost } from "./chat-host-mattermost.js";
import { FakeMattermostApi } from "./__tests__/mattermost-api.fake.js";

const legacyStore = vi.hoisted(() => ({
  platformStateStore: {
    users: { records: { get: async () => null } },
    secrets: { put: async () => undefined },
  },
}));

vi.mock("@octogee/core/provisioner-platform-state", () => legacyStore);

const NAMESPACE = "octogee-test";
const USER = { uid: "u_123", slug: "lin", firstName: "Lin", lastName: "Wu", email: "lin@example.com", photoURL: "https://images.invalid/lin.png" };

function freshApi() {
  const api = new FakeMattermostApi();
  const admin = api.addUser({ username: "platform-admin" });
  api.imageSources.set(USER.photoURL, { status: 200, contentType: "image/png" });
  return { api, admin };
}

function chatState(api: FakeMattermostApi) {
  const username = (id: string) => [...api.users.values()].find((user) => user.id === id)?.username ?? `unknown:${id}`;
  const teamName = (id: string) => api.teams.get(id)?.name ?? `unknown:${id}`;
  return {
    users: Object.fromEntries([...api.users.values()].map((user) => [user.username, {
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      nickname: user.nickname,
      deactivated: user.delete_at > 0,
      bot: user.is_bot,
      botDescription: user.bot_description ?? null,
      avatarUploads: api.avatars.get(user.id) ?? 0,
    }])),
    teams: Object.fromEntries([...api.teams.values()].map((team) => [team.name, {
      displayName: team.display_name,
      type: team.type,
      members: [...team.members.entries()].map(([id, roles]) => `${username(id)}:${roles}`).sort(),
    }])),
    channels: Object.fromEntries([...api.channels.values()].map((channel) => [`${teamName(channel.team_id)}/${channel.name}`, {
      type: channel.type,
      displayName: channel.display_name,
      purpose: channel.purpose,
      archived: channel.delete_at > 0,
      members: [...channel.members].map(username).sort(),
    }])),
    commands: [...api.commands.values()].map(({ id: _id, token: _token, team_id: teamId, ...command }) => ({ team: teamName(teamId), ...command })),
    tokens: api.tokens.map((token) => `${username(token.userId)}:${token.description}`).sort(),
  };
}

describe("Mattermost chat host adapter against the legacy provisioning path", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("leaves the chat host in the same state as provisionMattermostUser for a new user", async () => {
    const legacy = freshApi();
    vi.stubEnv("MM_URL", legacy.api.baseUrl);
    vi.stubEnv("MM_ADMIN_TOKEN", "admin-token");
    vi.stubEnv("MM_ADMIN_USER_ID", legacy.admin.id);
    vi.stubEnv("K8S_NAMESPACE", NAMESPACE);
    vi.stubGlobal("fetch", legacy.api.fetch);
    const legacyResult = await provisionMattermostUser(
      { ...USER, vibe: null },
      createMattermostChannelHost({ baseUrl: legacy.api.baseUrl, adminToken: "admin-token", fetch: legacy.api.fetch }),
      async () => ({ username: null, coachChannelName: null }),
    );
    expect(legacyResult["mattermost.userId"]).toEqual(expect.any(String));

    const adapter = freshApi();
    const host = createMattermostChatHost({
      baseUrl: adapter.api.baseUrl,
      adminToken: "admin-token",
      adminUserId: adapter.admin.id,
      controlCommandUrl: controlUiCommandUrl(NAMESPACE),
      fetch: adapter.api.fetch,
      log: { info: () => undefined, error: () => undefined },
    });
    const signal = new AbortController().signal;
    const { userId } = await host.ensureUser({
      uid: USER.uid,
      slug: USER.slug,
      email: USER.email,
      displayName: { first: USER.firstName, last: USER.lastName },
      avatarUrl: USER.photoURL,
    }, signal);
    const { teamId } = await host.ensureTeam({
      slug: USER.slug,
      displayName: computeWorkspaceDisplayName({ slug: USER.slug, firstName: USER.firstName, vibe: null }),
      userId,
    }, signal);
    const channels = await host.ensureChannels({ slug: USER.slug, ownerFirstName: USER.firstName, teamId, userId, agentChannel: true }, signal);
    const { botUserId } = await host.ensureAgentBot({
      slug: USER.slug,
      ownerFirstName: USER.firstName,
      teamId,
      agentChannelId: channels.agent,
      generalChannelId: channels.general,
    }, signal);
    await host.issueUserToken({ userId }, signal);
    await host.issueAgentToken({ botUserId }, signal);

    expect(chatState(adapter.api)).toEqual(chatState(legacy.api));
  });
});
