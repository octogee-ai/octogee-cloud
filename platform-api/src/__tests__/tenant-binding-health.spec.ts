import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: fsMocks.readFile,
}));

import {
  createTenantBindingHealthState,
  startTenantBindingSelfCheck,
} from "../lib/tenant-binding-health.js";

describe("tenant binding health", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset();
  });

  it("starts pending and accepts explicit state transitions", () => {
    const state = createTenantBindingHealthState();

    expect(state.get()).toEqual({ status: "pending" });
    state.set({ status: "skipped", reason: "manual" });

    expect(state.get()).toEqual({ status: "skipped", reason: "manual" });
  });

  it("skips the self-check outside Kubernetes", () => {
    const state = createTenantBindingHealthState();
    const reviewer = vi.fn();

    startTenantBindingSelfCheck(state, { reviewer, inCluster: false });

    expect(state.get()).toEqual({ status: "skipped", reason: "not-in-kubernetes" });
    expect(reviewer).not.toHaveBeenCalled();
    expect(fsMocks.readFile).not.toHaveBeenCalled();
  });

  it("marks healthy after reading and authenticating the projected token", async () => {
    const state = createTenantBindingHealthState();
    const reviewer = vi.fn(async () => ({ authenticated: true, user: { username: "system:sa" } }));
    fsMocks.readFile.mockResolvedValue(" token\n");

    startTenantBindingSelfCheck(state, {
      reviewer,
      inCluster: true,
      tokenPath: "/tmp/projected-token",
    });

    await vi.waitFor(() => expect(state.get().status).toBe("healthy"));
    expect(fsMocks.readFile).toHaveBeenCalledWith("/tmp/projected-token", "utf8");
    expect(reviewer).toHaveBeenCalledWith("token");
    expect(state.get()).toEqual({ status: "healthy", checkedAt: expect.any(String) });
  });

  it("marks unhealthy and logs the reason when review fails", async () => {
    const state = createTenantBindingHealthState();
    const log = vi.fn();
    fsMocks.readFile.mockResolvedValue("token");

    startTenantBindingSelfCheck(state, {
      reviewer: vi.fn(async () => ({ authenticated: false })),
      inCluster: true,
      tokenPath: "/tmp/projected-token",
      log,
    });

    await vi.waitFor(() => expect(state.get().status).toBe("unhealthy"));
    expect(log).toHaveBeenCalledWith(
      "FATAL: tenant-binding self-check failed: projected token was not authenticated for octogee-api audience",
    );
    expect(state.get()).toEqual({
      status: "unhealthy",
      checkedAt: expect.any(String),
      reason: "projected token was not authenticated for octogee-api audience",
    });
  });
});
