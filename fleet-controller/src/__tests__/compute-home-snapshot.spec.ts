import { describe, expect, it, vi } from "vitest";
import { createGatewayVmClient, type ComputeRequest } from "../lib/compute-vm.js";

const PROJECT = "octogee-test";
const BASE = `https://compute.googleapis.com/compute/v1/projects/${PROJECT}`;
const ZONE = "us-central1-b";
const OWNER = "OwnerA";
const HOME_LABELS = { "octogee-owner-uid": "ownera", "octogee-storage": "customer-home" };
const SNAPSHOT_LABELS = {
  "octogee-owner-uid": "ownera",
  "octogee-storage": "customer-home-snapshot",
  "octogee-owner-binding": "462d70022de6a165416cc82581f6217f40940596",
};
const home = { projectId: PROJECT, zone: ZONE, name: "computer-home", id: "102",
  sizeGb: 10, diskType: "pd-balanced" as const, source: `projects/${PROJECT}/zones/${ZONE}/disks/computer-home` };
const instance = { name: "computer", id: "101", status: "TERMINATED",
  metadata: { items: [{ key: "octogee-owner-uid", value: OWNER }] },
  disks: [{ deviceName: "octogee-home", boot: false, source: `${BASE}/zones/${ZONE}/disks/${home.name}`, autoDelete: false }] };
const snapshotInput = { home, ownerUid: OWNER, instanceName: instance.name, instanceId: instance.id, snapshotName: "home-102-g3" };
const snapshot = { projectId: PROJECT, name: snapshotInput.snapshotName, id: "103",
  sourceDiskId: home.id, sourceDisk: home.source, sizeGb: 10 };
const snapshotResource = { ...snapshot, sourceDisk: `${BASE}/zones/${ZONE}/disks/${home.name}`, status: "READY", snapshotType: "STANDARD", storageLocations: ["us-central1"], labels: SNAPSHOT_LABELS,
  selfLink: `${BASE}/global/snapshots/${snapshot.name}`, diskSizeGb: "10" };
const restoreInput = { snapshot, ownerUid: OWNER, zone: ZONE, diskName: "restored-home-103", minimumSizeGb: 10 };
const disk = { id: home.id, name: home.name, sizeGb: "10", status: "READY", type: "pd-balanced", labels: HOME_LABELS,
  users: [`${BASE}/zones/${ZONE}/instances/${instance.name}`] };
const restored = { ...disk, id: "104", name: restoreInput.diskName, users: [],
  sourceSnapshot: snapshotResource.selfLink, sourceSnapshotId: snapshot.id };

function fixture() {
  const resources: Record<string, unknown> = {
    [`${BASE}/zones/${ZONE}/instances/${instance.name}`]: instance,
    [`${BASE}/zones/${ZONE}/disks/${home.name}`]: disk,
  };
  const request = vi.fn<ComputeRequest>(async ({ method, url }) => {
    if (method === "POST") return { status: 200, data: { name: "storage-op", status: "DONE", targetId: home.id } };
    const resource = resources[url];
    return resource ? { status: 200, data: resource } : { status: 404 };
  });
  const client = createGatewayVmClient({ request, projectId: PROJECT, log: vi.fn(), now: () => 1, wait: async () => {} });
  return { client, request, resources };
}

