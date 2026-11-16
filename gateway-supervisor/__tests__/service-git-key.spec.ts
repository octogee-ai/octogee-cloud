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

const { generateServiceGitKey, generateUserSshKey, readLocalUserPubKey } = await import("../lib/git.js");
const { serviceGitKeyHolder } = await import("../lib/service-git-key-holder.js");
const { brokeredGitHost } = await import("../lib/gitea-admin-broker-client.js");

afterEach(() => fs.rmSync(KEYS_DIR, { recursive: true, force: true }));

describe("generateServiceGitKey", () => {
  it("generates a key for a user without one and records this gateway as its holder", () => {
    const publicKey = generateServiceGitKey("lin", "shared-blue");

    expect(publicKey).toMatch(/^ssh-ed25519 /);
    expect(readLocalUserPubKey("lin")).toBe(publicKey);
    expect(serviceGitKeyHolder("lin")).toBe("shared-blue");
    expect(fs.statSync(path.join(KEYS_DIR, "lin", "id_ed25519")).mode & 0o777).toBe(0o600);
  });

  it("keeps the key it generated for this gateway", () => {
    const first = generateServiceGitKey("lin", "shared-blue");

    expect(generateServiceGitKey("lin", "shared-blue")).toBe(first);
  });

  it("replaces a key registered before the service with one generated for this gateway", () => {
    const legacy = generateUserSshKey("lin");

    const publicKey = generateServiceGitKey("lin", "shared-blue");

    expect(publicKey).not.toBe(legacy);
    expect(serviceGitKeyHolder("lin")).toBe("shared-blue");
  });

  it("replaces a key generated for another gateway, as one carried in by a move", () => {
    const carried = generateServiceGitKey("lin", "isolated-lin");

    const publicKey = generateServiceGitKey("lin", "shared-blue");

    expect(publicKey).not.toBe(carried);
    expect(serviceGitKeyHolder("lin")).toBe("shared-blue");
  });

  it("refuses to generate without a gateway id", () => {
    expect(() => generateServiceGitKey("lin", "")).toThrow("needs the gateway id");
    expect(fs.existsSync(path.join(KEYS_DIR, "lin"))).toBe(false);
  });
});

describe("a key registered the legacy way", () => {
  it("is no longer held for the service, so the user's next service mount here registers a fresh key", async () => {
    const registeredThroughService = generateServiceGitKey("lin", "shared-blue");

    await brokeredGitHost.registerKey("lin", registeredThroughService);

    expect(serviceGitKeyHolder("lin")).toBeNull();
    const next = generateServiceGitKey("lin", "shared-blue");
    expect(next).not.toBe(registeredThroughService);
    expect(serviceGitKeyHolder("lin")).toBe("shared-blue");
  });
});
