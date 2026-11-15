import { describe, expect, it, vi, type Mock } from "vitest";
import { MigrationDrainPendingError } from "@octogee/core/fleet-migration-client";
import { gatewayScopedJobId, verifyFleetRequest } from "@octogee/core/fleet-signature";
import { SIGNATURE_HEADER } from "@octogee/shared/types/fleet-controller";
import { EventEmitter } from "node:events";
import {
  SURGE_OPENCLAW_COMPLETE_TIMEOUT_MS,
  SURGE_OPENCLAW_RESUME_TIMEOUT_MS,
  SURGE_RSYNC_FINISH_TIMEOUT_MS,
  SURGE_RSYNC_PUSH_TIMEOUT_MS,
  createSurgePodTransport,
  deleteCancelledSurgePod,
  parseSurgePodSnapshot,
  readPodSystemConfigCommit,
  type SurgeControlClientRequest,
  type SurgeControlRequest,
} from "../surge-user-handoff-runtime.js";
import {
  SurgeGatewayScopedSignatureCapabilityMissingError,
  type SurgePod,
} from "../surge-user-handoff.js";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";

const TARGET_CERTIFICATE_PEM = "-----BEGIN CERTIFICATE-----\nTUlHUkFUSU9O\n-----END CERTIFICATE-----\n";
const GATEWAY_ID = "gw-a";

const source: SurgePod = {
  uid: "old",
  name: "old-pod",
  podIP: "10.0.0.1",
  ready: true,
  terminating: false,
  crashLooping: false,
};
const target: SurgePod = {
  uid: "new",
  name: "new-pod",
  podIP: "10.0.0.2",
  ready: false,
  terminating: false,
  crashLooping: false,
};

describe("surge handoff Kubernetes projection", () => {
  it("keeps every observed UID while projecting usable pods independently", () => {
    expect(parseSurgePodSnapshot(JSON.stringify({
      items: [
        {
          metadata: { uid: "old", name: "old-pod" },
          status: {
            phase: "Running",
            podIP: "10.0.0.1",
            conditions: [{ type: "Ready", status: "True" }],
          },
        },
        {
          metadata: { uid: "new", name: "new-pod" },
          status: { phase: "Running", podIP: "10.0.0.2", conditions: [] },
        },
        {
          metadata: { uid: "gone", name: "gone-pod", deletionTimestamp: "now" },
          status: { phase: "Running", podIP: "10.0.0.3" },
        },
        {
          metadata: { uid: "pending", name: "pending-pod" },
          status: { phase: "Pending" },
        },
      ],
    }))).toEqual({
      pods: [
        source,
        target,
        {
          uid: "gone",
          name: "gone-pod",
          podIP: "10.0.0.3",
          ready: false,
          terminating: true,
          crashLooping: false,
        },
      ],
      observedPodUids: ["old", "new", "gone", "pending"],
    });
  });

  it.each([0, 1])("deletes only the exact cancelled target UID (exit %s)", async code => {
    const runKubectl = vi.fn(async () => ({ code, stdout: "", stderr: code ? "UID precondition failed" : "" }));
    const result = deleteCancelledSurgePod(runKubectl, "octogee-test", target);
    if (code) await expect(result).rejects.toThrow("UID precondition failed");
    else await expect(result).resolves.toBeUndefined();
    expect(runKubectl).toHaveBeenCalledExactlyOnceWith([
      "-n", "octogee-test", "delete", "--raw=/api/v1/namespaces/octogee-test/pods/new-pod", "-f", "-",
    ], { stdin: JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid: target.uid } }) });
  });

  it("marks a Running pod whose container sits in CrashLoopBackOff", () => {
    const wedged = parseSurgePodSnapshot(JSON.stringify({
      items: [{
        metadata: { uid: "wedged", name: "wedged-pod" },
        status: {
          phase: "Running", podIP: "10.0.0.4", conditions: [{ type: "Ready", status: "False" }],
          containerStatuses: [
            { name: "gateway-edge", ready: true, state: { running: { startedAt: "now" } } },
            { name: "gateway", ready: false, restartCount: 6, state: { waiting: { reason: "CrashLoopBackOff" } } },
          ],
        },
      }],
    }));
    expect(wedged.pods).toEqual([{ uid: "wedged", name: "wedged-pod", podIP: "10.0.0.4", ready: false, terminating: false, crashLooping: true }]);
  });

  it("requires a clean system-config commit from the exact held pod", async () => {
    const runKubectl = vi.fn(async () => ({ code: 0, stderr: "", stdout: "a".repeat(40) }));
    await expect(readPodSystemConfigCommit(runKubectl, "octogee-test", source)).resolves.toBe("a".repeat(40));
    expect(runKubectl).toHaveBeenCalledWith(expect.arrayContaining(["exec", "pod/old-pod", "-c", "gateway"]));
    runKubectl.mockResolvedValueOnce({ code: 1, stderr: "dirty checkout", stdout: "" });
    await expect(readPodSystemConfigCommit(runKubectl, "octogee-test", source)).rejects.toThrow("cannot verify system config commit");
  });


});

