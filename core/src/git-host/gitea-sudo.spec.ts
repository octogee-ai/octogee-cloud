import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../http/logging", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("GITEA_URL", "http://gitea.test:3000");
  vi.stubEnv("GITEA_TOKEN", "admin-tok");
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("giteaApiAsUser — admin token + Sudo impersonation", () => {
  it("uses the admin token and adds a Sudo header for the impersonated user", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    const { giteaApiAsUser } = await import("./gitea-client.js");

    const out = await giteaApiAsUser("ws-alice", "alice", "workspace/contents/notes/x.md");

    expect(out).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://gitea.test:3000/api/v1/repos/alice/workspace/contents/notes/x.md");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("token admin-tok");
    expect(headers.Sudo).toBe("ws-alice");
  });

  it("passes method + body through (PUT create)", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ content: { sha: "s" } }) });
    const { giteaApiAsUser } = await import("./gitea-client.js");

    await giteaApiAsUser("ws-bob", "alice", "workspace/contents/notes/y.md", "PUT", {
      message: "m",
      content: "QQ==",
      author: { name: "Bob", email: "bob@x.test" },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).Sudo).toBe("ws-bob");
    expect(JSON.parse(init.body as string).author).toEqual({ name: "Bob", email: "bob@x.test" });
  });

  it("throws Gitea API <status> on a non-ok response (e.g. ACL-denied 404 under Sudo)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => "Not Found" });
    const { giteaApiAsUser } = await import("./gitea-client.js");

    await expect(
      giteaApiAsUser("ws-stranger", "alice", "workspace/contents/secret.md"),
    ).rejects.toThrow("Gitea API 404");
  });

  it("allow-404 variant returns null instead of throwing", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => "Not Found" });
    const { giteaApiAsUserAllowNotFound } = await import("./gitea-client.js");

    const out = await giteaApiAsUserAllowNotFound("ws-alice", "alice", "workspace/contents/missing.md");
    expect(out).toBeNull();
  });

  it("refuses an unsafe Sudo identity (header-injection / CRLF) before any fetch", async () => {
    const { giteaApiAsUser } = await import("./gitea-client.js");
    for (const bad of ["ws-alice\r\nX-Evil: 1", "ws alice", "ws-alice\n", "../admin", ""]) {
      await expect(giteaApiAsUser(bad, "alice", "workspace/contents/x.md")).rejects.toThrow(/unsafe identity/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws if the admin token is not configured (fail loud, no silent degrade)", async () => {
    vi.stubEnv("GITEA_TOKEN", "");
    vi.resetModules();
    const { giteaApiAsUser } = await import("./gitea-client.js");
    await expect(giteaApiAsUser("ws-alice", "alice", "workspace/contents/x.md")).rejects.toThrow(/GITEA_TOKEN/);
  });
});
