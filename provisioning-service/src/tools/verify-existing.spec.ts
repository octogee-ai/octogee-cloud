import { describe, expect, it } from "vitest";

import { createMattermostChatHost } from "../hosts/chat-host-mattermost.js";
import { createGiteaGitHostAdapter } from "../hosts/git-host-gitea.js";
import { FakeGiteaApi } from "../hosts/__tests__/gitea-api.fake.js";
import { FakeMattermostApi } from "../hosts/__tests__/mattermost-api.fake.js";
import { formatReport, parseUsers, reportFails, verifyUser, type ExistingUser, type VerifySettings } from "./verify-existing.js";
import { createWriteGuard } from "./write-guard.js";

const COMMAND_URL = "https://callback.invalid/internal/mattermost/commands/control-ui";
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIReadOnlyKey gateway";
const signal = () => new AbortController().signal;
const log = { info: () => undefined, error: () => undefined };

function hosts() {
  const chatApi = new FakeMattermostApi();
  const gitApi = new FakeGiteaApi();
  const admin = chatApi.addUser({ username: "platform-admin" });
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return url.origin === new URL(gitApi.apiBaseUrl).origin ? gitApi.fetch(input, init) : chatApi.fetch(input, init);
  };
  const settings: VerifySettings = {
    chatHostUrl: chatApi.baseUrl,
    chatHostAdminToken: "chat-admin-token",
    chatHostAdminUserId: admin.id,
    chatControlCommandUrl: COMMAND_URL,
    gitHostUrl: new URL(gitApi.apiBaseUrl).origin,
    gitHostAdminToken: "git-admin-token",
    fetch,
  };
  return { chatApi, gitApi, admin, fetch, settings };
}

const nonGet = (requests: { method: string }[]) => requests.filter((request) => request.method !== "GET");

async function provision(context: ReturnType<typeof hosts>) {
  const { chatApi, gitApi, settings } = context;
  const chat = createMattermostChatHost({
    baseUrl: settings.chatHostUrl,
    adminToken: settings.chatHostAdminToken,
    adminUserId: settings.chatHostAdminUserId,
    controlCommandUrl: COMMAND_URL,
    fetch: chatApi.fetch,
    log,
  });
  const git = createGiteaGitHostAdapter({ apiBaseUrl: gitApi.apiBaseUrl, adminToken: "git-admin-token", fetch: gitApi.fetch, log });
  const { userId } = await chat.ensureUser({ uid: "u_1", slug: "lin", email: "lin@example.com", displayName: { first: "Lin", last: "Wu" }, avatarUrl: null }, signal());
  const { teamId } = await chat.ensureTeam({ slug: "lin", displayName: "Lin's Workshop", userId }, signal());
  const channels = await chat.ensureChannels({ slug: "lin", ownerFirstName: "Lin", teamId, userId, agentChannel: true }, signal());
  const { botUserId } = await chat.ensureAgentBot({ slug: "lin", ownerFirstName: "Lin", teamId, generalChannelId: channels.general, agentChannelId: channels.agent }, signal());
  const { owner } = await git.ensureOwner({ slug: "lin" }, signal());
  await git.ensureRepository({ owner, kind: "workspace" }, signal());
  await git.ensureRepository({ owner, kind: "project-coaches" }, signal());
  chatApi.requests.length = 0;
  gitApi.requests.length = 0;
  const user: ExistingUser = {
    uid: "u_1",
    slug: "lin",
    email: "lin@example.com",
    displayName: { first: "Lin", last: "Wu" },
    stored: { chatUserId: userId, teamId, generalChannelId: channels.general, agentChannelId: channels.agent, agentBotUserId: botUserId },
  };
  return user;
}

