import { afterEach, describe, expect, it, vi } from "vitest";
import { realDeviceAuthDeps } from "../lib/byosub-device-auth-io.js";

const ORIGINAL_K8S_NAMESPACE = process.env.K8S_NAMESPACE;
const ORIGINAL_OCTOGEE_API_URL = process.env.OCTOGEE_API_URL;

afterEach(() => {
  if (ORIGINAL_K8S_NAMESPACE === undefined) delete process.env.K8S_NAMESPACE;
  else process.env.K8S_NAMESPACE = ORIGINAL_K8S_NAMESPACE;
  if (ORIGINAL_OCTOGEE_API_URL === undefined) delete process.env.OCTOGEE_API_URL;
  else process.env.OCTOGEE_API_URL = ORIGINAL_OCTOGEE_API_URL;
  vi.unstubAllGlobals();
});

describe("realDeviceAuthDeps postCapture", () => {
  it("defaults capture posts to octogee-api in the current namespace", async () => {
    process.env.K8S_NAMESPACE = "shared-test";
    delete process.env.OCTOGEE_API_URL;
    const calls: Array<{ url: string; body: unknown; key: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        calls.push({
          url,
          body: JSON.parse(String(init.body)),
          key: headers.get("x-internal-service-key"),
        });
        return new Response("{}", { status: 200 });
      }),
    );

    const deps = realDeviceAuthDeps({
      openclawDir: "/tmp/openclaw",
      internalServiceKey: "",
    });

    await expect(deps.postCapture("flow-1", "{\"ok\":true}")).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      {
        url: "http://octogee-api.shared-test.svc.cluster.local:3001/api/model-credentials/subscription/capture",
        body: { flowId: "flow-1", credential: "{\"ok\":true}" },
        key: null,
      },
    ]);
  });

  it("honors OCTOGEE_API_URL for capture posts", async () => {
    process.env.OCTOGEE_API_URL = "http://octogee-api.custom:3001/";
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response("{}", { status: 200 });
      }),
    );

    const deps = realDeviceAuthDeps({
      openclawDir: "/tmp/openclaw",
      internalServiceKey: "k",
    });

    await expect(deps.postCapture("flow-1", "{}")).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      "http://octogee-api.custom:3001/api/model-credentials/subscription/capture",
    ]);
  });
});
