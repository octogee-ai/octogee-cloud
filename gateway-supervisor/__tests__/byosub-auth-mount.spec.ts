import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerByosubDeviceAuth,
  startFleetController,
} from "../lib/fleet-provisioner.js";
import type {
  StartFleetOptions,
  StartedFleetController,
} from "../lib/fleet-provisioner.js";
import type { GatewayRpcClient } from "../lib/gateway-rpc.js";
import type { UserLifecycleAdapter } from "../lib/user-lifecycle.js";

const KEY = "internal-key-123";

// A mounted route validates the internal-service-key and returns 401/4xx;
// an unmounted route 404s.
const BYOSUB_ROUTES = [
  "/internal/byosub/claude-sso/start",
  "/internal/byosub/claude-sso/submit",
  "/internal/byosub/device-auth/start",
];

// A controller without the local reconcile resolves caps.provision false, the
// capability the byosub auth mount was previously gated behind. The mount must
// not depend on it.
function operatorOpts(port: number): StartFleetOptions {
  return {
    rpc: {} as GatewayRpcClient,
    adapter: {} as UserLifecycleAdapter,
    gatewayId: "walter-test",
    revisionId: "walter-test-r1",
    log: () => undefined,
    port,
    publicKey: "pk",
    version: "v",
    openclawVersion: "oc",
    internalServiceKey: KEY,
    openclawDir: "/tmp/octogee-byosub-mount-noexist",
  } as StartFleetOptions;
}

describe("byosub auth route mount", () => {
  let controller: StartedFleetController | undefined;
  beforeEach(() => vi.stubEnv("K8S_NAMESPACE", "shared-test"));
  afterEach(async () => {
    await controller?.stop();
    controller = undefined;
    vi.unstubAllEnvs();
  });

  it("an operator (db-less) fleet controller still mounts the byosub auth endpoints", async () => {
    controller = await startFleetController(operatorOpts(0));
    for (const path of BYOSUB_ROUTES) {
      const res = await fetch(`http://127.0.0.1:${controller.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status, `${path} should be mounted`).not.toBe(404);
    }
  });

  it("registerByosubDeviceAuth mounts the endpoints and 401s a missing key", async () => {
    const app = express();
    registerByosubDeviceAuth(app, operatorOpts(0));
    const res = await request(app)
      .post("/internal/byosub/claude-sso/start")
      .send({ agentId: "probe" });
    expect(res.status).toBe(401);
  });
});
