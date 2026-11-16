import { describe, expect, it } from "vitest";

import { defaultAgentChannelPurpose } from "@octogee/core/mattermost/agent-channel-purpose";
import { controlUiCommandSpec } from "@octogee/core/mattermost/control-ui-command";
import { DEFAULT_AGENT_PAT_DESCRIPTION } from "@octogee/core/mattermost/default-agent-pat";
import { USER_PAT_DESCRIPTION } from "@octogee/core/mattermost/user-pat";
import { placeholderEmail } from "@octogee/core/placeholder-email";
import {
  workspaceDefaultAgentChannelName,
  workspaceDefaultAgentMmUsername,
  workspaceGeneralChannelName,
} from "@octogee/shared/types/identity";

import type { ChatUserInput } from "./chat-host.js";
import { createMattermostChatHost, gravatarUrl } from "./chat-host-mattermost.js";
import { HostError } from "./host-error.js";
import { FakeMattermostApi } from "./__tests__/mattermost-api.fake.js";

const COMMAND_URL = "http://callback.invalid/internal/mattermost/commands/control-ui";
const signal = () => new AbortController().signal;

function setup() {
  const api = new FakeMattermostApi();
  const admin = api.addUser({ username: "platform-admin" });
  const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const host = createMattermostChatHost({
    baseUrl: api.baseUrl,
    adminToken: "admin-token",
    adminUserId: admin.id,
    controlCommandUrl: COMMAND_URL,
    fetch: api.fetch,
    log: {
      info: (message, fields) => logs.push({ level: "info", message, fields }),
      error: (message, fields) => logs.push({ level: "error", message, fields }),
    },
  });
  return { api, admin, host, logs };
}

const userInput = (overrides: Partial<ChatUserInput> = {}): ChatUserInput => ({
  uid: "u_123",
  slug: "lin",
  email: "lin@example.com",
  displayName: { first: "Lin", last: "Wu" },
  avatarUrl: "https://images.invalid/lin.png",
  ...overrides,
});

async function converge(context: ReturnType<typeof setup>) {
  const { host, api } = context;
  api.imageSources.set("https://images.invalid/lin.png", { status: 200, contentType: "image/png" });
  const { userId } = await host.ensureUser(userInput(), signal());
  const { teamId } = await host.ensureTeam({ slug: "lin", displayName: "Lin's Workshop", userId }, signal());
  const channels = await host.ensureChannels({ slug: "lin", ownerFirstName: "Lin", teamId, userId, agentChannel: true }, signal());
  const { botUserId } = await host.ensureAgentBot(
    { slug: "lin", ownerFirstName: "Lin", teamId, agentChannelId: channels.agent, generalChannelId: channels.general },
    signal(),
  );
  return { userId, teamId, channels, botUserId };
}

