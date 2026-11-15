import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardMmRest, MAX_CAPTURED_RESPONSE_BYTES, type MmRestProxyDeps } from "../rest.js";

interface UpstreamSeen {
  method: string | undefined;
  url: string | undefined;
  acceptEncoding: string | undefined;
}

const servers: http.Server[] = [];

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startUpstream(
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; seen: UpstreamSeen[] }> {
  const seen: UpstreamSeen[] = [];
  const server = http.createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      acceptEncoding: req.headers["accept-encoding"] as string | undefined,
    });
    respond(req, res);
  });
  return { url: await listen(server), seen };
}

async function startProxy(deps: MmRestProxyDeps): Promise<string> {
  return listen(http.createServer((req, res) => forwardMmRest(deps, req, res)));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

const createdPost = JSON.stringify({ id: "post-1", channel_id: "dm-1", user_id: "mm-sep", message: "hi" });

describe("forwardMmRest response capture", () => {
  it("hands a captured response to the handler while the client receives it unchanged", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(createdPost);
    });
    const onCapturedResponse = vi.fn();
    const proxy = await startProxy({
      mmInternalUrl: upstream.url,
      log: vi.fn(),
      captureResponse: (req) => req.method === "POST" && req.url === "/api/v4/posts",
      onCapturedResponse,
    });

    const res = await fetch(`${proxy}/api/v4/posts`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-encoding": "gzip" },
      body: JSON.stringify({ channel_id: "dm-1", message: "hi" }),
    });

    expect(res.status).toBe(201);
    expect(await res.text()).toBe(createdPost);
    await vi.waitFor(() => expect(onCapturedResponse).toHaveBeenCalledTimes(1));
    expect(onCapturedResponse).toHaveBeenCalledWith({ status: 201, body: createdPost });
    expect(upstream.seen[0]?.acceptEncoding).toBeUndefined();
  });

  it("leaves uncaptured requests alone, including their accept-encoding", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    });
    const onCapturedResponse = vi.fn();
    const proxy = await startProxy({
      mmInternalUrl: upstream.url,
      log: vi.fn(),
      captureResponse: (req) => req.method === "POST" && req.url === "/api/v4/posts",
      onCapturedResponse,
    });

    const res = await fetch(`${proxy}/api/v4/users/me/teams`, { headers: { "accept-encoding": "gzip" } });

    expect(await res.text()).toBe("[]");
    expect(upstream.seen[0]?.acceptEncoding).toBe("gzip");
    expect(onCapturedResponse).not.toHaveBeenCalled();
  });

  it("drops an oversized captured body with a warning but still streams it to the client", async () => {
    const huge = "x".repeat(MAX_CAPTURED_RESPONSE_BYTES + 1);
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(201, { "content-type": "text/plain" });
      res.end(huge);
    });
    const log = vi.fn();
    const onCapturedResponse = vi.fn();
    const proxy = await startProxy({
      mmInternalUrl: upstream.url,
      log,
      captureResponse: () => true,
      onCapturedResponse,
    });

    const res = await fetch(`${proxy}/api/v4/posts`, { method: "POST" });

    expect((await res.text()).length).toBe(huge.length);
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining("captured response exceeded"), "warn"),
    );
    expect(onCapturedResponse).not.toHaveBeenCalled();
  });

  it("logs a throwing capture handler without affecting the client", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(createdPost);
    });
    const log = vi.fn();
    const proxy = await startProxy({
      mmInternalUrl: upstream.url,
      log,
      captureResponse: () => true,
      onCapturedResponse: () => { throw new Error("boom"); },
    });

    const res = await fetch(`${proxy}/api/v4/posts`, { method: "POST" });

    expect(await res.text()).toBe(createdPost);
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining("capture handler threw"), "warn"),
    );
  });
});
