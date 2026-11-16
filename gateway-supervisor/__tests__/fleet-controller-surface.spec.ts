import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gatewayScopedJobId, signFleetRequest } from "../lib/fleet-signature.js";
import { startFleetController } from "../lib/fleet-provisioner.js";
import type {
  StartFleetOptions,
  StartedFleetController,
} from "../lib/fleet-provisioner.js";
import type { GatewayRpcClient } from "../lib/gateway-rpc.js";
import type { UserLifecycleAdapter } from "../lib/user-lifecycle.js";
import {
  FLEET_STATE_PATH,
  SIGNATURE_HEADER,
} from "@octogee/shared/types/fleet-controller";
import { stubUserClaim } from "./helpers/user-claim.js";

const GATEWAY_ID = "builder-jack";

function ed25519Pair(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

const FLEET_CONTROLLER = ed25519Pair();

function controllerOpts(): StartFleetOptions {
  return {
    rpc: {} as GatewayRpcClient,
    adapter: {} as UserLifecycleAdapter,
    gatewayId: GATEWAY_ID,
    log: () => undefined,
    port: 0,
    publicKey: FLEET_CONTROLLER.publicKey,
    version: "sha-1",
    openclawVersion: "2026.8.1-beta.2",
    openclawDir: "/tmp/octogee-fleet-surface-noexist",
  } as StartFleetOptions;
}

function signedFleetStateRequest(port: number, body: Record<string, unknown>): Promise<Response> {
  const rawBody = JSON.stringify(body);
  return fetch(`http://127.0.0.1:${port}${FLEET_STATE_PATH}/${GATEWAY_ID}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SIGNATURE_HEADER]: signFleetRequest(FLEET_CONTROLLER.privateKey, String(body.requestId), rawBody),
    },
    body: rawBody,
  });
}

describe("fleet controller port surface", () => {
  let controller: StartedFleetController | undefined;

  beforeEach(() => {
    vi.stubEnv("K8S_NAMESPACE", "shared-test");
    vi.stubEnv("POD_UID", "pod-uid-1");
  });

  afterEach(async () => {
    await controller?.stop();
    controller = undefined;
    vi.unstubAllEnvs();
  });

  it("answers the unauthenticated probe with liveness and capabilities but no roster or tenant identity", async () => {
    controller = await startFleetController(controllerOpts());

    const res = await fetch(`http://127.0.0.1:${controller.port}/health`);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["podUid", "provisioning", "rsyncAttemptFencing", "startedAt", "status"]);
    expect(body.rsyncAttemptFencing).toBe(true);
    expect(body.provisioning).toBe("service");
    expect(body.podUid).toBe("pod-uid-1");
    expect(JSON.stringify(body)).not.toContain(GATEWAY_ID);
  });

  it.each([
    ["fresh held boot", "normal", "held", "held", "pod-uid-1", false],
    ["hydrated reservation", "target", "held", "held", "pod-uid-1", true],
    ["running process", "normal", "permitted", "running", "pod-uid-1", true],
    ["another pod", "normal", "held", "held", "old-pod", true],
  ])("publishes the mount proof appropriate to %s", async (_name, role, mode, phase, podUid, expectedMounted) => {
    stubUserClaim("jack");
    let mounted = true;
    const clearMountMarker = vi.fn(() => { mounted = false; });
    const opts = controllerOpts();
    opts.adapter = {
      isIsolatedGateway: () => true,
      isConfiguredUser: (slug: string) => slug === "jack",
      configuredUserOverlayPresent: () => true,
      listLocalUserSlugs: () => ["jack"],
      hasWorkspaceGitDir: () => true,
      hasGitRemote: () => true,
      userMountMarked: () => mounted,
      clearMountMarker,
    } as unknown as UserLifecycleAdapter;
    opts.surgeOpenClawProcessGate = {
      status: async () => ({ version: 1, podUid, role, mode, phase }),
    } as unknown as NonNullable<StartFleetOptions["surgeOpenClawProcessGate"]>;
    controller = await startFleetController(opts);
    const response = await signedFleetStateRequest(controller.port, { requestId: "retained-home", gatewayId: GATEWAY_ID });
    expect(response.status).toBe(200);
    expect((await response.json()).customers).toEqual(expectedMounted ? ["jack"] : []);
    expect(clearMountMarker).toHaveBeenCalledTimes(expectedMounted ? 0 : 1);
  });

  it("treats a user slug that is only in the environment as no configured user", async () => {
    vi.stubEnv("GATEWAY_BUILDER_SLUG", "jack");
    const clearMountMarker = vi.fn();
    const opts = controllerOpts();
    opts.adapter = {
      isIsolatedGateway: () => true,
      isConfiguredUser: () => true,
      configuredUserOverlayPresent: () => true,
      listLocalUserSlugs: () => ["jack"],
      hasWorkspaceGitDir: () => true,
      hasGitRemote: () => true,
      userMountMarked: () => true,
      clearMountMarker,
    } as unknown as UserLifecycleAdapter;
    opts.surgeOpenClawProcessGate = {
      status: async () => ({ version: 1, podUid: "pod-uid-1", role: "normal", mode: "held", phase: "held" }),
    } as unknown as NonNullable<StartFleetOptions["surgeOpenClawProcessGate"]>;
    controller = await startFleetController(opts);
    const response = await signedFleetStateRequest(controller.port, { requestId: "env-only", gatewayId: GATEWAY_ID });
    expect(response.status).toBe(200);
    expect(clearMountMarker).not.toHaveBeenCalled();
  });

  it("serves the roster only to a fleet-controller-signed request", async () => {
    controller = await startFleetController(controllerOpts());

    const res = await signedFleetStateRequest(controller.port, {
      requestId: "req-1",
      gatewayId: GATEWAY_ID,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      gatewayId: GATEWAY_ID,
      podUid: "pod-uid-1",
      version: "sha-1",
      openclawVersion: "2026.8.1-beta.2",
      customers: [],
      migratingIn: [],
    });
  });

  it("refuses an unsigned roster read", async () => {
    controller = await startFleetController(controllerOpts());

    const res = await fetch(
      `http://127.0.0.1:${controller.port}${FLEET_STATE_PATH}/${GATEWAY_ID}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: "req-1", gatewayId: GATEWAY_ID }),
      },
    );

    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(GATEWAY_ID);
  });

  it("answers an unsigned migration call identically whichever gatewayId it names", async () => {
    controller = await startFleetController(controllerOpts());

    const unsigned = (pathGatewayId: string) =>
      fetch(`http://127.0.0.1:${controller!.port}/quiesce/${pathGatewayId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ migrationId: "m1", slug: "alice" }),
      });

    const [mine, theirs] = await Promise.all([unsigned(GATEWAY_ID), unsigned("shared-a")]);

    expect(mine.status).toBe(401);
    expect(theirs.status).toBe(401);
    expect(await mine.text()).toEqual(await theirs.text());
  });

  it("refuses a migration call signed for a sibling gateway, so a relay cannot act here", async () => {
    controller = await startFleetController(controllerOpts());

    const rawBody = JSON.stringify({ migrationId: "m1", slug: "alice" });
    const res = await fetch(`http://127.0.0.1:${controller.port}/quiesce/${GATEWAY_ID}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signFleetRequest(
          FLEET_CONTROLLER.privateKey,
          gatewayScopedJobId("m1", "shared-a"),
          rawBody,
        ),
      },
      body: rawBody,
    });

    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(GATEWAY_ID);
  });

  it("rejects a correctly signed migration call whose path names another gateway", async () => {
    controller = await startFleetController(controllerOpts());

    const rawBody = JSON.stringify({ migrationId: "m1", slug: "alice" });
    const res = await fetch(`http://127.0.0.1:${controller.port}/quiesce/shared-a`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signFleetRequest(
          FLEET_CONTROLLER.privateKey,
          gatewayScopedJobId("m1", GATEWAY_ID),
          rawBody,
        ),
      },
      body: rawBody,
    });

    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(GATEWAY_ID);
  });
});
