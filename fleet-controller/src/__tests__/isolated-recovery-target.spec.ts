import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { prepareIsolatedRecoveryTarget } from "../isolated-recovery-target.js";
import { createSurgePodTransport, type SurgeControlRequest } from "../surge-user-handoff-runtime.js";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";

const target = { uid: "vm-current", name: "vm-current", podIP: "10.0.0.2", ready: false, terminating: false, crashLooping: false };
const input = { recovery: { uid: "alice", sourceGatewayId: "shared-a", operationId: "builder-activate-alice-g1", sourceEpoch: 0, claimStartedAt: 1000 },
  targetGatewayId: "alice-m-target", migrationId: "mig-builder-activate-alice-g1", slug: "alice" };

function controlRequest(reply: (route: string, body: Record<string, unknown>) => { status: number; body: Record<string, unknown> }): SurgeControlRequest {
  return (options, onResponse) => {
    const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; destroy: () => void; end: (body: string) => void };
    req.setTimeout = () => undefined;
    req.destroy = () => undefined;
    req.end = raw => {
      const value = reply(String(options.path), JSON.parse(raw));
      const response = Object.assign(new EventEmitter(), { statusCode: value.status, setEncoding: () => undefined });
      queueMicrotask(() => { onResponse(response); response.emit("data", JSON.stringify(value.body)); response.emit("end"); });
    };
    return req;
  };
}

describe("claimed user source recovery target preparation", () => {
  it.each(["held", "settled", "assigned", "authority-after-resolve", "authority-after-hold", "allocation-before-hold", "allocation-after-hold", "allocation-before-unreserve", "unknown-hold", "foreign-unreserve"] as const)("preserves recovery and allocation custody: %s", async scenario => {
    const events: string[] = [];
    let reads = 0, held = false, released = false;
    const transport = createSurgePodTransport({ privateKey: FLEET_KEY_PAIR.privateKey, log: vi.fn(),
      request: controlRequest((route, body) => {
        if (route.startsWith("/hold-")) {
          events.push("hold"); held = true;
          if (["settled", "allocation-before-unreserve", "foreign-unreserve"].includes(scenario)) {
            released = true;
            return { status: 409, body: { error: "OpenClaw process hold failed", message: "surge OpenClaw process gate target migration already released" } };
          }
          if (scenario === "unknown-hold") return { status: 409, body: { error: "OpenClaw process hold failed", message: "another operation owns target" } };
          return { status: 200, body: { ...body, operation: "hold", role: "target", mode: "held", phase: "held" } };
        }
        events.push("unreserve");
        return { status: 200, body: { ...body, targetPodUid: scenario === "foreign-unreserve" ? "foreign" : body.targetPodUid,
          operation: "unreserve", role: "normal", mode: "held", phase: "held" } };
      }),
    });
    const deps = {
      assertAuthority: vi.fn(async () => {
        if (scenario === "authority-after-resolve" && reads > 0 || scenario === "authority-after-hold" && held) throw new Error("claim changed");
      }),
      targetAssigned: vi.fn(async () => scenario === "assigned"),
      listPods: vi.fn(async () => {
        reads++;
        const changed = scenario === "allocation-before-hold" && reads > 1 || scenario === "allocation-after-hold" && held || scenario === "allocation-before-unreserve" && released;
        const pod = changed ? { ...target, uid: "replacement" } : target;
        return { pods: [pod], observedPodUids: [pod.uid] };
      }),
      holdTargetOpenClaw: transport.holdTargetOpenClaw!, unreserveTargetOpenClaw: transport.unreserveTargetOpenClaw!,
    };
    const prepare = prepareIsolatedRecoveryTarget(deps, input);
    if (scenario === "held" || scenario === "settled") {
      await expect(prepare).resolves.toBeUndefined();
      expect(events).toEqual(scenario === "held" ? ["hold"] : ["hold", "unreserve"]);
    } else {
      await expect(prepare).rejects.toThrow();
      if (["assigned", "authority-after-resolve", "allocation-before-hold"].includes(scenario)) expect(events).toEqual([]);
      else if (scenario !== "foreign-unreserve") expect(events).toEqual(["hold"]);
    }
  });
});
