import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../http/logging", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  clearGithubConditionalCache,
  githubContentsApi,
  githubContentsPut,
  githubJson,
} from "./github.js";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, etag: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ETag: etag,
    },
  });
}

function requestHeader(callIndex: number, name: string): string | null {
  const [, init] = fetchMock.mock.calls[callIndex] as [string, RequestInit];
  const headers = init.headers;
  if (headers instanceof Headers) return headers.get(name);
  return (headers as Record<string, string>)[name] ?? null;
}

beforeEach(() => {
  clearGithubConditionalCache();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  clearGithubConditionalCache();
  vi.unstubAllGlobals();
});

describe("GitHub conditional request cache", () => {
  it("revalidates contents requests with ETags and reuses cached JSON on 304", async () => {
    const listing = [{ name: "README.md", type: "file" }];
    fetchMock
      .mockResolvedValueOnce(jsonResponse(listing, '"contents-v1"'))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));

    await expect(githubContentsApi("octogee-ai", "octogee", "", "tok-1")).resolves.toEqual(listing);
    await expect(githubContentsApi("octogee-ai", "octogee", "", "tok-1")).resolves.toEqual(listing);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestHeader(0, "If-None-Match")).toBeNull();
    expect(requestHeader(1, "If-None-Match")).toBe('"contents-v1"');
  });

  it("revalidates generic GitHub GET JSON requests with the cached ETag", async () => {
    const branches = [{ name: "main" }];
    const url = "https://api.github.com/repos/octogee-ai/octogee/branches?per_page=100";
    fetchMock
      .mockResolvedValueOnce(jsonResponse(branches, '"branches-v1"'))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));

    await expect(githubJson("GET", url, "tok-1")).resolves.toEqual(branches);
    await expect(githubJson("GET", url, "tok-1")).resolves.toEqual(branches);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestHeader(1, "If-None-Match")).toBe('"branches-v1"');
  });

  it("does not share validators across different GitHub tokens", async () => {
    const url = "https://api.github.com/repos/octogee-ai/octogee";
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }, '"repo-a"'))
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }, '"repo-b"'));

    await githubJson("GET", url, "tok-a");
    await githubJson("GET", url, "tok-b");

    expect(requestHeader(0, "If-None-Match")).toBeNull();
    expect(requestHeader(1, "If-None-Match")).toBeNull();
  });

  it("does not send conditional headers on writes", async () => {
    const url = "https://api.github.com/repos/octogee-ai/octogee/issues";
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ number: 1 }], '"issues-v1"'))
      .mockResolvedValueOnce(jsonResponse({ number: 2 }, '"issues-v2"'));

    await githubJson("GET", url, "tok-1");
    await githubJson("POST", url, "tok-1", { title: "Follow up" });

    expect(requestHeader(1, "If-None-Match")).toBeNull();
  });

  it("clears stale validators after generic GitHub mutations", async () => {
    const url = "https://api.github.com/repos/octogee-ai/octogee/labels";
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ name: "status:todo" }], '"labels-v1"'))
      .mockResolvedValueOnce(jsonResponse({ name: "status:doing" }, '"labels-v2"'))
      .mockResolvedValueOnce(jsonResponse([{ name: "status:todo" }, { name: "status:doing" }], '"labels-v3"'));

    await githubJson("GET", url, "tok-1");
    await githubJson("POST", url, "tok-1", { name: "status:doing" });
    await githubJson("GET", url, "tok-1");

    expect(requestHeader(2, "If-None-Match")).toBeNull();
  });

  it("clears stale validators after contents writes", async () => {
    const listing = [{ name: "README.md", type: "file" }];
    fetchMock
      .mockResolvedValueOnce(jsonResponse(listing, '"readme-v1"'))
      .mockResolvedValueOnce(jsonResponse({ content: { sha: "newsha" } }, '"write-v1"'))
      .mockResolvedValueOnce(jsonResponse(listing, '"readme-v2"'));

    await githubContentsApi("octogee-ai", "octogee", "README.md", "tok-1");
    await githubContentsPut("octogee-ai", "octogee", "README.md", "tok-1", {
      message: "docs: update README.md",
      contentBase64: "QQ==",
      sha: "oldsha",
    });
    await githubContentsApi("octogee-ai", "octogee", "README.md", "tok-1");

    expect(requestHeader(2, "If-None-Match")).toBeNull();
  });
});
