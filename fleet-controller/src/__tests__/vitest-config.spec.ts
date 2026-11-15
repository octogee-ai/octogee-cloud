import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { describe, expect, it } from "vitest";
import config from "../../vitest.config.js";

interface VitestConfig {
  test?: { setupFiles?: string[] };
}

describe("glm-controller vitest config", () => {
  it("loads the deployment target fixture and the loopback listen shim", () => {
    expect((config as VitestConfig).test?.setupFiles).toEqual([
      "./src/test-setup/deployment-targets.ts",
      "./src/test-setup/octogee-entitlements.ts",
      "./src/test-setup/loopback-listen.ts",
      "./src/test-setup/public-app-origins.ts",
    ]);
  });
});

describe("loopback listen shim", () => {
  async function boundAddress(listenArgs: [number, string?]): Promise<string> {
    const server = http.createServer();
    server.listen(...listenArgs);
    await once(server, "listening");
    const { address } = server.address() as AddressInfo;
    server.close();
    return address;
  }

  it("pins host-less ephemeral listeners to 127.0.0.1", async () => {
    expect(await boundAddress([0])).toBe("127.0.0.1");
  });

  it("rewrites explicit wildcard hosts to 127.0.0.1", async () => {
    expect(await boundAddress([0, "0.0.0.0"])).toBe("127.0.0.1");
  });

  it("serves supertest requests from a loopback-bound server", async () => {
    let localAddress = "";
    await request((req: http.IncomingMessage, res: http.ServerResponse) => {
      localAddress = req.socket.localAddress ?? "";
      res.end("ok");
    })
      .get("/")
      .expect(200);
    expect(localAddress).toBe("127.0.0.1");
  });
});
