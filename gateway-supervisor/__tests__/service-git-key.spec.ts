import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-service-git-key-"));
const KEYS_DIR = path.join(TEST_ROOT, "keys");
afterAll(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

vi.mock("../lib/internal-fetch.js", () => ({ internalFetch: vi.fn(async () => new Response(null, { status: 204 })) }));

vi.mock("../lib/config.js", () => ({
  log: () => {},
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

  it("keeps a key registered for another holder in place until the replacement for this holder is registered", () => {
    const carried = generateUserSshKey("lin");
    recordServiceGitKeyHolder("lin", OTHER_HOLDER);

    const key = prepareServiceGitKey("lin", HOLDER);

    expect(key.publicKey).not.toBe(carried);
    expect(readLocalUserPubKey("lin")).toBe(carried);
    expect(serviceGitKeyHolder("lin")).toBe(OTHER_HOLDER);
    key.registered();
    expect(readLocalUserPubKey("lin")).toBe(key.publicKey);
    expect(serviceGitKeyHolder("lin")).toBe(HOLDER);
    expect(fs.readdirSync(path.join(KEYS_DIR, "lin")).sort()).toEqual(["id_ed25519", "id_ed25519.pub", "service-holder"]);
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

describe("a key registered the legacy way", () => {
  it("is no longer held for the service", async () => {
    const key = prepareServiceGitKey("lin", HOLDER);
    key.registered();

    await brokeredGitHost.registerKey("lin", key.publicKey);

    expect(serviceGitKeyHolder("lin")).toBeNull();
  });
});
