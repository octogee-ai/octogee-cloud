import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brokerSignalSubscriptionNeedsReauth } from "./byot-sync-runtime.js";

const originalEnv = { ...process.env };
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-state-signal-"));
  process.env.FLEET_BROKER_URL = "http://api.local/";
  process.env.OCTOGEE_API_SA_TOKEN_PATH = path.join(tmp, "token");
  fs.writeFileSync(process.env.OCTOGEE_API_SA_TOKEN_PATH, "projected-jwt\n");
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  fs.rmSync(tmp, { recursive: true, force: true });
});

const rejection = { gatewayId: "gw-ada", agentId: "octogee-ada-coach", provider: "anthropic" as const, observedAt: 1_780_000_000_000 };

describe("brokerSignalSubscriptionNeedsReauth", () => {
  it("posts the rejected login to the subscription auth-state route with the gateway's projected token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);

    await brokerSignalSubscriptionNeedsReauth(rejection);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.local/api/model-credentials/subscription/auth-state");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-k8s-sa-token")).toBe("projected-jwt");
    expect(JSON.parse(init.body as string)).toEqual({ ...rejection, state: "needs_reauth" });
  });

  it("throws with the status when the platform refuses the signal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));

    await expect(brokerSignalSubscriptionNeedsReauth(rejection)).rejects.toThrow("subscription auth-state 403 forbidden");
  });

  it("refuses to send without the gateway's projected token", async () => {
    fs.rmSync(process.env.OCTOGEE_API_SA_TOKEN_PATH!);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(brokerSignalSubscriptionNeedsReauth(rejection)).rejects.toThrow("projected service-account token unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
