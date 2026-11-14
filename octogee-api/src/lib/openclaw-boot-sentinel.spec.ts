import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { createOpenClawBootSentinelStore } from "./openclaw-boot-sentinel.js";

const gatewayId = "ceckert-m-f6736258";
const boot = { gatewayId, podName: "octogee-gateway-ceckert-m-f6736258-abc123-def45", podUid: "boot-1", releaseKey: "62cab13@sha256:abc" };

const runtime = { docKind: "runtime", gatewayId, release: 1, lifecycle: "serving", status: "running" };

function fixture() {
  const data: Record<string, Record<string, unknown>> = {
    [`glmGateways/${gatewayId}`]: structuredClone(runtime),
    [`gateways/${gatewayId}`]: { gatewayId, gatewayClass: "isolated", desiredRelease: 1, latestRelease: 1, desiredStatus: "running" },
  };
  return { data, store: createOpenClawBootSentinelStore(createDocumentFixtureStore(data), () => 300) };
}

describe("OpenClaw boot sentinel", () => {
  it("answers start to every claim of a release, however many boots failed before it", async () => {
    const f = fixture();
    const claims = [await f.store.claim(boot), await f.store.claim(boot), await f.store.claim({ ...boot, podUid: "boot-2" })];
    expect(claims).toEqual([{ action: "start" }, { action: "start" }, { action: "start" }]);
  });

  it("keeps no boot state on the gateway runtime", async () => {
    const f = fixture();
    await f.store.claim(boot);
    await f.store.claim(boot);
    expect(f.data[`glmGateways/${gatewayId}`]).toEqual(runtime);
  });

  it("records the healthy OpenClaw build and nothing else on completion", async () => {
    const f = fixture();
    await f.store.claim(boot);
    await expect(f.store.complete({ ...boot, openclawBuild: "e".repeat(40) })).resolves.toBe(true);
    expect(f.data[`glmGateways/${gatewayId}`]).toEqual({ ...runtime, openclawHealthyBuild: "e".repeat(40) });
  });

  it("refuses a claim for a gateway without a runtime document", async () => {
    const f = fixture();
    await expect(f.store.claim({ ...boot, gatewayId: "missing" })).resolves.toBeNull();
  });

  it("treats a registry document that is not a runtime record as a missing runtime", async () => {
    const f = fixture();
    const { docKind: _docKind, ...legacy } = runtime;
    f.data[`glmGateways/${gatewayId}`] = legacy;
    await expect(f.store.claim(boot)).resolves.toBeNull();
    await expect(f.store.complete({ ...boot, openclawBuild: "e".repeat(40) })).resolves.toBe(false);
    expect(f.data[`glmGateways/${gatewayId}`]).toEqual(legacy);
  });
});
