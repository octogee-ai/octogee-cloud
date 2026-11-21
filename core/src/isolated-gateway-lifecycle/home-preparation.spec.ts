import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore, FIXTURE_SIZING_PROFILES } from "@octogee/core-testing/journal-store";
import { assertFleetControllerOwnsPlacementAutomation } from "../placement-automation-owner.js";
import {
  HomeComputeUnavailableError,
  HomeCopyFailure,
  assertHomePreparationAuthority,
  homePreparationReady,
  prepareIsolatedHome,
  requireStoredHomeReadiness,
  type AllocateIsolatedGatewayInput,
  type HomePreparationRequest,
  type PlacementOwnerFence,
  type UserHomeLocation,
} from "./index.js";

type Tier = "hobby" | "pro" | "team";
type Doc = Record<string, any>;

const inProcessOwner: PlacementOwnerFence = async (transaction) => { await assertFleetControllerOwnsPlacementAutomation(transaction); };

function fixture(tier: Tier = "pro", sizingProfiles?: Record<string, unknown>) {
  const request: HomePreparationRequest = { uid: "uid-alice", leaseId: "lease", generation: 2, sourceGatewayId: "shared-1", sourceAssignmentEpoch: 4, sizingKey: tier, sizingTier: tier === "hobby" ? "s" : tier === "pro" ? "m" : "l" };
  const source: UserHomeLocation = { runtime: "gce-vm", layout: "portable", disk: { projectId: "octogee-test", zone: "us-central1-a", name: "old-home", source: "projects/octogee-test/zones/us-central1-a/disks/old-home", id: "100", sizeGb: 100, diskType: "pd-balanced" } };
  const documents: Record<string, Doc> = { "users/uid-alice": { username: "alice", builderSubscription: { tier, status: "active" }, provisioning: {
    openclaw: { gatewayId: "shared-1", slug: "alice", activationLease: { ...request, builderSlug: "alice", entitlementTier: tier, status: "requested" } },
  } } };
  if (sizingProfiles) documents["config/orchestrator"] = { sizingProfiles };
  const docs = new Map<string, Doc>(Object.entries(documents));
  const store = createDocumentFixtureStore(docs);
  const owner = () => docs.get("users/uid-alice")!;
  const target = { ...source.disk, name: "new-home", id: "200", sizeGb: 50, source: "projects/octogee-test/zones/us-central1-a/disks/new-home" };
  const home = {
    environment: "test", subnetwork: "subnet", nativeZones: ["us-central1-b"] as readonly string[],
    nativeZone: vi.fn(async (): Promise<string | null> => null),
    inventory: vi.fn(async (): Promise<UserHomeLocation | null> => owner().provisioning.homeStorage ?? source),
    verifyStopped: vi.fn(async () => {}),
    copy: {
      advance: vi.fn(async () => ({ progress: { status: "ready" as const, filesystem: "btrfs" as const, usedBytes: 1024, proof: { "volumes/data": "a".repeat(64), "desktop-home": "b".repeat(64) } }, target })),
      release: vi.fn(async () => true),
      abort: vi.fn(async () => true),
    },
    adopt: vi.fn(async () => true),
    removeStoppedHome: vi.fn(async () => true),
  };
  let now = 1000;
  const deps = {
    store,
    readSizingKey: async () => owner().builderSubscription.tier as string,
    requireOwner: inProcessOwner,
    now: () => now,
    log: vi.fn(),
    home,
  };
  return {
    owner, source, target, request, deps, home,
    setNow: (value: number) => { now = value; },
    user: async () => (await store.users.records.get("uid-alice"))!,
    prepare: (mode: "apply" | "plan" = "apply") => prepareIsolatedHome(deps, request, mode),
    reconcile: async () => homePreparationReady(await prepareIsolatedHome(deps, request)),
  };
}

function computeCalls(home: ReturnType<typeof fixture>["home"]): number {
  return [home.nativeZone, home.inventory, home.verifyStopped, home.copy.advance, home.copy.release, home.copy.abort, home.adopt, home.removeStoppedHome]
    .reduce((total, call) => total + call.mock.calls.length, 0);
}

