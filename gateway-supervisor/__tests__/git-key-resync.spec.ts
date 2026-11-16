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
const { clearPreStopStarted, markPreStopStarted, preStopStarted } = await import("../lib/prestop-marker.js");

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

function resyncFor(mounted: string[], settled: (slug: string) => boolean = () => true, podStopping: () => boolean = () => false) {
  const giveUpUserGitKey = vi.fn(async () => {});
  const pass = createGitKeyResync({
    adapter: { readLocalUserPubKey, giveUpUserGitKey, gitHost: brokeredGitHost, log },
    mountedUsers: () => mounted,
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
    generateUserSshKey("mei");
    const roster = {
      ensureAllowed: new Map([["lin", false], ["ada", true], ["mei", true]]),
      desiredFingerprints: new Map([["lin", "fp-1"], ["ada", "fp-1"], ["mei", "fp-1"]]),
      appliedFingerprints: new Map([["lin", "fp-1"], ["ada", "fp-1"], ["mei", "fp-1"]]),
    };
    const { pass } = resyncFor(["lin", "ada", "mei"], settledInRoster(roster, (slug) => slug === "mei"));

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
    const marker = path.join(TEST_ROOT, "prestop-started");
    const { pass } = resyncFor(["ada", "lin"], () => true, () => preStopStarted(marker));
    markPreStopStarted(marker);

    await expect(pass()).resolves.toBe("skipped");

    expect(host.requests).toEqual([]);

    clearPreStopStarted(marker);
    await expect(pass()).resolves.toBe("ran");

    expect(host.registrations.map(({ slug }) => slug)).toEqual(["ada", "lin"]);
  });

  it("stops a running pass before the next user when the pod's prestop flush starts", async () => {
    const host = gitHostBehindThePlatform();
    generateUserSshKey("ada");
    generateUserSshKey("lin");
    const { pass } = resyncFor(["ada", "lin"], () => true, () => host.registrations.length > 0);

    await pass();

    expect(host.registrations.map(({ slug }) => slug)).toEqual(["ada"]);
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
  it("removes a prestop marker left by an earlier container, then resyncs the roster's settled users after the pod's jitter", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    const host = gitHostBehindThePlatform();
    generateUserSshKey("ada");
    generateUserSshKey("lin");
    const marker = path.join(TEST_ROOT, "prestop-left-behind");
    markPreStopStarted(marker);
    const podId = "octogee-gateway-shared-blue-5bc59-p946t";

    const stop = startGitKeyResyncForPod({
      adapter: { readLocalUserPubKey, giveUpUserGitKey: vi.fn(async () => {}), gitHost: brokeredGitHost, log, userMigratingIn: () => false },
      mountedUsers: () => ["ada", "lin"],
      roster: {
        ensureAllowed: new Map([["ada", true], ["lin", false]]),
        desiredFingerprints: new Map([["ada", "fp-1"], ["lin", "fp-1"]]),
        appliedFingerprints: new Map([["ada", "fp-1"], ["lin", "fp-1"]]),
      },
      podId,
      prestopMarker: marker,
    });

    expect(preStopStarted(marker)).toBe(false);
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
});

describe("settledForGitKeyResync", () => {
  const settled = { ensureAllowed: true, desiredFingerprint: "fp-1", appliedFingerprint: "fp-1", migratingIn: false };

  it("accepts a user who is assigned, not quiescing, converged and not arriving in a move", () => {
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
    ["is arriving in a move", { ...settled, migratingIn: true }],
  ])("refuses a user who %s", (_case, state) => {
    expect(settledForGitKeyResync(state)).toBe(false);
  });
});

describe("git key resync schedule", () => {
  it("runs the first pass after the pod's jitter and then every interval", async () => {
    vi.useFakeTimers();
    const pass = vi.fn(async () => "ran" as const);

    const stop = startGitKeyResync(pass, { intervalMs: GIT_KEY_RESYNC_INTERVAL_MS, jitterMs: 90_000 });

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

  it("stops before the first pass when stopped inside the jitter", async () => {
    vi.useFakeTimers();
    const pass = vi.fn(async () => "ran" as const);

    startGitKeyResync(pass, { intervalMs: GIT_KEY_RESYNC_INTERVAL_MS, jitterMs: 90_000 })();
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
