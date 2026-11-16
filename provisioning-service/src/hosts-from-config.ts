import type { HostAdapterConfig } from "./config.js";
import type { ChatHost } from "./hosts/chat-host.js";
import { createMattermostChatHost, type HostLog } from "./hosts/chat-host-mattermost.js";
import { FakeChatHost, FakeGitHost } from "./hosts/fake-hosts.js";
import type { GitHost } from "./hosts/git-host.js";
import { createGiteaGitHostAdapter } from "./hosts/git-host-gitea.js";

export function hostsFromConfig(hosts: HostAdapterConfig, log: HostLog, fetchImpl?: typeof fetch): { chat: ChatHost; git: GitHost } {
  if (hosts.kind === "fake") {
    const chat = new FakeChatHost();
    const git = new FakeGitHost();
    chat.host.setDelay(hosts.delayMs);
    git.host.setDelay(hosts.delayMs);
    for (const [owner, keys] of Object.entries(hosts.gitKeys)) {
      git.owners.add(owner);
      git.keys.set(owner, keys.map((key) => ({ ...key })));
    }
    return { chat, git };
  }
  const { settings } = hosts;
  return {
    chat: createMattermostChatHost({
      baseUrl: settings.chatHostUrl,
      adminToken: settings.chatHostAdminToken,
      adminUserId: settings.chatHostAdminUserId,
      controlCommandUrl: settings.chatControlCommandUrl,
      log,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    }),
    git: createGiteaGitHostAdapter({
      apiBaseUrl: `${settings.gitHostUrl}/api/v1`,
      adminToken: settings.gitHostAdminToken,
      log,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    }),
  };
}
