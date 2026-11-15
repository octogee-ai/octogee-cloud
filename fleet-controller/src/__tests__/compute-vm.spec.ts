import { describe, it, expect, vi } from "vitest";
import {
  COMPUTER_HOME_RESTORE_METADATA_KEY,
  ComputeOperationError,
  createGatewayVmClient,
  instanceInsertBody,
  type ComputeRequest,
  type CreateGatewayVmInput,
} from "../lib/compute-vm";

const IMAGE = { name: "octogee-computer-20260927", id: "222" };

const BASE = "https://compute.googleapis.com/compute/v1/projects/octogee-test";

const input: CreateGatewayVmInput = {
  instanceName: "octogee-gw-b-mama-3-abc-hobby",
  zones: ["us-west1-b"],
  machineType: "n2-standard-4",
  imageFamily: "octogee-computer",
  diskSizeGb: 40, bootDiskType: "pd-ssd", homeDiskSizeGb: 20,
  provisioningModel: "SPOT",
  desktop: "omarchy",
  serviceAccountEmail: "octogee-gw-b-mama-3-abc-hobby@octogee-test.iam.gserviceaccount.com",
  subnetwork: "regions/us-west1/subnetworks/octogee-gateways",
  labels: { "octogee-gateway-id": "b-mama-3-abc-hobby", "octogee-owner-uid": "owner-a", purpose: "octogee-computer" },
  metadata: { "gateway-id": "b-mama-3-abc-hobby", "octogee-environment": "test" },
};

type Call = { url: string; method: string; body?: unknown };

function fakeCompute(script: (call: Call, calls: Call[]) => { status: number; data?: unknown } | Error, image: (typeof IMAGE & { labels?: Record<string, string> }) | null = IMAGE) {
  const calls: Call[] = [];
  const request: ComputeRequest = vi.fn(async (call: Call) => {
    calls.push(call);
    if (image && call.method === "GET" && call.url.includes("/images/family/")) return { status: 200, data: image };
    const out = script(call, calls);
    if (out instanceof Error) throw out;
    return out;
  });
  return { request, calls };
}

function http(status: number): Error {
  return Object.assign(new Error(`http ${status}`), { response: { status } });
}

function clientWith(request: ComputeRequest) {
  const log = vi.fn();
  let clock = 0;
  const client = createGatewayVmClient({
    request,
    projectId: "octogee-test",
    log,
    wait: async () => { clock += 1_000; },
    now: () => clock,
    operationTimeoutMs: 10_000,
    pollIntervalMs: 1_000,
  });
  return { client, log };
}

const instance = (overrides: Record<string, unknown> = {}) => ({
  status: 200,
  data: {
    id: "1234567890",
    name: input.instanceName,
    status: "RUNNING",
    networkInterfaces: [{ networkIP: "10.138.0.9" }],
    scheduling: { provisioningModel: "SPOT" },
    ...overrides,
  },
});

describe("instanceInsertBody", () => {
  it("retains an owned home disk independently of the disposable boot disk", () => {
    const body = instanceInsertBody("octogee-test", { ...input, homeDiskSizeGb: 10 }, "us-west1-b", "SPOT", IMAGE) as Record<string, any>;
    expect(body.disks[0].autoDelete).toBe(true);
    expect(body.disks[1]).toMatchObject({ autoDelete: false,
      initializeParams: { diskSizeGb: "10", diskType: "zones/us-west1-b/diskTypes/pd-balanced",
        labels: { "octogee-owner-uid": "owner-a", "octogee-storage": "customer-home" } } });
  });

  it("creates the boot disk with the tier's disk type", () => {
    expect((instanceInsertBody("octogee-test", input, "us-west1-b", "SPOT", IMAGE) as Record<string, any>).disks[0].initializeParams.diskType)
      .toBe("zones/us-west1-b/diskTypes/pd-ssd");
    expect((instanceInsertBody("octogee-test", { ...input, bootDiskType: "pd-balanced" }, "us-west1-b", "SPOT", IMAGE) as Record<string, any>).disks[0].initializeParams.diskType)
      .toBe("zones/us-west1-b/diskTypes/pd-balanced");
  });

  it("refuses a VM without an owner", () => {
    const { "octogee-owner-uid": _owner, ...unowned } = input.labels;
    expect(() => instanceInsertBody("octogee-test", { ...input, labels: unowned }, "us-west1-b", "SPOT", IMAGE)).toThrow(/owner-uid/);
  });

  it("renders a Spot VM from a selected named image with no external IP and the gateway identity", () => {
    const body = instanceInsertBody("octogee-test", input, "us-west1-b", "SPOT", IMAGE) as Record<string, any>;
    expect(body.name).toBe(input.instanceName);
    expect(body.machineType).toBe("zones/us-west1-b/machineTypes/n2-standard-4");
    expect(body.disks[0].initializeParams.sourceImage).toBe("projects/octogee-test/global/images/octogee-computer-20260927");
    expect(body.disks[0].initializeParams.diskSizeGb).toBe("40");
    expect(body.disks[0].autoDelete).toBe(true);
    expect(body.disks[1]).toEqual({
      boot: false,
      autoDelete: false,
      deviceName: "octogee-home",
      initializeParams: {
        diskName: `${input.instanceName}-home`,
        diskSizeGb: "20",
        diskType: "zones/us-west1-b/diskTypes/pd-balanced",
        labels: { "octogee-owner-uid": "owner-a", "octogee-storage": "customer-home" },
      },
    });
    expect(body.networkInterfaces).toEqual([{ subnetwork: input.subnetwork }]);
    expect(body.serviceAccounts).toEqual([
      {
        email: input.serviceAccountEmail,
        scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email"],
      },
    ]);
    expect(body.scheduling).toEqual({
      provisioningModel: "SPOT",
      instanceTerminationAction: "STOP",
      automaticRestart: false,
      onHostMaintenance: "TERMINATE",
    });
    expect(body.labels).toEqual(input.labels);
    expect(body.tags).toEqual({ items: ["octogee-computer"] });
    expect(body.metadata.items).toEqual([
      { key: "gateway-id", value: "b-mama-3-abc-hobby" },
      { key: "octogee-environment", value: "test" },
    ]);
  });

  it("sources the image from another project when the spec names one", () => {
    const body = instanceInsertBody("octogee", { ...input, imageProject: "octogee-test" }, "us-west1-b", "SPOT", IMAGE) as Record<string, any>;
    expect(body.disks[0].initializeParams.sourceImage).toBe("projects/octogee-test/global/images/octogee-computer-20260927");
  });

  it("renders on-demand scheduling for STANDARD", () => {
    const body = instanceInsertBody("octogee-test", input, "us-west1-b", "STANDARD", IMAGE) as Record<string, any>;
    expect(body.scheduling).toEqual({ provisioningModel: "STANDARD", automaticRestart: true, onHostMaintenance: "MIGRATE" });
  });
});

