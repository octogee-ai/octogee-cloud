import { beforeEach, describe, expect, it, vi } from "vitest";
import { DuplicateRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), getJson: vi.fn() }));
vi.mock("../../../gateway-edge/src/lib/channel-session-authorization.js", () => ({ authorizeChannel: mocks.authorize }));
import { resolveOpenClawChatAuthor } from "./openclaw-chat-author.js";
let documents: Record<string, Record<string, unknown>>;
let store: ReturnType<typeof createDocumentFixtureStore>;
let findAuthor: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  mocks.authorize.mockResolvedValue({ forbidden: false, client: { getJson: mocks.getJson } });
  mocks.getJson.mockResolvedValue({ id: "post", channel_id: "channel", user_id: "mm-author" });
  documents = { "users/uid-author": { username: "builder-slug", mattermost: { userId: "mm-author" } } };
  store = createDocumentFixtureStore(documents);
  findAuthor = vi.spyOn(store.users.records, "findByMattermostUserId");
});
describe("Control chat author identity", () => {
  it("resolves the actual post author to their Octogee UID and user slug", async () => {
    expect(await resolveOpenClawChatAuthor(store, "viewer", "workspace", "channel", "post")).toEqual({ uid: "uid-author", username: "builder-slug", mattermostUserId: "mm-author" });
    expect(mocks.authorize).toHaveBeenCalledWith("viewer", "channel", "workspace", expect.objectContaining({ requireActiveLedger: true }));
    expect(findAuthor).toHaveBeenCalledWith("mm-author");
  });
  it("includes the active private agent conversation when authorizing history attribution", async () => {
    mocks.getJson.mockResolvedValue({ id: "post", channel_id: "coach-channel", user_id: "mm-author" });
    mocks.authorize.mockImplementation(async (_uid, _channel, _workspace, options) =>
      options.requireActiveLedger && options.includeDefaultAgentConversation
        ? { forbidden: false, client: { getJson: mocks.getJson } }
        : null);
    await expect(resolveOpenClawChatAuthor(store, "owner", "workspace", "coach-channel", "post"))
      .resolves.toMatchObject({ uid: "uid-author", mattermostUserId: "mm-author" });
  });
  it.each([null, { forbidden: true }])("rejects inaccessible channels before reading posts", async (access) => {
    mocks.authorize.mockResolvedValue(access);
    await expect(resolveOpenClawChatAuthor(store, "viewer", "workspace", "channel", "post")).rejects.toThrow("access denied");
    expect(mocks.getJson).not.toHaveBeenCalled();
  });
  it("rejects posts outside the authorized channel", async () => {
    mocks.getJson.mockResolvedValue({ id: "post", channel_id: "other", user_id: "victim" });
    await expect(resolveOpenClawChatAuthor(store, "viewer", "workspace", "channel", "post")).rejects.toThrow("does not belong");
    expect(findAuthor).not.toHaveBeenCalled();
  });
  it("does not invent an Octogee identity for an unmapped Mattermost user", async () => {
    delete documents["users/uid-author"];
    expect(await resolveOpenClawChatAuthor(store, "viewer", "workspace", "channel", "post")).toBeNull();
  });
  it("rejects ambiguous Mattermost mappings", async () => {
    documents["users/uid-twin"] = { username: "twin", mattermost: { userId: "mm-author" } };
    await expect(resolveOpenClawChatAuthor(store, "viewer", "workspace", "channel", "post")).rejects.toBeInstanceOf(DuplicateRecordError);
  });
  it("rejects an author whose user slug is not a valid username", async () => {
    documents["users/uid-author"] = { username: "Not A Slug", mattermost: { userId: "mm-author" } };
    await expect(resolveOpenClawChatAuthor(store, "viewer", "workspace", "channel", "post")).rejects.toThrow("user slug is invalid");
  });
});
