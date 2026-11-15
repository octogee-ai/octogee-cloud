import { describe, expect, it } from "vitest";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { createProvisioningServiceRuntime } from "../provisioning-service-runtime.js";
import { renderMetrics, resetMetrics, setProvisioningMetricsSource } from "../metrics.js";

const store = {} as PlatformStateStore;
const documents = { account: async () => undefined };

describe("provisioning service runtime", () => {
  it("is off, says so once and writes nothing when no service URL is configured", () => {
    const logs: string[] = [];

    const runtime = createProvisioningServiceRuntime({ env: {}, store, documents, log: (message) => logs.push(message) });

    expect(runtime).toBeNull();
    expect(logs).toEqual([expect.stringContaining("provisioning service: off")]);
  });

  it("refuses a service URL without a token path", () => {
    expect(() => createProvisioningServiceRuntime({
      env: { PROVISIONING_SERVICE_URL: "http://provisioning-service" },
      store,
      documents,
      log: () => undefined,
    })).toThrow(/PROVISIONING_SERVICE_TOKEN_PATH/);
  });

  it("starts with the product projection and exposes its counters on the controller metrics", () => {
    const logs: string[] = [];
    const runtime = createProvisioningServiceRuntime({
      env: { PROVISIONING_SERVICE_URL: "http://provisioning-service", PROVISIONING_SERVICE_TOKEN_PATH: "/var/run/token" },
      store,
      documents,
      projection: () => ({
        storedMattermostNames: async () => ({ username: null, coachChannelName: null }),
        systemConfig: async () => undefined,
        user: async () => undefined,
        workspace: async () => undefined,
        channel: async () => undefined,
        agent: async () => undefined,
        workspaceEntry: async () => undefined,
      }),
      log: (message) => logs.push(message),
    });

    resetMetrics();
    setProvisioningMetricsSource(runtime!.renderMetrics);

    expect(logs).toEqual([expect.stringContaining("provisioning service: on at http://provisioning-service; product projection installed")]);
    expect(renderMetrics()).toContain('glm_provisioning_service_requests_total{outcome="unreachable"} 0');
    expect(renderMetrics()).toContain("glm_provisioning_watch_connected 0");
    expect(renderMetrics()).toContain('glm_provisioning_mirrors_total{outcome="chat-id-mismatch"} 0');
    expect(renderMetrics()).toContain('glm_provisioning_deletes_total{outcome="unreadable"} 0');
    expect(renderMetrics()).toContain("glm_provisioning_mirror_refused_users 0");
    resetMetrics();
    expect(renderMetrics()).not.toContain("glm_provisioning");
  });
});