describe("write guard", () => {
  it("lets no request other than GET reach either host through the adapters' full sequences", async () => {
    const context = hosts();
    const chatGuard = createWriteGuard(context.fetch, "chat");
    const gitGuard = createWriteGuard(context.fetch, "git");
    const chat = createMattermostChatHost({
      baseUrl: context.settings.chatHostUrl,
      adminToken: "chat-admin-token",
      adminUserId: context.admin.id,
      controlCommandUrl: COMMAND_URL,
      fetch: chatGuard.fetch,
      log,
    });
    const git = createGiteaGitHostAdapter({ apiBaseUrl: context.gitApi.apiBaseUrl, adminToken: "git-admin-token", fetch: gitGuard.fetch, log });
    const attempt = async <T>(body: () => Promise<T>) => body().catch(() => null);
    const existingUser = context.chatApi.addUser({ username: "lin" });
    const team = context.chatApi.addTeam("lin");
    context.chatApi.addChannel(team.id, "off-topic");
    context.gitApi.addAccount("ws-lin");

    await attempt(() => chat.ensureUser({ uid: "u_1", slug: "lin", email: "lin@example.com", displayName: { first: "Lin", last: "Wu" }, avatarUrl: "https://images.invalid/a.png" }, signal()));
    await attempt(() => chat.ensureUser({ uid: "u_2", slug: "new", email: "new@example.com", displayName: { first: "N", last: "" }, avatarUrl: null }, signal()));
    await attempt(() => chat.ensureTeam({ slug: "lin", displayName: "Lin", userId: existingUser.id }, signal()));
    await attempt(() => chat.ensureTeam({ slug: "new", displayName: "New", userId: existingUser.id }, signal()));
    await attempt(() => chat.ensureChannels({ slug: "lin", ownerFirstName: "Lin", teamId: team.id, userId: existingUser.id, agentChannel: true }, signal()));
    await attempt(() => chat.ensureAgentBot({ slug: "lin", ownerFirstName: "Lin", teamId: team.id }, signal()));
    await attempt(() => chat.issueAgentToken({ botUserId: existingUser.id }, signal()));
    await attempt(() => chat.issueUserToken({ userId: existingUser.id }, signal()));
    await attempt(() => git.ensureOwner({ slug: "lin" }, signal()));
    await attempt(() => git.ensureRepository({ owner: "lin", kind: "workspace" }, signal()));
    await attempt(() => git.registerKey({ owner: "lin", publicKey: KEY, holder: "gw-1" }, signal()));
    await attempt(() => git.releaseKey({ owner: "lin", publicKey: KEY, holder: "gw-1" }, signal()));

    expect(nonGet(context.chatApi.requests)).toEqual([]);
    expect(nonGet(context.gitApi.requests)).toEqual([]);
    expect(context.chatApi.imageRequests).toEqual([]);
    expect(chatGuard.writes.map((write) => `${write.method} ${write.path}`)).toEqual(expect.arrayContaining([
      "POST /users", "POST /teams", `POST /teams/${team.id}/members`, "POST /channels", "POST /bots", `POST /users/${existingUser.id}/tokens`,
    ]));
    expect(gitGuard.writes.map((write) => `${write.method} ${write.path}`)).toEqual(expect.arrayContaining([
      "POST /orgs", "POST /admin/users/ws-lin/keys",
    ]));
    expect(context.chatApi.tokens).toEqual([]);
  });
});

describe("write guard methods", () => {
  it("answers every method but GET and HEAD locally, whether the method is on the request or in the init", async () => {
    const reached: string[] = [];
    const base: typeof fetch = async (input, init) => {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      reached.push(method.toUpperCase());
      return new Response("{}", { status: 200 });
    };
    const guard = createWriteGuard(base, "chat");
    const url = "https://chat.invalid/api/v4/users/u1/tokens";

    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "delete", "OPTIONS"]) {
      await guard.fetch(url, { method });
      await guard.fetch(new Request(url, { method }));
      await guard.fetch(new URL(url), { method });
    }
    await guard.fetch(url);
    await guard.fetch(new Request(url, { method: "HEAD" }));

    expect(reached).toEqual(["GET", "HEAD"]);
    expect(guard.writes).toHaveLength(21);
  });
});

