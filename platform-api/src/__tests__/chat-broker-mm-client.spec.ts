import { afterEach, describe, expect, it, vi } from "vitest";

import { createMmClient, MmFetchError } from "../lib/chat-broker/mm-client.js";

interface CapturedFetch {
  url: string;
  init: RequestInit;
}

const captured: CapturedFetch[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  captured.length = 0;
});

function stubFetch(response: Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} });
      return response;
    }),
  );
}

describe("createMmClient", () => {
  it("trims one trailing base URL slash and sends bearer auth on GET", async () => {
    stubFetch(Response.json({ ok: true }));
    const client = createMmClient("https://mattermost.example.test/");

    const out = await client.get("/api/v4/users/me", "PAT-123");

    expect(out).toEqual({ ok: true });
    expect(captured[0]).toMatchObject({
      url: "https://mattermost.example.test/api/v4/users/me",
      init: {
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer PAT-123",
          accept: "application/json",
        }),
      },
    });
  });

  it("serializes POST JSON and returns null for empty bodies", async () => {
    stubFetch(new Response("", { status: 200 }));
    const client = createMmClient("https://mattermost.example.test");

    const out = await client.post("/api/v4/posts/search", "PAT-123", { terms: "hello" });

    expect(out).toBeNull();
    expect(captured[0].init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ terms: "hello" }),
      headers: expect.objectContaining({
        "content-type": "application/json",
      }),
    });
  });

  it("throws MmFetchError with the response body prefix for HTTP failures", async () => {
    stubFetch(new Response("denied".repeat(80), { status: 403, statusText: "Forbidden" }));
    const client = createMmClient("https://mattermost.example.test");

    await expect(client.get("/api/v4/channels/ch/posts", "PAT-123")).rejects.toMatchObject({
      status: 403,
      path: "/api/v4/channels/ch/posts",
      message: expect.stringContaining("GET /api/v4/channels/ch/posts"),
    });
  });

  it("throws MmFetchError for successful non-JSON bodies", async () => {
    stubFetch(new Response("not-json", { status: 200 }));
    const client = createMmClient("https://mattermost.example.test");

    await expect(client.get("/api/v4/users/me", "PAT-123")).rejects.toBeInstanceOf(MmFetchError);
  });
});
