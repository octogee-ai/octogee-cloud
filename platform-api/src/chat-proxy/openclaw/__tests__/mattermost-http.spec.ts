import { describe, expect, it, vi } from "vitest";
import {
  assertMattermostId,
  createMattermostInternalHttpClient,
} from "../mattermost-http.js";

const BASE_URL = "http://mattermost.octogee-test.svc.cluster.local:8065";
const TOKEN = "t".repeat(26);

describe("strict internal Mattermost HTTP", () => {
  it("fails configuration for public, credentialed, or malformed bases and weak tokens", () => {
    for (const baseUrl of [
      "",
      "https://mattermost.example.com",
      "http://user:pass@mattermost.octogee-test.svc.cluster.local:8065",
      "http://mattermost.octogee-test.svc.cluster.local:8065/path",
    ]) {
      expect(() => createMattermostInternalHttpClient({ baseUrl, token: TOKEN })).toThrow();
    }
    expect(() => createMattermostInternalHttpClient({ baseUrl: BASE_URL, token: "short" })).toThrow();
  });

  it("uses an abort deadline, refuses redirects, and encodes path segments", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const client = createMattermostInternalHttpClient({ baseUrl: BASE_URL, token: TOKEN, fetchImpl });
    await expect(client.requestJson("GET", ["posts", "x/y"])).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE_URL}/api/v4/posts/x%2Fy`,
      expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
      }),
    );
  });

  it("aborts hung requests and rejects oversized response bodies", async () => {
    const hung: typeof fetch = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const timed = createMattermostInternalHttpClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: hung,
      timeoutMs: 1,
    });
    await expect(timed.requestJson("GET", ["config", "client"])).rejects.toBeDefined();

    const oversized = createMattermostInternalHttpClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      maxResponseBytes: 8,
      fetchImpl: async () => new Response('{"too":"large"}', { status: 200 }),
    });
    await expect(oversized.requestJson("GET", ["config", "client"])).rejects.toThrow("size limit");
  });

  it("accepts only canonical 26-character Mattermost ids", () => {
    expect(assertMattermostId("a".repeat(26), "postId")).toBe("a".repeat(26));
    for (const value of ["short", "a".repeat(25) + "/", "../" + "a".repeat(23), "A".repeat(26)]) {
      expect(() => assertMattermostId(value, "postId")).toThrow("postId");
    }
  });
});