describe("verify-existing", () => {
  it("finds a fully provisioned user without would-creates, mismatches or writes reaching a host", async () => {
    const context = hosts();
    const user = await provision(context);
    const report = await verifyUser(user, context.settings, signal());

    expect(nonGet(context.chatApi.requests)).toEqual([]);
    expect(nonGet(context.gitApi.requests)).toEqual([]);
    expect(reportFails(report)).toBe(false);
    for (const run of report.runs) {
      expect(run.wouldCreate).toEqual([]);
      expect(run.mismatches).toEqual([]);
      expect(run.errors).toEqual([]);
      expect(run.found).toMatchObject({
        "chat account": user.stored!.chatUserId,
        "chat team": user.stored!.teamId,
        "agent bot": user.stored!.agentBotUserId,
        "git owner": "lin",
        "git repository workspace": "present",
        "git repository project-coaches": "present",
      });
      expect(run.writes).toEqual(expect.arrayContaining([`chat POST /teams/${user.stored!.teamId}/members`, "git create of existing git owner lin"]));
    }
    expect(report.runs.map((run) => run.run)).toEqual(["stored ids", "no ids"]);
  });

  it("uses the recorded bot ID during discovery when the username is legacy", async () => {
    const context = hosts();
    const user = await provision(context);
    const bot = context.chatApi.users.get(user.stored!.agentBotUserId!)!;
    bot.username = "legacy-coach";

    const report = await verifyUser(user, context.settings, signal());

    expect(reportFails(report)).toBe(false);
    expect(report.runs.map((run) => run.found["agent bot"])).toEqual([bot.id, bot.id]);
    expect(nonGet(context.chatApi.requests)).toEqual([]);
  });

  it("reports a missing team and the channels behind it as would-create and fails", async () => {
    const context = hosts();
    const user = await provision(context);
    context.chatApi.teams.clear();
    const report = await verifyUser(user, context.settings, signal());
    expect(report.runs[1].wouldCreate).toContain("chat team lin");
    expect(report.runs[1].errors).toEqual(expect.arrayContaining([expect.stringContaining("chat team")]));
    expect(reportFails(report)).toBe(true);
    expect(nonGet(context.chatApi.requests)).toEqual([]);
  });

  it("reports a missing repository as would-create", async () => {
    const context = hosts();
    const user = await provision(context);
    context.gitApi.repositories.clear();
    const report = await verifyUser(user, context.settings, signal());
    expect(report.runs[0].wouldCreate).toContain("git repository workspace");
    expect(reportFails(report)).toBe(true);
    expect(nonGet(context.gitApi.requests)).toEqual([]);
  });

  it("reports a stored id that differs from the resource found by name", async () => {
    const context = hosts();
    const user = await provision(context);
    const report = await verifyUser({ ...user, stored: { ...user.stored, teamId: "team-stale" } }, context.settings, signal());
    expect(report.runs[0].mismatches).toEqual([`chat team: stored team-stale, found ${user.stored!.teamId}`]);
    expect(report.runs[1].mismatches).toEqual([`chat team: stored team-stale, found ${user.stored!.teamId}`]);
    expect(reportFails(report)).toBe(true);
  });

  it("prints no email and no token", async () => {
    const context = hosts();
    const user = await provision(context);
    context.chatApi.users.delete(user.stored!.chatUserId!);
    const output = formatReport(await verifyUser(user, context.settings, signal()));
    expect(output).toContain("WOULD CREATE  chat account lin");
    expect(output).not.toContain("lin@example.com");
    expect(output).not.toContain("admin-token");
  });

  it("rejects a users file without uid and slug", () => {
    expect(() => parseUsers(JSON.stringify([{ slug: "lin" }]))).toThrow("uid and slug");
    expect(parseUsers(JSON.stringify([{ uid: "u", slug: "lin" }]))).toEqual([{ uid: "u", slug: "lin" }]);
  });
});