describe("snapshot an owned stopped home", () => {
  it("creates a standard incremental snapshot and returns only its verified READY receipt", async () => {
    const { client, request, resources } = fixture();

    await expect(client.snapshotStoppedHome(snapshotInput)).resolves.toBeNull();
    const posts = () => request.mock.calls.map(([call]) => call).filter(call => call.method === "POST");
    expect(posts()).toMatchObject([{
      url: expect.stringMatching(/computer-home\/createSnapshot\?requestId=[a-f0-9-]+$/u),
      body: { name: snapshot.name, snapshotType: "STANDARD", storageLocations: ["us-central1"], labels: SNAPSHOT_LABELS },
    }]);
    await expect(client.snapshotStoppedHome(snapshotInput)).resolves.toBeNull();
    expect(posts()[0]).toEqual(posts()[1]);

    resources[snapshotResource.selfLink] = { ...snapshotResource, status: "CREATING" };
    await expect(client.snapshotStoppedHome(snapshotInput)).resolves.toBeNull();
    resources[snapshotResource.selfLink] = snapshotResource;
    await expect(client.snapshotStoppedHome(snapshotInput)).resolves.toEqual(snapshot);
    expect(posts()).toHaveLength(2);
  });

  it("uses a different request ID for a new park of the same physical disk", async () => {
    const { client, request } = fixture();
    await client.snapshotStoppedHome(snapshotInput);
    await client.snapshotStoppedHome({ ...snapshotInput, snapshotName: "home-102-g4" });
    const posts = request.mock.calls.map(([call]) => call).filter(call => call.method === "POST");
    expect(posts[0].url).not.toEqual(posts[1].url);
    expect(posts[1].body).toMatchObject({ name: "home-102-g4" });
  });

  it("waits for a global operation when Compute reports a global snapshot receipt", async () => {
    const { client, request, resources } = fixture();
    const opUrl = `${BASE}/global/operations/snapshot-op`;
    resources[opUrl] = { name: "snapshot-op", status: "DONE" };
    const normalRequest = request.getMockImplementation()!;
    request.mockImplementation(call => call.method === "POST"
      ? Promise.resolve({ status: 200, data: { name: "snapshot-op", status: "PENDING", selfLink: opUrl } })
      : normalRequest(call));

    await expect(client.snapshotStoppedHome(snapshotInput)).resolves.toBeNull();
    expect(request).toHaveBeenCalledWith({ url: opUrl, method: "GET" });
  });

  it.each([
    { status: "RUNNING" }, { status: "SUSPENDED" }, { id: "905" },
    { metadata: { items: [{ key: "octogee-owner-uid", value: "OtherOwner" }] } },
    { disks: [{ ...instance.disks[0], autoDelete: true }] },
    { disks: [{ ...instance.disks[0], source: disk.users[0] }] },
  ])("refuses an unverifiable source instance (%j) without creating a snapshot", async change => {
    const { client, request, resources } = fixture();
    resources[`${BASE}/zones/${ZONE}/instances/${instance.name}`] = { ...instance, ...change };
    await expect(client.snapshotStoppedHome(snapshotInput)).rejects.toThrow();
    expect(request.mock.calls.some(([call]) => call.method === "POST")).toBe(false);
  });

  it.each([{ id: "999" }, { labels: {} }, { users: [...disk.users, "other-instance"] }])(
    "refuses the wrong or multiply attached source disk (%j)", async change => {
      const { client, request, resources } = fixture();
      resources[`${BASE}/zones/${ZONE}/disks/${home.name}`] = { ...disk, ...change };
      await expect(client.snapshotStoppedHome(snapshotInput)).rejects.toThrow();
      expect(request.mock.calls.some(([call]) => call.method === "POST")).toBe(false);
    },
  );

  it.each([{ sourceDiskId: "999" }, { labels: {} }, { status: "FAILED" }, { diskSizeGb: "9" }, { storageLocations: ["us"] }])(
    "preserves and rejects an unusable snapshot at the deterministic name (%j)", async change => {
      const { client, request, resources } = fixture();
      resources[snapshotResource.selfLink] = { ...snapshotResource, ...change };
      await expect(client.snapshotStoppedHome(snapshotInput)).rejects.toThrow();
      expect(request.mock.calls.some(([call]) => call.method !== "GET")).toBe(false);
    },
  );
});

