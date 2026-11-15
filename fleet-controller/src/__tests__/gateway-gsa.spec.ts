import { describe, it, expect, vi } from "vitest";
import {
  isolatedGatewayServiceAccountEmail,
  createGatewayServiceAccountTeardown,
  gatewaysHaveGoogleServiceAccounts,
} from "../lib/gateway-gsa";

describe("isolatedGatewayServiceAccountEmail", () => {
  it("builds the per-gateway GSA email from the KSA naming convention + project", () => {
    expect(isolatedGatewayServiceAccountEmail("walter", "octogee")).toBe(
      "octogee-gw-walter@octogee.iam.gserviceaccount.com",
    );
  });
});

describe("createGatewayServiceAccountTeardown — best-effort, idempotent", () => {
  it("DELETEs the per-gateway GSA via the IAM API (deleting the SA removes its WI binding)", async () => {
    const request = vi.fn(async () => ({ status: 200 }));
    const log = vi.fn();
    const teardown = createGatewayServiceAccountTeardown({ request, projectId: "octogee", log });

    await teardown("mama");

    expect(request).toHaveBeenCalledWith({
      url: "https://iam.googleapis.com/v1/projects/-/serviceAccounts/octogee-gw-mama%40octogee.iam.gserviceaccount.com",
      method: "DELETE",
    });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/deleted GSA octogee-gw-mama@/));
  });

  it("no-ops on 404 (no GSA for this gateway — cattle, or never provisioned)", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("not found"), { response: { status: 404 } });
    });
    const log = vi.fn();
    const teardown = createGatewayServiceAccountTeardown({ request, projectId: "octogee", log });

    await expect(teardown("cattle-1")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no GSA .* no-op/));
  });

  it("no-ops on a 404 surfaced as err.code (gaxios variant)", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("not found"), { code: 404 });
    });
    const teardown = createGatewayServiceAccountTeardown({
      request,
      projectId: "octogee",
      log: vi.fn(),
    });
    await expect(teardown("cattle-2")).resolves.toBeUndefined();
  });

  it("rethrows non-404 failures (e.g. 403) — no silent failure", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("permission denied"), { response: { status: 403 } });
    });
    const teardown = createGatewayServiceAccountTeardown({
      request,
      projectId: "octogee",
      log: vi.fn(),
    });
    await expect(teardown("x")).rejects.toThrow(/permission denied/);
  });
});

describe("gatewaysHaveGoogleServiceAccounts", () => {
  it("is false on an install that binds gateways to no Workload Identity project, as kind, GKE and EKS installs do", () => {
    expect(gatewaysHaveGoogleServiceAccounts("none")).toBe(false);
    expect(gatewaysHaveGoogleServiceAccounts(" none ")).toBe(false);
  });

  it("is true where gateways bind a Workload Identity project", () => {
    expect(gatewaysHaveGoogleServiceAccounts("octogee")).toBe(true);
  });
});
