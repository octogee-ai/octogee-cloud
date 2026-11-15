import { describe, expect, it, vi } from "vitest";
import { verifyFleetRequest } from "@octogee/core/fleet-signature";
import {
  FLEET_STATE_PATH,
  SIGNATURE_HEADER,
} from "@octogee/shared/types/fleet-controller";

import { resolveMigrationRecoveryUrl } from "../lib/migration-rsync-transfer.js";
import { createFleetStateFetcher, readPrivateProjectAgentWorkspace } from "../fleet-state-client.js";
import { FLEET_KEY_PAIR, OTHER_FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";

const STATE_BODY = {
  status: "ready",
  gatewayId: "builder-jack",
  podUid: "pod-uid-1",
  version: "sha-1",
  openclawVersion: "2026.8.1-beta.2",
  startedAt: 42,
  customers: ["jack"],
  migratingIn: [],
};

function okResponse(body: unknown = STATE_BODY): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function fetcherWith(
  fetchImpl: typeof fetch,
  log: (message: string) => void = () => undefined,
  requestId = "req-1",
) {
  return createFleetStateFetcher({
    privateKey: FLEET_KEY_PAIR.privateKey,
    resolveBaseUrl: (gatewayId) => `http://octogee-gateway-${gatewayId}.ns.svc.cluster.local:3003`,
    timeoutMs: 5_000,
    log,
    fetchImpl,
    newRequestId: () => requestId,
  });
}

it("reads workspace support from the addressed running pod, including a held target", async () => {
  const gatewayId = STATE_BODY.gatewayId;
  const pod = (name: string, podIP: string, ready: boolean) => ({ metadata: { name }, status: {
    phase: "Running", podIP, conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
  } });
  const old = pod("old-serving", "10.10.0.1", true), held = pod("new-held", "10.10.0.2", false);
  const runCommand = vi.fn(async () => ({ stdout: JSON.stringify({ items: [old, held] }), stderr: "", code: 0 }));
  const resolve = () => resolveMigrationRecoveryUrl({ namespace: "test", gatewayId, port: "3003", runCommand, resolveGatewayVm: async () => null });
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const rawBody = init?.body as string;
    expect(JSON.parse(rawBody)).toMatchObject({ gatewayId, privateProjectCoachSlug: "jack" });
    expect(verifyFleetRequest(FLEET_KEY_PAIR.publicKey, "compat", rawBody, new Headers(init?.headers).get(SIGNATURE_HEADER)!)).toBe(true);
    const body = String(url).includes("10.10.0.2")
      ? { ...STATE_BODY, podUid: "held-uid", status: "booting", privateProjectCoachWorkspace: false }
      : STATE_BODY;
    return okResponse(body);
  });
  const read = async () => readPrivateProjectAgentWorkspace({
    baseUrl: await resolve(), gatewayId, privateKey: FLEET_KEY_PAIR.privateKey,
    privateProjectCoachSlug: "jack", timeoutMs: 5_000, fetchImpl, newRequestId: () => "compat",
  });

  await expect(read()).resolves.toBeUndefined();
  runCommand.mockResolvedValue({ stdout: JSON.stringify({ items: [held] }), stderr: "", code: 0 });
  await expect(read()).resolves.toBe(false);
  expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(["10.10.0.1", "10.10.0.2"]);
});

describe("createFleetStateFetcher", () => {
  it("reads the roster over a request signed by the fleet controller key", async () => {
    const fetchImpl = vi.fn(async () => okResponse());

    const state = await fetcherWith(fetchImpl as unknown as typeof fetch)("builder-jack");

    expect(state).toMatchObject({ status: "ready", users: ["jack"] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `http://octogee-gateway-builder-jack.ns.svc.cluster.local:3003${FLEET_STATE_PATH}/builder-jack`,
    );
    expect(init.method).toBe("POST");
    const rawBody = init.body as string;
    expect(JSON.parse(rawBody)).toEqual({ requestId: "req-1", gatewayId: "builder-jack" });
    const signature = (init.headers as Record<string, string>)[SIGNATURE_HEADER];
    expect(verifyFleetRequest(FLEET_KEY_PAIR.publicKey, "req-1", rawBody, signature)).toBe(true);
    expect(verifyFleetRequest(OTHER_FLEET_KEY_PAIR.publicKey, "req-1", rawBody, signature))
      .toBe(false);
  });

  it("binds each read to a fresh requestId", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse());
    let n = 0;
    const fetchState = createFleetStateFetcher({
      privateKey: FLEET_KEY_PAIR.privateKey,
      resolveBaseUrl: () => "http://gw:3003",
      timeoutMs: 5_000,
      log: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      newRequestId: () => `req-${++n}`,
    });

    await fetchState("builder-jack");
    await fetchState("builder-jack");

    const ids = fetchImpl.mock.calls.map(
      ([, init]) => JSON.parse((init as RequestInit).body as string).requestId as string,
    );
    expect(ids).toEqual(["req-1", "req-2"]);
  });

  it("names the signature mismatch when a pod rejects the read, instead of failing silently", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 }) as Response);
    const log = vi.fn();

    await expect(fetcherWith(fetchImpl as unknown as typeof fetch, log)("builder-jack"))
      .resolves.toBeNull();

    expect(log).toHaveBeenCalledTimes(1);
    const [message] = log.mock.calls[0] as [string];
    expect(message).toContain("builder-jack");
    expect(message).toContain("401");
    expect(message).toContain("FLEET_CONTROLLER_PUBLIC_KEY");
  });

  it("names the missing route when a pod predates the signed roster read", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }) as Response);
    const log = vi.fn();

    await fetcherWith(fetchImpl as unknown as typeof fetch, log)("builder-jack");

    expect((log.mock.calls[0] as [string])[0]).toContain("must be rolled");
  });

  it("reports a persistent fault once, not once per poll", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 }) as Response);
    const log = vi.fn();
    const fetchState = fetcherWith(fetchImpl as unknown as typeof fetch, log);

    await fetchState("builder-jack");
    await fetchState("builder-jack");
    await fetchState("builder-jack");

    expect(log).toHaveBeenCalledTimes(1);
  });

  it("reports recovery so a cleared fault is visible", async () => {
    let status = 401;
    const fetchImpl = vi.fn(async () =>
      (status === 200 ? okResponse() : { ok: false, status }) as Response);
    const log = vi.fn();
    const fetchState = fetcherWith(fetchImpl as unknown as typeof fetch, log);

    await fetchState("builder-jack");
    status = 200;
    await fetchState("builder-jack");

    expect(log).toHaveBeenCalledTimes(2);
    expect((log.mock.calls[1] as [string])[0]).toContain("healthy");
  });

  it("reports unreachable (null) when the transport fails, carrying the cause", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const log = vi.fn();

    await expect(fetcherWith(fetchImpl as unknown as typeof fetch, log)("builder-jack"))
      .resolves.toBeNull();

    expect((log.mock.calls[0] as [string])[0]).toContain("connection refused");
  });

  it("reports unreachable (null) for a malformed body", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ status: "ready" }));
    const log = vi.fn();

    await expect(fetcherWith(fetchImpl as unknown as typeof fetch, log)("builder-jack"))
      .resolves.toBeNull();

    expect((log.mock.calls[0] as [string])[0]).toContain("malformed");
  });
});
