import { describe, expect, it } from "vitest";
import type { RealHostSettings } from "./config.js";
import { FakeChatHost, FakeGitHost } from "./hosts/fake-hosts.js";
import { hostsFromConfig } from "./hosts-from-config.js";

const log = { info: () => undefined, error: () => undefined };
const SETTINGS: RealHostSettings = {
  chatHostUrl: "https://chat.invalid", chatHostAdminToken: "chat-admin", chatHostAdminUserId: null,
  chatControlCommandUrl: "https://api.invalid/control", gitHostUrl: "https://git.invalid", gitHostAdminToken: "git-admin",
};

function recordingFetch(urls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify({ message: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("hostsFromConfig", () => {
  it("uses the real chat and git host adapters for real, and the fakes only for fake", () => {
    const real = hostsFromConfig({ kind: "real", settings: SETTINGS }, log);
    expect(real.chat).not.toBeInstanceOf(FakeChatHost);
    expect(real.git).not.toBeInstanceOf(FakeGitHost);
    const fake = hostsFromConfig({ kind: "fake" }, log);
    expect(fake.chat).toBeInstanceOf(FakeChatHost);
    expect(fake.git).toBeInstanceOf(FakeGitHost);
  });

  it("calls the git host under /api/v1 and the chat host under /api/v4 of the configured host roots", async () => {
    const urls: string[] = [];
    const real = hostsFromConfig({ kind: "real", settings: SETTINGS }, log, recordingFetch(urls));
    const signal = new AbortController().signal;
    await expect(real.git.ensureOwner({ slug: "lin" }, signal)).rejects.toThrow();
    await expect(real.chat.ensureUser({ uid: "u1", slug: "lin", email: "", displayName: { first: "", last: "" }, avatarUrl: null }, signal)).rejects.toThrow();
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls.filter((url) => url.startsWith("https://git.invalid/")).every((url) => url.startsWith("https://git.invalid/api/v1/"))).toBe(true);
    expect(urls.some((url) => url.startsWith("https://git.invalid/api/v1/"))).toBe(true);
    expect(urls.some((url) => url.startsWith("https://chat.invalid/api/v4/"))).toBe(true);
  });
});
