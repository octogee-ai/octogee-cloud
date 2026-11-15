import type { HostAdapterConfig } from "./config.js";
import type { ChatHost } from "./hosts/chat-host.js";
import { createMattermostChatHost, type HostLog } from "./hosts/chat-host-mattermost.js";
import { FakeChatHost, FakeGitHost } from "./hosts/fake-hosts.js";
import type { GitHost } from "./hosts/git-host.js";
import { createGiteaGitHostAdapter } from "./hosts/git-host-gitea.js";

export function hostsFromConfig(hosts: HostAdapterConfig, log: HostLog): { chat: ChatHost; git: GitHost } {
  if (hosts.kind === "fake") return { chat: new FakeChatHost(), git: new FakeGitHost() };
  const { settings } = hosts;
  return {
    chat: createMattermostChatHost({
      baseUrl: settings.chatHostUrl,
      adminToken: settings.chatHostAdminToken,
      adminUserId: settings.chatHostAdminUserId,
      controlCommandUrl: settings.chatControlCommandUrl,
      log,
    }),
    git: createGiteaGitHostAdapter({ apiBaseUrl: settings.gitHostUrl, adminToken: settings.gitHostAdminToken, log }),
  };
}