type SurgeTransportCall = { url: string; body?: Record<string, unknown> };
type FetchInput = string | URL | Request;
type NativeRequest = EventEmitter & {
  setTimeout: Mock<SurgeControlClientRequest["setTimeout"]>;
  destroy: Mock<SurgeControlClientRequest["destroy"]>;
  end: (body: string) => void;
};
type NativeResponse = EventEmitter & {
  statusCode: number;
  setEncoding: (encoding: BufferEncoding) => void;
};

function requestThroughFetch(fetch: typeof globalThis.fetch): SurgeControlRequest {
  return (options, onResponse) => {
    const req = new EventEmitter() as NativeRequest;
    req.setTimeout = vi.fn();
    req.destroy = vi.fn();
    req.end = (body: string) => {
      const hostname = typeof options.hostname === "string" ? options.hostname : "127.0.0.1";
      const port = typeof options.port === "number" || typeof options.port === "string"
        ? `:${options.port}`
        : "";
      const requestPath = typeof options.path === "string" ? options.path : "/";
      void fetch(`http://${hostname}${port}${requestPath}`, {
        method: typeof options.method === "string" ? options.method : "POST",
        headers: options.headers as HeadersInit | undefined,
        body,
      }).then(async (response) => {
        const nativeResponse = new EventEmitter() as NativeResponse;
        nativeResponse.statusCode = response.status;
        nativeResponse.setEncoding = vi.fn();
        onResponse(nativeResponse);
        nativeResponse.emit("data", await response.text());
        nativeResponse.emit("end");
      }).catch((error: unknown) => {
        req.emit("error", error);
      });
    };
    return req;
  };
}

