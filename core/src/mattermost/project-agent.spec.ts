import { describe, expect, it, vi } from "vitest";
import {
  PROJECT_AGENT_PAT_DESCRIPTION,
  createProjectAgentBot,
  projectAgentSecretDocId,
  retireProjectAgentBot,
} from "./project-agent.js";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";

const SECRET_PATH = "users/uid-1/secrets/projectAgentMattermost-orbit";

function deps() {
  const documents = new Map<string, Record<string, unknown>>();
  const store = createDocumentFixtureStore(documents);
  const set = vi.spyOn(store.secrets, "put");
  const del = vi.spyOn(store.secrets, "delete");
  return {
    secrets: store.secrets,
    mmApiCall: vi.fn(),
    log: vi.fn(),
    documents,
    set,
    del,
  };
}

interface MmCall {
  method: string;
  endpoint: string;
  body?: unknown;
}

function mmRecorder(handler: (method: string, endpoint: string, body?: unknown) => unknown) {
  const calls: MmCall[] = [];
  const fn = vi.fn(async (method: string, endpoint: string, body?: unknown) => {
    calls.push({ method, endpoint, body });
    return handler(method, endpoint, body);
  });
  return { fn, calls };
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    uid: "uid-1",
    username: "alice",
    project: "orbit",
    teamId: "team-1",
    displayName: "BenderEcho",
    projectChannelIds: ["chan-a", "chan-b"],
    ...overrides,
  };
}

function mmError(status: number, detail: string): Error & { status: number } {
  return Object.assign(new Error(`MM API ${status}: ${detail}`), { status });
}

describe("projectAgentSecretDocId", () => {
  it("keys the secret per project", () => {
    expect(projectAgentSecretDocId("orbit")).toBe("projectAgentMattermost-orbit");
  });
});

