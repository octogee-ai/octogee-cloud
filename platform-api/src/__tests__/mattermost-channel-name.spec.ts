import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMmApi = vi.fn();
vi.mock("../lib/mattermost", () => ({
  mmApi: (...args: unknown[]) => mockMmApi(...args),
}));

import {
  ChannelNameInUseError,
  createFreshPrivateChannel,
  isChannelNameTakenError,
  releaseArchivedChannelName,
  retiredChannelName,
} from "../lib/mattermost-channel-name.js";

function mmError(status: number, text: string): Error & { status: number } {
  const error = new Error(`MM API ${status}: ${text}`) as Error & { status: number };
  error.status = status;
  return error;
}
const TAKEN = mmError(400, '{"id":"store.sql_channel.save_channel.exists.app_error","message":"A channel with that name already exists on the same team."}');
const NAME = "ceckert-proj-octogee-general";

beforeEach(() => mockMmApi.mockReset());

describe("isChannelNameTakenError", () => {
  it("recognizes only Mattermost's save_channel.exists 400", () => {
    expect(isChannelNameTakenError(TAKEN)).toBe(true);
    expect(isChannelNameTakenError(mmError(400, '{"id":"model.channel.is_valid.display_name.app_error"}'))).toBe(false);
    expect(isChannelNameTakenError(mmError(404, "not found"))).toBe(false);
    expect(isChannelNameTakenError(new Error("save_channel.exists"))).toBe(false);
  });
});

describe("retiredChannelName", () => {
  it("appends a base36 second stamp and never exceeds Mattermost's 64-char limit", () => {
    const stamped = retiredChannelName(NAME, 1_789_070_223_358);
    expect(stamped).toBe(`${NAME}-x${Math.floor(1_789_070_223_358 / 1000).toString(36)}`);
    const long = retiredChannelName("a".repeat(64), 1_789_070_223_358);
    expect(long).toHaveLength(64);
    expect(long.endsWith(`-x${Math.floor(1_789_070_223_358 / 1000).toString(36)}`)).toBe(true);
  });
});

describe("releaseArchivedChannelName", () => {
  it("restores, renames, and re-archives an archived holder of the name", async () => {
    mockMmApi
      .mockResolvedValueOnce({ id: "old", name: NAME, type: "P", delete_at: 1_789_067_913_141 })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    await expect(releaseArchivedChannelName("team-1", NAME, () => 1_789_070_223_358)).resolves.toBe("released");
    expect(mockMmApi.mock.calls).toEqual([
      [`/teams/team-1/channels/name/${NAME}?include_deleted=true`],
      ["/channels/old/restore", "POST"],
      ["/channels/old/patch", "PUT", { name: retiredChannelName(NAME, 1_789_070_223_358) }],
      ["/channels/old", "DELETE"],
    ]);
  });

  it("re-archives a restored holder when the rename fails, so the name is not left live", async () => {
    mockMmApi
      .mockResolvedValueOnce({ id: "old", name: NAME, type: "P", delete_at: 5 })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(mmError(500, "patch failed"))
      .mockResolvedValueOnce({});
    await expect(releaseArchivedChannelName("team-1", NAME)).rejects.toThrow("MM API 500: patch failed");
    expect(mockMmApi.mock.calls.map(([path, method]) => `${method ?? "GET"} ${path}`)).toEqual([
      `GET /teams/team-1/channels/name/${NAME}?include_deleted=true`,
      "POST /channels/old/restore",
      "PUT /channels/old/patch",
      "DELETE /channels/old",
    ]);
  });

  it("reports a live holder without touching it, and an absent name without touching anything", async () => {
    mockMmApi.mockResolvedValueOnce({ id: "live", name: NAME, type: "P", delete_at: 0 });
    await expect(releaseArchivedChannelName("team-1", NAME)).resolves.toBe("live");
    expect(mockMmApi).toHaveBeenCalledTimes(1);

    mockMmApi.mockReset();
    mockMmApi.mockRejectedValueOnce(mmError(404, "Channel does not exist."));
    await expect(releaseArchivedChannelName("team-1", NAME)).resolves.toBe("absent");
    expect(mockMmApi).toHaveBeenCalledTimes(1);
  });
});

describe("createFreshPrivateChannel", () => {
  it("creates directly when the name is free", async () => {
    mockMmApi.mockResolvedValueOnce({ id: "new" });
    await expect(createFreshPrivateChannel("team-1", NAME, "Octogee")).resolves.toBe("new");
    expect(mockMmApi).toHaveBeenCalledWith("/channels", "POST", {
      team_id: "team-1", name: NAME, display_name: "Octogee", type: "P",
    });
  });

  it("frees an archived remnant and creates fresh when the first create is refused", async () => {
    mockMmApi
      .mockRejectedValueOnce(TAKEN)
      .mockResolvedValueOnce({ id: "old", name: NAME, type: "P", delete_at: 5 })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ id: "new" });
    await expect(createFreshPrivateChannel("team-1", NAME, "Octogee")).resolves.toBe("new");
    expect(mockMmApi.mock.calls.map(([path, method]) => `${method ?? "GET"} ${path}`)).toEqual([
      "POST /channels",
      `GET /teams/team-1/channels/name/${NAME}?include_deleted=true`,
      "POST /channels/old/restore",
      "PUT /channels/old/patch",
      "DELETE /channels/old",
      "POST /channels",
    ]);
  });

  it("refuses to adopt a live channel with the same name", async () => {
    mockMmApi
      .mockRejectedValueOnce(TAKEN)
      .mockResolvedValueOnce({ id: "live", name: NAME, type: "P", delete_at: 0 });
    await expect(createFreshPrivateChannel("team-1", NAME, "Octogee")).rejects.toBeInstanceOf(ChannelNameInUseError);
    expect(mockMmApi).toHaveBeenCalledTimes(2);
  });

  it("surfaces the original error when the refusal is not a name collision, or the name is gone by lookup", async () => {
    mockMmApi.mockRejectedValueOnce(mmError(503, "unavailable"));
    await expect(createFreshPrivateChannel("team-1", NAME, "Octogee")).rejects.toThrow("MM API 503");
    expect(mockMmApi).toHaveBeenCalledTimes(1);

    mockMmApi.mockReset();
    mockMmApi.mockRejectedValueOnce(TAKEN).mockRejectedValueOnce(mmError(404, "gone"));
    await expect(createFreshPrivateChannel("team-1", NAME, "Octogee")).rejects.toBe(TAKEN);
  });
});
