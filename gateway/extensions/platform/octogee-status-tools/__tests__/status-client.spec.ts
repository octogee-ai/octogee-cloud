import { describe, expect, it, vi } from "vitest";
import {
  fetchAgentUsageStatus,
  formatStatusText,
  gatewayClassMismatchNote,
  StatusToolError,
  type AgentUsageStatus,
} from "../status-client.js";

function status(overrides: Partial<AgentUsageStatus> = {}): AgentUsageStatus {
  return {
    gatewayClass: "shared",
    week: { percentUsed: 20, resetAt: "2026-07-06T00:00:00.000Z" },
    window: {
      percentUsed: 50,
      nextRefillAt: "2026-07-02T16:00:00.000Z",
      degraded: false,
      blocked: false,
      reason: null,
    },
    credits: null,
    credential: { path: "platform_broker", provider: null },
    ...overrides,
  };
}

const productFields = { tier: "pro", effectiveTier: "pro", trialDaysRemaining: 4 };

describe("fetchAgentUsageStatus", () => {
  it("POSTs the agentId with the projected KSA token and returns every field the broker sent", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(status(productFields)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await fetchAgentUsageStatus({
      agentId: "octogee-tester20-coach",
      brokerUrl: "http://broker.local/",
      tokenPath: "/token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readTokenImpl: async () => "ksa-token\n",
    });

    expect(result).toEqual(status(productFields));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://broker.local/internal/byok/agent-usage-status");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "x-k8s-sa-token": "ksa-token",
    });
    expect(JSON.parse(init.body as string)).toEqual({ agentId: "octogee-tester20-coach" });
  });

  it("throws a typed error on a broker failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(
      fetchAgentUsageStatus({
        agentId: "octogee-x-coach",
        brokerUrl: "http://broker.local",
        tokenPath: "/token",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        readTokenImpl: async () => "t",
      }),
    ).rejects.toThrowError(StatusToolError);
  });
});

describe("formatStatusText", () => {
  it("renders the platform-token view with window and throttle", () => {
    expect(formatStatusText(status())).toBe([
      "Gateway class: shared",
      "Billing: Platform tokens (metered broker token)",
      "Token window: 50% used · refills 2026-07-02T16:00:00.000Z",
      "Throttle: none — full models available",
    ].join("\n"));
  });

  it("reports the account fields a product adds to the broker response, in the order it sent them", () => {
    const text = formatStatusText(status(productFields));
    expect(text.split("\n")[1]).toBe("Account: tier pro · effectiveTier pro · trialDaysRemaining 4");
  });

  it("leaves out account fields the product sent as null", () => {
    const text = formatStatusText(status({ ...productFields, trialDaysRemaining: null }));
    expect(text).toContain("Account: tier pro · effectiveTier pro\n");
  });

  it("writes structured account fields as JSON", () => {
    const text = formatStatusText(status({ limits: { projects: 3 } }));
    expect(text).toContain('Account: limits {"projects":3}');
  });

  it("renders owner-subscription suppression clearly", () => {
    const text = formatStatusText(
      status({
        credential: { path: "byosub_suppressed_customer", provider: "claude-cli" },
      }),
    );
    expect(text).toContain(
      "Billing: Owner subscription SUPPRESSED (this gateway requires verified turn authority) — running platform tokens under the owner's policy (claude-cli)",
    );
    expect(text).toContain("Token window: 50% used");
  });

  it("renders user byosub with no platform budget lines", () => {
    const text = formatStatusText(
      status({
        gatewayClass: "isolated",
        credential: { path: "byosub", provider: "claude-cli" },
      }),
    );
    expect(text).toContain("Owner subscription (BYOSUB) — no platform budget");
    expect(text).not.toContain("Token window");
  });

  it("renders an exhausted window distinctly from a policy degradation, naming the policy reason", () => {
    expect(
      formatStatusText(
        status({ window: { ...status().window, degraded: true, reason: "window_exhausted" } }),
      ),
    ).toContain("Throttle: window exhausted — degraded to the house model until refill");
    expect(
      formatStatusText(
        status({ window: { ...status().window, degraded: true, reason: "free_tier" } }),
      ),
    ).toContain("Throttle: degraded to the house model (free_tier)");
  });

  it("renders a spent allowance as paused, never as still-serving", () => {
    const weekLocked = formatStatusText(
      status({ window: { ...status().window, blocked: true, reason: "week_exhausted" } }),
    );
    expect(weekLocked).toContain("Throttle: BLOCKED — weekly allowance spent, resumes when the week resets");
    const windowLocked = formatStatusText(
      status({ window: { ...status().window, blocked: true, reason: "window_exhausted" } }),
    );
    expect(windowLocked).toContain("Throttle: BLOCKED — burst window spent, resumes at the next refill");
    expect(windowLocked).not.toContain("Throttle: none");
  });
});

describe("gatewayClassMismatchNote", () => {
  it.each([
    ["isolated", "builder"],
    ["builder", "isolated"],
    ["builder", "builder"],
    ["isolated", "isolated"],
  ])("treats pod class %s and fleet doc class %s as the same class", (podClass, fleetDocClass) => {
    expect(gatewayClassMismatchNote(podClass, fleetDocClass)).toBe("");
  });

  it.each([
    ["shared", "isolated"],
    ["isolated", "shared"],
  ])("warns when pod class %s differs from fleet doc class %s", (podClass, fleetDocClass) => {
    expect(gatewayClassMismatchNote(podClass, fleetDocClass)).toBe(
      `\n⚠ pod env says GATEWAY_CLASS=${podClass} but the fleet doc says ${fleetDocClass}`,
    );
  });

  it("says nothing when the pod class is unknown", () => {
    expect(gatewayClassMismatchNote("", "builder")).toBe("");
  });
});