describe("createProjectAgentBot", () => {
  it("creates the bot, joins team + project channels only, mints a PAT, persists the secret", async () => {
    const d = deps();
    const mm = mmRecorder((method, endpoint) => {
      if (method === "POST" && endpoint === "/bots") return { user_id: "bot-1" };
      if (method === "POST" && endpoint === "/teams/team-1/members") return {};
      if (method === "POST" && endpoint.startsWith("/channels/")) return {};
      if (method === "GET" && endpoint === "/users/bot-1/tokens") return [];
      if (method === "POST" && endpoint === "/users/bot-1/tokens") return { token: "proj-pat" };
      throw new Error(`unexpected mmApiCall: ${method} ${endpoint}`);
    });
    d.mmApiCall = mm.fn;

    const result = await createProjectAgentBot(d, createInput());

    expect(result).toEqual({ mmUserId: "bot-1", token: "proj-pat" });
    expect(mm.calls[0]).toEqual({
      method: "POST",
      endpoint: "/bots",
      body: {
        username: "alice-proj-orbit-coach",
        display_name: "BenderEcho",
        description: "Octogee project agent for alice/orbit",
      },
    });
    expect(mm.calls).toContainEqual({
      method: "POST",
      endpoint: "/teams/team-1/members",
      body: { team_id: "team-1", user_id: "bot-1" },
    });
    expect(mm.calls).toContainEqual({
      method: "POST",
      endpoint: "/channels/chan-a/members",
      body: { user_id: "bot-1" },
    });
    expect(mm.calls).toContainEqual({
      method: "POST",
      endpoint: "/channels/chan-b/members",
      body: { user_id: "bot-1" },
    });
    expect(d.documents.get(SECRET_PATH)).toEqual({
      personalToken: "proj-pat",
      mmUserId: "bot-1",
      project: "orbit",
      createdAt: expect.any(Number),
    });
  });

  it("adopts an existing bot user when creation conflicts", async () => {
    const d = deps();
    const mm = mmRecorder((method, endpoint) => {
      if (method === "POST" && endpoint === "/bots") throw new Error("store error: exists");
      if (method === "GET" && endpoint === "/users/username/alice-proj-orbit-coach") {
        return { id: "bot-9", is_bot: true, delete_at: 0 };
      }
      if (method === "POST" && endpoint === "/teams/team-1/members") return {};
      if (method === "POST" && endpoint.startsWith("/channels/")) return {};
      if (method === "GET" && endpoint === "/users/bot-9/tokens") return [];
      if (method === "POST" && endpoint === "/users/bot-9/tokens") return { token: "pat-9" };
      throw new Error(`unexpected mmApiCall: ${method} ${endpoint}`);
    });
    d.mmApiCall = mm.fn;

    const result = await createProjectAgentBot(d, createInput());

    expect(result).toEqual({ mmUserId: "bot-9", token: "pat-9" });
    expect(d.log).toHaveBeenCalled();
  });

  it("retries partial and completed provisioning through existing team and channel memberships", async () => {
    const d = deps();
    const memberships = new Set<string>();
    let botExists = false;
    let channelFailed = false;
    let minted = 0;
    const mm = mmRecorder((method, endpoint) => {
      if (method === "POST" && endpoint === "/bots") {
        if (botExists) throw mmError(409, "bot exists");
        botExists = true;
        return { user_id: "bot-1" };
      }
      if (method === "GET" && endpoint === "/users/username/alice-proj-orbit-coach") {
        return { id: "bot-1", is_bot: true, delete_at: 0 };
      }
      if (method === "POST" && endpoint.endsWith("/members")) {
        if (endpoint === "/channels/chan-b/members" && !channelFailed) {
          channelFailed = true;
          throw mmError(502, "membership unavailable");
        }
        if (memberships.has(endpoint)) {
          const detail = endpoint.startsWith("/teams/")
            ? '{"id":"store.sql_team.save_member.exists.app_error"}'
            : endpoint === "/channels/chan-a/members"
              ? '{"id":"store.sql_channel.save_member.exists.app_error"}'
              : "user_already_in_channel";
          throw mmError(409, detail);
        }
        memberships.add(endpoint);
        return {};
      }
      if (method === "GET" && endpoint === "/users/bot-1/tokens") {
        return minted ? [{ id: "stale-pat", description: PROJECT_AGENT_PAT_DESCRIPTION }] : [];
      }
      if (method === "POST" && endpoint === "/users/tokens/revoke") return {};
      if (method === "POST" && endpoint === "/users/bot-1/tokens") return { token: `pat-${++minted}` };
      throw new Error(`unexpected mmApiCall: ${method} ${endpoint}`);
    });
    d.mmApiCall = mm.fn;

    await expect(createProjectAgentBot(d, createInput())).rejects.toThrow("membership unavailable");
    expect(d.set).not.toHaveBeenCalled();
    await expect(createProjectAgentBot(d, createInput())).resolves.toEqual({ mmUserId: "bot-1", token: "pat-1" });
    await expect(createProjectAgentBot(d, createInput())).resolves.toEqual({ mmUserId: "bot-1", token: "pat-2" });

    expect(memberships).toEqual(new Set([
      "/teams/team-1/members", "/channels/chan-a/members", "/channels/chan-b/members",
    ]));
    expect(d.set).toHaveBeenCalledTimes(2);
    expect(d.documents.get(SECRET_PATH)).toEqual(expect.objectContaining({ personalToken: "pat-2", mmUserId: "bot-1" }));
    expect(mm.calls).toContainEqual({ method: "POST", endpoint: "/users/tokens/revoke", body: { token_id: "stale-pat" } });
  });

  describe.each(["/teams/team-1/members", "/channels/chan-a/members"])("membership failure at %s", (failedEndpoint) => {
    it.each([
      [409, '{"id":"store.sql_channel.save_member.conflict.app_error"}'],
      [409, "already a member"],
      [409, '{"id":"store.sql_channel.save_member.exists.app_error.other"}'],
      [409, JSON.stringify({
        id: failedEndpoint.startsWith("/teams/")
          ? "store.sql_channel.save_member.exists.app_error"
          : "store.sql_team.save_member.exists.app_error",
      })],
      [401, '{"id":"store.sql_channel.save_member.exists.app_error"}'],
      [403, '{"id":"store.sql_channel.save_member.exists.app_error"}'],
    ])("preserves status %s with detail %s without minting or saving a token", async (status, detail) => {
      const d = deps();
      const failure = mmError(status, detail);
      d.mmApiCall = vi.fn(async (method: string, endpoint: string) => {
        if (method === "POST" && endpoint === "/bots") return { user_id: "bot-1" };
        if (endpoint === failedEndpoint) throw failure;
        if (method === "POST" && endpoint.endsWith("/members")) return {};
        throw new Error(`unexpected mmApiCall: ${method} ${endpoint}`);
      });

      await expect(createProjectAgentBot(d, createInput())).rejects.toBe(failure);

      expect(d.mmApiCall.mock.calls.some(([, endpoint]) => endpoint.includes("/tokens"))).toBe(false);
      expect(d.set).not.toHaveBeenCalled();
    });
  });

  it("refuses to adopt a username-squatting NON-bot user", async () => {
    const d = deps();
    d.mmApiCall = vi.fn(async (method: string, endpoint: string) => {
      if (method === "POST" && endpoint === "/bots") throw new Error("store error: exists");
      if (method === "GET" && endpoint === "/users/username/alice-proj-orbit-coach") {
        return { id: "human-1", is_bot: false, delete_at: 0 };
      }
      throw new Error(`unexpected mmApiCall: ${method} ${endpoint}`);
    });

    await expect(createProjectAgentBot(d, createInput())).rejects.toThrow(/not a bot/);
    expect(d.set).not.toHaveBeenCalled();
  });

  it("reactivates a previously retired (deactivated) bot on adopt", async () => {
    const d = deps();
    const mm = mmRecorder((method, endpoint) => {
      if (method === "POST" && endpoint === "/bots") throw new Error("store error: exists");
      if (method === "GET" && endpoint === "/users/username/alice-proj-orbit-coach") {
        return { id: "bot-9", is_bot: true, delete_at: 1_700_000_000 };
      }
      if (method === "PUT" && endpoint === "/users/bot-9/active") return {};
      if (method === "POST" && endpoint === "/teams/team-1/members") return {};
      if (method === "POST" && endpoint.startsWith("/channels/")) return {};
      if (method === "GET" && endpoint === "/users/bot-9/tokens") return [];
      if (method === "POST" && endpoint === "/users/bot-9/tokens") return { token: "pat-9" };
      throw new Error(`unexpected mmApiCall: ${method} ${endpoint}`);
    });
    d.mmApiCall = mm.fn;

    const result = await createProjectAgentBot(d, createInput());

    expect(result).toEqual({ mmUserId: "bot-9", token: "pat-9" });
    expect(mm.calls).toContainEqual({
      method: "PUT",
      endpoint: "/users/bot-9/active",
      body: { active: true },
    });
  });

  it("throws when the bot can be neither created nor found, and writes no secret", async () => {
    const d = deps();
    d.mmApiCall = vi.fn(async (method: string, endpoint: string) => {
      if (method === "POST" && endpoint === "/bots") throw new Error("boom");
      if (method === "GET") return null;
      throw new Error(`unexpected mmApiCall: ${method} ${endpoint}`);
    });

    await expect(createProjectAgentBot(d, createInput())).rejects.toThrow(
      /alice-proj-orbit-coach/,
    );
    expect(d.set).not.toHaveBeenCalled();
  });

  it("revokes only stale project-agent tokens before minting", async () => {
    const d = deps();
    const revoked: unknown[] = [];
    const mm = mmRecorder((method, endpoint, body) => {
      if (method === "POST" && endpoint === "/bots") return { user_id: "bot-1" };
      if (method === "POST" && endpoint === "/teams/team-1/members") return {};
      if (method === "POST" && endpoint.startsWith("/channels/")) return {};
      if (method === "GET" && endpoint === "/users/bot-1/tokens") {
        return [
          { id: "stale-1", description: PROJECT_AGENT_PAT_DESCRIPTION },
          { id: "other", description: "manual token" },
        ];
      }
      if (method === "POST" && endpoint === "/users/tokens/revoke") {
        revoked.push(body);
        return {};
      }
      if (method === "POST" && endpoint === "/users/bot-1/tokens") return { token: "fresh" };
      throw new Error(`unexpected mmApiCall: ${method} ${endpoint}`);
    });
    d.mmApiCall = mm.fn;

    await createProjectAgentBot(d, createInput());

    expect(revoked).toEqual([{ token_id: "stale-1" }]);
  });

  it("throws when the mint returns no token, and writes no secret", async () => {
    const d = deps();
    d.mmApiCall = vi.fn(async (method: string, endpoint: string) => {
      if (method === "POST" && endpoint === "/bots") return { user_id: "bot-1" };
      if (method === "POST" && endpoint === "/teams/team-1/members") return {};
      if (method === "POST" && endpoint.startsWith("/channels/")) return {};
      if (method === "GET" && endpoint === "/users/bot-1/tokens") return [];
      if (method === "POST" && endpoint === "/users/bot-1/tokens") return {};
      throw new Error(`unexpected mmApiCall: ${method} ${endpoint}`);
    });

    await expect(createProjectAgentBot(d, createInput())).rejects.toThrow(/PAT/);
    expect(d.set).not.toHaveBeenCalled();
  });
});

