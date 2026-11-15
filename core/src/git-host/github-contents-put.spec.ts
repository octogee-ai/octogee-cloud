import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../http/logging", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { githubContentsPut } from "./github.js";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("githubContentsPut — create-or-update through the contents API", () => {
  it("PUTs message, base64 content, sha and author to the contents URL with bearer auth", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ content: { sha: "newsha" } }),
    });

    const out = await githubContentsPut("octogee-ai", "octogee", "notes/idea.md", "tok-1", {
      message: "notes: edit notes/idea.md",
      contentBase64: Buffer.from("# Idea", "utf8").toString("base64"),
      sha: "oldsha",
      author: { name: "Alice A", email: "alice@x.test" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/octogee-ai/octogee/contents/notes/idea.md");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    expect(JSON.parse(init.body as string)).toEqual({
      message: "notes: edit notes/idea.md",
      content: Buffer.from("# Idea", "utf8").toString("base64"),
      sha: "oldsha",
      author: { name: "Alice A", email: "alice@x.test" },
    });
    expect(out).toEqual({ content: { sha: "newsha" } });
  });

  it("omits sha and author when absent (fresh create)", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    await githubContentsPut("octogee-ai", "octogee", "notes/new.md", "tok-1", {
      message: "notes: edit notes/new.md",
      contentBase64: "QQ==",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ message: "notes: edit notes/new.md", content: "QQ==" });
    expect("sha" in body).toBe(false);
    expect("author" in body).toBe(false);
  });

  it("throws loudly with the status on a non-ok response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => "Validation Failed",
    });

    await expect(
      githubContentsPut("octogee-ai", "octogee", "notes/x.md", "tok-1", {
        message: "m",
        contentBase64: "QQ==",
      }),
    ).rejects.toThrow("GitHub API 422");
  });

  it("rejects an invalid owner before any network call", async () => {
    await expect(
      githubContentsPut("bad owner!", "octogee", "notes/x.md", "tok-1", {
        message: "m",
        contentBase64: "QQ==",
      }),
    ).rejects.toThrow(/Invalid GitHub owner/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
