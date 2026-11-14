import { describe, expect, it } from "vitest";

import { openClawProcessEnv } from "../entrypoints/surge-openclaw-supervisor.js";

describe("surge OpenClaw supervisor process environment", () => {
  it("keeps the pod token for the shared operator identity", () => {
    const env = openClawProcessEnv({
      OPENCLAW_GATEWAY_TOKEN: "pod-token",
      OCTOGEE_POD_RELAY_TOKEN: "pod-token",
      OPENCLAW_CONTROL_IDENTITY: "shared-operator",
    });

    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("pod-token");
    expect(env.OCTOGEE_POD_RELAY_TOKEN).toBe("pod-token");
  });

  it("withholds the pod token from a per-user OpenClaw process while keeping the relay credential", () => {
    const source = {
      OPENCLAW_GATEWAY_TOKEN: "pod-token",
      OCTOGEE_POD_RELAY_TOKEN: "pod-token",
      OPENCLAW_CONTROL_IDENTITY: "per-user",
      GATEWAY_ID: "walter",
    };

    const env = openClawProcessEnv(source);

    expect(env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
    expect(env.OCTOGEE_POD_RELAY_TOKEN).toBe("pod-token");
    expect(env.GATEWAY_ID).toBe("walter");
    expect(source.OPENCLAW_GATEWAY_TOKEN).toBe("pod-token");
  });

  it("hands a per-user VM gateway the pod secret as the local-direct password for its desktop node", () => {
    const env = openClawProcessEnv({
      OPENCLAW_GATEWAY_TOKEN: "pod-token",
      OPENCLAW_CONTROL_IDENTITY: "per-user",
      GATEWAY_RUNTIME_KIND: "gce-vm",
    });

    expect(env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
    expect(env.OPENCLAW_GATEWAY_PASSWORD).toBe("pod-token");
  });

  it("gives the production Hobby gateway the same local-direct credential as its desktop node", () => {
    const env = openClawProcessEnv({ OPENCLAW_GATEWAY_TOKEN: "pod-token", OPENCLAW_CONTROL_IDENTITY: "per-user", GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: "cluster", GATEWAY_COMPUTER_DESKTOP: "x11" });
    expect(env.OPENCLAW_GATEWAY_PASSWORD).toBe("pod-token");
    expect(env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
  });

  it("keeps cluster isolated gateways password-free", () => {
    const env = openClawProcessEnv({
      OPENCLAW_GATEWAY_TOKEN: "pod-token",
      OPENCLAW_CONTROL_IDENTITY: "per-user",
    });

    expect(env).not.toHaveProperty("OPENCLAW_GATEWAY_PASSWORD");
  });

  it.each([
    ["shared-operator", { OPENCLAW_CONTROL_IDENTITY: "shared-operator" }],
    ["per-user", { OPENCLAW_CONTROL_IDENTITY: "per-user", GATEWAY_RUNTIME_KIND: "gce-vm" }],
  ])("asks OpenClaw to print its failure stack for the %s identity", (_identity, source) => {
    expect(openClawProcessEnv({ ...source, OPENCLAW_GATEWAY_TOKEN: "pod-token" }).OPENCLAW_DEBUG).toBe("1");
  });

  it.each([
    ["shared-operator", { OPENCLAW_CONTROL_IDENTITY: "shared-operator" }],
    ["per-user", { OPENCLAW_CONTROL_IDENTITY: "per-user", GATEWAY_RUNTIME_KIND: "gce-vm" }],
  ])("widens the failure stack past Node's default frame limit for the %s identity", (_identity, source) => {
    expect(openClawProcessEnv({ ...source, OPENCLAW_GATEWAY_TOKEN: "pod-token" }).NODE_OPTIONS).toBe("--stack-trace-limit=50");
  });

  it("keeps inherited Node options ahead of the stack-trace limit", () => {
    const env = openClawProcessEnv({ OPENCLAW_CONTROL_IDENTITY: "shared-operator", NODE_OPTIONS: "--max-old-space-size=4096" });
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=4096 --stack-trace-limit=50");
  });
});
