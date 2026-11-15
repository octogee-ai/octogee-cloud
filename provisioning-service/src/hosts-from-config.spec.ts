import { describe, expect, it } from "vitest";
import { FakeChatHost, FakeGitHost } from "./hosts/fake-hosts.js";
import { hostsFromConfig } from "./hosts-from-config.js";

const log = { info: () => undefined, error: () => undefined };

describe("hostsFromConfig", () => {
  it("uses the real chat and git host adapters for real, and the fakes only for fake", () => {
    const real = hostsFromConfig({
      kind: "real",
      settings: {
        chatHostUrl: "http://chat.invalid", chatHostAdminToken: "a", chatHostAdminUserId: null,
        chatControlCommandUrl: "http://api.invalid/control", gitHostUrl: "http://git.invalid", gitHostAdminToken: "b",
      },
    }, log);
    expect(real.chat).not.toBeInstanceOf(FakeChatHost);
    expect(real.git).not.toBeInstanceOf(FakeGitHost);
    const fake = hostsFromConfig({ kind: "fake" }, log);
    expect(fake.chat).toBeInstanceOf(FakeChatHost);
    expect(fake.git).toBeInstanceOf(FakeGitHost);
  });
});