describe("retireProjectAgentBot", () => {
  it("revokes all tokens, deactivates the bot user, and deletes the secret", async () => {
    const d = deps();
    const mm = mmRecorder((method, endpoint) => {
      if (method === "GET" && endpoint === "/users/bot-1/tokens") {
        return [{ id: "t1" }, { id: "t2" }];
      }
      if (method === "POST" && endpoint === "/users/tokens/revoke") return {};
      if (method === "DELETE" && endpoint === "/users/bot-1") return {};
      throw new Error(`unexpected mmApiCall: ${method} ${endpoint}`);
    });
    d.mmApiCall = mm.fn;

    await retireProjectAgentBot(d, { uid: "uid-1", project: "orbit", mmUserId: "bot-1" });

    expect(mm.calls).toContainEqual({
      method: "POST",
      endpoint: "/users/tokens/revoke",
      body: { token_id: "t1" },
    });
    expect(mm.calls).toContainEqual({
      method: "POST",
      endpoint: "/users/tokens/revoke",
      body: { token_id: "t2" },
    });
    expect(mm.calls).toContainEqual({ method: "DELETE", endpoint: "/users/bot-1", body: undefined });
    expect(d.del).toHaveBeenCalledWith("uid-1", "projectAgentMattermost-orbit");
  });

  it("continues past a failed token listing (logs) and still deactivates + deletes the secret", async () => {
    const d = deps();
    d.mmApiCall = vi.fn(async (method: string, endpoint: string) => {
      if (method === "GET" && endpoint === "/users/bot-1/tokens") throw new Error("list down");
      if (method === "DELETE" && endpoint === "/users/bot-1") return {};
      throw new Error(`unexpected mmApiCall: ${method} ${endpoint}`);
    });

    await retireProjectAgentBot(d, { uid: "uid-1", project: "orbit", mmUserId: "bot-1" });

    expect(d.log).toHaveBeenCalled();
    expect(d.del).toHaveBeenCalled();
  });

  it("stays idempotent when the bot user is already gone (404) and still deletes the secret", async () => {
    const d = deps();
    d.mmApiCall = vi.fn(async (method: string, endpoint: string) => {
      if (method === "GET" && endpoint === "/users/bot-1/tokens") return [];
      if (method === "DELETE" && endpoint === "/users/bot-1") {
        const err = new Error("MM API 404: user not found") as Error & { status: number };
        err.status = 404;
        throw err;
      }
      throw new Error(`unexpected mmApiCall: ${method} ${endpoint}`);
    });

    await retireProjectAgentBot(d, { uid: "uid-1", project: "orbit", mmUserId: "bot-1" });

    expect(d.log).toHaveBeenCalled();
    expect(d.del).toHaveBeenCalled();
  });

  it("propagates non-404 deactivation failures without deleting the secret", async () => {
    const d = deps();
    d.mmApiCall = vi.fn(async (method: string, endpoint: string) => {
      if (method === "GET" && endpoint === "/users/bot-1/tokens") return [];
      if (method === "DELETE" && endpoint === "/users/bot-1") {
        const err = new Error("MM API 500: internal") as Error & { status: number };
        err.status = 500;
        throw err;
      }
      throw new Error(`unexpected mmApiCall: ${method} ${endpoint}`);
    });

    await expect(
      retireProjectAgentBot(d, { uid: "uid-1", project: "orbit", mmUserId: "bot-1" }),
    ).rejects.toThrow(/500/);
    expect(d.del).not.toHaveBeenCalled();
  });
});
