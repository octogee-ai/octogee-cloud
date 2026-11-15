import express from "express";
import { generateKeyPairSync } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { signFleetRequest } from "../lib/fleet-signature.js";
import { fleetStatePrivateProjectAgentWorkspace } from "../lib/fleet-provisioner.js";
import { createFleetStateHandler } from "../lib/fleet-state-http.js";
import {
  FLEET_STATE_PATH,
  SIGNATURE_HEADER,
  type FleetStateResponse,
} from "@octogee/shared/types/fleet-controller";

function ed25519Pair(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

const FLEET_CONTROLLER = ed25519Pair();
const IMPOSTOR = ed25519Pair();

const STATE: FleetStateResponse = {
  status: "ready",
  gatewayId: "shared-a",
  podUid: "pod-uid-1",
  version: "sha-1",
  openclawVersion: "2026.8.1-beta.2",
  startedAt: 42,
  users: ["alice", "bob"],
  migratingIn: ["carol"],
  configuredBuilder: null,
};

function appWith(gatewayId = "shared-a"): express.Express {
  const app = express();
  app.use(express.json({
    verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }));
  app.post(
    `${FLEET_STATE_PATH}/:gatewayId`,
    createFleetStateHandler({
      publicKey: FLEET_CONTROLLER.publicKey,
      gatewayId,
      readState: ({ privateProjectCoachSlug }) => ({ ...STATE, gatewayId,
        ...(privateProjectCoachSlug ? { privateProjectCoachWorkspace: fleetStatePrivateProjectAgentWorkspace({
          agents: { entries: { "octogee-alice-proj-orbit-coach": { workspace: "/openclaw/customers/alice/.system/project-coaches/orbit" },
            "octogee-bob-proj-orbit-coach": { workspace: "/openclaw/customers/bob/projects/orbit" } } },
        }, "/openclaw", privateProjectCoachSlug) } : {}),
      }),
      log: () => undefined,
    }),
  );
  return app;
}

function signedPost(
  app: express.Express,
  pathGatewayId: string,
  body: Record<string, unknown>,
  privateKey = FLEET_CONTROLLER.privateKey,
) {
  const rawBody = JSON.stringify(body);
  return request(app)
    .post(`${FLEET_STATE_PATH}/${pathGatewayId}`)
    .set("content-type", "application/json")
    .set(SIGNATURE_HEADER, signFleetRequest(privateKey, String(body.requestId), rawBody))
    .send(rawBody);
}

describe("signed fleet state endpoint", () => {
  it("returns the tenant roster to a request signed by the fleet controller key", async () => {
    const res = await signedPost(appWith(), "shared-a", {
      requestId: "req-1",
      gatewayId: "shared-a",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(STATE);
  });

  it("reports the addressed tenant's configured workspace only to the fleet controller", async () => {
    const body = { requestId: "req-private", gatewayId: "shared-a", privateProjectCoachSlug: "alice" };
    const own = await signedPost(appWith(), "shared-a", body);
    expect(own.body.privateProjectCoachWorkspace).toBe(true);
    const other = await signedPost(appWith(), "shared-a", { ...body, privateProjectCoachSlug: "bob" });
    expect(other.body.privateProjectCoachWorkspace).toBe(false);
    const unsigned = await signedPost(appWith(), "shared-a", body, IMPOSTOR.privateKey);
    expect(unsigned.status).toBe(401);
    expect(unsigned.body).not.toHaveProperty("privateProjectCoachWorkspace");
  });

  it("rejects an unsigned request without confirming which gateway answered", async () => {
    const res = await request(appWith())
      .post(`${FLEET_STATE_PATH}/shared-a`)
      .set("content-type", "application/json")
      .send(JSON.stringify({ requestId: "req-1", gatewayId: "shared-a" }));

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("shared-a");
    expect(res.body).not.toHaveProperty("customers");
  });

  it("rejects a signature minted by any key but the fleet controller's", async () => {
    const res = await signedPost(
      appWith(),
      "shared-a",
      { requestId: "req-1", gatewayId: "shared-a" },
      IMPOSTOR.privateKey,
    );

    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty("customers");
  });

  it("refuses a signature minted for another gateway, so a relayed capture cannot be replayed", async () => {
    const res = await signedPost(appWith("builder-jack"), "builder-jack", {
      requestId: "req-1",
      gatewayId: "shared-a",
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("builder-jack");
    expect(res.body).not.toHaveProperty("customers");
  });

  it("refuses a path gatewayId that does not address this pod", async () => {
    const res = await signedPost(appWith("builder-jack"), "shared-a", {
      requestId: "req-1",
      gatewayId: "builder-jack",
    });

    expect(res.status).toBe(400);
    expect(res.body).not.toHaveProperty("customers");
  });

  it("rejects a signed body that is missing requestId or gatewayId", async () => {
    const res = await signedPost(appWith(), "shared-a", { requestId: "req-1" });

    expect(res.status).toBe(400);
    expect(res.body).not.toHaveProperty("customers");
  });

  it("rejects an unparseable body before it reaches the state read", async () => {
    const res = await request(appWith())
      .post(`${FLEET_STATE_PATH}/shared-a`)
      .set("content-type", "application/json")
      .set(SIGNATURE_HEADER, signFleetRequest(FLEET_CONTROLLER.privateKey, "req-1", "not json"))
      .send("not json");

    expect(res.status).toBe(400);
    expect(res.body).not.toHaveProperty("customers");
  });

  it("answers with a state that is read asynchronously", async () => {
    const res = await signedPost(appReading(async () => STATE), "shared-a", { requestId: "req-1", gatewayId: "shared-a" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(STATE);
  });

  it("logs a failed state read and answers without tenant identity", async () => {
    const log = vi.fn();
    const res = await signedPost(appReading(async () => { throw new Error("roster unreadable"); }, log), "shared-a", {
      requestId: "req-1",
      gatewayId: "shared-a",
    });

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("shared-a");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("roster unreadable"));
  });
});

function appReading(readState: () => Promise<FleetStateResponse>, log: (message: string) => void = () => undefined): express.Express {
  const app = express();
  app.use(express.json({
    verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }));
  app.post(`${FLEET_STATE_PATH}/:gatewayId`, createFleetStateHandler({
    publicKey: FLEET_CONTROLLER.publicKey,
    gatewayId: "shared-a",
    readState,
    log,
  }));
  return app;
}
