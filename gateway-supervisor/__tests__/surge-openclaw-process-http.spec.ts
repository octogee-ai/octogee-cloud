import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { gatewayScopedJobId, signFleetRequest } from "../lib/fleet-signature.js";
import {
  createHoldSurgeOpenClawHandler,
  createResumeSurgeOpenClawHandler,
  createUnreserveSurgeOpenClawHandler,
} from "../lib/surge-openclaw-process-http.js";
import { SIGNATURE_HEADER } from "@octogee/shared/types/fleet-controller";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";

const PRIVATE_KEY = FLEET_KEY_PAIR.privateKey;
const PUBLIC_KEY = FLEET_KEY_PAIR.publicKey;
const GATEWAY_ID = "user-ceckert-test";

// The fleet controller scopes each pod-addressed signature to the gateway it addresses.
function signForPod(jobId: string, rawBody: string, gatewayId: string = GATEWAY_ID): string {
  return signFleetRequest(PRIVATE_KEY, gatewayScopedJobId(jobId, gatewayId), rawBody);
}

function response() {
  let status = 200;
  let body: unknown;
  return {
    status: (code: number) => {
      status = code;
      return { json: (value: unknown) => { body = value; } };
    },
    json: (value: unknown) => { body = value; },
    result: () => ({ status, body }),
  };
}

function request(body: Record<string, unknown>, signature?: string, pathGatewayId = GATEWAY_ID) {
  const rawBody = JSON.stringify(body);
  return {
    rawBody,
    params: { gatewayId: pathGatewayId },
    header: (name: string) => name.toLowerCase() === SIGNATURE_HEADER.toLowerCase() ? signature : undefined,
  };
}

function gateRequest(body: { migrationId: string; slug: string; targetPodUid: string }) {
  return { migrationId: body.migrationId, slug: body.slug, targetPodUid: body.targetPodUid };
}

const GATE_STATE = {
  version: 1 as const,
  podUid: "target-pod",
  role: "target" as const,
  mode: "held" as const,
  phase: "held" as const,
};

beforeEach(() => { vi.stubEnv("POD_UID", "target-pod"); });
afterEach(() => vi.unstubAllEnvs());

