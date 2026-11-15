import { describe, expect, it, vi } from "vitest";
import { loadOpenClawProfileAppearance, loadOpenClawChatProfileAppearance } from "./profile-appearance.js";

const session = { uid: "uid-A", gatewayId: "walter", revisionId: "walter", sessionId: "opaque-session"};
const env = { OPENCLAW_CONTROL_BROKER_URL: "https://broker.test" };

describe("Gateway profile broker client", () => {
  it("uses the authenticated broker session and receives profile bytes without Google credentials", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ displayName: "Chris", avatar: { revision: "one", avatarBase64: Buffer.from("jpeg").toString("base64") } })));
    const result = await loadOpenClawProfileAppearance(session, env, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("https://broker.test/internal/openclaw-control/profile", expect.objectContaining({
      method: "POST", body: JSON.stringify({ gatewayId: "walter", revisionId: "walter", sessionId: "opaque-session" }), signal: expect.any(AbortSignal),
    }));
    expect(result.displayName).toBe("Chris");
    expect(result.avatar!.revision).toBe("one");
    expect(await result.avatar!.read()).toEqual(Buffer.from("jpeg"));
  });
  it("preserves an absent name and avatar", async () => {
    expect(await loadOpenClawProfileAppearance(session, env, async () => new Response(JSON.stringify({ displayName: null, avatar: null })))).toEqual({ displayName: null, avatar: null });
  });
  it.each([403, 404, 409, 500])("reports broker status %s", async (status) => {
    await expect(loadOpenClawProfileAppearance(session, env, async () => new Response(null, { status }))).rejects.toThrow(String(status));
  });
  it.each([
    {}, { displayName: 12, avatar: null }, { displayName: null, avatar: {} },
    { displayName: null, avatar: { revision: "one", avatarBase64: "invalid!" } },
    { displayName: null, avatar: { revision: "one", avatarBase64: "a".repeat(700_000) } },
  ])("rejects malformed broker appearance %#", async (body) => {
    await expect(loadOpenClawProfileAppearance(session, env, async () => new Response(JSON.stringify(body)))).rejects.toThrow("Invalid profile broker response");
  });
});


describe("Chat profile appearance broker", () => {
  const source = { channelId: "c".repeat(26), postId: "p".repeat(26) };
  it("uses post evidence and the existing avatar decoder without trusting a requested UID", async () => {
    const author = { uid: "uid-author", username: "builder-slug", mattermostUserId: "m".repeat(26) };
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response(JSON.stringify({ author, displayName: "Full name", avatar: { revision: "one", avatarBase64: Buffer.from("jpeg").toString("base64") } })));
    const profile = await loadOpenClawChatProfileAppearance(session, source, env, fetchImpl);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toEqual({ gatewayId: session.gatewayId, revisionId: session.revisionId, sessionId: session.sessionId, ...source });
    expect(profile).toMatchObject({ ...author, appearance: { displayName: "Full name" } });
    expect(await profile!.appearance.avatar!.read()).toEqual(Buffer.from("jpeg"));
  });
  it("preserves an unmapped author's absence", async () => {
    expect(await loadOpenClawChatProfileAppearance(session, source, env, async () => new Response(null, { status: 204 }))).toBeNull();
  });
  it("rejects missing author identity", async () => {
    await expect(loadOpenClawChatProfileAppearance(session, source, env, async () => new Response(JSON.stringify({ displayName: "Spoof", avatar: null })))).rejects.toThrow("Invalid chat profile");
  });
});