describe("Mattermost chat host adapter", () => {
  it("creates a new user's account, team, channels and agent bot under the legacy names", async () => {
    const context = setup();
    const { api, admin } = context;
    const { userId, teamId, channels, botUserId } = await converge(context);

    const user = api.users.get(userId)!;
    expect(user).toMatchObject({ username: "lin", email: "lin@example.com", first_name: "Lin", last_name: "Wu", nickname: "Lin" });
    expect(api.avatars.get(userId)).toBe(1);

    const team = api.teams.get(teamId)!;
    expect(team).toMatchObject({ name: "lin", display_name: "Lin's Workshop", type: "I" });
    expect(team.members.get(userId)).toBe("team_user");
    expect(team.members.has(admin.id)).toBe(true);
    expect(team.members.has(botUserId)).toBe(true);
    expect(api.channelByName(teamId, "off-topic")?.delete_at).toBeGreaterThan(0);
    expect(api.channelByName(teamId, "town-square")?.delete_at).toBe(0);
    const expectedCommand = controlUiCommandSpec(teamId, COMMAND_URL);
    expect([...api.commands.values()]).toEqual([
      expect.objectContaining({ team_id: teamId, trigger: expectedCommand.trigger, url: COMMAND_URL, method: "P" }),
    ]);

    const agent = api.channels.get(channels.agent!)!;
    expect(agent).toMatchObject({ name: workspaceDefaultAgentChannelName("lin"), type: "P", display_name: "Coach" });
    expect(agent.purpose).toBe(defaultAgentChannelPurpose("Lin"));
    expect([...agent.members].sort()).toEqual([userId, admin.id, botUserId].sort());
    const general = api.channels.get(channels.general)!;
    expect(general).toMatchObject({ name: workspaceGeneralChannelName("lin"), type: "P", display_name: "General" });
    expect([...general.members].sort()).toEqual([userId, admin.id, botUserId].sort());

    const bot = api.users.get(botUserId)!;
    expect(bot).toMatchObject({ username: workspaceDefaultAgentMmUsername("lin"), is_bot: true, first_name: "Octo", bot_description: "Coach for Lin" });
    expect(general.purpose).toBe("Lin's workspace — general discussion");
  });

  it("adopts the recorded bot by ID even when its username differs from the default", async () => {
    const { api, host } = setup();
    const owner = api.addUser({ username: "lin" });
    const existing = api.addUser({ username: "legacy-coach", is_bot: true });
    const { teamId } = await host.ensureTeam({ slug: "lin", displayName: "Lin's Workshop", userId: owner.id }, signal());

    await expect(host.ensureAgentBot({ slug: "lin", ownerFirstName: "Lin", teamId, existingBotUserId: existing.id }, signal()))
      .resolves.toEqual({ botUserId: existing.id });

    expect(api.users.get(existing.id)?.username).toBe("legacy-coach");
    expect(api.teams.get(teamId)?.members.has(existing.id)).toBe(true);
    expect(api.count("POST", /^\/bots$/)).toBe(0);
    expect(api.count("GET", /^\/users\/username\/lin-coach$/)).toBe(0);
  });

  it.each(["missing", "inactive", "human"])("refuses a recorded bot ID that is %s without creating a replacement", async (kind) => {
    const { api, host } = setup();
    const existing = api.addUser({ username: "legacy-coach", is_bot: kind !== "human", delete_at: kind === "inactive" ? 1 : 0 });
    if (kind === "missing") api.users.delete(existing.id);

    await expect(host.ensureAgentBot({ slug: "lin", ownerFirstName: "Lin", teamId: "team", existingBotUserId: existing.id }, signal()))
      .rejects.toThrow("recorded agent bot is missing or inactive");

    expect(api.count("POST", /^\/bots$/)).toBe(0);
    expect(api.count("GET", /^\/users\/username\/lin-coach$/)).toBe(0);
  });

  it("asks the chat host for exactly the names the legacy provisioning path uses", async () => {
    const context = setup();
    const { teamId } = await converge(context);
    const names = (method: string, path: string) =>
      context.api.requests.filter((request) => request.method === method && request.path.startsWith(path));
    expect(names("GET", "/users/username/").map((request) => request.path)).toEqual(
      expect.arrayContaining(["/users/username/lin", "/users/username/lin-coach"]),
    );
    expect(names("GET", "/teams/name/").map((request) => request.path)).toEqual(["/teams/name/lin"]);
    expect(names("GET", `/teams/${teamId}/channels/name/`).map((request) => request.path.split("?")[0])).toEqual([
      `/teams/${teamId}/channels/name/town-square`,
      `/teams/${teamId}/channels/name/off-topic`,
      `/teams/${teamId}/channels/name/general`,
      `/teams/${teamId}/channels/name/lin-coach`,
      `/teams/${teamId}/channels/name/lin-general`,
    ]);
    expect("lin-coach").toBe(workspaceDefaultAgentMmUsername("lin"));
    expect("lin-coach").toBe(workspaceDefaultAgentChannelName("lin"));
    expect("lin-general").toBe(workspaceGeneralChannelName("lin"));
  });

  it("confirms stored ids on a second attempt without creating anything or uploading the avatar again", async () => {
    const context = setup();
    const { host, api } = context;
    const first = await converge(context);
    const before = { users: api.users.size, teams: api.teams.size, channels: api.channels.size };
    api.requests.length = 0;

    await host.ensureUser(userInput({ knownUserId: first.userId }), signal());
    await host.ensureTeam({ slug: "lin", displayName: "Lin's Workshop", userId: first.userId, knownTeamId: first.teamId }, signal());
    await host.ensureChannels({ slug: "lin", ownerFirstName: "Lin", teamId: first.teamId, userId: first.userId, agentChannel: true, known: first.channels }, signal());
    await host.ensureAgentBot(
      { slug: "lin", ownerFirstName: "Lin", teamId: first.teamId, agentChannelId: first.channels.agent, generalChannelId: first.channels.general, knownBotUserId: first.botUserId },
      signal(),
    );

    expect({ users: api.users.size, teams: api.teams.size, channels: api.channels.size }).toEqual(before);
    expect(api.count("POST", /^\/(users|teams|channels|bots|commands)$/)).toBe(0);
    expect(api.avatars.get(first.userId)).toBe(1);
  });

  it("adopts an account found by username when the stored id is gone", async () => {
    const { api, host } = setup();
    const existing = api.addUser({ username: "lin" });
    api.imageSources.set("https://images.invalid/lin.png", { status: 200, contentType: "image/png" });
    await expect(host.ensureUser(userInput({ knownUserId: "user-deleted" }), signal())).resolves.toEqual({ userId: existing.id });
    expect(api.count("POST", /^\/users$/)).toBe(0);
    expect(api.imageRequests).toEqual([]);
    expect(api.count("POST", /\/image$/)).toBe(0);
  });

  it("adopts a deactivated account found by username as it is, without reactivating it", async () => {
    const { api, host } = setup();
    const existing = api.addUser({ username: "lin", delete_at: 1 });
    api.imageSources.set("https://images.invalid/lin.png", { status: 200, contentType: "image/png" });
    await expect(host.ensureUser(userInput(), signal())).resolves.toEqual({ userId: existing.id });
    expect(existing.delete_at).toBe(1);
    expect(api.count("PUT", /\/active$/)).toBe(0);
    expect(api.count("POST", /\/image$/)).toBe(0);
  });

  it("reactivates and renames an account held by the same email under another username", async () => {
    const { api, host } = setup();
    const existing = api.addUser({ username: "old-name", email: "lin@example.com", delete_at: 1 });
    api.imageSources.set("https://images.invalid/lin.png", { status: 200, contentType: "image/png" });
    await expect(host.ensureUser(userInput(), signal())).resolves.toEqual({ userId: existing.id });
    expect(existing).toMatchObject({ username: "lin", first_name: "Lin", last_name: "Wu", delete_at: 0 });
    expect(api.count("POST", /\/image$/)).toBe(0);
  });

  it("settles two concurrent creates of the same account, team, channel and bot as one resource each", async () => {
    const context = setup();
    const { api, host } = context;
    api.imageSources.set("https://images.invalid/lin.png", { status: 200, contentType: "image/png" });

    const users = await Promise.all([host.ensureUser(userInput(), signal()), host.ensureUser(userInput(), signal())]);
    expect(users[0].userId).toBe(users[1].userId);
    expect([...api.users.values()].filter((user) => user.username === "lin")).toHaveLength(1);
    expect(api.requests.filter((request) => request.method === "POST" && request.path === "/users")).toHaveLength(2);
    expect(api.count("POST", /\/image$/)).toBe(1);

    const userId = users[0].userId;
    const teams = await Promise.all([1, 2].map(() => host.ensureTeam({ slug: "lin", displayName: "Lin", userId }, signal())));
    expect(teams[0].teamId).toBe(teams[1].teamId);
    expect([...api.teams.values()].filter((team) => team.name === "lin")).toHaveLength(1);

    const teamId = teams[0].teamId;
    const channels = await Promise.all([1, 2].map(() => host.ensureChannels({ slug: "lin", ownerFirstName: "Lin", teamId, userId, agentChannel: true }, signal())));
    expect(channels[0]).toEqual(channels[1]);
    expect([...api.channels.values()].filter((channel) => channel.name.startsWith("lin-"))).toHaveLength(2);

    const bots = await Promise.all([1, 2].map(() => host.ensureAgentBot({ slug: "lin", ownerFirstName: "Lin", teamId }, signal())));
    expect(bots[0].botUserId).toBe(bots[1].botUserId);
    expect([...api.users.values()].filter((user) => user.username === "lin-coach")).toHaveLength(1);
  });

  it("restores an archived agent channel instead of failing to create it", async () => {
    const { api, host } = setup();
    const user = api.addUser({ username: "lin" });
    const team = api.addTeam("lin");
    const archived = api.addChannel(team.id, "lin-coach", { delete_at: 5, type: "P" });
    const channels = await host.ensureChannels({ slug: "lin", ownerFirstName: "Lin", teamId: team.id, userId: user.id, agentChannel: true }, signal());
    expect(channels.agent).toBe(archived.id);
    expect(archived.delete_at).toBe(0);
  });

  it("points an existing control command at the configured callback", async () => {
    const { api, host } = setup();
    const user = api.addUser({ username: "lin" });
    const team = api.addTeam("lin");
    api.commands.set("command-old", { id: "command-old", team_id: team.id, trigger: "ui", url: "http://old.invalid", method: "P", token: "t" });
    await host.ensureTeam({ slug: "lin", displayName: "Lin", userId: user.id }, signal());
    expect(api.commands.get("command-old")).toMatchObject({ url: COMMAND_URL });
    expect(api.commands.size).toBe(1);
  });

  it("returns a failed avatar upload as a warning and logs it as an error without failing the account", async () => {
    const { api, host, logs } = setup();
    api.imageSources.set("https://images.invalid/lin.png", { status: 200, contentType: "image/png" });
    api.fail("POST", /\/image$/, 413);
    const result = await host.ensureUser(userInput(), signal());
    expect(result.warnings).toEqual(["avatar upload: 413 from chat host"]);
    expect(logs).toContainEqual(expect.objectContaining({ level: "error", message: "[provisioning] chat avatar upload failed" }));
  });

  it("gives an account with no email the placeholder address of its uid and uploads no avatar", async () => {
    const { api, host } = setup();
    const { userId } = await host.ensureUser(userInput({ email: "", avatarUrl: null }), signal());
    expect(api.users.get(userId)?.email).toBe(placeholderEmail("u_123"));
    expect(api.avatars.has(userId)).toBe(false);
  });

  it("refuses an avatar source that is not https without fetching it", async () => {
    const { api, host, logs } = setup();
    const result = await host.ensureUser(userInput({ avatarUrl: "http://images.invalid/lin.png" }), signal());
    expect(result.warnings).toEqual(["avatar fetch: the image source is not an https url"]);
    expect(api.imageRequests).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ level: "error", fields: expect.objectContaining({ uid: "u_123" }) }));
  });

  it("refuses an avatar image larger than five megabytes", async () => {
    const { api, host } = setup();
    api.imageSources.set("https://images.invalid/lin.png", { status: 200, contentType: "image/png", bytes: 5 * 1024 * 1024 + 1 });
    const result = await host.ensureUser(userInput(), signal());
    expect(result.warnings).toEqual([`avatar fetch: the image is larger than ${5 * 1024 * 1024} bytes`]);
    expect(api.count("POST", /\/image$/)).toBe(0);
  });

  it("uses the email's avatar image when the spec carries no avatar url", async () => {
    const { api, host } = setup();
    api.imageSources.set(gravatarUrl("lin@example.com"), { status: 200, contentType: "image/jpeg" });
    const { userId, warnings } = await host.ensureUser(userInput({ avatarUrl: null }), signal());
    expect(warnings).toBeUndefined();
    expect(api.avatars.get(userId)).toBe(1);
  });

  it.each([
    [503, "transient"],
    [429, "transient"],
    [400, "terminal"],
    [403, "terminal"],
  ] as const)("classes a %i from the chat host as %s", async (status, kind) => {
    const { api, host } = setup();
    api.fail("POST", /^\/users$/, status);
    const error = await host.ensureUser(userInput(), signal()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostError);
    expect(error).toMatchObject({ kind });
    expect(api.userByName("lin")).toBeUndefined();
    expect((error as Error).message).toMatch(new RegExp(`: ${status} from chat host \\(fake\\.injected\\)$`));
    expect((error as Error).message).not.toContain("echoed");
  });

  it("classes an unreachable chat host as transient", async () => {
    const { api, host } = setup();
    api.fail("GET", /^\/teams\/name\//, 0);
    await expect(host.ensureTeam({ slug: "lin", displayName: "Lin", userId: "u" }, signal())).rejects.toMatchObject({ kind: "transient" });
  });

  it("fails the team step when a default channel cannot be archived for a reason other than being undeletable", async () => {
    const { api, host } = setup();
    const user = api.addUser({ username: "lin" });
    api.addChannel(api.addTeam("lin").id, "off-topic");
    api.fail("DELETE", /^\/channels\//, 500);
    await expect(host.ensureTeam({ slug: "lin", displayName: "Lin", userId: user.id }, signal())).rejects.toMatchObject({ kind: "transient" });
  });

  it("fails the channel step when a member cannot be added", async () => {
    const { api, host } = setup();
    const user = api.addUser({ username: "lin" });
    const team = api.addTeam("lin");
    api.fail("POST", /\/members$/, 500);
    await expect(host.ensureChannels({ slug: "lin", ownerFirstName: "Lin", teamId: team.id, userId: user.id, agentChannel: false }, signal()))
      .rejects.toMatchObject({ kind: "transient" });
  });

  it("issues agent and user tokens under the legacy descriptions and never logs them", async () => {
    const context = setup();
    const { api, host, logs } = context;
    const { userId, botUserId } = await converge(context);
    const agentToken = await host.issueAgentToken({ botUserId }, signal());
    const userToken = await host.issueUserToken({ userId }, signal());
    expect(api.tokens).toEqual([
      expect.objectContaining({ userId: botUserId, description: DEFAULT_AGENT_PAT_DESCRIPTION, token: agentToken.token }),
      expect.objectContaining({ userId, description: USER_PAT_DESCRIPTION, token: userToken.token }),
    ]);
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain(agentToken.token);
    expect(logged).not.toContain(userToken.token);
  });

  it("fails token issue when the chat host answers without a token", async () => {
    const { api, host } = setup();
    api.fail("POST", /\/tokens$/, 404);
    await expect(host.issueUserToken({ userId: "user-x" }, signal())).rejects.toMatchObject({ kind: "terminal" });
  });
});
