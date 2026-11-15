import { signingKey } from "../test-setup/signature-keys.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const internalFetchSpy = vi.fn();

vi.mock("@octogee/core/internal-fetch", () => ({
  internalFetch: (url: string, init: RequestInit, opts: Record<string, unknown>) =>
    internalFetchSpy(url, init, opts),
}));

const { docs } = vi.hoisted(() => ({ docs: {} as Record<string, Record<string, unknown> | undefined> }));

vi.mock("@octogee/core/identity/platform-state-store", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(docs) };
});

const { platformStateStore } = await import("@octogee/core/identity/platform-state-store");
const modelCredentialSyncTrigger = await import("../lib/byot-sync-trigger.js");

function vmRuntime(gatewayId: string, vm: Record<string, unknown>): Record<string, unknown> {
  return { docKind: "runtime", gatewayId, release: 1, lifecycle: "serving", runtime: "gce-vm", vm };
}
const {
  gatewayModelCredentialSyncUrl,
  postGatewayModelCredentialSync,
  triggerGatewayModelCredentialSync,
} = modelCredentialSyncTrigger;

const userData = {
  byotActive: true,
  username: "smile-wring-011b",
  provisioning: { openclaw: { status: "complete" } },
  systemConfig: { byot: { provider: "openai", model: "openai/gpt-5" } },
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function expectedSignature(body: unknown, timestamp: string, secret: string): string {
  return crypto.sign(null, Buffer.from(`v1\nwalter\n${timestamp}\n${canonicalJson(body)}`), secret).toString("hex");
}

describe("model credential sync trigger", () => {
  beforeEach(() => {
    internalFetchSpy.mockReset();
    for (const path of Object.keys(docs)) delete docs[path];
    vi.restoreAllMocks();
    delete process.env.K8S_NAMESPACE;
    delete process.env.GATEWAY_EDGE_INTERNAL_URL_TEMPLATE;
    delete process.env.INTERNAL_SERVICE_KEY;
    delete process.env.BYOT_SYNC_INTERNAL_SIGNING_SECRET;
  });

  it("builds the per-instance gateway-edge URL, never the round-robin gateway alias", () => {
    expect(gatewayModelCredentialSyncUrl("walter", { K8S_NAMESPACE: "octogee-test" })).toBe(
      "http://gateway-edge-walter.octogee-test.svc.cluster.local:3001/api/g/walter/internal/model-credential-sync",
    );
  });

  it("honors an explicit gateway-edge URL template", () => {
    expect(
      gatewayModelCredentialSyncUrl("gw-1", {
        GATEWAY_EDGE_INTERNAL_URL_TEMPLATE: "http://custom-{gatewayId}.svc:3001/root/",
      }),
    ).toBe("http://custom-gw-1.svc:3001/root/api/g/gw-1/internal/model-credential-sync");
  });

  it("sends model selections to the running gateway VM instead of a nonexistent Kubernetes service", async () => {
    docs["glmGateways/builder-1"] = vmRuntime("builder-1", { status: "RUNNING", internalIp: "10.128.0.49" });
    internalFetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    await postGatewayModelCredentialSync({
      gatewayId: "builder-1", userData,
      env: { K8S_NAMESPACE: "octogee", BYOT_SYNC_INTERNAL_SIGNING_SECRET: signingKey },
    });
    expect(internalFetchSpy.mock.calls[0][0]).toBe(
      "http://10.128.0.49:3001/api/g/builder-1/internal/model-credential-sync",
    );
  });

  it.each([
    { status: "STOPPED", internalIp: "10.128.0.49" },
    { status: "RUNNING" },
    { status: "RUNNING", internalIp: "invalid/address" },
  ])("rejects an unavailable or malformed VM address instead of falling back to cluster DNS: %j", async (vm) => {
    docs["glmGateways/builder-1"] = vmRuntime("builder-1", vm);
    await expect(postGatewayModelCredentialSync({
      gatewayId: "builder-1", userData,
      env: { BYOT_SYNC_INTERNAL_SIGNING_SECRET: signingKey },
    })).rejects.toThrow("Gateway VM is not reachable");
    expect(internalFetchSpy).not.toHaveBeenCalled();
  });

  it("does not export legacy BYOT trigger helper aliases", () => {
    expect("gatewayByotSyncUrl" in modelCredentialSyncTrigger).toBe(false);
    expect("postGatewayByotSync" in modelCredentialSyncTrigger).toBe(false);
    expect("triggerGatewayByotSync" in modelCredentialSyncTrigger).toBe(false);
  });

  it("POSTs the userData through internalFetch with a model credential sync signature, enriched with the free-tier dial", async () => {
    internalFetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    await postGatewayModelCredentialSync({
      gatewayId: "walter",
      userData,
      env: { K8S_NAMESPACE: "octogee-test", BYOT_SYNC_INTERNAL_SIGNING_SECRET: signingKey },
    });
    // No dial doc → the compiled defaults ride along; the pod-side derive must
    // never fall back to its constant on a push while the fleet is dialed away.
    const enriched = {
      freeTierModelRef: "platform-openai/gpt-6-luna",
      builderAgentDefault: {
        primary: "platform-openai/gpt-6.1-terra",
        fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
      },
      ...userData,
    };
    expect(internalFetchSpy).toHaveBeenCalledWith(
      "http://gateway-edge-walter.octogee-test.svc.cluster.local:3001/api/g/walter/internal/model-credential-sync",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(enriched),
      }),
      expect.objectContaining({ fetchImpl: undefined }),
    );
    const headers = new Headers(internalFetchSpy.mock.calls[0][1].headers);
    expect(headers.get("content-type")).toBe("application/json");
    const timestamp = headers.get("x-byot-sync-timestamp");
    expect(timestamp).toMatch(/^\d+$/);
    expect(headers.get("x-byot-sync-signature")).toBe(
      expectedSignature(enriched, timestamp!, signingKey),
    );
    expect(headers.get("x-k8s-sa-token")).toBeNull();
  });

  it("carries the operator's dialed free-tier model on every push payload", async () => {
    docs["platformConfig/models"] = { freeTierModelRef: "anthropic/claude-haiku-4-5" };
    internalFetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    await postGatewayModelCredentialSync({
      gatewayId: "walter",
      userData,
      env: { K8S_NAMESPACE: "octogee-test", BYOT_SYNC_INTERNAL_SIGNING_SECRET: signingKey },
    });
    const body = JSON.parse(internalFetchSpy.mock.calls[0][1].body as string);
    expect(body.freeTierModelRef).toBe("anthropic/claude-haiku-4-5");
  });

  it("carries the operator's dialed user Agent default on every push payload", async () => {
    docs["platformConfig/models"] = {
      freeTierModelRef: "anthropic/claude-haiku-4-5",
      builderAgentModelRef: "anthropic/claude-sonnet-4-6",
      builderAgentFallbackModelRef: null,
    };
    internalFetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    await postGatewayModelCredentialSync({
      gatewayId: "walter",
      userData,
      env: { K8S_NAMESPACE: "octogee-test", BYOT_SYNC_INTERNAL_SIGNING_SECRET: signingKey },
    });
    const body = JSON.parse(internalFetchSpy.mock.calls[0][1].body as string);
    expect(body.builderAgentDefault).toEqual({
      primary: "anthropic/claude-sonnet-4-6",
      fallbacks: [],
    });
  });

  it("keeps the free-tier dial when the independent Ops dial is invalid", async () => {
    docs["platformConfig/models"] = {
      freeTierModelRef: "anthropic/claude-haiku-4-5",
      opsAgentModelRef: "anthropic/claude-haiku-4-5",
    };
    internalFetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    await postGatewayModelCredentialSync({
      gatewayId: "walter",
      userData,
      env: { K8S_NAMESPACE: "octogee-test", BYOT_SYNC_INTERNAL_SIGNING_SECRET: signingKey },
    });

    const body = JSON.parse(internalFetchSpy.mock.calls[0][1].body as string);
    expect(body.freeTierModelRef).toBe("anthropic/claude-haiku-4-5");
  });

  it("serves the compiled default when the dial read fails (loud, never blocking the sync)", async () => {
    vi.spyOn(platformStateStore.config.platform, "get").mockRejectedValue(new Error("firestore down"));
    internalFetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const warns: string[] = [];
    await postGatewayModelCredentialSync({
      gatewayId: "walter",
      userData,
      env: { K8S_NAMESPACE: "octogee-test", BYOT_SYNC_INTERNAL_SIGNING_SECRET: signingKey },
      logWarn: (m) => warns.push(m),
    });
    const body = JSON.parse(internalFetchSpy.mock.calls[0][1].body as string);
    expect(body.freeTierModelRef).toBe("platform-openai/gpt-6-luna");
    expect(body.builderAgentDefault).toEqual({
      primary: "platform-openai/gpt-6.1-terra",
      fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
    });
    expect(warns.join("\n")).toContain("platform model dial");
  });

  it("fails before network I/O when no BYOT sync signing secret is configured", async () => {
    await expect(
      postGatewayModelCredentialSync({
        gatewayId: "walter",
        userData,
        env: { K8S_NAMESPACE: "octogee-test" },
      }),
    ).rejects.toThrow(/BYOT_SYNC_INTERNAL_SIGNING_SECRET/);
    expect(internalFetchSpy).not.toHaveBeenCalled();
  });

  it("throws on non-2xx responses so the fire-and-forget wrapper can log", async () => {
    internalFetchSpy.mockResolvedValue(new Response("nope", { status: 503 }));
    await expect(
      postGatewayModelCredentialSync({
        gatewayId: "walter",
        userData,
        env: { BYOT_SYNC_INTERNAL_SIGNING_SECRET: signingKey },
      }),
    ).rejects.toThrow(/503 nope/);
  });

  it("fire-and-forget wrapper logs failures without throwing to the caller", async () => {
    internalFetchSpy.mockResolvedValue(new Response("nope", { status: 503 }));
    const warn = vi.fn();
    expect(() =>
      triggerGatewayModelCredentialSync({
        gatewayId: "walter",
        userData,
        env: { BYOT_SYNC_INTERNAL_SIGNING_SECRET: signingKey },
        logWarn: warn,
      }),
    ).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("503 nope")));
  });

  it.each([
    "routes/billing/byot.ts",
    "routes/byosub.ts",
  ])("%s imports the model credential trigger name", (relativePath) => {
    const src = readFileSync(join(import.meta.dirname, "..", relativePath), "utf8");
    expect(src).toContain("triggerGatewayModelCredentialSync");
    expect(src).not.toContain("triggerGatewayByotSync");
  });
});