function allocationFence(h: ReturnType<typeof fixture>, user: Awaited<ReturnType<ReturnType<typeof fixture>["user"]>>, request: Partial<HomePreparationRequest> = {}) {
  return () => requireStoredHomeReadiness({
    user,
    request: { ...h.request, builderSlug: "alice", ...request } as AllocateIsolatedGatewayInput,
    sizingProfile: FIXTURE_SIZING_PROFILES[request.sizingKey ?? h.request.sizingKey] ?? null,
  });
}

describe("isolated home preparation, as the in-process caller runs it", () => {
  function archivedHome() {
    const h = fixture("hobby");
    const home = h.owner().provisioning;
    home.homeDisk = { ...h.source.disk, sizeGb: 10 };
    home.homeMigration = { phase: "complete", preparedFor: { leaseId: "previous", generation: 1, sizingKey: "hobby" } };
    home.homeArchive = {
      phase: "archived", operationId: "park-1", gatewayId: "isolated-1", instanceId: "123",
      bootDisk: { source: "projects/octogee-test/zones/us-central1-a/disks/old-boot", id: "99" },
      snapshot: { id: "321", name: "parked-home", projectId: "octogee-test", sourceDiskId: "100", sourceDisk: h.source.disk.source, sizeGb: 10 },
    };
    return h;
  }

  it("prepares a fresh lease from the archived home without querying the deleted disk", async () => {
    const h = archivedHome();
    await expect(h.prepare("plan")).resolves.toMatchObject({ state: "ready" });
    expect(h.owner().provisioning.homeMigration.preparedFor.generation).toBe(1);
    await expect(h.prepare()).resolves.toEqual({ state: "ready" });
    expect(allocationFence(h, await h.user())).not.toThrow();
    expect(h.owner().provisioning.homeArchive.phase).toBe("archived");
    expect(computeCalls(h.home)).toBe(0);
  });

  it.each(["preparing", "snapshot-ready", "restoring", "wrong-source"])("refuses %s archive preparation before accessing Compute", async reason => {
    const h = archivedHome();
    const archive = h.owner().provisioning.homeArchive;
    if (reason === "wrong-source") archive.snapshot.sourceDiskId = "999";
    else archive.phase = reason;
    await expect(h.prepare()).rejects.toThrow(/archive/i);
    expect(h.owner().provisioning.homeMigration.preparedFor.generation).toBe(1);
    expect(computeCalls(h.home)).toBe(0);
  });

  it("prepares a Hobby user's retained home at the Hobby allowance, like any VM tier", async () => {
    const h = fixture("hobby");
    await h.reconcile();
    expect(h.home.inventory).toHaveBeenCalled();
    expect(h.home.copy.advance).toHaveBeenCalledWith(expect.objectContaining({ desiredGiB: 10 }));
  });

  it("copies a home outside the native zones into an allowed native zone before adopting it", async () => {
    const h = fixture();
    await h.reconcile();
    expect(h.owner().provisioning.homeMigration.copy.operationId).toMatch(/^home-copy-test-[a-f0-9]{24}$/);
    expect(h.home.copy.advance).toHaveBeenCalledWith(expect.objectContaining({ targetZone: "us-central1-b" }));
  });

  it("uses the verified retained VM's zone when a user upgrades again", async () => {
    const h = fixture();
    h.home.nativeZone.mockResolvedValue("us-central1-f");
    await h.reconcile();
    expect(h.home.copy.advance).toHaveBeenCalledWith(expect.objectContaining({ targetZone: "us-central1-f" }));
  });

  it("does not activate a smaller home until verification and helper detachment complete", async () => {
    const h = fixture();
    expect(await h.reconcile()).toBe(false);
    expect(h.home.adopt).not.toHaveBeenCalled();
    expect(h.owner().provisioning.homeMigration.phase).toBe("releasing");
    h.home.copy.release.mockResolvedValueOnce(false);
    expect(await h.reconcile()).toBe(false);
    expect(h.home.adopt).not.toHaveBeenCalled();
    expect(await h.reconcile()).toBe(false);
    expect(await h.reconcile()).toBe(true);
    expect(h.owner().provisioning.homeCapacity).toMatchObject({ desiredGiB: 50, allocatedGiB: 50, status: "ready" });
    expect(h.owner().provisioning.homeStorage.retained).toEqual([h.source]);
    expect(h.owner().provisioning.homeDisk).toEqual(h.target);
    expect(h.home.copy.advance).toHaveBeenCalledTimes(1);
    expect(await h.reconcile()).toBe(true);
    expect(h.home.adopt).toHaveBeenCalledTimes(1);
  });

  it("keeps the larger home on a cheaper native tier when usage is over the new limit", async () => {
    const h = fixture("pro");
    h.home.copy.advance.mockResolvedValue({ progress: { status: "copying", usedBytes: 60 * 1024 ** 3 } } as never);
    expect(await h.reconcile()).toBe(false);
    expect(h.owner().provisioning.homeMigration.phase).toBe("retaining");
    expect(await h.reconcile()).toBe(true);
    expect(h.owner().provisioning.homeCapacity).toMatchObject({ desiredGiB: 50, allocatedGiB: 100, status: "shrink-pending" });
    expect(h.home.adopt).not.toHaveBeenCalled();
    expect(h.home.copy.abort).toHaveBeenCalled();
  });

  it("retains source and retries adoption after a failure", async () => {
    const h = fixture();
    await h.reconcile(); await h.reconcile();
    h.home.adopt.mockRejectedValueOnce(new Error("Kubernetes unavailable"));
    await expect(h.reconcile()).rejects.toThrow(/Kubernetes/);
    expect(h.owner().provisioning.homeStorage).toBeUndefined();
    expect(h.owner().provisioning.homeMigration.source.disk.id).toBe("100");
    expect(await h.reconcile()).toBe(true);
  });

  it("does not copy or adopt an active source, a changed entitlement, or a changed activation lease", async () => {
    const h = fixture();
    h.home.verifyStopped.mockRejectedValue(new Error("source running"));
    await expect(h.reconcile()).rejects.toThrow(/running/);
    expect(h.home.copy.advance).not.toHaveBeenCalled();
    expect(h.owner().provisioning.homeMigration).toBeUndefined();
    const user = await h.user();
    expect(() => assertHomePreparationAuthority(user, "team", h.request)).toThrow(/authority/);
    expect(() => assertHomePreparationAuthority(user, "pro", { ...h.request, generation: 3 })).toThrow(/authority/);
  });

  it("refuses to prepare a VM home when the user's tier runs the isolated gateway as a pod", async () => {
    const h = fixture("pro", { pro: { isolation: "isolated", sizingTier: "m", fallbackStorageGb: null, computer: { runtime: "cluster", homeSizeGiB: 50 } } });
    await expect(h.reconcile()).rejects.toThrow("home migration requires a VM tier policy");
    expect(computeCalls(h.home)).toBe(0);
    expect(h.owner().provisioning.homeMigration).toBeUndefined();
  });

  it("refuses to migrate once the user's tier no longer matches the activation lease", async () => {
    const h = fixture();
    h.owner().builderSubscription.tier = "team";
    await expect(h.reconcile()).rejects.toThrow(/authority/);
    expect(h.home.inventory).not.toHaveBeenCalled();
    expect(h.owner().provisioning.homeMigration).toBeUndefined();
  });

  it("retains rollback homes until successful admission and the grace period have elapsed", async () => {
    const h = fixture();
    await h.reconcile(); await h.reconcile(); await h.reconcile(); await h.reconcile();
    expect(h.home.removeStoppedHome).not.toHaveBeenCalled();
    h.owner().provisioning.homeStorage.admittedAt = 1000;
    h.setNow(1000 + 7 * 24 * 60 * 60_000);
    expect(await h.reconcile()).toBe(true);
    expect(h.home.removeStoppedHome).toHaveBeenCalledWith(h.request.uid, h.source);
    expect(h.owner().provisioning.homeStorage.retained).toEqual([]);
  });

  it("cleans a failed worker before retrying and never adopts its unverified target", async () => {
    const h = fixture();
    h.home.copy.advance.mockRejectedValueOnce(new HomeCopyFailure("disk copy interrupted"));
    expect(await h.reconcile()).toBe(false);
    expect(h.owner().provisioning.homeMigration.phase).toBe("failed");
    h.home.copy.abort.mockResolvedValueOnce(false);
    expect(await h.reconcile()).toBe(false);
    expect(h.home.adopt).not.toHaveBeenCalled();
    expect(await h.reconcile()).toBe(false);
    expect(h.owner().provisioning.homeMigration.phase).toBe("retrying");
    h.setNow(70_000);
    expect(await h.reconcile()).toBe(false);
    expect(h.owner().provisioning.homeMigration.phase).toBe("releasing");
    expect(h.owner().provisioning.homeMigration.attempt).toBe(2);
    expect(h.home.copy.advance).toHaveBeenCalledTimes(2);
  });

  it("blocks after three failed copy attempts while preserving the original home", async () => {
    const h = fixture();
    let now = 1000;
    h.setNow(now);
    h.home.copy.advance.mockRejectedValue(new HomeCopyFailure("copy failed"));
    await h.reconcile();
    for (const attempt of [1, 2, 3]) {
      expect(h.owner().provisioning.homeMigration.attempt).toBe(attempt);
      expect(await h.reconcile()).toBe(false);
      if (attempt < 3) {
        expect(h.owner().provisioning.homeMigration.phase).toBe("retrying");
        expect(await h.reconcile()).toBe(false);
        now += 60_000;
        h.setNow(now);
        expect(await h.reconcile()).toBe(false);
      }
    }
    expect(h.owner().provisioning.homeMigration.phase).toBe("blocked");
    await expect(h.reconcile()).rejects.toThrow(/three failed copies/);
    await expect(h.prepare()).resolves.toEqual({ state: "blocked", reason: expect.stringContaining("three failed copies"), attempts: 3 });
    expect(h.owner().provisioning.homeMigration.source).toEqual(h.source);
    expect(h.home.copy.advance).toHaveBeenCalledTimes(3);
    expect(h.home.adopt).not.toHaveBeenCalled();
  });

  it.each(["filesystem", "claim"])("refuses to adopt a retired cluster home copy identified by its %s", async (legacy) => {
    const h = fixture();
    const target = legacy === "claim" ? { ...h.target, claim: { name: "home-copy-old-home", uid: "claim-1", volumeName: "pvc-1" } } : h.target;
    const copy = { operationId: "home-copy-test-old", ownerUid: "uid-alice", source: h.source.disk, sourceLayout: "portable", targetZone: "us-central1-a", desiredGiB: 10, subnetwork: "subnet", ...(legacy === "filesystem" ? { targetFilesystem: "ext4" } : {}) };
    h.owner().provisioning.homeMigration = { id: "home-copy-test-old", tier: "pro", source: h.source, copy, phase: "adopting", target,
      proof: { status: "ready", usedBytes: 1024, filesystem: legacy === "filesystem" ? "ext4" : "btrfs", proof: {} }, startedAt: 1 };
    await expect(h.reconcile()).rejects.toThrow(/retired cluster home records need operator cleanup/);
    expect(h.home.adopt).not.toHaveBeenCalled();
    expect(h.owner().provisioning.homeDisk).toBeUndefined();
  });
});