describe("surge OpenClaw process control handlers", () => {
  it.each(["foreign", "missing"] as const)("refuses a signed hold at the wrong or unbound receiving allocation before gate effects: %s", async scenario => {
    const hold = vi.fn(async () => ({ ...GATE_STATE, role: "source" as const }));
    const drain = vi.fn();
    const handler = createHoldSurgeOpenClawHandler({ publicKey: PUBLIC_KEY, gatewayId: GATEWAY_ID,
      configuredBuilder: () => true, processGate: { hold, resume: vi.fn(), unreserve: vi.fn(), finalizeTargetCancellation: vi.fn() },
      waitForActiveProvisioningDrain: drain });
    const body = { migrationId: "abandoned-target", slug: "ceckert-test", targetPodUid: "old-pod",
      ...(scenario === "foreign" ? { receivingPodUid: "old-pod" } : {}) };
    const res = response();
    await handler(request(body, signForPod(body.migrationId, JSON.stringify(body))) as never, res as never, vi.fn());
    expect(res.result().status).toBe(scenario === "foreign" ? 409 : 400);
    expect(hold).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  });

  it("requires a signed configured user hold and returns only after the child is held", async () => {
    const hold = vi.fn(async () => ({ ...GATE_STATE, completionStarted: false }));
    const handler = createHoldSurgeOpenClawHandler({
      publicKey: PUBLIC_KEY,
      gatewayId: GATEWAY_ID,
      configuredBuilder: (slug) => slug === "ceckert-test",
      processGate: { hold, resume: vi.fn(), unreserve: vi.fn(), finalizeTargetCancellation: vi.fn() },
    });
    const body = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
      receivingPodUid: "target-pod",
    };
    const raw = JSON.stringify(body);
    const res = response();

    await handler(
      request(body, signForPod(body.migrationId, raw)) as never,
      res as never,
      vi.fn(),
    );

    expect(hold).toHaveBeenCalledWith(gateRequest(body));
    expect(res.result()).toEqual({
      status: 200,
      body: { ...gateRequest(body), operation: "hold", role: "target", mode: "held", phase: "held", completionStarted: false },
    });
  });

  it("waits for an active source reconcile after holding the user process", async () => {
    vi.stubEnv("POD_UID", "source-pod");
    let releaseDrain: (() => void) | undefined;
    const hold = vi.fn(async () => ({ ...GATE_STATE, role: "source" as const }));
    const waitForActiveProvisioningDrain = vi.fn(() => new Promise<void>((resolve) => {
      releaseDrain = resolve;
    }));
    const handler = createHoldSurgeOpenClawHandler({
      publicKey: PUBLIC_KEY,
      gatewayId: GATEWAY_ID,
      configuredBuilder: (slug) => slug === "ceckert-test",
      processGate: { hold, resume: vi.fn(), unreserve: vi.fn(), finalizeTargetCancellation: vi.fn() },
      waitForActiveProvisioningDrain,
    });
    const body = {
      migrationId: "surge-gateway-source",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
      receivingPodUid: "source-pod",
    };
    const raw = JSON.stringify(body);
    const res = response();
    let settled = false;
    const held = handler(
      request(body, signForPod(body.migrationId, raw)) as never,
      res as never,
      vi.fn(),
    ).then(() => {
      settled = true;
    });

    await Promise.resolve();

    expect(hold).toHaveBeenCalledWith(gateRequest(body));
    expect(waitForActiveProvisioningDrain).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    releaseDrain?.();
    await held;

    expect(res.result()).toEqual({
      status: 200,
      body: { ...gateRequest(body), operation: "hold", role: "source", mode: "held", phase: "held" },
    });
  });

  it("finalizes a signed target cancellation only after user provisioning drains", async () => {
    let releaseDrain!: () => void;
    const hold = vi.fn(async () => ({ ...GATE_STATE, phase: "cancelling" as const }));
    const finalizeTargetCancellation = vi.fn(async () => ({
      ...GATE_STATE,
      role: "normal" as const,
      phase: "held" as const,
    }));
    const waitForActiveProvisioningDrain = vi.fn(() => new Promise<void>((resolve) => {
      releaseDrain = resolve;
    }));
    const handler = createHoldSurgeOpenClawHandler({
      publicKey: PUBLIC_KEY,
      gatewayId: GATEWAY_ID,
      configuredBuilder: (slug) => slug === "ceckert-test",
      processGate: { hold, resume: vi.fn(), unreserve: vi.fn(), finalizeTargetCancellation },
      waitForActiveProvisioningDrain,
    });
    const body = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
      receivingPodUid: "target-pod",
    };
    const raw = JSON.stringify(body);
    const res = response();
    let settled = false;
    const held = handler(
      request(body, signForPod(body.migrationId, raw)) as never,
      res as never,
      vi.fn(),
    ).then(() => { settled = true; });

    await Promise.resolve();

    expect(waitForActiveProvisioningDrain).toHaveBeenCalledOnce();
    expect(finalizeTargetCancellation).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    releaseDrain();
    await held;

    expect(finalizeTargetCancellation).toHaveBeenCalledWith(gateRequest(body));
    expect(res.result()).toEqual({
      status: 200,
      body: { ...gateRequest(body), operation: "hold", role: "normal", mode: "held", phase: "held" },
    });
  });

  it("refuses unsigned and foreign user resume attempts", async () => {
    const resume = vi.fn();
    const handler = createResumeSurgeOpenClawHandler({
      publicKey: PUBLIC_KEY,
      gatewayId: GATEWAY_ID,
      configuredBuilder: () => false,
      processGate: { hold: vi.fn(), resume, unreserve: vi.fn(), finalizeTargetCancellation: vi.fn() },
    });
    const body = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
      receivingPodUid: "target-pod",
    };
    const unsignedRes = response();
    await handler(request(body) as never, unsignedRes as never, vi.fn());
    expect(unsignedRes.result().status).toBe(401);

    const signedRes = response();
    const raw = JSON.stringify(body);
    await handler(
      request(body, signForPod(body.migrationId, raw)) as never,
      signedRes as never,
      vi.fn(),
    );
    expect(signedRes.result().status).toBe(409);
    expect(resume).not.toHaveBeenCalled();
  });

  it("unreserves a signed configured isolated target through the gate", async () => {
    const unreserve = vi.fn(async () => ({
      ...GATE_STATE,
      role: "normal" as const,
    }));
    const handler = createUnreserveSurgeOpenClawHandler({
      publicKey: PUBLIC_KEY,
      gatewayId: GATEWAY_ID,
      configuredBuilder: (slug) => slug === "ceckert-test",
      processGate: { hold: vi.fn(), resume: vi.fn(), unreserve, finalizeTargetCancellation: vi.fn() },
    });
    const body = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
      receivingPodUid: "target-pod",
    };
    const raw = JSON.stringify(body);
    const res = response();

    await handler(
      request(body, signForPod(body.migrationId, raw)) as never,
      res as never,
      vi.fn(),
    );

    expect(unreserve).toHaveBeenCalledWith(gateRequest(body));
    expect(res.result()).toEqual({
      status: 200,
      body: { ...gateRequest(body), operation: "unreserve", role: "normal", mode: "held", phase: "held" },
    });
  });
});