describe("createGatewayVmClient.create", () => {
  it("inserts, waits for the zone operation, and describes the instance", async () => {
    const { request, calls } = fakeCompute((call) => {
      if (call.method === "POST" && call.url === `${BASE}/zones/us-west1-b/instances`) {
        return { status: 200, data: { name: "op-1", status: "RUNNING" } };
      }
      if (call.url === `${BASE}/zones/us-west1-b/operations/op-1`) {
        return { status: 200, data: { name: "op-1", status: calls.length >= 3 ? "DONE" : "RUNNING" } };
      }
      if (call.method === "GET" && call.url === `${BASE}/zones/us-west1-b/instances/${input.instanceName}`) {
        return instance();
      }
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { client } = clientWith(request);

    const result = await client.create(input);

    expect(result.alreadyExisted).toBe(false);
    expect(result.fellBackToStandard).toBe(false);
    expect(result.provisioningModel).toBe("SPOT");
    expect(result.description).toEqual({
      machineType: null,      name: input.instanceName,
      zone: "us-west1-b",
      status: "RUNNING",
      instanceId: "1234567890",
      internalIp: "10.138.0.9",
      provisioningModel: "SPOT",
      gatewayId: null,
      labels: {},
      metadata: {},
      lastStartedAt: null,
      serviceAccounts: [],
    });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("creates a checkpoint-restoring computer only from an image whose boot keeps writers off until the restore admits them", async () => {
    const restoring = { ...input, metadata: { ...input.metadata, [COMPUTER_HOME_RESTORE_METADATA_KEY]: "checkpoint" } };
    const script = (call: Call) => {
      if (call.method === "POST") return { status: 200, data: { name: "op-1", status: "DONE" } };
      if (call.method === "GET" && call.url.endsWith(`/instances/${input.instanceName}`)) return instance();
      return new Error(`unexpected ${call.method} ${call.url}`);
    };
    for (const labels of [undefined, { "home-restore": "ungated" }]) {
      const ungated = fakeCompute(script, { ...IMAGE, ...(labels ? { labels } : {}) });
      await expect(clientWith(ungated.request).client.create(restoring)).rejects.toThrow(/does not gate .* writers .* checkpoint restore/);
      expect(ungated.calls.filter((c) => c.method === "POST")).toEqual([]);
    }

    const gated = fakeCompute(script, { ...IMAGE, labels: { "home-restore": "gated-v1" } });
    await expect(clientWith(gated.request).client.create(restoring)).resolves.toMatchObject({ alreadyExisted: false });
    const plain = fakeCompute(script);
    await expect(clientWith(plain.request).client.create(input)).resolves.toMatchObject({ alreadyExisted: false });
  });

  it("falls back to on-demand when the zone has no Spot capacity", async () => {
    const posts: unknown[] = [];
    const { request } = fakeCompute((call) => {
      if (call.method === "POST" && call.url.endsWith("/instances")) {
        posts.push(call.body);
        return { status: 200, data: { name: `op-${posts.length}`, status: "RUNNING" } };
      }
      if (call.url.endsWith("/operations/op-1")) {
        return {
          status: 200,
          data: { name: "op-1", status: "DONE", error: { errors: [{ code: "ZONE_RESOURCE_POOL_EXHAUSTED", message: "no spot" }] } },
        };
      }
      if (call.url.endsWith("/operations/op-2")) return { status: 200, data: { name: "op-2", status: "DONE" } };
      if (call.method === "GET" && call.url.endsWith(`/instances/${input.instanceName}`)) {
        return instance({ scheduling: { provisioningModel: "STANDARD" } });
      }
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { client, log } = clientWith(request);

    const result = await client.create(input);

    expect(posts).toHaveLength(2);
    expect((posts[0] as any).scheduling.provisioningModel).toBe("SPOT");
    expect((posts[1] as any).scheduling.provisioningModel).toBe("STANDARD");
    expect(result.fellBackToStandard).toBe(true);
    expect(result.provisioningModel).toBe("STANDARD");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/SPOT capacity exhausted in us-west1-b; retrying on-demand in us-west1-b/));
  });

  it("does not fall back for an on-demand request that fails, and surfaces the code", async () => {
    const { request, calls } = fakeCompute((call) => {
      if (call.method === "POST") return { status: 200, data: { name: "op-1", status: "RUNNING" } };
      if (call.url.endsWith("/operations/op-1")) {
        return { status: 200, data: { name: "op-1", status: "DONE", error: { errors: [{ code: "QUOTA_EXCEEDED", message: "cpus" }] } } };
      }
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { client } = clientWith(request);

    await expect(client.create({ ...input, provisioningModel: "STANDARD" })).rejects.toBeInstanceOf(ComputeOperationError);
    await expect(client.create({ ...input, provisioningModel: "STANDARD" })).rejects.toThrow(/QUOTA_EXCEEDED: cpus/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("reuses an existing instance when insert returns 409", async () => {
    const { request, calls } = fakeCompute((call) => {
      if (call.method === "POST") return http(409);
      if (call.method === "GET" && call.url.endsWith(`/instances/${input.instanceName}`)) return instance({ status: "TERMINATED" });
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { client, log } = clientWith(request);

    const result = await client.create(input);

    expect(result.alreadyExisted).toBe(true);
    expect(result.description.status).toBe("TERMINATED");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/already exists in us-west1-b \(TERMINATED\)/));
  });

  it("fails loudly when the operation never finishes", async () => {
    const { request } = fakeCompute((call) => {
      if (call.method === "POST") return { status: 200, data: { name: "op-1", status: "RUNNING" } };
      if (call.url.endsWith("/operations/op-1")) return { status: 200, data: { name: "op-1", status: "RUNNING" } };
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { client } = clientWith(request);

    await expect(client.create(input)).rejects.toThrow(/did not finish within 10000ms/);
  });
});

describe("createGatewayVmClient lifecycle", () => {
  it("reads the attached service account and scopes for reuse", async () => {
    const serviceAccounts = [{ email: input.serviceAccountEmail, scopes: ["old-scope"] }];
    const { request } = fakeCompute(() => instance({ serviceAccounts }));
    expect((await clientWith(request).client.describe(input.instanceName, "us-west1-b"))?.serviceAccounts).toEqual(serviceAccounts);
  });

  it("sets the VM identity and waits for Compute to finish before returning", async () => {
    const { request, calls } = fakeCompute((call) => {
      if (call.method === "POST") return { status: 200, data: { name: "identity", status: "RUNNING" } };
      return { status: 200, data: { name: "identity", status: "DONE" } };
    });
    await clientWith(request).client.setServiceAccount(input.instanceName, "us-west1-b", input.serviceAccountEmail);
    expect(calls).toEqual([
      { url: `${BASE}/zones/us-west1-b/instances/${input.instanceName}/setServiceAccount`, method: "POST", body: {
        email: input.serviceAccountEmail,
        scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email"],
      } },
      { url: `${BASE}/zones/us-west1-b/operations/identity`, method: "GET" },
    ]);
  });

  it("describe returns null for a missing instance", async () => {
    const { request } = fakeCompute(() => http(404));
    const { client } = clientWith(request);
    expect(await client.describe("octogee-gw-nope", "us-west1-b")).toBeNull();
  });

  it("stop and start post the lifecycle verb and wait for the operation", async () => {
    const { request, calls } = fakeCompute((call) => {
      if (call.method === "POST") return { status: 200, data: { name: `op-${call.url.split("/").pop()}`, status: "DONE" } };
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { client } = clientWith(request);

    await client.stop(input.instanceName, "us-west1-b");
    await client.start(input.instanceName, "us-west1-b");

    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/zones/us-west1-b/instances/${input.instanceName}/stop`,
      `${BASE}/zones/us-west1-b/instances/${input.instanceName}/start`,
    ]);
  });

  it("suspend and resume post the lifecycle verb and wait for the operation", async () => {
    const { request, calls } = fakeCompute((call) => {
      if (call.method === "POST") return { status: 200, data: { name: `op-${call.url.split("/").pop()}`, status: "RUNNING" } };
      if (call.url.includes("/operations/op-")) return { status: 200, data: { name: call.url.split("/").pop(), status: "DONE" } };
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { client } = clientWith(request);

    await client.suspend(input.instanceName, "us-west1-b");
    expect(await client.resume(input.instanceName, "us-west1-b")).toEqual({ fellBackToStandard: false });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${BASE}/zones/us-west1-b/instances/${input.instanceName}/suspend`,
      `GET ${BASE}/zones/us-west1-b/operations/op-suspend`,
      `POST ${BASE}/zones/us-west1-b/instances/${input.instanceName}/resume`,
      `GET ${BASE}/zones/us-west1-b/operations/op-resume`,
    ]);
  });

  it("delete is idempotent on 404 and reports whether anything was deleted", async () => {
    const present = fakeCompute((call) => {
      if (call.method === "DELETE") return { status: 200, data: { name: "op-del", status: "DONE" } };
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const absent = fakeCompute(() => http(404));

    expect(await clientWith(present.request).client.delete(input.instanceName, "us-west1-b")).toBe(true);
    expect(await clientWith(absent.request).client.delete(input.instanceName, "us-west1-b")).toBe(false);
    expect(present.calls[0]).toMatchObject({ method: "DELETE", url: `${BASE}/zones/us-west1-b/instances/${input.instanceName}` });
  });

  it("describe reads the bound gateway id from instance metadata", async () => {
    const { request } = fakeCompute(() => instance({ metadata: { items: [{ key: "gateway-id", value: "b-x" }, { key: "gateway-image", value: "img" }] } }));
    const { client } = clientWith(request);
    expect((await client.describe(input.instanceName, "us-west1-b"))?.gatewayId).toBe("b-x");
  });

  it("start reschedules a stopped Spot VM on-demand when Spot capacity is exhausted, and only then", async () => {
    const posts: Call[] = [];
    const { request } = fakeCompute((call) => {
      if (call.method === "POST") {
        posts.push(call);
        return { status: 200, data: { name: `op-${posts.length}`, status: "RUNNING" } };
      }
      if (call.url.endsWith("/operations/op-1")) {
        return { status: 200, data: { name: "op-1", status: "DONE", error: { errors: [{ code: "ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS", message: "no spot" }] } } };
      }
      if (call.url.includes("/operations/op-")) return { status: 200, data: { name: call.url.split("/").pop(), status: "DONE" } };
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { client, log } = clientWith(request);

    const result = await client.start(input.instanceName, "us-west1-b");

    expect(result).toEqual({ fellBackToStandard: true });
    expect(posts.map((c) => c.url.split("/").pop())).toEqual(["start", "setScheduling", "start"]);
    expect(posts[1].body).toEqual({ provisioningModel: "STANDARD", automaticRestart: true, onHostMaintenance: "MIGRATE" });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/spot capacity exhausted .* restarting on-demand/));

    const other = fakeCompute((call) => {
      if (call.method === "POST") return { status: 200, data: { name: "op-q", status: "RUNNING" } };
      if (call.url.endsWith("/operations/op-q")) {
        return { status: 200, data: { name: "op-q", status: "DONE", error: { errors: [{ code: "QUOTA_EXCEEDED", message: "cpus" }] } } };
      }
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    await expect(clientWith(other.request).client.start(input.instanceName, "us-west1-b")).rejects.toThrow(/QUOTA_EXCEEDED/);
    expect(other.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("resume stops and restarts when Spot capacity is exhausted on resume, and only then", async () => {
    const posts: Call[] = [];
    const exhausted = { status: "DONE", error: { errors: [{ code: "ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS", message: "no spot" }] } };
    const { request } = fakeCompute((call) => {
      if (call.method === "POST") {
        posts.push(call);
        return { status: 200, data: { name: `op-${posts.length}`, status: "RUNNING" } };
      }
      if (call.url.endsWith("/operations/op-1") || call.url.endsWith("/operations/op-3")) {
        return { status: 200, data: { name: call.url.split("/").pop(), ...exhausted } };
      }
      if (call.url.includes("/operations/op-")) return { status: 200, data: { name: call.url.split("/").pop(), status: "DONE" } };
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { client, log } = clientWith(request);

    const result = await client.resume(input.instanceName, "us-west1-b");

    expect(result).toEqual({ fellBackToStandard: true });
    expect(posts.map((c) => c.url.split("/").pop())).toEqual(["resume", "stop", "start", "setScheduling", "start"]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/spot capacity exhausted .* on resume; stopping and restarting/));

    const other = fakeCompute((call) => {
      if (call.method === "POST") return { status: 200, data: { name: "op-q", status: "RUNNING" } };
      if (call.url.endsWith("/operations/op-q")) {
        return { status: 200, data: { name: "op-q", status: "DONE", error: { errors: [{ code: "QUOTA_EXCEEDED", message: "cpus" }] } } };
      }
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    await expect(clientWith(other.request).client.resume(input.instanceName, "us-west1-b")).rejects.toThrow(/QUOTA_EXCEEDED/);
    expect(other.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("find locates a VM by name across zones and refuses an ambiguous answer", async () => {
    const aggregated = (zones: string[]) => ({
      status: 200,
      data: {
        items: Object.fromEntries([
          ...zones.map((zone) => [`zones/${zone}`, { instances: [{ ...instance().data, zone: `https://www.googleapis.com/compute/v1/projects/octogee-test/zones/${zone}`, status: "TERMINATED" }] }]),
          ["zones/us-east1-b", { warning: { code: "NO_RESULTS_ON_PAGE" } }],
        ]),
      },
    });
    const one = fakeCompute((call) => (call.method === "GET" && call.url.includes("/aggregated/instances?") ? aggregated(["us-west1-b"]) : new Error(`unexpected ${call.url}`)));
    const found = await clientWith(one.request).client.find(input.instanceName);
    expect(found).toMatchObject({ name: input.instanceName, zone: "us-west1-b", status: "TERMINATED", instanceId: "1234567890" });
    expect(one.calls[0].url).toBe(`${BASE}/aggregated/instances?filter=${encodeURIComponent(`name = "${input.instanceName}"`)}`);

    const none = fakeCompute(() => ({ status: 200, data: { items: { "zones/us-west1-b": { warning: { code: "NO_RESULTS_ON_PAGE" } } } } }));
    expect(await clientWith(none.request).client.find(input.instanceName)).toBeNull();

    const two = fakeCompute(() => aggregated(["us-west1-b", "us-central1-a"]));
    await expect(clientWith(two.request).client.find(input.instanceName)).rejects.toThrow(/2 instances named/);
  });

  it("bind replaces the labels and merges the metadata under the current fingerprints", async () => {
    const posts: Call[] = [];
    const { request } = fakeCompute((call) => {
      if (call.method === "GET" && call.url.endsWith(`/instances/${input.instanceName}`)) {
        return instance({
          labelFingerprint: "lf-1",
          labels: { "octogee-gateway-id": "b-old", purpose: "octogee-computer" },
          metadata: { fingerprint: "mf-1", items: [{ key: "gateway-id", value: "b-old" }, { key: "ssh-keys", value: "chris:ssh-ed25519 AAA" }] },
        });
      }
      if (call.method === "POST") {
        posts.push(call);
        return { status: 200, data: { name: `op-${posts.length}`, status: "DONE" } };
      }
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { client } = clientWith(request);

    await client.bind(input.instanceName, "us-west1-b", {
      labels: { "octogee-gateway-id": "b-new", purpose: "octogee-computer" },
      metadata: { "gateway-id": "b-new", "gateway-image": "img:2" },
    });

    expect(posts.map((c) => c.url.split("/").pop())).toEqual(["setLabels", "setMetadata"]);
    expect(posts[0].body).toEqual({ labelFingerprint: "lf-1", labels: { "octogee-gateway-id": "b-new", purpose: "octogee-computer" } });
    expect(posts[1].body).toEqual({
      fingerprint: "mf-1",
      items: [
        { key: "gateway-id", value: "b-new" },
        { key: "ssh-keys", value: "chris:ssh-ed25519 AAA" },
        { key: "gateway-image", value: "img:2" },
      ],
    });
  });

  it("propagates non-404 failures from every verb", async () => {
    const { request } = fakeCompute(() => http(403));
    const { client } = clientWith(request);
    await expect(client.describe("x", "us-west1-b")).rejects.toThrow(/http 403/);
    await expect(client.delete("x", "us-west1-b")).rejects.toThrow(/http 403/);
    await expect(client.stop("x", "us-west1-b")).rejects.toThrow(/http 403/);
    await expect(client.list({ labels: { purpose: "octogee-computer" } })).rejects.toThrow(/http 403/);
    await expect(client.findByLabels({ "octogee-owner-uid": "uida" })).rejects.toThrow(/http 403/);
  });
});

describe("createGatewayVmClient listing", () => {
  const pooled = {
    id: "777",
    name: "octogee-computer-test-ab12cd34",
    status: "RUNNING",
    creationTimestamp: "2026-09-05T10:00:00.000-07:00",
    lastStartTimestamp: "2026-09-05T10:01:00.000-07:00",
    networkInterfaces: [{ networkIP: "10.138.0.20" }],
    scheduling: { provisioningModel: "SPOT" },
    labels: { purpose: "octogee-computer", "octogee-environment": "test" },
    labelFingerprint: "lf-1",
    metadata: { fingerprint: "mf-1", items: [{ key: "octogee-environment", value: "test" }] },
  };

  it("describe surfaces labels, metadata, and the last start time", async () => {
    const { request } = fakeCompute(() => ({ status: 200, data: pooled }));
    const { client } = clientWith(request);

    expect(await client.describe(pooled.name, "us-west1-b")).toEqual({
      machineType: null,      name: pooled.name,
      zone: "us-west1-b",
      status: "RUNNING",
      instanceId: "777",
      internalIp: "10.138.0.20",
      provisioningModel: "SPOT",
      gatewayId: null,
      labels: { purpose: "octogee-computer", "octogee-environment": "test" },
      metadata: { "octogee-environment": "test" },
      lastStartedAt: Date.parse("2026-09-05T17:01:00.000Z"),
      serviceAccounts: [],
    });
  });

  it("list finds VMs in every zone of the aggregated listing and follows pagination", async () => {
    const inZone = (zone: string, name: string) => ({ ...pooled, name, zone: `https://www.googleapis.com/compute/v1/projects/octogee-test/zones/${zone}` });
    const { request, calls } = fakeCompute((call) => {
      if (call.method !== "GET" || !call.url.startsWith(`${BASE}/aggregated/instances?`)) return new Error(`unexpected ${call.method} ${call.url}`);
      const url = new URL(call.url);
      if (url.searchParams.get("pageToken") === "p2") {
        return { status: 200, data: { items: { "zones/us-central1-f": { instances: [inZone("us-central1-f", "octogee-computer-test-second")] } } } };
      }
      return {
        status: 200,
        data: {
          items: {
            "zones/us-central1-a": { instances: [inZone("us-central1-a", "octogee-computer-test-legacy")] },
            "zones/us-central1-b": { instances: [inZone("us-central1-b", "octogee-computer-test-ab12cd34")] },
            "zones/us-east1-b": { warning: { code: "NO_RESULTS_ON_PAGE" } },
          },
          nextPageToken: "p2",
        },
      };
    });
    const { client } = clientWith(request);

    const members = await client.list({ labels: { purpose: "octogee-computer", "octogee-environment": "test" } });

    expect(members.map((m) => [m.name, m.zone])).toEqual([
      ["octogee-computer-test-legacy", "us-central1-a"],
      ["octogee-computer-test-ab12cd34", "us-central1-b"],
      ["octogee-computer-test-second", "us-central1-f"],
    ]);
    expect(new URL(calls[0].url).searchParams.get("filter")).toBe("(labels.purpose = \"octogee-computer\") AND (labels.octogee-environment = \"test\")");
  });

  it("findByLabels locates the one instance carrying every label across zones and refuses an ambiguous answer", async () => {
    const labels = { "octogee-owner-uid": "uida", "octogee-environment": "test", purpose: "octogee-computer" };
    const inZone = (zone: string, name: string, extra: Record<string, string> = {}) => ({
      ...pooled, name, zone: `https://www.googleapis.com/compute/v1/projects/octogee-test/zones/${zone}`, labels: { ...labels, ...extra },
    });
    const aggregated = (instances: unknown[]) => ({ status: 200, data: { items: { "zones/us-west1-b": { instances }, "zones/us-east1-b": { warning: { code: "NO_RESULTS_ON_PAGE" } } } } });

    const one = fakeCompute((call) => (call.method === "GET" && call.url.includes("/aggregated/instances?") ? aggregated([inZone("us-west1-b", "octogee-computer-test-claimed", { "octogee-gateway-id": "b-x" })]) : new Error(`unexpected ${call.url}`)));
    const found = await clientWith(one.request).client.findByLabels(labels);
    expect(found).toMatchObject({ name: "octogee-computer-test-claimed", zone: "us-west1-b", labels: { ...labels, "octogee-gateway-id": "b-x" } });
    expect(new URL(one.calls[0].url).searchParams.get("filter")).toBe(
      "(labels.octogee-owner-uid = \"uida\") AND (labels.octogee-environment = \"test\") AND (labels.purpose = \"octogee-computer\")",
    );

    const none = fakeCompute(() => aggregated([{ ...inZone("us-west1-b", "octogee-computer-test-uidb"), labels: { ...labels, "octogee-owner-uid": "uidb" } }]));
    expect(await clientWith(none.request).client.findByLabels(labels)).toBeNull();

    const two = fakeCompute(() => aggregated([inZone("us-west1-b", "octogee-computer-test-uida"), inZone("us-central1-a", "octogee-computer-test-claimed")]));
    await expect(clientWith(two.request).client.findByLabels(labels)).rejects.toThrow(/2 instances match \(octogee-computer-test-uida in us-west1-b, octogee-computer-test-claimed in us-central1-a\)/);
  });

  it("list returns nothing when no zone has matching instances", async () => {
    const { request } = fakeCompute(() => ({ status: 200, data: {} }));
    const { client } = clientWith(request);
    expect(await client.list({ labels: { purpose: "octogee-computer" } })).toEqual([]);
  });
});

describe("createGatewayVmClient — zone walk", () => {
  const input: CreateGatewayVmInput = {
    instanceName: "octogee-computer-test-abc",
    zones: ["us-central1-b", "us-central1-c", "us-central1-f"],
    machineType: "n2-standard-4",
    imageFamily: "octogee-computer",
    diskSizeGb: 40, bootDiskType: "pd-ssd", homeDiskSizeGb: 20,
    provisioningModel: "SPOT",
    desktop: "omarchy",
    serviceAccountEmail: "computer@octogee.iam.gserviceaccount.com",
    subnetwork: "regions/us-central1/subnetworks/default",
    labels: { "octogee-owner-uid": "uida" },
    metadata: {},
  };

  const exhaustedIn = (spot: readonly string[], standard: readonly string[] = []) => {
    const posts: Array<{ zone: string; model: string }> = [];
    let op = 0;
    const gets: string[] = [];
    const { request } = fakeCompute((call) => {
      if (call.method === "POST" && call.url.endsWith("/instances")) {
        const zone = /\/zones\/([^/]+)\/instances$/u.exec(call.url)?.[1] ?? "?";
        posts.push({ zone, model: (call.body as any).scheduling.provisioningModel });
        op += 1;
        return { status: 200, data: { name: `op-${op}`, status: "RUNNING" } };
      }
      const opMatch = /\/operations\/op-(\d+)$/u.exec(call.url);
      if (opMatch) {
        const attempt = posts[Number(opMatch[1]) - 1];
        const exhausted = (attempt.model === "SPOT" ? spot : standard).includes(attempt.zone);
        return exhausted
          ? { status: 200, data: { name: call.url, status: "DONE", error: { errors: [{ code: "ZONE_RESOURCE_POOL_EXHAUSTED", message: "no capacity" }] } } }
          : { status: 200, data: { name: call.url, status: "DONE" } };
      }
      if (call.method === "GET" && call.url.includes(`/instances/${input.instanceName}`)) {
        gets.push(call.url);
        const landed = posts[posts.length - 1];
        return instance({ scheduling: { provisioningModel: landed.model } });
      }
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    return { request, posts, gets };
  };

  it("places the VM in the first zone of the given order and describes it there", async () => {
    const { request, posts, gets } = exhaustedIn([]);
    const { client } = clientWith(request);

    const result = await client.create(input);

    expect(posts).toEqual([{ zone: "us-central1-b", model: "SPOT" }]);
    expect(gets).toEqual([`${BASE}/zones/us-central1-b/instances/octogee-computer-test-abc`]);
    expect(result.description.zone).toBe("us-central1-b");
  });

  it("tries spot in the next zone before paying on-demand", async () => {
    const { request, posts } = exhaustedIn(["us-central1-b"]);
    const { client, log } = clientWith(request);

    const result = await client.create(input);

    expect(posts).toEqual([
      { zone: "us-central1-b", model: "SPOT" },
      { zone: "us-central1-c", model: "SPOT" },
    ]);
    expect(result.fellBackToStandard).toBe(false);
    expect(result.provisioningModel).toBe("SPOT");
    expect(result.description.zone).toBe("us-central1-c");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/SPOT capacity exhausted in us-central1-b.*retrying SPOT in us-central1-c/));
  });

  it("walks every zone before it gives up on spot, then walks on-demand in the same order", async () => {
    const { request, posts } = exhaustedIn(["us-central1-b", "us-central1-c", "us-central1-f"], ["us-central1-b"]);
    const { client } = clientWith(request);

    const result = await client.create(input);

    expect(posts).toEqual([
      { zone: "us-central1-b", model: "SPOT" },
      { zone: "us-central1-c", model: "SPOT" },
      { zone: "us-central1-f", model: "SPOT" },
      { zone: "us-central1-b", model: "STANDARD" },
      { zone: "us-central1-c", model: "STANDARD" },
    ]);
    expect(result.fellBackToStandard).toBe(true);
    expect(result.provisioningModel).toBe("STANDARD");
    expect(result.description.zone).toBe("us-central1-c");
  });

  it("walks the zones for an on-demand request that hits a stockout", async () => {
    const { request, posts } = exhaustedIn([], ["us-central1-b"]);
    const { client } = clientWith(request);

    const result = await client.create({ ...input, provisioningModel: "STANDARD" });

    expect(posts).toEqual([
      { zone: "us-central1-b", model: "STANDARD" },
      { zone: "us-central1-c", model: "STANDARD" },
    ]);
    expect(result.fellBackToStandard).toBe(false);
  });

  it("surfaces the stockout once every zone refused on-demand too", async () => {
    const all = ["us-central1-b", "us-central1-c", "us-central1-f"];
    const { request, posts } = exhaustedIn(all, all);
    const { client } = clientWith(request);

    await expect(client.create(input)).rejects.toThrow(/ZONE_RESOURCE_POOL_EXHAUSTED/);
    expect(posts).toHaveLength(6);
  });

  it("falls straight to on-demand in the only zone when one zone is configured", async () => {
    const { request, posts } = exhaustedIn(["us-central1-b"]);
    const { client } = clientWith(request);

    const result = await client.create({ ...input, zones: ["us-central1-b"] });

    expect(posts).toEqual([
      { zone: "us-central1-b", model: "SPOT" },
      { zone: "us-central1-b", model: "STANDARD" },
    ]);
    expect(result.fellBackToStandard).toBe(true);
  });

  it("refuses to place a VM with no zones", async () => {
    const { request, posts } = exhaustedIn([]);
    await expect(clientWith(request).client.create({ ...input, zones: [] })).rejects.toThrow(/octogee-computer-test-abc: no zones to place it in/);
    expect(posts).toEqual([]);
  });
});

describe("createGatewayVmClient.lastPreemptedAt", () => {
  const preempted = (instanceName: string, insertTime: string) => ({
    operationType: "compute.instances.preempted",
    targetLink: `https://www.googleapis.com/compute/v1/projects/octogee-test/zones/us-central1-a/instances/${instanceName}`,
    insertTime,
    status: "DONE",
  });

  it("reads the newest Compute preemption of that instance across the zone's operation pages", async () => {
    const { request, calls } = fakeCompute((call) => {
      if (call.method !== "GET" || !call.url.startsWith(`${BASE}/zones/us-central1-a/operations?`)) return new Error(`unexpected ${call.method} ${call.url}`);
      const url = new URL(call.url);
      if (url.searchParams.get("pageToken") === "p2") {
        return { status: 200, data: { items: [preempted("octogee-computer-test-44847785", "2026-09-25T21:19:43.000-00:00")] } };
      }
      return {
        status: 200,
        data: {
          items: [
            preempted("octogee-computer-test-44847785", "2026-09-24T08:00:00.000-00:00"),
            preempted("octogee-computer-test-other", "2026-09-25T22:00:00.000-00:00"),
          ],
          nextPageToken: "p2",
        },
      };
    });
    const { client } = clientWith(request);

    const at = await client.lastPreemptedAt("octogee-computer-test-44847785", "us-central1-a");

    expect(at).toBe(Date.parse("2026-09-25T21:19:43.000Z"));
    expect(new URL(calls[0].url).searchParams.get("filter")).toBe("operationType = \"compute.instances.preempted\"");
  });

  it("answers null when Compute has no preemption on record for the instance", async () => {
    const { request } = fakeCompute(() => ({ status: 200, data: { items: [preempted("octogee-computer-test-other", "2026-09-25T22:00:00.000Z")] } }));

    expect(await clientWith(request).client.lastPreemptedAt("octogee-computer-test-44847785", "us-central1-a")).toBeNull();
  });

  it("propagates a failed operations read instead of reporting no preemption", async () => {
    const { request } = fakeCompute(() => http(403));

    await expect(clientWith(request).client.lastPreemptedAt("octogee-computer-test-44847785", "us-central1-a")).rejects.toThrow(/http 403/);
  });
});

describe("createGatewayVmClient boot image currency", () => {
  const IMAGES = "https://www.googleapis.com/compute/v1/projects/octogee/global/images";

  it("reads the image the boot disk was created from, not the home disk's", async () => {
    const { request, calls } = fakeCompute((call) => {
      if (call.url === `${BASE}/zones/us-west1-b/instances/${input.instanceName}`) {
        return instance({ disks: [
          { boot: false, source: `${BASE}/zones/us-west1-b/disks/${input.instanceName}-home` },
          { boot: true, source: `${BASE}/zones/us-west1-b/disks/${input.instanceName}` },
        ] });
      }
      if (call.url === `${BASE}/zones/us-west1-b/disks/${input.instanceName}`) {
        return { status: 200, data: { sourceImage: `${IMAGES}/octogee-computer-20260914`, sourceImageId: "111" } };
      }
      return new Error(`unexpected ${call.method} ${call.url}`);
    });

    expect(await clientWith(request).client.readBootImage(input.instanceName, "us-west1-b")).toEqual({ name: "octogee-computer-20260914", id: "111" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("refuses to answer for a boot disk that records no source image", async () => {
    const { request } = fakeCompute((call) => call.url.includes("/disks/")
      ? { status: 200, data: {} }
      : instance({ disks: [{ boot: true, source: `${BASE}/zones/us-west1-b/disks/boot` }] }));

    await expect(clientWith(request).client.readBootImage(input.instanceName, "us-west1-b")).rejects.toThrow(/records no source image/);
  });

  it("resolves an image family's current member in the named project, defaulting to the client's", async () => {
    const { request, calls } = fakeCompute(() => ({ status: 200, data: { name: "octogee-computer-20260927", id: "222" } }), null);
    const { client } = clientWith(request);

    expect(await client.readFamilyImage("octogee-computer", "octogee")).toEqual({ name: "octogee-computer-20260927", id: "222" });
    await client.readFamilyImage("octogee-computer");

    expect(calls.map((c) => c.url)).toEqual([
      "https://compute.googleapis.com/compute/v1/projects/octogee/global/images/family/octogee-computer",
      `${BASE}/global/images/family/octogee-computer`,
    ]);
  });
});

 it("reads the observed machine type and resizes a stopped VM through the Compute operation", async () => {
   const { request, calls } = fakeCompute((call) => call.method === "GET" ? instance({ machineType: `${BASE}/zones/us-west1-b/machineTypes/n2-standard-4` }) : { status: 200, data: { name: "resize-1", status: "DONE" } });
   const { client } = clientWith(request);
   expect((await client.describe(input.instanceName, "us-west1-b"))?.machineType).toBe("n2-standard-4");
   await client.setMachineType(input.instanceName, "us-west1-b", "n2-standard-2");
   expect(calls.at(-1)).toEqual({ url: `${BASE}/zones/us-west1-b/instances/${input.instanceName}/setMachineType`, method: "POST", body: { machineType: "zones/us-west1-b/machineTypes/n2-standard-2" } });
 });

 it("journals a provisioning-model change, then sets the stopped VM's scheduling", async () => {
   const request = vi.fn(async () => ({ status: 200, data: { name: "schedule", status: "DONE" } }));
   const journalProvisioningModel = vi.fn(async (_input, action) => action());
   const client = createGatewayVmClient({ request, projectId: "octogee-test", log: vi.fn(), wait: async () => {}, now: () => 0, journalProvisioningModel });
   await client.setProvisioningModel("computer", "us-central1-a", "STANDARD");
   expect(journalProvisioningModel).toHaveBeenCalledWith({ instanceName: "computer", zone: "us-central1-a", provisioningModel: "STANDARD" }, expect.any(Function));
   expect(journalProvisioningModel.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]);
   expect(request).toHaveBeenCalledWith({ url: `${BASE}/zones/us-central1-a/instances/computer/setScheduling`, method: "POST",
     body: { provisioningModel: "STANDARD", automaticRestart: true, onHostMaintenance: "MIGRATE" } });
 });

 it("journals a capacity change before issuing the Compute mutation", async () => {
   const request = vi.fn(async () => ({ status: 200, data: { name: "resize", status: "DONE" } }));
   const journalMachineType = vi.fn(async (_input, action) => action());
   const client = createGatewayVmClient({ request, projectId: "octogee-test", log: vi.fn(), wait: async () => {}, now: () => 0, journalMachineType });
   await client.setMachineType("computer", "us-central1-a", "n2-standard-2");
   expect(journalMachineType).toHaveBeenCalledWith({ instanceName: "computer", zone: "us-central1-a", machineType: "n2-standard-2" }, expect.any(Function));
   expect(journalMachineType.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]);
 });


describe("verified home retention", () => {
  const source = `${BASE}/zones/us-west1-b/disks/customer-home`;
  const home = { projectId: "octogee-test", zone: "us-west1-b", name: "customer-home", id: "777", sizeGb: 30, diskType: "pd-ssd" as const, source: "projects/octogee-test/zones/us-west1-b/disks/customer-home" };
  const disk = (extra = {}) => ({ name: home.name, id: home.id, sizeGb: "30", type: "zones/us-west1-b/diskTypes/pd-ssd", labelFingerprint: "disk-fp", labels: { "octogee-owner-uid": "uida", "octogee-storage": "customer-home" }, ...extra });
  it("disables home auto-delete and confirms the same owned disk without resizing it", async () => {
    let autoDelete = true;
    const { request, calls } = fakeCompute(call => {
      if (call.method === "GET" && call.url.endsWith(`/instances/${input.instanceName}`)) return instance({ metadata: { items: [{ key: "octogee-owner-uid", value: "UidA" }] }, disks: [{ deviceName: "octogee-home", source, autoDelete }] });
      if (call.method === "GET" && call.url === source) return { status: 200, data: disk() };
      if (call.method === "POST" && call.url.includes("/setDiskAutoDelete?")) { autoDelete = false; return { status: 200, data: { name: "keep", status: "DONE" } }; }
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    await expect(clientWith(request).client.retainHome(input.instanceName, home.zone, "UidA")).resolves.toEqual(home);
    expect(calls.filter(call => call.method !== "GET")).toEqual([{ method: "POST", url: `${BASE}/zones/us-west1-b/instances/${input.instanceName}/setDiskAutoDelete?autoDelete=false&deviceName=octogee-home` }]);
  });
  it.each([{ id: "wrong" }, { users: ["another-instance"] }, { labels: { "octogee-owner-uid": "another-owner" } }])("refuses an unverified detached source before any deletion: %j", async extra => {
    const { request, calls } = fakeCompute(_call => ({ status: 200, data: disk(extra) }));
    await expect(clientWith(request).client.deleteRetainedHome(home, "UidA")).rejects.toThrow(/unverified/);
    expect(calls.every(call => call.method === "GET")).toBe(true);
  });
  it("finishes erasure after a lost successful-delete acknowledgement without re-deleting", async () => {
    let exists = true;
    const { request, calls } = fakeCompute(call => {
      if (call.method === "GET") return exists ? { status: 200, data: disk() } : http(404);
      if (call.method === "DELETE") { exists = false; return http(503); }
      return new Error("unexpected request");
    });
    const client = clientWith(request).client;
    await expect(client.deleteRetainedHome(home, "UidA")).rejects.toThrow("503");
    await expect(client.deleteRetainedHome(home, "UidA")).resolves.toBeUndefined();
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(1);
  });
  it.each([403, 500, 503])("does not treat HTTP %i as completed erasure", async code => {
    const { request, calls } = fakeCompute(() => http(code));
    await expect(clientWith(request).client.deleteRetainedHome(home, "UidA")).rejects.toThrow(String(code));
    expect(calls.every(call => call.method === "GET")).toBe(true);
  });
  it.each([home.source, source, source.replace("compute.googleapis.com", "www.googleapis.com")])("deletes only a verified stopped boot with normalized home self-link %s", async attachedSource => {
    const { request, calls } = fakeCompute(call => {
      if (call.method === "GET" && call.url.includes("/instances/")) return instance({ id: "4242", status: "TERMINATED", metadata: { items: [{ key: "octogee-owner-uid", value: "UidA" }] }, disks: [{ boot: true, autoDelete: true }, { deviceName: "octogee-home", source: attachedSource, autoDelete: false }] });
      if (call.method === "GET") return { status: 200, data: disk() };
      return { status: 200, data: { name: "delete-boot", status: "DONE" } };
    });
    await clientWith(request).client.deleteRetainingHome(input.instanceName, home.zone, "UidA", home, "4242");
    expect(calls.filter(call => call.method === "DELETE")).toEqual([{ url: `${BASE}/zones/${home.zone}/instances/${input.instanceName}`, method: "DELETE" }]);
  });
  it.each(["running", "instance-changed", "owner-changed", "home-auto-delete", "other-auto-delete", "disk-changed", "other-project", "other-zone"])("refuses unsafe retained-boot deletion before any DELETE: %s", async scenario => {
    const disks = [{ boot: true, autoDelete: true }, { deviceName: "octogee-home", source: scenario === "other-project" ? source.replace("octogee-test", "another-project") : scenario === "other-zone" ? source.replace(home.zone, "us-west1-c") : home.source, autoDelete: scenario === "home-auto-delete" }];
    if (scenario === "other-auto-delete") disks.push({ deviceName: "unverified-user-disk", source: "extra", autoDelete: true });
    const { request, calls } = fakeCompute(call => call.url.includes("/instances/")
      ? instance({ id: scenario === "instance-changed" ? "999" : "4242", status: scenario === "running" ? "RUNNING" : "TERMINATED", metadata: { items: [{ key: "octogee-owner-uid", value: scenario === "owner-changed" ? "Other" : "UidA" }] }, disks })
      : { status: 200, data: disk(scenario === "disk-changed" ? { id: "888" } : {}) });
    await expect(clientWith(request).client.deleteRetainingHome(input.instanceName, home.zone, "UidA", home, "4242")).rejects.toThrow();
    expect(calls.every(call => call.method === "GET")).toBe(true);
  });
  it("attaches an existing 30-GiB home while leaving its capacity and contents intact", () => {
    const body = instanceInsertBody("octogee-test", { ...input, homeDiskSizeGb: 10, retainedHome: home }, home.zone, "SPOT", IMAGE) as Record<string, any>;
    expect(body.disks[1]).toEqual({ boot: false, autoDelete: false, deviceName: "octogee-home", source: home.source, mode: "READ_WRITE" });
    expect(body.disks[1]).not.toHaveProperty("initializeParams");
  });
});


describe("cold placement image identity", () => {
  it("resolves one named image before every zone/model attempt even when the family advances during fallback", async () => {
    const posts: Array<Record<string, any>> = [];
    const familyReads: string[] = [];
    const request: ComputeRequest = vi.fn(async call => {
      if (call.url.includes("/images/family/")) {
        familyReads.push(call.url);
        return { status: 200, data: { name: familyReads.length === 1 ? "vm-image-a" : "vm-image-b", id: "111" } };
      }
      if (call.method === "POST" && call.url.endsWith("/instances")) {
        posts.push(call.body as Record<string, any>);
        if (posts.length < 3) throw new ComputeOperationError("no capacity", ["ZONE_RESOURCE_POOL_EXHAUSTED"]);
        return { status: 200, data: { name: "created", status: "DONE" } };
      }
      return instance({ scheduling: { provisioningModel: "STANDARD" } });
    });
    await clientWith(request).client.create({ ...input, zones: ["us-west1-b", "us-west1-c"], imageProject: "octogee" });
    expect(familyReads).toEqual(["https://compute.googleapis.com/compute/v1/projects/octogee/global/images/family/octogee-computer"]);
    expect(posts).toHaveLength(3);
    expect(posts.map(post => post.disks[0].initializeParams.sourceImage)).toEqual(Array(3).fill("projects/octogee/global/images/vm-image-a"));
  });
  it.each(["changed-id", "missing-admission"])("rejects an unsafe pinned retained-home image before insertion: %s", async scenario => {
    const request: ComputeRequest = vi.fn(async () => ({ status: 200, data: { ...IMAGE, id: scenario === "changed-id" ? "333" : IMAGE.id } }));
    await expect(clientWith(request).client.create({ ...input, image: IMAGE, retainedHome: { projectId: "octogee-test", zone: input.zones[0], name: "home", id: "777", sizeGb: 30, diskType: "pd-ssd", source: "projects/octogee-test/zones/us-west1-b/disks/home" } })).rejects.toThrow(/identity changed|admission contract/);
    expect(vi.mocked(request).mock.calls.every(([call]) => call.method === "GET")).toBe(true);
    expect(vi.mocked(request).mock.calls[0][0].url).toBe(`${BASE}/global/images/${IMAGE.name}`);
  });
  it.each([{}, { name: "vm-image-a" }, { name: "../family/other", id: "111" }])("rejects an unresolvable image identity before Compute mutations", async data => {
    const request: ComputeRequest = vi.fn(async call => call.url.includes("/images/family/") ? { status: 200, data }
      : call.method === "POST" ? { status: 200, data: { name: "created", status: "DONE" } } : instance());
    await expect(clientWith(request).client.create(input)).rejects.toThrow(/image/);
    expect(vi.mocked(request).mock.calls.every(([call]) => call.method === "GET")).toBe(true);
  });
});
