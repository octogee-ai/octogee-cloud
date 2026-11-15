import { describe, expect, it, vi } from "vitest";

import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";
import { createOpenClawBootWatcher } from "../lib/openclaw-boot-watcher.js";

describe("OpenClaw boot watcher", () => {
  it("records an ordinary first start without running Doctor", async () => {
    const client = {
      claimOpenClawBoot: vi.fn(async () => ({ action: "start" as const })),
      completeOpenClawDoctor: vi.fn(async () => undefined),
      completeOpenClawBoot: vi.fn(async () => undefined),
    };
    const watcher = createOpenClawBootWatcher({
      client,
      releaseKey: "release@sha256:abc",
      log: () => undefined,
    });

    await watcher.beforeStart();

    expect(client.claimOpenClawBoot).toHaveBeenCalledWith({ releaseKey: "release@sha256:abc" });
  });

  it("refuses a Doctor claim that names no source request instead of repairing the home", async () => {
    const watcher = createOpenClawBootWatcher({
      client: {
        claimOpenClawBoot: vi.fn(async () => ({ action: "doctor" as const })),
        completeOpenClawDoctor: vi.fn(async () => undefined),
        completeOpenClawBoot: vi.fn(async () => undefined),
      },
      releaseKey: "release@sha256:abc",
      log: () => undefined,
    });

    await expect(watcher.beforeStart()).rejects.toThrow("OpenClaw boot claim requested Doctor without a source request");
  });

  it("clears the sentinel after health", async () => {
    const completeOpenClawBoot = vi.fn(async () => undefined);
    const watcher = createOpenClawBootWatcher({
      client: {
        claimOpenClawBoot: vi.fn(async () => ({ action: "start" as const })),
        completeOpenClawDoctor: vi.fn(async () => undefined),
        completeOpenClawBoot,
      },
      releaseKey: "release@sha256:abc",
      log: () => undefined,
    });

    await watcher.healthy();

    expect(completeOpenClawBoot).toHaveBeenCalledWith({ releaseKey: "release@sha256:abc" });
  });

  it("starts normally when the platform release does not have the sentinel route", async () => {
    const log = vi.fn();
    const watcher = createOpenClawBootWatcher({
      client: {
        claimOpenClawBoot: vi.fn(async () => {
          throw new Error("fleet-broker POST /internal/fleet/openclaw-boot/claim → 404");
        }),
        completeOpenClawDoctor: vi.fn(async () => undefined),
      completeOpenClawBoot: vi.fn(async () => undefined),
      },
      releaseKey: "release@sha256:abc",
      log,
    });

    await watcher.beforeStart();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("starting normally"));
  });

  it("does not hide a rejected sentinel claim", async () => {
    const failure = new Error("fleet-broker POST /internal/fleet/openclaw-boot/claim → 403");
    const watcher = createOpenClawBootWatcher({
      client: {
        claimOpenClawBoot: vi.fn(async () => { throw failure; }),
        completeOpenClawDoctor: vi.fn(async () => undefined),
      completeOpenClawBoot: vi.fn(async () => undefined),
      },
      releaseKey: "release@sha256:abc",
      log: () => undefined,
    });

    await expect(watcher.beforeStart()).rejects.toBe(failure);
  });

  it("finishes normally when the platform release does not have the completion route", async () => {
    const log = vi.fn();
    const watcher = createOpenClawBootWatcher({
      client: {
        claimOpenClawBoot: vi.fn(async () => ({ action: "start" as const })),
        completeOpenClawDoctor: vi.fn(async () => undefined),
      completeOpenClawBoot: vi.fn(async () => {
          throw new Error("fleet-broker POST /internal/fleet/openclaw-boot/healthy → 404");
        }),
      },
      releaseKey: "release@sha256:abc",
      log,
    });

    await watcher.healthy();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("completion unavailable"));
  });

  it("does not hide a rejected sentinel completion", async () => {
    const failure = new Error("fleet-broker POST /internal/fleet/openclaw-boot/healthy → 403");
    const watcher = createOpenClawBootWatcher({
      client: {
        claimOpenClawBoot: vi.fn(async () => ({ action: "start" as const })),
        completeOpenClawDoctor: vi.fn(async () => undefined),
      completeOpenClawBoot: vi.fn(async () => { throw failure; }),
      },
      releaseKey: "release@sha256:abc",
      log: () => undefined,
    });

    await expect(watcher.healthy()).rejects.toBe(failure);
  });
});