describe("isolated home preparation readiness record", () => {
  const preparedFor = { leaseId: "lease", generation: 2, sizingKey: "pro" };

  it("records the lease it prepared for when the home is adopted, and allocation then passes the stored fence", async () => {
    const h = fixture();
    expect(allocationFence(h, await h.user())).toThrow(/not prepared/);
    for (let call = 0; call < 3; call += 1) await h.prepare();
    await expect(h.prepare()).resolves.toEqual({ state: "ready" });
    expect(h.owner().provisioning.homeMigration).toMatchObject({ phase: "complete", preparedFor });
    expect(allocationFence(h, await h.user())).not.toThrow();
  });

  it("records the lease when the larger home is retained", async () => {
    const h = fixture();
    h.home.copy.advance.mockResolvedValue({ progress: { status: "copying", usedBytes: 60 * 1024 ** 3 } } as never);
    await h.prepare();
    await expect(h.prepare()).resolves.toEqual({ state: "ready" });
    expect(h.owner().provisioning.homeMigration).toMatchObject({ phase: "complete", preparedFor });
  });

  it("records a completed preparation and nothing else when no migration is needed", async () => {
    const h = fixture();
    h.home.inventory.mockResolvedValue(null);

    await expect(h.prepare()).resolves.toEqual({ state: "ready" });

    expect(h.owner().provisioning.homeMigration).toEqual({ phase: "complete", preparedFor });
    expect(h.home.copy.advance).not.toHaveBeenCalled();
  });

  it("reads back its own record, with no source disk, without starting a migration", async () => {
    const h = fixture();
    h.home.inventory.mockResolvedValue(null);
    h.owner().provisioning.homeMigration = { phase: "complete", preparedFor };

    expect(await h.reconcile()).toBe(true);
    await expect(h.prepare()).resolves.toEqual({ state: "ready" });

    expect(h.owner().provisioning.homeMigration).toEqual({ phase: "complete", preparedFor });
    expect(h.home.verifyStopped).not.toHaveBeenCalled();
    expect(h.home.copy.advance).not.toHaveBeenCalled();
  });

  it("reads back its own record over a home that already fits, without starting a migration", async () => {
    const h = fixture();
    h.home.inventory.mockResolvedValue({ ...h.source, disk: { ...h.source.disk, sizeGb: 50 } });
    h.owner().provisioning.homeMigration = { phase: "complete", preparedFor: { ...preparedFor, generation: 1 } };

    expect(await h.reconcile()).toBe(true);

    expect(h.owner().provisioning.homeMigration).toEqual({ phase: "complete", preparedFor });
    expect(h.home.copy.advance).not.toHaveBeenCalled();
  });

  it("does not count a record written before the handover, which names no lease, until prepare runs for the lease", async () => {
    const h = fixture();
    h.home.inventory.mockResolvedValue({ ...h.source, disk: { ...h.source.disk, sizeGb: 50 } });
    h.owner().provisioning.homeMigration = { id: "home-copy-test-earlier", tier: "pro", source: h.source, phase: "complete", startedAt: 1, completedAt: 2,
      copy: { operationId: "home-copy-test-earlier", ownerUid: "uid-alice", source: h.source.disk, sourceLayout: "portable", targetZone: "us-central1-b", desiredGiB: 50, subnetwork: "subnet" } };

    expect(allocationFence(h, await h.user())).toThrow(/not prepared/);
    await expect(h.prepare()).resolves.toEqual({ state: "ready" });

    expect(h.owner().provisioning.homeMigration).toMatchObject({ id: "home-copy-test-earlier", phase: "complete", preparedFor });
    expect(allocationFence(h, await h.user())).not.toThrow();
  });

  it("never lets a record for an older lease, generation or sizing key satisfy the fence", async () => {
    const h = fixture();
    h.home.inventory.mockResolvedValue(null);
    await h.prepare();
    const user = await h.user();

    expect(allocationFence(h, user, { leaseId: "lease-next" })).toThrow(/not prepared/);
    expect(allocationFence(h, user, { generation: 3 })).toThrow(/not prepared/);
    expect(allocationFence(h, user, { sizingKey: "team", sizingTier: "l" })).toThrow(/not prepared/);
  });

  it("supersedes the record when the sizing key changes and prepare runs for the new key", async () => {
    const h = fixture();
    h.home.inventory.mockResolvedValue(null);
    await h.prepare();
    h.owner().builderSubscription.tier = "team";
    const lease = h.owner().provisioning.openclaw.activationLease;
    Object.assign(lease, { entitlementTier: "team", sizingTier: "l", sizingKey: "team" });

    await expect(prepareIsolatedHome(h.deps, { ...h.request, sizingKey: "team", sizingTier: "l" })).resolves.toEqual({ state: "ready" });

    expect(h.owner().provisioning.homeMigration).toEqual({ phase: "complete", preparedFor: { ...preparedFor, sizingKey: "team" } });
  });

  it("clears the record when a new migration starts", async () => {
    const h = fixture();
    h.owner().provisioning.homeMigration = { phase: "complete", preparedFor: { ...preparedFor, generation: 1 } };

    await h.prepare();

    expect(h.owner().provisioning.homeMigration.preparedFor).toBeUndefined();
    expect(h.owner().provisioning.homeMigration.phase).toBe("releasing");
  });
});