describe("surge handoff direct pod transport", () => {
  it.each(["hold", "export", "stage", "activate", "resume", "retire", "abort"] as const)("sends scheduler %s to the exact pod with gateway-bound migration authority", async phase => {
    const operationId = "surge-scheduler-exact-clock";
    const agentIds = ["octogee-alice-coach", "octogee-alice-proj-orbit-coach"];
    const snapshot = { version: 1, operationId, agentIds, jobs: [], scratch: [] };
    const result = { operationId, phase, agentIds, drained: true, ...(phase === "export" ? { snapshot } : {}) };
    const fetch = vi.fn(async (_url: FetchInput, _init?: RequestInit) => new Response(JSON.stringify(result)));
    const transport = createSurgePodTransport({ privateKey: FLEET_KEY_PAIR.privateKey, fetch, log: vi.fn() });
    const body = { migrationId: operationId, slug: "alice", phase, agentIds,
      ...(phase === "stage" ? { snapshot } : {}) };
    await expect(transport.scheduler!({ gatewayId: GATEWAY_ID, pod: target, slug: "alice", operationId, phase, agentIds,
      ...(phase === "stage" ? { snapshot } : {}) })).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("http://10.0.0.2:3003/scheduler/gw-a", expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }));
    const init = fetch.mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body))).toEqual(body);
    const signature = new Headers(init.headers).get(SIGNATURE_HEADER)!;
    expect(verifyFleetRequest(FLEET_KEY_PAIR.publicKey, gatewayScopedJobId(operationId, GATEWAY_ID), String(init.body), signature)).toBe(true);
    expect(verifyFleetRequest(FLEET_KEY_PAIR.publicKey, gatewayScopedJobId("stale-clock", GATEWAY_ID), String(init.body), signature)).toBe(false);
    expect(verifyFleetRequest(FLEET_KEY_PAIR.publicKey, gatewayScopedJobId(operationId, "foreign-gateway"), String(init.body), signature)).toBe(false);
  });

  it.each([
    { operationId: "foreign-attempt" }, { phase: "hold" }, { drained: false }, { drained: "true" },
    { agentIds: [] }, { agentIds: [""] }, { agentIds: [1] },
  ])("refuses an unconfirmed scheduler ACK %j", async invalid => {
    const response = { operationId: "scheduler-clock", phase: "activate", drained: true, agentIds: ["octogee-alice-coach"], ...invalid };
    const fetch = vi.fn(async () => new Response(JSON.stringify(response)));
    const transport = createSurgePodTransport({ privateKey: FLEET_KEY_PAIR.privateKey, fetch, log: vi.fn() });
    await expect(transport.scheduler!({ gatewayId: GATEWAY_ID, pod: target, slug: "alice", operationId: "scheduler-clock", phase: "activate" })).rejects.toThrow(/scheduler activate/u);
  });

  it("requires a snapshot in the matching scheduler export ACK", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ operationId: "scheduler-clock", phase: "export", drained: true, agentIds: ["octogee-alice-coach"] })));
    const transport = createSurgePodTransport({ privateKey: FLEET_KEY_PAIR.privateKey, fetch, log: vi.fn() });
    await expect(transport.scheduler!({ gatewayId: GATEWAY_ID, pod: source, slug: "alice", operationId: "scheduler-clock", phase: "export" })).rejects.toThrow(/scheduler export/u);
  });

  it.each(["abort", "resume"] as const)("accepts an empty-scope scheduler %s ACK for an attempt that never acquired custody", async phase => {
    const result = { operationId: "scheduler-clock", phase, drained: true, agentIds: [] };
    const fetch = vi.fn(async () => new Response(JSON.stringify(result)));
    const transport = createSurgePodTransport({ privateKey: FLEET_KEY_PAIR.privateKey, fetch, log: vi.fn() });
    await expect(transport.scheduler!({ gatewayId: GATEWAY_ID, pod: source, slug: "alice", operationId: "scheduler-clock", phase })).resolves.toEqual(result);
  });

  it.each(["quiesce", "waitForSourceIdle"] as const)("treats HTTP 200 drained:false as pending for %s", async (method) => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ drained: false, runningCount: 1 }), { status: 200 }));
    const transport = createSurgePodTransport({ privateKey: FLEET_KEY_PAIR.privateKey, fetch, log: vi.fn() });
    await expect(transport[method]({ gatewayId: GATEWAY_ID, slug: "alice", operationId: "surge-op", sourcePod: source })).rejects.toBeInstanceOf(MigrationDrainPendingError);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ stopMattermost: false, timeoutMs: 30_000 });
  });

  it("reopens source voice and chat admission with the matching signed migration identity", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ resumed: true }), { status: 200 }));
    const transport = createSurgePodTransport({ privateKey: FLEET_KEY_PAIR.privateKey, fetch, log: vi.fn() });
    await transport.resumeSourceIngress({ gatewayId: GATEWAY_ID, slug: "alice", operationId: "surge-op", sourcePod: source });
    expect(fetch).toHaveBeenCalledWith("http://10.0.0.1:3003/resume/gw-a", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ migrationId: "surge-op", slug: "alice" });
  });

  it.each(["target", "settled", "foreign-id", "foreign-pod", "foreign-role", "permitted", "stopping", "released"] as const)("validates exact target hold ownership while retaining ordinary late-hold rejection: %s", async scenario => {
    const body = { migrationId: "recovery-op", slug: "alice", targetPodUid: target.uid, operation: "hold", role: scenario === "settled" ? "normal" : "target", mode: "held", phase: "held" };
    if (scenario === "foreign-id") body.migrationId = "other";
    if (scenario === "foreign-pod") body.targetPodUid = "other";
    if (scenario === "foreign-role") body.role = "source";
    if (scenario === "permitted") body.mode = "permitted";
    if (scenario === "stopping") body.phase = "stopping";
    const fetch = vi.fn(async () => scenario === "released"
      ? new Response(JSON.stringify({ error: "OpenClaw process hold failed", message: "surge OpenClaw process gate target migration already released" }), { status: 409 })
      : new Response(JSON.stringify(body), { status: 200 }));
    const transport = createSurgePodTransport({ privateKey: FLEET_KEY_PAIR.privateKey, fetch, request: requestThroughFetch(fetch), log: vi.fn() });
    const hold = transport.holdTargetOpenClaw!({ gatewayId: GATEWAY_ID, slug: "alice", operationId: "recovery-op", targetPod: target });
    if (scenario === "target" || scenario === "settled") await expect(hold).resolves.toBeUndefined();
    else await expect(hold).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a source hold response that does not prove the exact stopped-writer custody", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ migrationId: "recovery-op", slug: "alice",
      targetPodUid: target.uid, operation: "hold", role: "normal", mode: "held", phase: "held" }), { status: 200 }));
    const transport = createSurgePodTransport({ privateKey: FLEET_KEY_PAIR.privateKey, fetch,
      request: requestThroughFetch(fetch), log: vi.fn() });
    await expect(transport.stopSourceOpenClaw!({ gatewayId: GATEWAY_ID, slug: "alice", operationId: "recovery-op",
      sourcePod: source, targetPod: target })).rejects.toThrow("source OpenClaw hold did not confirm");
  });

  it("uses native full-operation deadlines for user holds, source resume, and target completion", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    const request = vi.fn<SurgeControlRequest>((options, onResponse) => {
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: Mock<SurgeControlClientRequest["setTimeout"]>;
        destroy: Mock<SurgeControlClientRequest["destroy"]>;
        end: (body: string) => void;
      };
      req.setTimeout = vi.fn();
      req.destroy = vi.fn();
      req.end = (body: string) => {
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
          setEncoding: (encoding: BufferEncoding) => void;
        };
        response.statusCode = 200;
        response.setEncoding = vi.fn();
        queueMicrotask(() => {
          onResponse(response);
          response.emit("data", JSON.stringify(options.path === "/hold-surge-openclaw/default"
            ? { ...JSON.parse(body), operation: "hold", role: options.hostname === target.podIP ? "target" : "source", mode: "held", phase: "held" }
            : { resumed: true }));
          response.emit("end");
        });
      };
      return req;
    });
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      request,
      log: vi.fn(),
    });

    await expect(transport.stopSourceOpenClaw?.({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      sourcePod: source,
      targetPod: target,
    })).resolves.toBeUndefined();
    await expect(transport.holdTargetOpenClaw?.({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      targetPod: target,
    })).resolves.toBeUndefined();
    await expect(transport.resumeSourceOpenClaw?.({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      sourcePod: source,
      targetPod: target,
    })).resolves.toBeUndefined();
    await expect(transport.releaseTarget({
      gatewayId: "default",
      operationId: "surge-default-new",
      pod: target,
    })).resolves.toBeUndefined();

    expect(fetch).not.toHaveBeenCalled();
    expect(request).toHaveBeenNthCalledWith(1, expect.objectContaining({
      hostname: source.podIP,
      port: 3003,
      path: "/hold-surge-openclaw/default",
      method: "POST",
      agent: false,
    }), expect.any(Function));
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({
      hostname: target.podIP,
      port: 3003,
      path: "/hold-surge-openclaw/default",
      method: "POST",
      agent: false,
    }), expect.any(Function));
    expect(request).toHaveBeenNthCalledWith(3, expect.objectContaining({
      hostname: source.podIP,
      port: 3003,
      path: "/resume-surge-openclaw/default",
      method: "POST",
      agent: false,
    }), expect.any(Function));
    expect(request).toHaveBeenNthCalledWith(4, expect.objectContaining({
      hostname: target.podIP,
      port: 3003,
      path: "/complete-surge-handoff/default",
      method: "POST",
      agent: false,
    }), expect.any(Function));
    expect(bodies).toEqual([
      {
        migrationId: "surge-default-new",
        slug: "alice",
        targetPodUid: target.uid,
        receivingPodUid: source.uid,
      },
      {
        migrationId: "surge-default-new",
        slug: "alice",
        targetPodUid: target.uid,
        receivingPodUid: target.uid,
      },
      {
        migrationId: "surge-default-new",
        slug: "alice",
        targetPodUid: target.uid,
        receivingPodUid: source.uid,
      },
      {
        migrationId: "surge-default-new",
        targetPodUid: target.uid,
      },
    ]);
    const sourceHoldRequest = request.mock.results[0]?.value as NativeRequest;
    const targetHoldRequest = request.mock.results[1]?.value as NativeRequest;
    const resumeRequest = request.mock.results[2]?.value as NativeRequest;
    const completeRequest = request.mock.results[3]?.value as NativeRequest;
    expect(sourceHoldRequest.setTimeout).toHaveBeenCalledWith(
      SURGE_OPENCLAW_COMPLETE_TIMEOUT_MS,
      expect.any(Function),
    );
    expect(targetHoldRequest.setTimeout).toHaveBeenCalledWith(
      SURGE_OPENCLAW_COMPLETE_TIMEOUT_MS,
      expect.any(Function),
    );
    expect(resumeRequest.setTimeout).toHaveBeenCalledWith(
      SURGE_OPENCLAW_RESUME_TIMEOUT_MS,
      expect.any(Function),
    );
    expect(completeRequest.setTimeout).toHaveBeenCalledWith(
      SURGE_OPENCLAW_COMPLETE_TIMEOUT_MS,
      expect.any(Function),
    );
  });

  it("uses native full-operation deadlines for both rsync transfer phases and durable flush", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    const requests: NativeRequest[] = [];
    const request = vi.fn<SurgeControlRequest>((options, onResponse) => {
      const req = new EventEmitter() as NativeRequest;
      req.setTimeout = vi.fn();
      req.destroy = vi.fn();
      req.end = (body: string) => {
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        const response = new EventEmitter() as NativeResponse;
        response.statusCode = 200;
        response.setEncoding = vi.fn();
        const responseBody = String(options.path).includes("/prepare-rsync-import/")
          ? { port: 30873, host: "0.0.0.0", module: "octogee-import", certificatePem: TARGET_CERTIFICATE_PEM }
          : { imported: true };
        queueMicrotask(() => {
          onResponse(response);
          response.emit("data", JSON.stringify(responseBody));
          response.emit("end");
        });
      };
      requests.push(req);
      return req;
    });
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      request,
      randomKey: vi.fn()
        .mockReturnValueOnce("keys-transfer-key")
        .mockReturnValueOnce("final-transfer-key"),
      log: vi.fn(),
    });

    await expect(transport.transfer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      sourcePod: source,
      targetPod: target,
      loadStrategy: "standard",
      configTransferMode: "activation-manifest",
    })).resolves.toBeUndefined();
    await expect(transport.flush({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      pod: source,
      reason: "migration-final",
    })).resolves.toEqual({});

    expect(fetch).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([options]) => options.path)).toEqual([
      "/prepare-rsync-import/default",
      "/push-rsync-state/default",
      "/finish-rsync-import/default",
      "/prepare-rsync-import/default",
      "/push-rsync-state/default",
      "/finish-rsync-import/default",
      "/flush/default",
    ]);
    expect(bodies.slice(0, 6).map((body) => [body.mode, body.rpcPhase])).toEqual([
      ["keys", "prepare-rsync-import"],
      ["keys", "push-rsync-state"],
      ["keys", "finish-rsync-import"],
      ["final", "prepare-rsync-import"],
      ["final", "push-rsync-state"],
      ["final", "finish-rsync-import"],
    ]);
    expect(bodies[6]).toEqual({
      migrationId: "surge-default-new",
      slug: "alice",
      reason: "migration-final",
    });
    const timeouts = [
      SURGE_OPENCLAW_COMPLETE_TIMEOUT_MS,
      SURGE_RSYNC_PUSH_TIMEOUT_MS,
      SURGE_RSYNC_FINISH_TIMEOUT_MS,
      SURGE_OPENCLAW_COMPLETE_TIMEOUT_MS,
      SURGE_RSYNC_PUSH_TIMEOUT_MS,
      SURGE_RSYNC_FINISH_TIMEOUT_MS,
      330_000,
    ];
    for (const [index, timeoutMs] of timeouts.entries()) {
      expect(requests[index]?.setTimeout).toHaveBeenCalledWith(timeoutMs, expect.any(Function));
    }
  });

  it("aborts the target import without pushing when the target offers no pinned TLS certificate", async () => {
    const calls: SurgeTransportCall[] = [];
    const fetch = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.includes("/prepare-rsync-import/")) {
        return new Response(JSON.stringify({ port: 30873, host: "0.0.0.0", module: "state" }));
      }
      return new Response(JSON.stringify({ imported: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      request: requestThroughFetch(fetch),
      randomKey: vi.fn(() => "transfer-key"),
      log: vi.fn(),
    });

    await expect(transport.transfer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      sourcePod: source,
      targetPod: target,
      loadStrategy: "expedited",
      configTransferMode: "activation-manifest",
    })).rejects.toThrow("did not return a migration TLS certificate");
    expect(calls.map((call) => call.url)).toEqual([
      "http://10.0.0.2:3003/prepare-rsync-import/default",
      "http://10.0.0.2:3003/abort-rsync-import/default",
    ]);
  });

  it("transfers user keys before final state and verifies each direct pod", async () => {
    const calls: SurgeTransportCall[] = [];
    const fetch = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ready", podUid: "pod-uid", startedAt: 1 }));
      }
      if (url.includes("/fleet-state/")) {
        return new Response(JSON.stringify({
          status: "ready",
          version: url.includes("10.0.0.2") ? "new" : "old",
          customers: ["alice"],
        }));
      }
      if (url.endsWith("/surge-ready")) {
        return new Response(JSON.stringify({ handoffReleased: false, openclawUp: true }), { status: 503 });
      }
      if (url.includes("/prepare-rsync-import/")) {
        return new Response(JSON.stringify({ port: 30873, host: "0.0.0.0", module: "octogee-import", certificatePem: TARGET_CERTIFICATE_PEM }));
      }
      return new Response(JSON.stringify({ imported: true, released: true }));
    }) as unknown as typeof globalThis.fetch;
    const randomKey = vi.fn()
      .mockReturnValueOnce("keys-transfer-key")
      .mockReturnValueOnce("final-transfer-key");
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      request: requestThroughFetch(fetch),
      randomKey,
      log: vi.fn(),
    });

    await expect(transport.readPodHealth(target, GATEWAY_ID)).resolves.toEqual({
      status: "ready",
      version: "new",
      fleetSignatureCapability: "gateway-scoped",
      handoffReleased: false,
      prelaunchState: "none",
      mountedCustomers: ["alice"],
    });
    await transport.transfer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      sourcePod: source,
      targetPod: target,
      loadStrategy: "expedited",
      configTransferMode: "activation-manifest",
    });
    await transport.discardTargetUser({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      targetPod: target,
    });

    expect(calls.map((call) => call.url)).toEqual([
      "http://10.0.0.2:3003/health",
      "http://10.0.0.2:3003/surge-ready",
      `http://10.0.0.2:3003/fleet-state/${GATEWAY_ID}`,
      "http://10.0.0.2:3003/prepare-rsync-import/default",
      "http://10.0.0.1:3003/push-rsync-state/default",
      "http://10.0.0.2:3003/finish-rsync-import/default",
      "http://10.0.0.2:3003/prepare-rsync-import/default",
      "http://10.0.0.1:3003/push-rsync-state/default",
      "http://10.0.0.2:3003/finish-rsync-import/default",
      "http://10.0.0.2:3003/unmount/default",
    ]);
    expect(calls.slice(3, 9).map((call) => call.body?.rpcPhase)).toEqual([
      "prepare-rsync-import",
      "push-rsync-state",
      "finish-rsync-import",
      "prepare-rsync-import",
      "push-rsync-state",
      "finish-rsync-import",
    ]);
    expect(calls[3]?.body).toMatchObject({
      slug: "alice",
      mode: "keys",
      sourcePodIp: "10.0.0.1",
      transferKey: "keys-transfer-key",
    });
    expect(calls[4]?.body).toMatchObject({
      mode: "keys",
      targetHost: "10.0.0.2",
      targetPort: 30873,
      targetCertificatePem: TARGET_CERTIFICATE_PEM,
    });
    expect(calls[6]?.body).toMatchObject({
      slug: "alice",
      mode: "final",
      sourcePodIp: "10.0.0.1",
      transferKey: "final-transfer-key",
      configTransferMode: "activation-manifest",
    });
    expect(calls[7]?.body).toMatchObject({
      mode: "final",
      targetHost: "10.0.0.2",
      targetPort: 30873,
      targetCertificatePem: TARGET_CERTIFICATE_PEM,
      includeActivationManifest: true,
      configTransferMode: "activation-manifest",
    });
    expect(calls[8]?.body).toMatchObject({
      mode: "final",
      loadStrategy: "expedited",
      configTransferMode: "activation-manifest",
    });
    expect(randomKey).toHaveBeenCalledTimes(2);
  });

  it("converges a user system config before final import and clears only target migration observation on convergence failure", async () => {
    const calls: SurgeTransportCall[] = [];
    const fetch = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.includes("/prepare-rsync-import/")) {
        return new Response(JSON.stringify({ port: 30873, host: "0.0.0.0", module: "state", certificatePem: TARGET_CERTIFICATE_PEM }));
      }
      if (url.includes("/flush/")) {
        return new Response(JSON.stringify({ error: "flush failed" }), { status: 500 });
      }
      return new Response(JSON.stringify({ imported: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      request: requestThroughFetch(fetch),
      randomKey: vi.fn()
        .mockReturnValueOnce("keys-transfer-key")
        .mockReturnValueOnce("final-transfer-key"),
      log: vi.fn(),
    });

    await expect(transport.transfer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      sourcePod: source,
      targetPod: target,
      loadStrategy: "standard",
      configTransferMode: "configured-builder-system-config",
      expectedSystemConfigCommit: "a".repeat(40),
    })).rejects.toThrow("flush pod=new-pod: 500");

    expect(calls.map((call) => call.url)).toEqual([
      "http://10.0.0.2:3003/prepare-rsync-import/default",
      "http://10.0.0.1:3003/push-rsync-state/default",
      "http://10.0.0.2:3003/finish-rsync-import/default",
      "http://10.0.0.2:3003/flush/default",
      "http://10.0.0.2:3003/abort-rsync-import/default",
    ]);
    expect(calls[3]?.body).toEqual({
      migrationId: "surge-default-new",
      slug: "alice",
      reason: "migration-converge",
      expectedSystemConfigCommit: "a".repeat(40),
    });
    expect(calls[4]?.body).toEqual({
      migrationId: "surge-default-new",
      slug: "alice",
      rpcPhase: "abort-rsync-import",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
    });
    expect(calls.some((call) => call.url.includes("/unmount/"))).toBe(false);
  });

  it("aborts target import when flush fails even after its config checkpoint succeeded", async () => {
    const calls: SurgeTransportCall[] = [];
    const log = vi.fn();
    const expectedSystemConfigCommit = "a".repeat(40);
    const fetch = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.includes("/prepare-rsync-import/")) {
        return new Response(JSON.stringify({ port: 30873, host: "0.0.0.0", module: "state", certificatePem: TARGET_CERTIFICATE_PEM }));
      }
      if (url.includes("/flush/")) {
        return new Response(JSON.stringify({
          migrationId: "surge-default-new",
          slug: "alice",
          ok: false,
          durationMs: 12,
          systemConfigCommit: expectedSystemConfigCommit,
          steps: [
            { name: "session-quiesce", status: "skipped", durationMs: 0 },
            {
              name: "workspace-git",
              status: "failed",
              error: "[git-sync] durable flush failed: alice: git metadata is missing",
              durationMs: 1,
            },
            { name: "blob-sync", status: "skipped", durationMs: 0 },
            { name: "system-config", status: "done", durationMs: 11 },
            { name: "gitea-key-release", status: "skipped", durationMs: 0 },
          ],
        }), { status: 500 });
      }
      return new Response(JSON.stringify({ imported: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      request: requestThroughFetch(fetch),
      randomKey: vi.fn()
        .mockReturnValueOnce("keys-transfer-key")
        .mockReturnValueOnce("final-transfer-key"),
      log,
    });

    await expect(transport.transfer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      sourcePod: source,
      targetPod: target,
      loadStrategy: "standard",
      configTransferMode: "configured-builder-system-config",
      expectedSystemConfigCommit,
    })).rejects.toThrow("flush pod=new-pod: 500");

    expect(calls.map((call) => [call.url, call.body?.mode, call.body?.rpcPhase])).toEqual([
      ["http://10.0.0.2:3003/prepare-rsync-import/default", "keys", "prepare-rsync-import"],
      ["http://10.0.0.1:3003/push-rsync-state/default", "keys", "push-rsync-state"],
      ["http://10.0.0.2:3003/finish-rsync-import/default", "keys", "finish-rsync-import"],
      ["http://10.0.0.2:3003/flush/default", undefined, undefined],
      ["http://10.0.0.2:3003/abort-rsync-import/default", "final", "abort-rsync-import"],
    ]);
  });

  it("does not transfer final state when the key transfer fails", async () => {
    const calls: SurgeTransportCall[] = [];
    const fetch = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.includes("/prepare-rsync-import/")) {
        return new Response(JSON.stringify({ port: 30873, host: "0.0.0.0", module: "octogee-import", certificatePem: TARGET_CERTIFICATE_PEM }));
      }
      if (url.includes("/push-rsync-state/") && body?.mode === "keys") {
        return new Response(JSON.stringify({ error: "key export missing" }), { status: 404 });
      }
      return new Response(JSON.stringify({ imported: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      request: requestThroughFetch(fetch),
      randomKey: () => "transfer-key",
      log: vi.fn(),
    });

    await expect(transport.transfer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      sourcePod: source,
      targetPod: target,
      loadStrategy: "standard",
      configTransferMode: "activation-manifest",
    })).rejects.toThrow(/push-rsync-state.*404/u);

    expect(calls.map((call) => [call.url, call.body?.mode, call.body?.rpcPhase])).toEqual([
      ["http://10.0.0.2:3003/prepare-rsync-import/default", "keys", "prepare-rsync-import"],
      ["http://10.0.0.1:3003/push-rsync-state/default", "keys", "push-rsync-state"],
      ["http://10.0.0.2:3003/abort-rsync-import/default", "keys", "abort-rsync-import"],
    ]);
  });

  it("retries signed target cleanup once after a structured config hash race", async () => {
    let attempts = 0;
    const log = vi.fn();
    const fetch = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(JSON.stringify({
          error: "unmount failed",
          message: "config changed",
          code: "hash-mismatch",
        }), { status: 500 })
        : new Response(JSON.stringify({ unmounted: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log,
    });

    await expect(transport.discardTargetUser({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      targetPod: target,
    })).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("retrying signed unmount once"));
  });

  it("does not retry target cleanup after an unstructured or permanent failure", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      error: "unmount failed",
      message: "account removal rejected",
      code: "invalid-patch",
    }), { status: 500 })) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log: vi.fn(),
    });

    await expect(transport.discardTargetUser({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      targetPod: target,
    })).rejects.toThrow("invalid-patch");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stops after the single bounded retry when the config hash keeps racing", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      error: "unmount failed",
      message: "config changed",
      code: "hash-mismatch",
    }), { status: 500 })) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log: vi.fn(),
    });

    await expect(transport.discardTargetUser({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      targetPod: target,
    })).rejects.toThrow("hash-mismatch");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports a latched runtime as booting when the live OpenClaw probe is down", async () => {
    const fetch = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ready", podUid: "pod-uid", startedAt: 1 }));
      }
      if (url.includes("/fleet-state/")) {
        return new Response(JSON.stringify({ status: "ready", version: "new", customers: [] }));
      }
      return new Response(JSON.stringify({
        handoffReleased: true,
        openclawUp: false,
      }), { status: 503 });
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log: vi.fn(),
    });

    await expect(transport.readPodHealth(target, GATEWAY_ID)).resolves.toEqual({
      status: "booting",
      version: "new",
      fleetSignatureCapability: "gateway-scoped",
      handoffReleased: true,
      prelaunchState: "none",
      mountedCustomers: [],
    });
  });

  it("carries a held prelaunch surge report so a stopped isolated target stays transferable", async () => {
    const fetch = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ready", podUid: "pod-uid", startedAt: 1 }));
      }
      if (url.includes("/fleet-state/")) {
        return new Response(JSON.stringify({ status: "ready", version: "new", customers: [] }));
      }
      return new Response(JSON.stringify({
        handoffReleased: false,
        openclawUp: false,
        prelaunchState: "hydrated",
      }), { status: 503 });
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log: vi.fn(),
    });

    await expect(transport.readPodHealth(target, GATEWAY_ID)).resolves.toMatchObject({
      status: "booting",
      prelaunchState: "hydrated",
    });
  });

  it.each(["valid", "held", "false-held", "invalid-held", "foreign-pod", "missing-migration", "invalid-slug", "malformed"] as const)(
    "accepts only pod-bound terminal target readiness: %s", async (mode) => {
      const terminalTarget: unknown = mode === "malformed" ? "terminal" : {
        migrationId: mode === "missing-migration" ? "" : "surge-gw-a-new",
        slug: mode === "invalid-slug" ? "../alice" : "alice",
        targetPodUid: mode === "foreign-pod" ? "old" : target.uid,
        ...(["held", "false-held", "invalid-held"].includes(mode) ? { processHeld: mode === "invalid-held" ? "true" : mode === "held" } : {}),
      };
      const fetch = vi.fn(async (input: FetchInput) => {
        const url = String(input);
        if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ready", podUid: target.uid, startedAt: 1 }));
        if (url.includes("/fleet-state/")) return new Response(JSON.stringify({ status: "ready", version: "new", customers: [] }));
        return new Response(JSON.stringify({ handoffReleased: false, openclawUp: false, prelaunchState: "held", terminalTarget }), { status: 503 });
      }) as unknown as typeof globalThis.fetch;
      const transport = createSurgePodTransport({ privateKey: FLEET_KEY_PAIR.privateKey, fetch, log: vi.fn() });
      const health = await transport.readPodHealth(target, GATEWAY_ID);
      if (["valid", "held", "false-held"].includes(mode)) expect(health).toMatchObject({ status: "booting", terminalTarget });
      else expect(health).toBeNull();
    },
  );

  it("uses the native full-operation deadline for target unreserve", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    let body: Record<string, unknown> | undefined;
    const request = vi.fn<SurgeControlRequest>((options, onResponse) => {
      const req = new EventEmitter() as NativeRequest;
      req.setTimeout = vi.fn();
      req.destroy = vi.fn();
      req.end = (raw: string) => {
        body = JSON.parse(raw) as Record<string, unknown>;
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
          setEncoding: (encoding: BufferEncoding) => void;
        };
        response.statusCode = 200;
        response.setEncoding = vi.fn();
        queueMicrotask(() => {
          onResponse(response);
          response.emit("data", JSON.stringify({ ...body, operation: "unreserve", role: "normal", mode: "held", phase: "held" }));
          response.emit("end");
        });
      };
      return req;
    });
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      request,
      log: vi.fn(),
    });

    await transport.unreserveTargetOpenClaw!({
      gatewayId: GATEWAY_ID,
      slug: "alice",
      operationId: "surge-gw-a-target",
      targetPod: target,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      hostname: target.podIP,
      port: 3003,
      path: `/unreserve-surge-openclaw/${GATEWAY_ID}`,
      method: "POST",
      agent: false,
    }), expect.any(Function));
    expect(body).toEqual({
      migrationId: "surge-gw-a-target",
      slug: "alice",
      targetPodUid: target.uid,
      receivingPodUid: target.uid,
    });
    const native = request.mock.results[0]?.value as NativeRequest;
    expect(native.setTimeout).toHaveBeenCalledWith(
      SURGE_OPENCLAW_COMPLETE_TIMEOUT_MS,
      expect.any(Function),
    );
  });

  it("names the missing process-control capability when a pod predates the endpoint", async () => {
    const request = vi.fn<SurgeControlRequest>((_options, onResponse) => {
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: Mock<SurgeControlClientRequest["setTimeout"]>;
        destroy: Mock<SurgeControlClientRequest["destroy"]>;
        end: () => void;
      };
      req.setTimeout = vi.fn();
      req.destroy = vi.fn();
      req.end = () => {
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
          setEncoding: (encoding: BufferEncoding) => void;
        };
        response.statusCode = 404;
        response.setEncoding = vi.fn();
        queueMicrotask(() => {
          onResponse(response);
          response.emit("data", JSON.stringify({ error: "not found" }));
          response.emit("end");
        });
      };
      return req;
    });
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      request,
      log: vi.fn(),
    });

    await expect(transport.stopSourceOpenClaw!({
      gatewayId: GATEWAY_ID,
      slug: "alice",
      operationId: "surge-gw-a-target",
      sourcePod: source,
      targetPod: target,
    })).rejects.toThrow("lacks the required surge OpenClaw hold endpoint");
  });

  it("rejects pod health that does not prove the mounted user inventory", async () => {
    const log = vi.fn();
    const fetch = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ready", podUid: "pod-uid", startedAt: 1 }));
      }
      if (url.includes("/fleet-state/")) {
        return new Response(JSON.stringify({ status: "ready", version: "new" }));
      }
      return new Response(JSON.stringify({ handoffReleased: false, openclawUp: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log,
    });

    await expect(transport.readPodHealth(target, GATEWAY_ID)).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("invalid fleet state response"));
  });

  it("reads the roster and image tag from the signed fleet state, not the slim /health probe", async () => {
    const calls: SurgeTransportCall[] = [];
    const fetch = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
      });
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ready", podUid: "new", startedAt: 1 }));
      }
      if (url.includes("/fleet-state/")) {
        return new Response(JSON.stringify({
          status: "ready",
          version: "new",
          customers: ["alice", "alice", "bob"],
        }));
      }
      return new Response(JSON.stringify({ handoffReleased: false, openclawUp: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log: vi.fn(),
    });

    await expect(transport.readPodHealth(target, GATEWAY_ID)).resolves.toEqual({
      status: "ready",
      version: "new",
      fleetSignatureCapability: "gateway-scoped",
      handoffReleased: false,
      prelaunchState: "none",
      mountedCustomers: ["alice", "bob"],
    });
    const fleetStateCall = calls.find((call) => call.url.includes("/fleet-state/"));
    expect(fleetStateCall?.url).toBe(`http://10.0.0.2:3003/fleet-state/${GATEWAY_ID}`);
    expect(fleetStateCall?.body).toMatchObject({ gatewayId: GATEWAY_ID });
  });

  it("refuses a legacy health payload before any gateway-scoped signed exchange", async () => {
    const calls: string[] = [];
    const log = vi.fn();
    const fetch = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({
          status: "ready",
          gatewayId: GATEWAY_ID,
          version: "old",
          customers: ["alice"],
        }));
      }
      return new Response(JSON.stringify({ handoffReleased: false, openclawUp: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log,
    });

    await expect(transport.readPodHealth(source, GATEWAY_ID)).resolves.toEqual({
      status: "ready",
      version: "old",
      fleetSignatureCapability: "legacy",
      handoffReleased: false,
      prelaunchState: "none",
      mountedCustomers: ["alice"],
    });
    await expect(transport.quiesce({
      gatewayId: GATEWAY_ID,
      slug: "alice",
      operationId: "surge-gw-a-new",
      sourcePod: source,
    })).rejects.toBeInstanceOf(SurgeGatewayScopedSignatureCapabilityMissingError);
    await expect(transport.readPodHealth(source, GATEWAY_ID)).resolves.toMatchObject({
      fleetSignatureCapability: "legacy",
    });

    expect(calls.every((url) => !url.includes("/fleet-state/") && !url.includes("/quiesce/"))).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("predates the gateway-scoped fleet signature protocol"));
  });

  it("names an unsigned-read rejection so a fleet key skew is not read as an absent pod", async () => {
    const log = vi.fn();
    const fetch = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ready", podUid: "new", startedAt: 1 }));
      }
      if (url.includes("/fleet-state/")) {
        return new Response(JSON.stringify({ error: "invalid signature" }), { status: 401 });
      }
      return new Response(JSON.stringify({ handoffReleased: false, openclawUp: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log,
    });

    await expect(transport.readPodHealth(target, GATEWAY_ID)).resolves.toBeNull();
    await expect(transport.readPodHealth(target, GATEWAY_ID)).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("does not match the fleet controller's signing key"),
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
