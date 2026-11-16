import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-service-git-key-"));
const KEYS_DIR = path.join(TEST_ROOT, "keys");
afterAll(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

vi.mock("../lib/internal-fetch.js", () => ({ internalFetch: vi.fn(async () => new Response(null, { status: 204 })) }));

const logged = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("../lib/config.js", () => ({
  log: (line: string) => logged.lines.push(line),
  dlog: () => {},
  GIT_API_URL: "https://gitea.test/api/v1",
  GIT_SSH_HOST: "gitea.test",
  OPENCLAW_DIR: TEST_ROOT,
  CUSTOMERS_DIR: path.join(TEST_ROOT, "customers"),
  CUSTOMER_KEYS_DIR: KEYS_DIR,
  AGENTS_DIR: path.join(TEST_ROOT, "agents"),
}));

const { prepareServiceGitKey, generateUserSshKey, readLocalUserPubKey } = await import("../lib/git.js");
const { serviceGitKeyHolder, recordServiceGitKeyHolder } = await import("../lib/service-git-key-holder.js");
const { brokeredGitHost } = await import("../lib/gitea-admin-broker-client.js");
const { internalFetch } = await import("../lib/internal-fetch.js");

const HOLDER = "shared-blue/octogee-gateway-shared-blue-5bc59-p946t";
const OTHER_HOLDER = "isolated-lin/octogee-gateway-isolated-lin-0";

afterEach(() => fs.rmSync(KEYS_DIR, { recursive: true, force: true }));

describe("prepareServiceGitKey", () => {
  it("generates a key for a user without one and records the holder once it is registered", () => {
    const key = prepareServiceGitKey("lin", HOLDER);

    expect(key.publicKey).toMatch(/^ssh-ed25519 /);
    expect(readLocalUserPubKey("lin")).toBe(key.publicKey);
    expect(serviceGitKeyHolder("lin")).toBeNull();
    key.registered();
    expect(serviceGitKeyHolder("lin")).toBe(HOLDER);
    expect(fs.statSync(path.join(KEYS_DIR, "lin", "id_ed25519")).mode & 0o777).toBe(0o600);
  });

  it("registers the key already on disk for this holder again", () => {
    const first = prepareServiceGitKey("lin", HOLDER);
    first.registered();

    expect(prepareServiceGitKey("lin", HOLDER).publicKey).toBe(first.publicKey);
  });

  it("registers a key this pod registered the legacy way, without generating another", () => {
    const legacy = generateUserSshKey("lin");

    const key = prepareServiceGitKey("lin", HOLDER);

    expect(key.publicKey).toBe(legacy);
    key.registered();
    expect(readLocalUserPubKey("lin")).toBe(legacy);
    expect(serviceGitKeyHolder("lin")).toBe(HOLDER);
  });

  it("registers the key on disk under this holder when its marker names another holder", () => {
    const carried = generateUserSshKey("lin");
    recordServiceGitKeyHolder("lin", OTHER_HOLDER);

    const key = prepareServiceGitKey("lin", HOLDER);

    expect(key.publicKey).toBe(carried);
    key.registered();
    expect(serviceGitKeyHolder("lin")).toBe(HOLDER);
  });

  it("fails and keeps the private key when its public half cannot be read", () => {
    generateUserSshKey("lin");
    fs.rmSync(path.join(KEYS_DIR, "lin", "id_ed25519.pub"));

    expect(() => prepareServiceGitKey("lin", HOLDER)).toThrow("public key");
    expect(fs.existsSync(path.join(KEYS_DIR, "lin", "id_ed25519"))).toBe(true);
  });

  it("fails on a marker it cannot read instead of reading it as absent", () => {
    fs.mkdirSync(path.join(KEYS_DIR, "lin", "service-holder"), { recursive: true });

    expect(() => serviceGitKeyHolder("lin")).toThrow();
  });

  it("regenerates a key directory that holds no usable key", () => {
    fs.mkdirSync(path.join(KEYS_DIR, "lin"), { recursive: true });
    fs.writeFileSync(path.join(KEYS_DIR, "lin", "id_ed25519.pub"), "ssh-ed25519 AAAA orphan");

    const key = prepareServiceGitKey("lin", HOLDER);

    expect(key.publicKey).not.toBe("ssh-ed25519 AAAA orphan");
    expect(readLocalUserPubKey("lin")).toBe(key.publicKey);
  });

  it("refuses to prepare a key without a holder", () => {
    expect(() => prepareServiceGitKey("lin", "")).toThrow("needs the holder");
    expect(fs.existsSync(path.join(KEYS_DIR, "lin"))).toBe(false);
  });
});

describe("a legacy registration of a key the service holds", () => {
  const body = () => JSON.parse(String(vi.mocked(internalFetch).mock.calls.at(-1)?.[1]?.body));

  it("asks the platform to register it through the service for this pod and keeps the marker", async () => {
    const key = prepareServiceGitKey("lin", HOLDER);
    key.registered();
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response(null, { status: 204 }));

    await brokeredGitHost.registerKey("lin", key.publicKey);

    expect(body()).toEqual({ slug: "lin", pubKey: key.publicKey, serviceHolder: HOLDER });
    expect(serviceGitKeyHolder("lin")).toBe(HOLDER);
  });

  it("drops the marker when the platform registered the key on the git host instead", async () => {
    const key = prepareServiceGitKey("lin", HOLDER);
    key.registered();
    vi.mocked(internalFetch).mockResolvedValueOnce(Response.json({ registeredOn: "git-host" }));

    await brokeredGitHost.registerKey("lin", key.publicKey);

    expect(serviceGitKeyHolder("lin")).toBeNull();
    expect(logged.lines).toContainEqual(expect.stringContaining("lin: the platform registered the key on the git host"));
  });

  it("keeps the marker and fails when the platform does not register it", async () => {
    const key = prepareServiceGitKey("lin", HOLDER);
    key.registered();
    vi.mocked(internalFetch).mockResolvedValueOnce(Response.json({ error: "provisioning_pending", reason: "GenerationNotObserved" }, { status: 503 }));

    await expect(brokeredGitHost.registerKey("lin", key.publicKey)).rejects.toThrow("503");
    expect(serviceGitKeyHolder("lin")).toBe(HOLDER);
  });

  it("sends no marker for a key the service does not hold", async () => {
    const legacy = generateUserSshKey("lin");
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response(null, { status: 204 }));

    await brokeredGitHost.registerKey("lin", legacy);

    expect(body()).toEqual({ slug: "lin", pubKey: legacy });
  });
});