describe("isolated home preparation, as the Admin API runs it", () => {
  it("plans from the stored state without any Compute Engine call or write", async () => {
    const h = fixture();
    const before = structuredClone(h.owner());

    await expect(h.prepare("plan")).resolves.toEqual({ state: "in-progress", step: "start" });

    expect(computeCalls(h.home)).toBe(0);
    expect(h.owner()).toEqual(before);
  });

  it("answers in-progress with the step and the error code when Compute Engine is unavailable, and repeats the step next time", async () => {
    const h = fixture();
    await h.prepare();
    expect(h.owner().provisioning.homeMigration.phase).toBe("releasing");
    h.home.copy.release.mockRejectedValueOnce(new HomeComputeUnavailableError("http-503", "remove-home-copy-helper: HTTP 503"));

    await expect(h.prepare()).resolves.toEqual({ state: "in-progress", step: "releasing", lastError: { code: "http-503" } });
    expect(h.owner().provisioning.homeMigration.phase).toBe("releasing");

    await expect(h.prepare()).resolves.toEqual({ state: "in-progress", step: "adopting" });
    expect(h.home.copy.release).toHaveBeenCalledTimes(2);
  });

  it("reports the stored step when Compute Engine is unavailable before the step runs", async () => {
    const h = fixture();
    await h.prepare();
    h.home.inventory.mockRejectedValueOnce(new HomeComputeUnavailableError("http-503", "inventory: HTTP 503"));

    await expect(h.prepare()).resolves.toEqual({ state: "in-progress", step: "releasing", lastError: { code: "http-503" } });
  });

  it("refuses an unfinished migration whose user has no home disk instead of answering ready", async () => {
    const h = fixture();
    await h.prepare();
    const before = structuredClone(h.owner().provisioning.homeMigration);
    h.home.inventory.mockResolvedValue(null);

    await expect(h.prepare()).rejects.toThrow(`home migration ${before.id} is releasing but uid-alice has no home disk`);
    expect(h.owner().provisioning.homeMigration).toEqual(before);
  });

  it("answers a repeat of a committed preparation ready after the lease moved on, without Compute Engine", async () => {
    const h = fixture();
    h.home.inventory.mockResolvedValue(null);
    await expect(h.prepare()).resolves.toEqual({ state: "ready" });
    Object.assign(h.owner().provisioning.openclaw.activationLease, { status: "provisioning", targetGatewayId: "alice-m-12345678" });
    h.home.inventory.mockRejectedValue(new HomeComputeUnavailableError("http-503", "inventory: HTTP 503"));
    const calls = computeCalls(h.home);

    await expect(h.prepare()).resolves.toEqual({ state: "ready" });

    expect(computeCalls(h.home)).toBe(calls);
    expect(h.owner().provisioning.homeMigration).toEqual({ phase: "complete", preparedFor: { leaseId: "lease", generation: 2, sizingKey: "pro" } });
  });

  it("still refuses a moved lease the stored preparation does not name", async () => {
    const h = fixture();
    h.home.inventory.mockResolvedValue(null);
    await h.prepare();
    Object.assign(h.owner().provisioning.openclaw.activationLease, { status: "provisioning", targetGatewayId: "alice-m-12345678", generation: 3 });

    await expect(prepareIsolatedHome(h.deps, { ...h.request, generation: 3 })).rejects.toThrow("home migration activation authority changed");
  });

  it("refuses an unknown sizing key as an authority change before reading its profile", async () => {
    const h = fixture();

    await expect(prepareIsolatedHome(h.deps, { ...h.request, sizingKey: "unknown" })).rejects.toThrow("home migration activation authority changed");
    expect(computeCalls(h.home)).toBe(0);
  });

  it("lets an error that leaves the state unknown through", async () => {
    const h = fixture();
    h.home.copy.advance.mockRejectedValueOnce(new Error("home copy target identity/capacity differs"));
    await expect(h.prepare()).rejects.toThrow("home copy target identity/capacity differs");
  });

  it("refuses before any Compute Engine call once the client owns placement", async () => {
    const h = fixture();
    const refusal = new Error("placement automation belongs to the client");

    await expect(prepareIsolatedHome({ ...h.deps, requireOwner: async () => { throw refusal; } }, h.request)).rejects.toBe(refusal);
    await expect(prepareIsolatedHome({ ...h.deps, requireOwner: async () => { throw refusal; } }, h.request, "plan")).rejects.toBe(refusal);

    expect(computeCalls(h.home)).toBe(0);
    expect(h.owner().provisioning.homeMigration).toBeUndefined();
  });

  it("checks the owner again before each Compute Engine effect", async () => {
    const h = fixture();
    let checks = 0;
    const refusal = new Error("owner changed");
    const requireOwner: PlacementOwnerFence = async () => {
      checks += 1;
      if (checks > 3) throw refusal;
    };

    await expect(prepareIsolatedHome({ ...h.deps, requireOwner }, h.request)).rejects.toBe(refusal);

    expect(h.home.inventory).toHaveBeenCalledTimes(1);
    expect(h.home.verifyStopped).not.toHaveBeenCalled();
    expect(h.owner().provisioning.homeMigration).toBeUndefined();
  });
});