describe("restore the verified home snapshot", () => {
  it("creates a balanced disk, verifies the source snapshot ID, and reuses the exact disk", async () => {
    const { client, request, resources } = fixture();
    resources[snapshotResource.selfLink] = snapshotResource;

    await expect(client.restoreHomeFromSnapshot(restoreInput)).resolves.toBeNull();
    const post = request.mock.calls.find(([call]) => call.method === "POST")?.[0];
    expect(post).toMatchObject({
      url: expect.stringMatching(/\/disks\?requestId=[a-f0-9-]+$/u),
      body: { name: restoreInput.diskName, type: `${BASE}/zones/${ZONE}/diskTypes/pd-balanced`, sourceSnapshot: snapshotResource.selfLink, sizeGb: "10", labels: HOME_LABELS },
    });

    const diskUrl = `${BASE}/zones/${ZONE}/disks/${restoreInput.diskName}`;
    resources[diskUrl] = { ...restored, status: "RESTORING" };
    await expect(client.restoreHomeFromSnapshot(restoreInput)).resolves.toBeNull();
    resources[diskUrl] = restored;
    await expect(client.restoreHomeFromSnapshot(restoreInput)).resolves.toEqual({
      ...home, id: restored.id, name: restoreInput.diskName, source: `projects/${PROJECT}/zones/${ZONE}/disks/${restoreInput.diskName}`,
    });
    expect(request.mock.calls.filter(([call]) => call.method === "POST")).toHaveLength(1);
  });

  it("rejects a create conflict whose resulting target belongs to a different snapshot", async () => {
    const { client, request, resources } = fixture();
    resources[snapshotResource.selfLink] = snapshotResource;
    const normalRequest = request.getMockImplementation()!;
    request.mockImplementation(async call => {
      if (call.method !== "POST") return normalRequest(call);
      resources[`${BASE}/zones/${ZONE}/disks/${restoreInput.diskName}`] = { ...restored, sourceSnapshotId: "999" };
      return { status: 409 };
    });

    await expect(client.restoreHomeFromSnapshot(restoreInput)).rejects.toThrow("Restored home disk identity");
    expect(request.mock.calls.filter(([call]) => call.method !== "GET").map(([call]) => call.method)).toEqual(["POST"]);
  });

  it("rejects a case-distinct owner even though Compute lowercases owner labels", async () => {
    const { client, request, resources } = fixture();
    resources[snapshotResource.selfLink] = snapshotResource;

    await expect(client.restoreHomeFromSnapshot({ ...restoreInput, ownerUid: OWNER.toLowerCase() })).rejects.toThrow();
    expect(request.mock.calls.some(([call]) => call.method !== "GET")).toBe(false);
  });

  it.each([{ id: "999" }, { sourceDiskId: "999" }, { labels: {} }, { selfLink: "projects/other/global/snapshots/home-102-g3" }, { status: "CREATING" }])(
    "does not restore an unverified snapshot (%j)", async change => {
      const { client, request, resources } = fixture();
      resources[snapshotResource.selfLink] = { ...snapshotResource, ...change };
      await expect(client.restoreHomeFromSnapshot(restoreInput)).rejects.toThrow();
      expect(request.mock.calls.some(([call]) => call.method !== "GET")).toBe(false);
    },
  );

  it.each([{ sourceSnapshotId: "999" }, { labels: {} }, { status: "FAILED" }, { users: disk.users }, { sizeGb: "11" }])(
    "preserves and rejects an unrelated disk at the deterministic name (%j)", async change => {
      const { client, request, resources } = fixture();
      resources[snapshotResource.selfLink] = snapshotResource;
      resources[`${BASE}/zones/${ZONE}/disks/${restoreInput.diskName}`] = { ...restored, ...change };
      await expect(client.restoreHomeFromSnapshot(restoreInput)).rejects.toThrow();
      expect(request.mock.calls.some(([call]) => call.method !== "GET")).toBe(false);
    },
  );
});