describe("operator-requested source Doctor", () => {
  const sourceDoctor = { requestId: "source-repair", agentIds: ["octogee-alice-coach"], postgresAgentStores: [{ agentId: "octogee-alice-coach", storeId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", schema: "owned_agent" }] };
  function fixture() {
    const order: string[] = [];
    const client = {
      claimOpenClawBoot: vi.fn().mockResolvedValue({ action: "doctor", sourceDoctor }),
      completeOpenClawBoot: vi.fn(),
      completeOpenClawDoctor: vi.fn(async () => { order.push("ack"); }),
    };
    const repairSourceDoctor = vi.fn(async () => { order.push("doctor"); });
    return { client: { ...client, assertOpenClawDoctor: vi.fn(async () => {}) }, repairSourceDoctor, order };
  }
  it("rejects an explicit repair without PostgreSQL authority before Native effects", async () => {
    const f = fixture();
    f.client.claimOpenClawBoot.mockResolvedValue({ action: "doctor", sourceDoctor: { requestId: "repair", agentIds: sourceDoctor.agentIds } });
    await expect(createOpenClawBootWatcher({ ...f, releaseKey: "qualified", log: () => {} }).beforeStart()).rejects.toThrow("invalid source Doctor request");
    expect(f.repairSourceDoctor).not.toHaveBeenCalled();
    expect(f.client.completeOpenClawDoctor).not.toHaveBeenCalled();
  });
  it.each([false, true])("uses the exact PostgreSQL owner roster and rechecks broker authority, scheduler repair=%s", async scheduler => {
    const f = fixture();
    const postgresAgentStores = [{ agentId: "octogee-alice-coach", storeId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", schema: "owned_agent" }];
    f.client.claimOpenClawBoot.mockResolvedValue({ action: "doctor", sourceDoctor: { ...sourceDoctor, postgresAgentStores,
      ...(scheduler ? { schedulerStateRecovery: true } : {}) } });
    const assertOpenClawDoctor = vi.fn(async () => {});
    const repairSourceDoctor = vi.fn(async (_ids, options) => { await options.assertCurrent(); });
    await createOpenClawBootWatcher({ ...f, client: { ...f.client, assertOpenClawDoctor }, repairSourceDoctor, releaseKey: "qualified", log: () => {} }).beforeStart();
    expect(repairSourceDoctor).toHaveBeenCalledWith(sourceDoctor.agentIds, { expectedAnchors: postgresAgentStores, assertCurrent: expect.any(Function),
      ...(scheduler ? { schedulerStateRecovery: true } : {}),
      diagnostics: { requestId: sourceDoctor.requestId, releaseKey: "qualified", log: expect.any(Function) },
    });
    expect(assertOpenClawDoctor).toHaveBeenCalledWith({ releaseKey: "qualified", requestId: sourceDoctor.requestId });
    expect(f.client.completeOpenClawDoctor).toHaveBeenCalledOnce();
  });
  it("keeps PostgreSQL startup fenced after authority loss during maintenance", async () => {
    const f = fixture();
    f.client.claimOpenClawBoot.mockResolvedValue({ action: "doctor", sourceDoctor: { ...sourceDoctor,
      postgresAgentStores: [{ agentId: "octogee-alice-coach", storeId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", schema: "owned_agent" }] } });
    const repairSourceDoctor = vi.fn(async (_ids, options) => { await options.assertCurrent(); });
    await expect(createOpenClawBootWatcher({ ...f, repairSourceDoctor, client: { ...f.client,
      assertOpenClawDoctor: vi.fn().mockRejectedValue(new Error("custody changed")) }, releaseKey: "qualified", log: () => {} }).beforeStart()).rejects.toThrow("custody changed");
    expect(f.client.completeOpenClawDoctor).not.toHaveBeenCalled();
  });
  it("acknowledges the requested repair only after the PostgreSQL repair completes", async () => {
    const f = fixture();
    await createOpenClawBootWatcher({ ...f, releaseKey: "observed-image-build", log: () => {} }).beforeStart();
    expect(f.order).toEqual(["doctor", "ack"]);
    expect(f.client.completeOpenClawDoctor).toHaveBeenCalledWith({ releaseKey: "observed-image-build", requestId: sourceDoctor.requestId, verifiedAgentIds: sourceDoctor.agentIds });
  });
  it("keeps the source repair unacknowledged when native postflight still refuses a requested store", async () => {
    const f = fixture(); f.repairSourceDoctor.mockRejectedValue(new Error("agent store still incompatible"));
    await expect(createOpenClawBootWatcher({ ...f, releaseKey: "observed-image-build", log: () => {} }).beforeStart()).rejects.toThrow("agent store still incompatible");
    expect(f.client.completeOpenClawDoctor).not.toHaveBeenCalled();
  });
  it("waits for the controller's installed image proof before spending the requested Doctor", async () => {
    const f = fixture();
    f.client.claimOpenClawBoot.mockResolvedValueOnce({ action: "wait", sourceDoctor });
    const wait = vi.fn(async () => { f.order.push("wait"); });
    await createOpenClawBootWatcher({ ...f, wait, releaseKey: "observed-image-build", log: () => {} }).beforeStart();
    expect(f.order).toEqual(["wait", "doctor", "ack"]);
  });
  it("does not acknowledge or preflight a failed canonical Doctor", async () => {
    const f = fixture(); f.repairSourceDoctor.mockRejectedValue(new Error("Doctor failed"));
    await expect(createOpenClawBootWatcher({ ...f, releaseKey: "observed-image-build", log: () => {} }).beforeStart()).rejects.toThrow("Doctor failed");
    expect(f.client.completeOpenClawDoctor).not.toHaveBeenCalled();
  });
  it("fails fenced after the bounded installed image proof wait instead of starting a writer", async () => {
    const f = fixture(); f.client.claimOpenClawBoot.mockResolvedValue({ action: "wait", sourceDoctor });
    let now = 0;
    await expect(createOpenClawBootWatcher({ ...f, now: () => now, wait: async (ms) => { now += ms; }, releaseKey: "observed-image-build", log: () => {} }).beforeStart()).rejects.toThrow("image proof wait timed out");
    expect(f.client.completeOpenClawDoctor).not.toHaveBeenCalled();
  });

  it("does not fall back to ordinary startup if the broker route disappears after an explicit request", async () => {
    const f = fixture(); f.client.claimOpenClawBoot.mockResolvedValueOnce({ action: "wait", sourceDoctor }).mockRejectedValue(new Error("fleet-broker POST /internal/fleet/openclaw-boot/claim → 404"));
    await expect(createOpenClawBootWatcher({ ...f, wait: async () => {}, releaseKey: "observed-image-build", log: () => {} }).beforeStart()).rejects.toThrow("source Doctor claim failed");
    expect(f.client.completeOpenClawDoctor).not.toHaveBeenCalled();
  });

});

describe("OpenClaw build reporting during platform rollout", () => {
  const installed = "b".repeat(40);
  function buildReportFixture(
    claim: Awaited<ReturnType<FleetBrokerClient["claimOpenClawBoot"]>>,
    { configured = true }: { configured?: boolean } = {},
  ) {
    const client = {
      claimOpenClawBoot: vi.fn(async () => claim),
      completeOpenClawDoctor: vi.fn(async () => undefined),
      completeOpenClawBoot: vi.fn(async () => undefined),
    };
    const watcher = createOpenClawBootWatcher({
      client,
      releaseKey: "release@sha256:abc",
      log: () => undefined,
      ...(configured ? { openclaw: { binary: "/opt/fixture/openclaw", installedBuild: async () => installed } } : {}),
    });
    return { client, watcher };
  }

  it("starts without Doctor whenever the platform says start, so a failed upgrade is not retried on every boot", async () => {
    const f = buildReportFixture({ action: "start" });

    await f.watcher.beforeStart();

    expect(f.client.claimOpenClawBoot).toHaveBeenCalledWith({ releaseKey: "release@sha256:abc", openclawBuild: installed });
  });

  it("reports the installed OpenClaw build with health", async () => {
    const f = buildReportFixture({ action: "start" });

    await f.watcher.healthy();

    expect(f.client.completeOpenClawBoot).toHaveBeenCalledWith({ releaseKey: "release@sha256:abc", openclawBuild: installed });
  });
});
