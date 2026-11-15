import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import http, { type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentControlCallbackRouter } from "@octogee/core/http-candidates/agent-control-callback-router";
import { applyGatewayPrefixStripInPlace } from "../chat-proxy/gateway-prefix.js";
import { createMattermostInteractionProxyHandler } from "../chat-proxy/openclaw/mattermost-interaction-proxy.js";
import { signingKey, verificationKey } from "../test-setup/signature-keys.js";

const servers: Server[] = [];
const now = 1_800_000_000_000;
const legacySecret = "local-test-legacy-callback-secret";
const otherKey = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
}).publicKey;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback address");
  return `http://127.0.0.1:${address.port}`;
}

interface WireRequest {
  body: Buffer;
  headers: IncomingHttpHeaders;
}

async function callbackChain(options: {
  publicKey?: string;
  receiverGatewayId?: string;
  alterWire?: (request: WireRequest) => WireRequest;
} = {}) {
  const deliveries: Array<{ path: string | undefined; body: string; headers: IncomingHttpHeaders }> = [];
  const upstream = await listen(http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    deliveries.push({ path: req.url, body: Buffer.concat(chunks).toString(), headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ update: { message: "local callback accepted" } }));
  }));
  const handler = createMattermostInteractionProxyHandler({
    gatewayId: options.receiverGatewayId ?? "walter",
    routerPublicKey: options.publicKey ?? verificationKey,
    targetOrigin: upstream,
    now: () => now,
    log: () => undefined,
  });
  const receiver = await listen(http.createServer((req, res) => {
    applyGatewayPrefixStripInPlace(req);
    void handler(req, res);
  }));
  let target = receiver;
  if (options.alterWire) {
    target = await listen(http.createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const altered = options.alterWire!({ body: Buffer.concat(chunks), headers: { ...req.headers } });
        const headers = new Headers();
        for (const [name, value] of Object.entries(altered.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        headers.set("content-length", String(altered.body.length));
        const response = await fetch(`${receiver}${req.url}`, {
          method: "POST", headers, body: new Uint8Array(altered.body), signal: AbortSignal.timeout(5_000),
        });
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(await response.text());
      } catch (error) {
        console.error("Callback fixture request failed", error);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "callback_fixture_failed" }));
      }
    }));
  }
  const router = await listen(createAgentControlCallbackRouter({
    namespace: "octogee-test",
    signingKey,
    now: () => now,
    targetOrigin: () => target,
    log: () => undefined,
  }));
  return {
    deliveries,
    send: (body: string, account = "default") => fetch(
      `${router}/internal/openclaw/mattermost/walter/mattermost/interactions/${account}`,
      { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(5_000) },
    ),
  };
}

describe("callback signatures across the router and runtime receiver", () => {
  it.each(["default", "alice-project"])("delivers an unchanged %s callback through both real endpoints", async (account) => {
    const chain = await callbackChain();
    const body = '{ "post_id": "local-post", "context": { "action": "approve", "label": "café" } }';
    const response = await chain.send(body, account);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ update: { message: "local callback accepted" } });
    expect(chain.deliveries).toHaveLength(1);
    expect(chain.deliveries[0]).toMatchObject({ path: `/mattermost/interactions/${account}`, body });
    expect(chain.deliveries[0].headers["x-octogee-agent-control-signature"]).toBeUndefined();
  });

  it.each([
    { name: "another verification key", options: { publicKey: otherKey } },
    { name: "another gateway identity", options: { receiverGatewayId: "other-user" } },
    {
      name: "body changed after signing",
      options: { alterWire: (request: WireRequest) => ({ ...request, body: Buffer.from('{"action":"deny"}') }) },
    },
    {
      name: "a legacy HMAC sender",
      options: { alterWire: (request: WireRequest) => ({
        ...request,
        headers: {
          ...request.headers,
          "x-octogee-agent-control-signature": createHmac("sha256", legacySecret)
            .update(`v1\nwalter\n${now}\n${createHash("sha256").update(request.body).digest("hex")}`).digest("hex"),
        },
      }) },
    },
  ])("refuses $name before invoking the runtime", async ({ options }) => {
    const chain = await callbackChain(options);
    const response = await chain.send('{"action":"approve"}');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(chain.deliveries).toEqual([]);
  });
});
