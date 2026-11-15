import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@octogee/core/http/logging", () => ({ logger }));

const ENV_KEYS = ["MM_URL", "MM_ADMIN_TOKEN", "K8S_NAMESPACE"] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function importMattermost() {
  vi.resetModules();
  return import("../lib/mattermost.js");
}

describe("mattermost api helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    restoreEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restoreEnv();
  });

  it("fails fast when the admin token is missing", async () => {
    delete process.env.MM_ADMIN_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { mmApi } = await importMattermost();

    await expect(mmApi("/teams")).rejects.toThrow("MM_ADMIN_TOKEN not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends JSON requests to the configured Mattermost URL", async () => {
    process.env.MM_URL = "http://mattermost.test";
    process.env.MM_ADMIN_TOKEN = "admin-token";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "team-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { mmApi, MM_URL } = await importMattermost();

    await expect(mmApi("/teams", "POST", { name: "mira" })).resolves.toEqual({ id: "team-1" });

    expect(MM_URL).toBe("http://mattermost.test");
    expect(fetchMock).toHaveBeenCalledWith("http://mattermost.test/api/v4/teams", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "mira" }),
    });
  });

  it("logs and throws Mattermost errors with status attached", async () => {
    process.env.MM_URL = "http://mattermost.test";
    const fetchMock = vi.fn(async () => new Response("denied", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const { mmApi } = await importMattermost();

    await expect(mmApi("/users/me", "GET", undefined, "user-token")).rejects.toMatchObject({
      message: "MM API 403: denied",
      status: 403,
    });
    expect(logger.error).toHaveBeenCalledWith("MM API error: 403 GET /users/me", {
      response: "denied",
    });
  });

  it("throws expected idempotent membership conflicts without error logging", async () => {
    process.env.MM_URL = "http://mattermost.test";
    const fetchMock = vi.fn(async () => new Response("already a member", { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const { mmApi } = await importMattermost();

    await expect(
      mmApi("/channels/channel-1/members", "POST", { user_id: "user-1" }, "user-token"),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      mmApi("/teams/team-1/members", "POST", { user_id: "user-1" }, "user-token"),
    ).rejects.toMatchObject({ status: 409 });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("keeps unexpected Mattermost conflicts at error severity", async () => {
    process.env.MM_URL = "http://mattermost.test";
    const fetchMock = vi.fn(async () => new Response("conflict", { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const { mmApi } = await importMattermost();

    await expect(mmApi("/channels", "POST", {}, "user-token")).rejects.toMatchObject({
      status: 409,
    });
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("uploads avatar buffers as form-data with the caller token", async () => {
    process.env.MM_URL = "http://mattermost.test";
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { mmUploadAvatarBuffer } = await importMattermost();

    await expect(mmUploadAvatarBuffer("user-1", Buffer.from([1, 2, 3]), "user-token")).resolves.toBe(true);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchMock.mock.calls[0][0]).toBe("http://mattermost.test/api/v4/users/user-1/image");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer user-token" });
    expect(init.body).toBeInstanceOf(FormData);
  });
});
