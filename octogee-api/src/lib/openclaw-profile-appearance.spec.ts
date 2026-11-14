import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../../gateway-edge/src/lib/mattermost.js", () => ({ MM_URL: "http://mattermost.test" }));
import { loadOpenClawProfileAppearance, type UserProfileAppearance } from "./openclaw-profile-appearance.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

let documents: Record<string, Record<string, unknown>>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubEnv("MM_ADMIN_TOKEN", undefined);
  documents = {
    "users/uid-A": { mattermost: { userId: "mm-A" } },
    "users/uid-A/secrets/mattermost": { personalToken: "user-mm-token" },
  };
});

const ownAppearance = (appearance: Partial<UserProfileAppearance>) =>
  vi.fn(async () => ({ displayName: null, avatar: null, ...appearance }));

describe("OpenClaw profile appearance", () => {
  it("uses the user's own name and avatar without asking Mattermost", async () => {
    const avatar = { revision: "upload:1", read: async () => Buffer.from("jpeg") };
    const appearance = await loadOpenClawProfileAppearance(
      createDocumentFixtureStore(documents), "uid-A", ownAppearance({ displayName: " Chris ", avatar }),
    );
    expect(appearance).toEqual({ displayName: "Chris", avatar });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("imports the mapped Mattermost name and avatar when no installed profile is set", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: "mm-A", first_name: "Ada", last_name: "Lovelace", last_picture_update: 42 })))
      .mockResolvedValueOnce(new Response(new Uint8Array(png)));
    const appearance = await loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "uid-A");
    expect(appearance.displayName).toBe("Ada Lovelace");
    expect(appearance.avatar!.revision).toContain("42");
    const bytes = await appearance.avatar!.read();
    expect(mocks.fetch).toHaveBeenNthCalledWith(2, "http://mattermost.test/api/v4/users/mm-A/image", expect.objectContaining({
      headers: { Authorization: "Bearer user-mm-token" }, redirect: "error",
    }));
    expect(await sharp(bytes).metadata()).toMatchObject({ format: "jpeg", width: 256, height: 256 });
  });

  it("keeps the user's own name and fills the avatar from Mattermost", async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ id: "mm-A", first_name: "Other", last_picture_update: 5 })));
    const appearance = await loadOpenClawProfileAppearance(
      createDocumentFixtureStore(documents), "uid-A", ownAppearance({ displayName: "Ada" }),
    );
    expect(appearance.displayName).toBe("Ada");
    expect(appearance.avatar!.revision).toBe("mattermost:mm-A:5");
    expect(mocks.fetch).toHaveBeenCalledWith("http://mattermost.test/api/v4/users/me", expect.objectContaining({
      headers: { Authorization: "Bearer user-mm-token" },
    }));
  });

  it("leaves an unprovisioned user's avatar absent and uses their own name", async () => {
    documents["users/uid-A"] = {};
    expect(await loadOpenClawProfileAppearance(
      createDocumentFixtureStore(documents), "uid-A", ownAppearance({ displayName: "Ada Lovelace" }),
    )).toEqual({ displayName: "Ada Lovelace", avatar: null });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects a Mattermost token bound to a different user", async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ id: "another-person" })));
    await expect(loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "uid-A")).rejects.toThrow("Mattermost profile identity mismatch");
  });

  it("reports missing personal credentials without using an admin credential", async () => {
    vi.stubEnv("MM_ADMIN_TOKEN", "must-not-use");
    delete documents["users/uid-A/secrets/mattermost"];
    await expect(loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "uid-A")).rejects.toThrow("Mattermost personal token missing");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("propagates a failing profile source instead of treating it as an empty profile", async () => {
    const failing = vi.fn(async () => { throw new Error("storage unavailable"); });
    await expect(loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "uid-A", failing)).rejects.toThrow("storage unavailable");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not read any profile when the authenticated UID is missing", async () => {
    const source = ownAppearance({ displayName: "Someone" });
    await expect(loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "unknown", source)).rejects.toThrow("Octogee user not found");
    expect(source).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("reports Mattermost failures rather than treating them as an empty profile", async () => {
    mocks.fetch.mockResolvedValue(new Response("denied", { status: 403 }));
    await expect(loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "uid-A")).rejects.toThrow("Mattermost profile request failed: 403");
  });

  it("rejects oversized Mattermost avatar streams", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: "mm-A", first_name: "Ada" })))
      .mockResolvedValueOnce(new Response(new Uint8Array(5 * 1024 * 1024 + 1)));
    const appearance = await loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "uid-A");
    await expect(appearance.avatar!.read()).rejects.toThrow("Avatar exceeds 5 MB");
  });
});
