import { describe, expect, it, vi } from "vitest";
import { platformReleaseRecord, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import {
  deployFleet,
  formatFleetSummary,
  FleetDeploymentDeferredError,
  type FleetGateway,
  type FleetSnapshot,
} from "../lib/fleet-deploy.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const tag = "aaaaaaa-oc2026.10.2";
const payload: ReleasePayload = {
  imageRepository: "registry/images/octogee-gateway",
  imageTag: `${tag}@${digest("a")}`,
  profileImages: { isolated: { imageRepository: "registry/images/octogee-gateway-builder", imageTag: `${tag}@${digest("b")}` } },
  gatewayEdgeImage: { imageRepository: "registry/images/gateway-edge", imageTag: `${tag}@${digest("c")}` },
};
const old = { ...payload, imageTag: `old@${digest("d")}` };

function gateway(id: string, patch: Partial<FleetGateway> = {}): FleetGateway {
  const shared = id.startsWith("shared-");
  const image = shared ? payload : payload.profileImages!.isolated;
  return {
    gatewayId: id, gatewayClass: shared ? "shared" : "isolated", imageProfile: shared ? "standard" : "isolated", addedBy: shared ? "automation" : null,
    desiredStatus: "running", latestRelease: 2, desiredRelease: 2, liveRelease: 2,
    latestPayload: payload, desiredPayload: payload, assignments: [], operations: [],
    runtime: { release: 2, lifecycle: "serving", status: "ready", heartbeatAt: 100, mountedCustomers: [], migratingIn: [] },
    live: { observedAt: 100, instances: [{ id: "instance-1", ready: true, containers: [
      { name: "gateway", image: `${image.imageRepository}:${image.imageTag}`, digests: [image.imageTag.split("@")[1]], running: true },
      { name: "gateway-edge", image: `${payload.gatewayEdgeImage!.imageRepository}:${payload.gatewayEdgeImage!.imageTag}`, digests: [digest("c")], running: true },
    ] }] },
    ...patch,
  };
}

function harness(snapshots: FleetSnapshot[]) {
  let time = 100;
  let index = 0;
  const deploy = vi.fn(async (_target: FleetGateway) => ({ release: 2, operationId: "roll-2" }));
  const readSnapshot = vi.fn(async () => structuredClone(snapshots[Math.min(index++, snapshots.length - 1)]));
  const deps = { readSnapshot, deploy, now: () => time, sleep: async (ms: number) => { time += ms; }, log: vi.fn() };
  const run = () => deployFleet({ environment: "test", sourceSha: "a".repeat(40), payload, timeoutMs: 500, pollIntervalMs: 100, maxObservationAgeMs: 1000 }, deps);
  return { run, deploy, readSnapshot, deps };
}
const snapshot = (...gateways: FleetGateway[]): FleetSnapshot => ({ gateways, sharedReplacements: [], platform: platformReleaseRecord(payload, 100), retirements: [] });

describe("complete TEST fleet deployment", () => {
  it("deploys PROD users and retains paused gateways without starting them", async () => {
    const h = harness([
      snapshot(gateway("shared-0"), gateway("b-live", { latestPayload: old, desiredPayload: old }), gateway("b-paused", { desiredStatus: "paused", latestPayload: old, desiredPayload: old })),
      snapshot(gateway("shared-0"), gateway("b-live"), gateway("b-paused", { desiredStatus: "paused", runtime: null, live: null })),
    ]);
    const report = await deployFleet({ environment: "prod", sourceSha: "a".repeat(40), payload, timeoutMs: 500, pollIntervalMs: 100, maxObservationAgeMs: 1000 }, h.deps);
    expect(report.environment).toBe("prod");
    expect(report.outcome).toBe("converged");
    expect(h.deploy.mock.calls.map(([target]) => target.gatewayId)).toEqual(["b-live", "b-paused"]);
    expect(report.targets.find((target) => target.gatewayId === "b-paused")?.status).toBe("paused-desired-only");
  });
  it("deploys every user including paused roots, never shared or retired roots, and reports paused desired-only", async () => {
    const shared = gateway("shared-0");
    const before = (id: string, desiredStatus: "running" | "paused") => gateway(id, { desiredStatus, latestRelease: 1, desiredRelease: 1, latestPayload: old, desiredPayload: old });
    const h = harness([
      snapshot(shared, before("b-live", "running"), before("b-paused", "paused"), gateway("b-retired", { desiredStatus: "retired" })),
      snapshot(shared, gateway("b-live"), gateway("b-paused", { desiredStatus: "paused", runtime: null, live: null }), gateway("b-retired", { desiredStatus: "retired" })),
    ]);
    const report = await h.run();
    expect(h.deploy.mock.calls.map(([target]) => target.gatewayId)).toEqual(["b-live", "b-paused"]);
    expect(report.outcome).toBe("converged");
    expect(report.targets.find((target) => target.gatewayId === "b-paused")?.status).toBe("paused-desired-only");
    expect(report.targets.find((target) => target.gatewayId === "b-retired")?.status).toBe("retired-skipped");
    expect(h.readSnapshot).toHaveBeenCalledTimes(3);
  });

  it("rescans and deploys users created while the ship is converging", async () => {
    const h = harness([
      snapshot(gateway("shared-0")),
      snapshot(gateway("shared-0"), gateway("b-new", { latestPayload: old, desiredPayload: old, latestRelease: 1, desiredRelease: 1 })),
      snapshot(gateway("shared-0"), gateway("b-new")),
    ]);
    expect((await h.run()).outcome).toBe("converged");
    expect(h.deploy).toHaveBeenCalledOnce();
    expect(h.deploy.mock.calls[0][0].gatewayId).toBe("b-new");
    expect(h.readSnapshot).toHaveBeenCalledTimes(4);
  });

  it("rescans a typed transient ownership fence and deploys once the source becomes idle", async () => {
    const oldUser = gateway("b-busy", { latestPayload: old, desiredPayload: old, latestRelease: 1, desiredRelease: 1 });
    const h = harness([snapshot(gateway("shared-0"), oldUser), snapshot(gateway("shared-0"), oldUser), snapshot(gateway("shared-0"), gateway("b-busy"))]);
    h.deploy.mockRejectedValueOnce(new FleetDeploymentDeferredError("source transfer outcome is unresolved"));
    expect((await h.run()).outcome).toBe("converged");
    expect(h.deploy).toHaveBeenCalledTimes(2);
    expect(h.deps.log.mock.calls[0][0]).toContain("source transfer outcome is unresolved");
  });

  it("reports an eventually retired user after a transient retirement race", async () => {
    const h = harness([snapshot(gateway("shared-0"), gateway("b-retiring", { latestPayload: old })), snapshot(gateway("shared-0"), gateway("b-retiring", { desiredStatus: "retired" }))]);
    h.deploy.mockRejectedValue(new FleetDeploymentDeferredError("retirement claim"));
    const report = await h.run();
    expect(report.outcome).toBe("converged");
    expect(report.targets.find((target) => target.gatewayId === "b-retiring")?.status).toBe("retired-skipped");
    expect(h.deploy).toHaveBeenCalledOnce();
  });

  it("records a mutation failure against the exact target", async () => {
    const h = harness([snapshot(gateway("shared-0"), gateway("b-broken", { latestPayload: old }))]);
    h.deploy.mockRejectedValue(new Error("retirement fence"));
    const report = await h.run();
    expect(report.outcome).toBe("failed");
    expect(report.targets.find((target) => target.gatewayId === "b-broken")).toMatchObject({ status: "failed", reasons: ["retirement fence"] });
  });

  it("fails a rollout operation for the target release without accepting an old serving runtime", async () => {
    const h = harness([snapshot(gateway("shared-0"), gateway("b-failed", { operations: [{ id: "roll", release: 2, status: "failed", error: "roll failed" }] }))]);
    expect((await h.run()).targets.find((target) => target.gatewayId === "b-failed")).toMatchObject({ status: "failed", reasons: ["rollout roll failed: roll failed"] });
  });

  it.each(["gateway", "gateway-edge"])("refuses a live %s digest mismatch despite matching tags", async (name) => {
    const target = gateway("b-drift");
    target.live!.instances[0].containers.find((container) => container.name === name)!.digests = [digest("e")];
    const report = await harness([snapshot(gateway("shared-0"), target)]).run();
    expect(report.outcome).toBe("timed-out");
    expect(report.targets.find((item) => item.gatewayId === "b-drift")?.reasons.join(" ")).toContain(`${name} digest`);
  });

  it("replaces a mixed desired image family and never declares it converged", async () => {
    const mixed = { ...payload, profileImages: { isolated: { ...payload.profileImages!.isolated, imageTag: `old@${digest("e")}` } } };
    const h = harness([snapshot(gateway("shared-0"), gateway("b-mixed", { latestPayload: mixed, desiredPayload: mixed }))]);
    expect((await h.run()).outcome).toBe("timed-out");
    expect(h.deploy).toHaveBeenCalledOnce();
  });

  it("waits for shared replacement to finish, retire its old member, and remove assignments", async () => {
    const oldShared = gateway("shared-old", { desiredStatus: "draining", assignments: [{ slug: "ada", state: "serving" }] });
    const nextShared = gateway("shared-new");
    const h = harness([
      { platform: platformReleaseRecord(payload, 100), retirements: [], gateways: [oldShared, nextShared], sharedReplacements: [{ sourceGatewayId: "shared-old", targetGatewayId: "shared-new", updatedAt: 0 }] },
      snapshot({ ...oldShared, desiredStatus: "retired", live: { observedAt: 200, instances: [] } }, nextShared),
      snapshot({ ...oldShared, desiredStatus: "retired", assignments: [], live: { observedAt: 300, instances: [] } }, nextShared),
    ]);
    const report = await h.run();
    expect(report.outcome).toBe("converged");
    expect(h.readSnapshot).toHaveBeenCalledTimes(4);
    expect(h.deploy).not.toHaveBeenCalled();
    expect(report.targets.find((target) => target.gatewayId === "shared-old")?.status).toBe("shared-retired");
  });

  it("reports shared gateways an operator added with their build and does not wait on them", async () => {
    const h = harness([snapshot(
      gateway("shared-0"),
      gateway("shared-ops1", { addedBy: "operator", latestPayload: old, desiredPayload: old }),
      gateway("shared-ops2", { addedBy: "operator", desiredStatus: "paused", latestPayload: old, desiredPayload: old, runtime: null, live: null }),
    )]);

    const report = await h.run();

    expect(report.outcome).toBe("converged");
    expect(h.deploy).not.toHaveBeenCalled();
    expect(report.targets.filter((target) => target.addedBy === "operator")).toEqual([
      expect.objectContaining({ gatewayId: "shared-ops1", status: "operator-reported", build: old.imageTag, reasons: [] }),
      expect.objectContaining({ gatewayId: "shared-ops2", status: "operator-reported", build: old.imageTag, reasons: [] }),
    ]);
    expect(formatFleetSummary(report)).toContain(`| shared-ops1 | operator-reported |`);
  });

  it("does not converge while the only running shared gateway is one an operator added", async () => {
    const h = harness([snapshot(
      gateway("shared-0", { desiredStatus: "retired", runtime: null, live: null }),
      gateway("shared-ops1", { addedBy: "operator", latestPayload: old, desiredPayload: old }),
    )]);

    const report = await h.run();

    expect(report.outcome).toBe("timed-out");
    expect(report.reasons).toContain("no running Shared gateway added by automation");
  });

  it("requires fresh live observation and heartbeat, not desired config alone", async () => {
    const stale = gateway("b-stale");
    stale.live!.observedAt = 99;
    stale.runtime!.heartbeatAt = 99;
    const report = await harness([snapshot(gateway("shared-0"), stale)]).run();
    expect(report.outcome).toBe("timed-out");
    expect(report.targets.find((target) => target.gatewayId === "b-stale")?.reasons).toEqual(expect.arrayContaining(["live observation predates ship or is stale", "heartbeat predates ship or is stale"]));
  });

  it("fails before fleet writes when another platform release supersedes the selected family", async () => {
    const h = harness([{ ...snapshot(gateway("shared-0"), gateway("b-old", { latestPayload: old })), platform: platformReleaseRecord(old, 100) }]);
    const report = await h.run();
    expect(report.outcome).toBe("failed");
    expect(report.reasons.join(" ")).toContain("superseded");
    expect(h.deploy).not.toHaveBeenCalled();
  });

  it("accepts deployed short-SHA Shared tags while keeping user releases canonical", async () => {
    const deployed: ReleasePayload = {
      ...payload, imageTag: payload.imageTag.replace(tag, "aaaaaaa"),
      profileImages: { isolated: { ...payload.profileImages!.isolated, imageTag: payload.profileImages!.isolated.imageTag.replace(tag, "aaaaaaa") } },
      gatewayEdgeImage: { ...payload.gatewayEdgeImage!, imageTag: payload.gatewayEdgeImage!.imageTag.replace(tag, "aaaaaaa") },
    };
    const h = harness([{ ...snapshot(gateway("shared-0", { latestPayload: deployed, desiredPayload: deployed }), gateway("b-old-tag", { latestPayload: deployed, desiredPayload: deployed })), platform: platformReleaseRecord(deployed, 100) },
      { ...snapshot(gateway("shared-0", { latestPayload: deployed, desiredPayload: deployed }), gateway("b-old-tag")), platform: platformReleaseRecord(deployed, 100) }]);
    expect((await h.run()).outcome).toBe("converged");
    expect(h.deploy.mock.calls.map(([target]) => target.gatewayId)).toEqual(["b-old-tag"]);
  });

  it.each(["source", "openclaw"])("rejects platform %s supersession even when image digests are reused", async (field) => {
    const changed: ReleasePayload = field === "openclaw" ? { ...payload, openclawSourceSha: "f".repeat(40) } : {
      ...payload, imageTag: payload.imageTag.replace(tag, "bbbbbbb"),
      profileImages: { isolated: { ...payload.profileImages!.isolated, imageTag: payload.profileImages!.isolated.imageTag.replace(tag, "bbbbbbb") } },
      gatewayEdgeImage: { ...payload.gatewayEdgeImage!, imageTag: payload.gatewayEdgeImage!.imageTag.replace(tag, "bbbbbbb") },
    };
    const h = harness([{ ...snapshot(gateway("shared-0")), platform: platformReleaseRecord(changed, 100) }]);
    expect((await h.run()).outcome).toBe("failed");
    expect(h.deploy).not.toHaveBeenCalled();
  });

  it("accepts a swept Shared root only with its completed retirement journal and fresh empty live inventory", async () => {
    const gone = { ...snapshot(gateway("shared-new")), retirements: [{ gatewayId: "shared-old", operationId: "retire-old", completedAt: 150, live: { observedAt: 200, instances: [] } }] };
    const h = harness([snapshot(gateway("shared-old", { desiredStatus: "draining" }), gateway("shared-new")), gone]);
    const report = await h.run();
    expect(report.outcome).toBe("converged");
    expect(report.targets.find((target) => target.gatewayId === "shared-old")).toMatchObject({ status: "shared-retired", retirementOperationId: "retire-old" });
  });

  it("reports a deleted user with a succeeded retirement journal as skipped without live image claims", async () => {
    const gone = { ...snapshot(gateway("shared-0")), retirements: [{ gatewayId: "b-old", operationId: "retire-user", completedAt: 150, live: { observedAt: 200, instances: [] } }] };
    const report = await harness([snapshot(gateway("shared-0"), gateway("b-old")), gone]).run();
    expect(report.outcome).toBe("converged");
    expect(report.targets.find((target) => target.gatewayId === "b-old")).toMatchObject({ status: "retired-skipped", observed: null, retirementOperationId: "retire-user" });
  });

  it("bounds the final job summary and keeps target text inside table cells", async () => {
    const report = await harness([snapshot(gateway("shared-0"))]).run();
    report.targets = Array.from({ length: 202 }, () => ({ ...report.targets[0], gatewayId: "unsafe|name\n".repeat(100) }));
    const summary = formatFleetSummary(report);
    expect(summary).toContain("Showing 200 of 202 targets");
    expect(summary).toContain("Source: " + "a".repeat(40));
    expect(summary).not.toContain("unsafe|name");
    expect(summary.split("\n").filter((line) => line.startsWith("| unsafe"))).toHaveLength(200);
  });

  it("keeps swept Shared retirement pending while an old instance is still live", async () => {
    const oldShared = gateway("shared-old", { desiredStatus: "draining" });
    const gone = { ...snapshot(gateway("shared-new")), retirements: [{ gatewayId: "shared-old", operationId: "retire-old", completedAt: 150, live: oldShared.live }] };
    const report = await harness([snapshot(oldShared, gateway("shared-new")), gone]).run();
    expect(report.outcome).toBe("timed-out");
    expect(report.targets.find((target) => target.gatewayId === "shared-old")?.reasons).toContain("retired Shared member still has live instances");
  });

  it("does not lose a target that disappears before retirement is verified", async () => {
    const h = harness([snapshot(gateway("shared-0"), gateway("b-vanished")), snapshot(gateway("shared-0"))]);
    const report = await h.run();
    expect(report.outcome).toBe("failed");
    expect(report.targets.find((target) => target.gatewayId === "b-vanished")?.reasons).toEqual(["gateway disappeared before retirement was verified"]);
  });

  it("reports a failed inventory read and does not mutate any target", async () => {
    const h = harness([snapshot(gateway("shared-0"))]);
    h.readSnapshot.mockRejectedValue(new Error("permission denied"));
    expect(await h.run()).toMatchObject({ outcome: "failed", reasons: ["fleet snapshot failed: permission denied"] });
    expect(h.deploy).not.toHaveBeenCalled();
  });

  it("rejects an unknown environment before reads or writes", async () => {
    const h = harness([snapshot(gateway("shared-0"))]);
    await expect(deployFleet({ environment: "unknown" as "test", sourceSha: "a".repeat(40), payload, timeoutMs: 500 }, h.deps)).rejects.toThrow("TEST or PROD");
    expect(h.readSnapshot).not.toHaveBeenCalled();
    expect(h.deploy).not.toHaveBeenCalled();
  });
});
