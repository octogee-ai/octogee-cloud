import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-git-key-resync-"));
const KEYS_DIR = path.join(TEST_ROOT, "keys");
afterAll(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

vi.mock("../lib/internal-fetch.js", () => ({ internalFetch: vi.fn() }));

const logged = vi.hoisted(() => ({ lines: [] as string[], failures: [] as string[] }));

vi.mock("../lib/config.js", () => ({
  log: (line: string, fields?: { status?: string }) => {
    logged.lines.push(line);
    if (fields?.status === "failed") logged.failures.push(line);
  },
  dlog: () => {},
  GIT_API_URL: "https://gitea.test/api/v1",
  GIT_SSH_HOST: "gitea.test",
  OPENCLAW_DIR: TEST_ROOT,
  CUSTOMERS_DIR: path.join(TEST_ROOT, "customers"),
  CUSTOMER_KEYS_DIR: KEYS_DIR,
  AGENTS_DIR: path.join(TEST_ROOT, "agents"),
}));

const { log } = await import("../lib/config.js");
const { prepareServiceGitKey, generateUserSshKey, readLocalUserPubKey } = await import("../lib/git.js");
const { brokeredGitHost } = await import("../lib/gitea-admin-broker-client.js");
const { internalFetch } = await import("../lib/internal-fetch.js");
const {
  createGitKeyResync,
  GIT_KEY_RESYNC_INTERVAL_MS,
  gitKeyResyncJitterMs,
  settledForGitKeyResync,
  settledInRoster,
  startGitKeyResync,
  startGitKeyResyncForPod,
} = await import("../lib/git-key-resync.js");

const { pendingCloneAppliedFingerprint } = await import("../lib/pending-clone-fingerprint.js");
const { clearLeftoverPreStopMarker, clearPreStopStarted, markPreStopStarted, podPreStopMarker, preStopStarted } = await import("../lib/prestop-marker.js");

const HOLDER = "shared-blue/octogee-gateway-shared-blue-5bc59-p946t";

interface Registration {
  slug: string;
  pubKey: string;
  serviceHolder?: string;
}

function gitHostBehindThePlatform() {
  const keys = new Map<string, string[]>();
  const requests: string[] = [];
  const registrations: Registration[] = [];
  const unlistable = new Set<string>();
  const refusals = new Map<string, string>();
  const pending = new Map<string, string>();
  let holdListing: Promise<void> | null = null;
  vi.mocked(internalFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === "/internal/gitea/user-pubkeys") {
      const slug = url.searchParams.get("slug") ?? "";
      requests.push(`list ${slug}`);
      if (holdListing) await holdListing;
      if (unlistable.has(slug)) return Response.json({ error: "the git host is down" }, { status: 502 });
      return Response.json({ pubKeys: keys.get(slug) ?? [] });
    }
    if (method === "POST" && url.pathname === "/internal/gitea/ensure-user") {
      const body = JSON.parse(String(init?.body)) as Registration;
      requests.push(`register ${body.slug}`);
      registrations.push(body);
      const refusal = refusals.get(body.slug);
      if (refusal !== undefined) return Response.json({ error: "provisioning_refused", reason: refusal }, { status: 422 });
      const waiting = pending.get(body.slug);
      if (waiting !== undefined) return Response.json({ error: "provisioning_pending", reason: waiting }, { status: 503, headers: { "retry-after": "1" } });
      keys.set(body.slug, [...(keys.get(body.slug) ?? []), body.pubKey]);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request ${method} ${url.pathname}`);
  });
  return {
    keys,
    requests,
    registrations,
    unlistable,
    refusals,
    pending,
    holdListings() {
      let release!: () => void;
      holdListing = new Promise<void>((resolve) => { release = resolve; });
      return () => {
        holdListing = null;
        release();
      };
    },
  };
}

function resyncFor(mounted: string[] | (() => string[]), settled: (slug: string) => boolean = () => true, podStopping: () => boolean = () => false) {
  const giveUpUserGitKey = vi.fn(async () => {});
  const pass = createGitKeyResync({
    adapter: { readLocalUserPubKey, giveUpUserGitKey, gitHost: brokeredGitHost, log },
    mountedUsers: typeof mounted === "function" ? mounted : () => mounted,
    settled,
    podStopping,
    log,
  });
  return { pass, giveUpUserGitKey };
}

function serviceHeldKey(slug: string): string {
  const key = prepareServiceGitKey(slug, HOLDER);
  key.registered();
  return key.publicKey;
}

beforeEach(() => {
  vi.mocked(internalFetch).mockReset();
});

afterEach(() => {
  fs.rmSync(KEYS_DIR, { recursive: true, force: true });
  logged.lines.length = 0;
  logged.failures.length = 0;
  vi.useRealTimers();
});

describe("periodic git key resync for mounted users", () => {
  it("registers a key that left the git host again through the put when the pod holds a marker", async () => {
    const host = gitHostBehindThePlatform();
    const publicKey = serviceHeldKey("lin");
    const { pass } = resyncFor(["lin"]);

    await expect(pass()).resolves.toBe("ran");

    expect(host.registrations).toEqual([{ slug: "lin", pubKey: publicKey, serviceHolder: HOLDER }]);
    expect(host.keys.get("lin")).toEqual([publicKey]);
    expect(logged.failures).toEqual([]);
    expect(logged.lines).toContainEqual(expect.stringContaining("lin: the key was missing on the git host and is registered again"));
  });

  it("registers a key that left the git host again directly when the pod holds no marker", async () => {
    const host = gitHostBehindThePlatform();
    const publicKey = generateUserSshKey("lin");
    const { pass } = resyncFor(["lin"]);

    await pass();

    expect(host.registrations).toEqual([{ slug: "lin", pubKey: publicKey }]);
    expect(host.keys.get("lin")).toEqual([publicKey]);
  });

  it("lists the keys once and writes nothing for a user whose key is on the git host", async () => {
    const host = gitHostBehindThePlatform();
    host.keys.set("lin", [serviceHeldKey("lin")]);
    const { pass } = resyncFor(["lin"]);

    await pass();

    expect(host.requests).toEqual(["list lin"]);
    expect(host.registrations).toEqual([]);
  });

  it("leaves a key the account holds under another pod's title alone", async () => {
    const host = gitHostBehindThePlatform();
    const [type, material] = generateUserSshKey("lin").split(" ");
    host.keys.set("lin", [`${type} ${material} registered-by-another-pod`]);
    const { pass } = resyncFor(["lin"]);

    await pass();

    expect(host.requests).toEqual(["list lin"]);
    expect(host.registrations).toEqual([]);
  });

  it("skips a user who is not settled and serving, such as one being quiesced for a move", async () => {
    const host = gitHostBehindThePlatform();
    generateUserSshKey("lin");
    generateUserSshKey("ada");
    const roster = {
      ensureAllowed: new Map([["lin", false], ["ada", true]]),
      desiredFingerprints: new Map([["lin", "fp-1"], ["ada", "fp-1"]]),
      appliedFingerprints: new Map([["lin", "fp-1"], ["ada", "fp-1"]]),
    };
    const { pass } = resyncFor(["lin", "ada"], settledInRoster(roster));

    await pass();

    expect(host.requests).toEqual(["list ada", "register ada", "list ada"]);

    roster.ensureAllowed.set("lin", true);
    await pass();

    expect(host.registrations.map(({ slug }) => slug)).toEqual(["ada", "lin"]);
  });

  it("logs a failed listing with the slug and goes on to the next user", async () => {
    const host = gitHostBehindThePlatform();
    generateUserSshKey("ada");
    generateUserSshKey("lin");
    host.unlistable.add("ada");
    const { pass, giveUpUserGitKey } = resyncFor(["ada", "lin"]);

    await expect(pass()).resolves.toBe("ran");

    expect(logged.failures).toEqual([expect.stringMatching(/ada: .*502/)]);
    expect(host.requests).toEqual(["list ada", "list lin", "register lin", "list lin"]);
    expect(giveUpUserGitKey).not.toHaveBeenCalled();

    host.unlistable.delete("ada");
    await pass();

    expect(host.registrations.map(({ slug }) => slug)).toEqual(["lin", "ada"]);
  });

  it("logs a failed registration with the slug and goes on to the next user", async () => {
    const host = gitHostBehindThePlatform();
    generateUserSshKey("ada");
    generateUserSshKey("lin");
    const fake = vi.mocked(internalFetch).getMockImplementation()!;
    vi.mocked(internalFetch).mockImplementation(async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { slug?: string } : {};
      if (init?.method === "POST" && body.slug === "ada") return Response.json({ error: "the git host refused the key" }, { status: 502 });
      return fake(input, init);
    });
    const { pass } = resyncFor(["ada", "lin"]);

    await pass();

    expect(logged.failures).toEqual([expect.stringMatching(/ada: .*502/)]);
    expect(host.keys.get("lin")).toHaveLength(1);
  });

  it("skips a tick that finds the previous pass still running", async () => {
    const host = gitHostBehindThePlatform();
    host.keys.set("lin", [generateUserSshKey("lin")]);
    const release = host.holdListings();
    const { pass } = resyncFor(["lin"]);

    const first = pass();
    await vi.waitFor(() => expect(host.requests).toEqual(["list lin"]));
    await expect(pass()).resolves.toBe("skipped");
    release();

    await expect(first).resolves.toBe("ran");
    expect(host.requests).toEqual(["list lin"]);
    await expect(pass()).resolves.toBe("ran");
  });

  it("logs a refused registration once per user until the refusal changes", async () => {
    const host = gitHostBehindThePlatform();
    serviceHeldKey("lin");
    host.refusals.set("lin", "GitOwnerFailed");
    const { pass } = resyncFor(["lin"]);

    await pass();
    await pass();
    await pass();

    expect(host.registrations).toHaveLength(3);
    expect(logged.failures).toEqual([expect.stringMatching(/lin: .*GitOwnerFailed/)]);

    host.refusals.set("lin", "ChatUserFailed");
    await pass();
    await pass();

    expect(logged.failures).toEqual([expect.stringMatching(/GitOwnerFailed/), expect.stringMatching(/lin: .*ChatUserFailed/)]);

    host.refusals.delete("lin");
    await pass();
    host.keys.delete("lin");
    host.refusals.set("lin", "ChatUserFailed");
    await pass();

    expect(logged.failures).toHaveLength(3);
  });

  it("registers nothing once the pod's prestop flush has started, which releases every key", async () => {
    const host = gitHostBehindThePlatform();
    generateUserSshKey("ada");
    generateUserSshKey("lin");
    const marker = { file: path.join(TEST_ROOT, "prestop-started"), podId: "pod-a" };
    const { pass } = resyncFor(["ada", "lin"], () => true, () => preStopStarted(marker));
    markPreStopStarted(marker);

    await expect(pass()).resolves.toBe("skipped");

    expect(host.requests).toEqual([]);

    clearPreStopStarted(marker);
    await expect(pass()).resolves.toBe("ran");

    expect(host.registrations.map(({ slug }) => slug)).toEqual(["ada", "lin"]);
  });

  it("ignores a prestop marker another pod wrote, such as one carried in with a home directory", async () => {
    const host = gitHostBehindThePlatform();
    generateUserSshKey("lin");
    const file = path.join(TEST_ROOT, "prestop-carried-in");
    markPreStopStarted({ file, podId: "pod-that-stopped" });
    const { pass } = resyncFor(["lin"], () => true, () => preStopStarted({ file, podId: "pod-a" }));

    await expect(pass()).resolves.toBe("ran");

    expect(host.registrations.map(({ slug }) => slug)).toEqual(["lin"]);
    expect(preStopStarted({ file, podId: "pod-that-stopped" })).toBe(true);
    fs.rmSync(file);
  });

  it("keeps the marker outside the shared temp directory, in the pod's own state directory", () => {
    expect(podPreStopMarker().file).toBe(path.join(TEST_ROOT, "prestop-started"));
    expect(podPreStopMarker().podId).not.toBe("");
  });

  it("stops a running pass before the next user when the pod's prestop flush starts", async () => {
    const host = gitHostBehindThePlatform();
    generateUserSshKey("ada");
    generateUserSshKey("lin");
    const { pass } = resyncFor(["ada", "lin"], () => true, () => host.registrations.length > 0);

    await pass();

    expect(host.registrations.map(({ slug }) => slug)).toEqual(["ada"]);
  });

  it.each([
    ["stops being settled, as when it starts quiescing for a move", serviceHeldKey, (state: { settled: boolean }) => { state.settled = false; }],
    ["is unmounted, with a key the pod registers directly", generateUserSshKey, (state: { mounted: string[] }) => { state.mounted = []; }],
    ["is on a pod whose prestop flush starts", serviceHeldKey, (state: { stopping: boolean }) => { state.stopping = true; }],
  ])("registers nothing for a user who %s between the listing and the registration", async (_case, keyOnDisk, change) => {
    const host = gitHostBehindThePlatform();
    keyOnDisk("lin");
    const state = { settled: true, mounted: ["lin"], stopping: false };
    const release = host.holdListings();
    const { pass } = resyncFor(() => state.mounted, () => state.settled, () => state.stopping);

    const running = pass();
    await vi.waitFor(() => expect(host.requests).toEqual(["list lin"]));
    change(state);
    release();

    await expect(running).resolves.toBe("ran");
    expect(host.requests).toEqual(["list lin"]);
    expect(host.registrations).toEqual([]);
    expect(logged.failures).toEqual([]);
    expect(logged.lines).toContainEqual(expect.stringMatching(/lin: .*since its keys were listed, so its key is not registered/));
  });

  it("stops asking the platform again for a key the service has not registered yet once the user is unmounted during the wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const host = gitHostBehindThePlatform();
    serviceHeldKey("lin");
    host.pending.set("lin", "GitKeyPutNotObserved");
    const state = { mounted: ["lin"] };
    const { pass } = resyncFor(() => state.mounted);

    const running = pass();
    await vi.waitFor(() => expect(host.registrations).toHaveLength(1));
    state.mounted = [];
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(running).resolves.toBe("ran");
    expect(host.registrations).toHaveLength(1);
    expect(logged.failures).toEqual([]);
  });

  it("leaves a key directory whose public key cannot be read as it is, and logs it", async () => {
    const host = gitHostBehindThePlatform();
    generateUserSshKey("lin");
    fs.rmSync(path.join(KEYS_DIR, "lin", "id_ed25519.pub"));
    const { pass, giveUpUserGitKey } = resyncFor(["lin"]);

    await pass();

    expect(host.requests).toEqual([]);
    expect(giveUpUserGitKey).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(KEYS_DIR, "lin", "id_ed25519"))).toBe(true);
    expect(logged.failures).toEqual([expect.stringContaining("lin: no readable public key")]);
  });

  it("logs a failed read of the mounted users and ends the pass", async () => {
    gitHostBehindThePlatform();
    const pass = createGitKeyResync({
      adapter: { readLocalUserPubKey, giveUpUserGitKey: vi.fn(async () => {}), gitHost: brokeredGitHost, log },
      mountedUsers: () => {
        throw new Error("the users directory is unreadable");
      },
      settled: () => true,
      podStopping: () => false,
      log,
    });

    await expect(pass()).resolves.toBe("ran");

    expect(logged.failures).toEqual([expect.stringContaining("the users directory is unreadable")]);
  });
});

describe("the pod's git key resync", () => {
  const podId = "octogee-gateway-shared-blue-5bc59-p946t";
  const roster = () => ({
    ensureAllowed: new Map([["ada", true], ["lin", false]]),
    desiredFingerprints: new Map([["ada", "fp-1"], ["lin", "fp-1"]]),
    appliedFingerprints: new Map([["ada", "fp-1"], ["lin", "fp-1"]]),
  });
  const startForPod = (marker: { file: string; podId: string }) => startGitKeyResyncForPod({
    adapter: { readLocalUserPubKey, giveUpUserGitKey: vi.fn(async () => {}), gitHost: brokeredGitHost, log },
    mountedUsers: () => ["ada", "lin"],
    roster: roster(),
    marker,
  });

  it("resyncs the roster's settled users after the pod's jitter, and stands down once the prestop flush marks its start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    const host = gitHostBehindThePlatform();
    generateUserSshKey("ada");
    generateUserSshKey("lin");
    const marker = { file: path.join(TEST_ROOT, "prestop-of-this-pod"), podId };

    const stop = startForPod(marker);

    expect(host.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(gitKeyResyncJitterMs(podId, GIT_KEY_RESYNC_INTERVAL_MS));
    await vi.waitFor(() => expect(host.registrations.map(({ slug }) => slug)).toEqual(["ada"]));

    markPreStopStarted(marker);
    host.keys.delete("ada");
    await vi.advanceTimersByTimeAsync(GIT_KEY_RESYNC_INTERVAL_MS);

    expect(host.registrations).toHaveLength(1);
    stop();
    clearPreStopStarted(marker);
  });

  it("keeps a marker the prestop flush wrote before the resync started, and resyncs nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    const host = gitHostBehindThePlatform();
    generateUserSshKey("ada");
    const marker = { file: path.join(TEST_ROOT, "prestop-before-the-resync"), podId };
    markPreStopStarted(marker);

    const stop = startForPod(marker);
    await vi.advanceTimersByTimeAsync(GIT_KEY_RESYNC_INTERVAL_MS * 2);

    expect(preStopStarted(marker)).toBe(true);
    expect(host.requests).toEqual([]);
    stop();
    clearPreStopStarted(marker);
  });

  it("treats a marker it cannot read as a pod that is stopping: it resyncs nothing and logs the failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    const host = gitHostBehindThePlatform();
    generateUserSshKey("ada");
    const marker = { file: path.join(TEST_ROOT, "prestop-unreadable"), podId };
    fs.mkdirSync(marker.file);

    const stop = startForPod(marker);
    await vi.advanceTimersByTimeAsync(GIT_KEY_RESYNC_INTERVAL_MS);

    expect(host.requests).toEqual([]);
    expect(logged.failures).toContainEqual(expect.stringContaining("the prestop marker could not be read, so no key is resynced"));
    stop();
    fs.rmSync(marker.file, { recursive: true });
  });
});

describe("a prestop marker left by an earlier container", () => {
  it("is removed when the supervisor process starts", () => {
    const marker = { file: path.join(TEST_ROOT, "prestop-left-behind"), podId: "pod-a" };
    markPreStopStarted(marker);

    clearLeftoverPreStopMarker(marker);

    expect(preStopStarted(marker)).toBe(false);
    expect(logged.failures).toEqual([]);
  });

  it("is logged as a failure when it cannot be removed, and the pod then counts as stopping", () => {
    const marker = { file: path.join(TEST_ROOT, "prestop-not-removable"), podId: "pod-a" };
    fs.mkdirSync(marker.file);

    expect(() => clearLeftoverPreStopMarker(marker)).not.toThrow();

    expect(logged.failures).toEqual([expect.stringContaining("could not be removed, so no key is resynced on this pod")]);
    expect(() => preStopStarted(marker)).toThrow();
    fs.rmSync(marker.file, { recursive: true });
  });
});

describe("settledForGitKeyResync", () => {
  const settled = { ensureAllowed: true, desiredFingerprint: "fp-1", appliedFingerprint: "fp-1" };

  it("accepts a user who is assigned, not quiescing and converged", () => {
    expect(settledForGitKeyResync(settled)).toBe(true);
  });

  it("accepts a mounted user whose only unfinished work is a project checkout", () => {
    expect(settledForGitKeyResync({ ...settled, appliedFingerprint: pendingCloneAppliedFingerprint("fp-1") })).toBe(true);
    expect(settledForGitKeyResync({ ...settled, appliedFingerprint: pendingCloneAppliedFingerprint("fp-0") })).toBe(false);
  });

  it.each([
    ["is quiescing or not assigned here", { ...settled, ensureAllowed: false }],
    ["is not in the desired roster", { ...settled, desiredFingerprint: undefined }],
    ["is still being mounted or re-attached", { ...settled, appliedFingerprint: "fp-0" }],
    ["has no applied state yet", { ...settled, appliedFingerprint: undefined }],
  ])("refuses a user who %s", (_case, state) => {
    expect(settledForGitKeyResync(state)).toBe(false);
  });
});

describe("git key resync schedule", () => {
  it("runs the first pass after the pod's jitter and then every interval", async () => {
    vi.useFakeTimers();
    const pass = vi.fn(async () => "ran" as const);

    const stop = startGitKeyResync(pass, { intervalMs: GIT_KEY_RESYNC_INTERVAL_MS, jitterMs: 90_000 }, log);

    await vi.advanceTimersByTimeAsync(89_999);
    expect(pass).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(pass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(GIT_KEY_RESYNC_INTERVAL_MS);
    expect(pass).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(GIT_KEY_RESYNC_INTERVAL_MS * 2);
    expect(pass).toHaveBeenCalledTimes(2);
  });

  it("logs a pass that rejects at error level and runs the next one", async () => {
    vi.useFakeTimers();
    const pass = vi.fn(async (): Promise<"ran"> => "ran").mockRejectedValueOnce(new Error("the roster could not be read"));

    const stop = startGitKeyResync(pass, { intervalMs: GIT_KEY_RESYNC_INTERVAL_MS, jitterMs: 0 }, log);
    await vi.advanceTimersByTimeAsync(0);

    expect(logged.failures).toEqual([expect.stringContaining("the roster could not be read")]);

    await vi.advanceTimersByTimeAsync(GIT_KEY_RESYNC_INTERVAL_MS);
    expect(pass).toHaveBeenCalledTimes(2);
    expect(logged.failures).toHaveLength(1);
    stop();
  });

  it("stops before the first pass when stopped inside the jitter", async () => {
    vi.useFakeTimers();
    const pass = vi.fn(async () => "ran" as const);

    startGitKeyResync(pass, { intervalMs: GIT_KEY_RESYNC_INTERVAL_MS, jitterMs: 90_000 }, log)();
    await vi.advanceTimersByTimeAsync(GIT_KEY_RESYNC_INTERVAL_MS);

    expect(pass).not.toHaveBeenCalled();
  });

  it("runs every ten minutes, with a jitter that is stable for one pod, inside the interval and different between pods", () => {
    expect(GIT_KEY_RESYNC_INTERVAL_MS).toBe(10 * 60_000);
    const pods = ["octogee-gateway-shared-blue-5bc59-p946t", "octogee-gateway-shared-blue-5bc59-x1y2z", "octogee-gateway-shared-green-7d8e9-f3g4h"];
    const jitters = pods.map((pod) => gitKeyResyncJitterMs(pod, GIT_KEY_RESYNC_INTERVAL_MS));

    expect(gitKeyResyncJitterMs(pods[0], GIT_KEY_RESYNC_INTERVAL_MS)).toBe(jitters[0]);
    for (const jitter of jitters) {
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThan(GIT_KEY_RESYNC_INTERVAL_MS);
    }
    expect(new Set(jitters).size).toBe(pods.length);
  });
});