describe("erase the exact owned home snapshot", () => {
  const recycledName = "home-102-g3-recycled";
  const recycleDirectory = `https://compute.googleapis.com/compute/beta/projects/${PROJECT}/global/recoverableSnapshots`;
  const recycled = { id: "777", name: recycledName, originalResource: snapshotResource };

  it("removes the active snapshot and its recoverable copy, then verifies both are gone", async () => {
    const { client, request, resources } = fixture();
    resources[snapshotResource.selfLink] = snapshotResource;
    let copies = [recycled];
    const original = request.getMockImplementation()!;
    request.mockImplementation(async call => {
      if (call.method === "GET" && call.url.startsWith(`${recycleDirectory}?`)) return { status: 200, data: { items: copies } };
      if (call.method === "DELETE" && call.url.startsWith(`${snapshotResource.selfLink}?`)) delete resources[snapshotResource.selfLink];
      else if (call.method === "DELETE" && call.url.startsWith(`${recycleDirectory}/${recycledName}?`)) copies = [];
      else return original(call);
      return { status: 200, data: { name: "erase-op", status: "DONE" } };
    });

    await expect(client.eraseHomeSnapshot(snapshot, OWNER)).resolves.toBe(false);
    await expect(client.eraseHomeSnapshot(snapshot, OWNER)).resolves.toBe(false);
    await expect(client.eraseHomeSnapshot(snapshot, OWNER)).resolves.toBe(true);
    expect(request.mock.calls.filter(([call]) => call.method === "DELETE")).toHaveLength(2);
  });

  it("refuses a same-name active snapshot with a different numeric identity", async () => {
    const { client, request, resources } = fixture();
    resources[snapshotResource.selfLink] = { ...snapshotResource, id: "900" };
    await expect(client.eraseHomeSnapshot(snapshot, OWNER)).rejects.toThrow(/exact READY snapshot/);
    expect(request.mock.calls.some(([call]) => call.method === "DELETE")).toBe(false);
  });

  it("ignores another original ID and refuses the expected original with wrong owner binding", async () => {
    const { client, request } = fixture();
    const original = request.getMockImplementation()!;
    request.mockImplementation(call => call.url.startsWith(`${recycleDirectory}?`)
      ? Promise.resolve({ status: 200, data: { items: [
        { ...recycled, originalResource: { ...snapshotResource, id: "900" } },
        { ...recycled, originalResource: { ...snapshotResource, labels: {} } },
      ] } })
      : original(call));
    await expect(client.eraseHomeSnapshot(snapshot, OWNER)).rejects.toThrow(/recoverable snapshot identity/);
    expect(request.mock.calls.some(([call]) => call.method === "DELETE")).toBe(false);
  });

  it("fails closed when the recycle-bin listing cannot be verified", async () => {
    const { client, request } = fixture();
    const original = request.getMockImplementation()!;
    request.mockImplementation(call => call.url.startsWith(`${recycleDirectory}?`)
      ? Promise.resolve({ status: 403 }) : original(call));
    await expect(client.eraseHomeSnapshot(snapshot, OWNER)).rejects.toThrow(/HTTP 403/);
    expect(request.mock.calls.some(([call]) => call.method === "DELETE")).toBe(false);
  });
});

describe("verify the exact charged disks before and after archive", () => {
  const bootPath = `projects/${PROJECT}/zones/${ZONE}/disks/owner-boot`;
  const boot = { source: bootPath, id: "105" };
  const bootUrl = `https://compute.googleapis.com/compute/v1/${bootPath}`;

  it("captures boot provenance and refuses to report zero provisioning until both disks disappear", async () => {
    const { client, resources } = fixture();
    resources[`${BASE}/zones/${ZONE}/instances/${instance.name}`] = {
      ...instance, disks: [{ boot: true, autoDelete: true, source: bootUrl }, ...instance.disks],
    };
    resources[bootUrl] = { name: "owner-boot", id: boot.id, users: disk.users };

    await expect(client.readArchiveBootDisk(snapshotInput)).resolves.toEqual(boot);
    await expect(client.archiveDisksAbsent(home, boot)).resolves.toBe(false);
    delete resources[bootUrl];
    await expect(client.archiveDisksAbsent(home, boot)).resolves.toBe(false);
    delete resources[`${BASE}/zones/${ZONE}/disks/${home.name}`];
    await expect(client.archiveDisksAbsent(home, boot)).resolves.toBe(true);
  });

  it("rejects an extra attached disk or reused provider name", async () => {
    const { client, resources } = fixture();
    resources[`${BASE}/zones/${ZONE}/instances/${instance.name}`] = {
      ...instance, disks: [{ boot: true, autoDelete: true, source: bootUrl }, ...instance.disks, { boot: false, autoDelete: false }],
    };
    resources[bootUrl] = { name: "owner-boot", id: "999", users: disk.users };
    await expect(client.readArchiveBootDisk(snapshotInput)).rejects.toThrow(/exactly two disks/);
    await expect(client.archiveDisksAbsent(home, boot)).rejects.toThrow(/replaced/);
  });
});
