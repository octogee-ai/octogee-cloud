import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { forwardMmRest } from "../mm-proxy/rest.js";

interface CapturedUpstream {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface FakeMmServer {
  port: number;
  baseUrl: string;
  captured: CapturedUpstream[];
  setResponse: (
    handler: (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => void | Promise<void>,
  ) => void;
  close: () => Promise<void>;
}

async function startFakeMm(): Promise<FakeMmServer> {
  const captured: CapturedUpstream[] = [];
  let respond: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => void | Promise<void> = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  };

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString("utf-8"),
      });
      void respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    captured,
    setResponse: (handler) => {
      respond = handler;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

interface FakeProxyServer {
  port: number;
  close: () => Promise<void>;
}

async function startProxy(mmInternalUrl: string): Promise<FakeProxyServer> {
  const server = http.createServer((req, res) => {
    forwardMmRest({ mmInternalUrl, log: () => undefined }, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

let mm: FakeMmServer;
let proxy: FakeProxyServer;

beforeAll(async () => {
  mm = await startFakeMm();
  proxy = await startProxy(mm.baseUrl);
});

afterAll(async () => {
  await proxy.close();
  await mm.close();
});

function fetchProxy(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${proxy.port}${path}`,
      {
        method: init.method ?? "GET",
        headers: init.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

describe("forwardMmRest — REST proxy forwarding semantics", () => {
  it("forwards GET method + path + query verbatim and preserves status code + body", async () => {
    mm.setResponse((_req, res) => {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ created: true }));
    });

    const result = await fetchProxy("/api/v4/users/me?include=teams", {
      method: "GET",
      headers: { Authorization: "Bearer test-token", "X-Custom": "yes" },
    });

    expect(result.status).toBe(201);
    expect(JSON.parse(result.body)).toEqual({ created: true });
    expect(mm.captured.length).toBeGreaterThan(0);
    const last = mm.captured[mm.captured.length - 1];
    expect(last.method).toBe("GET");
    expect(last.url).toBe("/api/v4/users/me?include=teams");
    expect(last.headers.authorization).toBe("Bearer test-token");
    expect(last.headers["x-custom"]).toBe("yes");
  });

  it("forwards POST method + body verbatim", async () => {
    mm.setResponse((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ echoed: true }));
    });

    const payload = JSON.stringify({ channel_id: "ch1", message: "hello" });
    const result = await fetchProxy("/api/v4/posts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(payload)),
        Authorization: "Bearer test",
      },
      body: payload,
    });

    expect(result.status).toBe(200);
    const last = mm.captured[mm.captured.length - 1];
    expect(last.method).toBe("POST");
    expect(last.url).toBe("/api/v4/posts");
    expect(last.body).toBe(payload);
    expect(last.headers["content-type"]).toBe("application/json");
  });

  it("strips hop-by-hop headers (Connection, Transfer-Encoding, etc.)", async () => {
    mm.setResponse((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    await fetchProxy("/api/v4/system/ping", {
      headers: {
        Connection: "keep-alive",
        "Keep-Alive": "timeout=5",
        "Proxy-Authorization": "shouldnt-leak",
      },
    });

    const last = mm.captured[mm.captured.length - 1];
    expect(last.headers["proxy-authorization"]).toBeUndefined();
    expect(last.headers["keep-alive"]).toBeUndefined();
  });

  it("rewrites the Host header to the upstream target", async () => {
    mm.setResponse((_req, res) => {
      res.writeHead(200);
      res.end();
    });

    await fetchProxy("/api/v4/users/me");
    const last = mm.captured[mm.captured.length - 1];
    expect(last.headers.host).toBe(`127.0.0.1:${mm.port}`);
  });

  it("returns 502 with JSON body when upstream is unreachable", async () => {
    const orphan = await startProxy("http://127.0.0.1:1");
    try {
      const result = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const req = http.request(
            `http://127.0.0.1:${orphan.port}/api/v4/users/me`,
            { method: "GET" },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf-8"),
                }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        },
      );
      expect(result.status).toBe(502);
      expect(JSON.parse(result.body)).toEqual({
        error: "Mattermost upstream unavailable",
      });
    } finally {
      await orphan.close();
    }
  });
});
