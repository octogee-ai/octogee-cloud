import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-user-git-key-"));
const KEYS_DIR = path.join(TEST_ROOT, "keys");
afterAll(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

vi.mock("../lib/config.js", () => ({ CUSTOMER_KEYS_DIR: KEYS_DIR }));

const { giveUpUserGitKey } = await import("../lib/user-git-key.js");
type Releaser = Parameters<typeof giveUpUserGitKey>[1];
type ServiceRelease = Awaited<ReturnType<Releaser["releaseServiceKey"]>>;

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJd1dWZmZXJkYXRhZm9ydGVzdGluZ29ubHkwMDAwMDAw octogee-lin@gateway";
const HOLDER = "shared-blue/octogee-gateway-shared-blue-5bc59-p946t";

function keyOnDisk(slug: string, files: { privateKey?: boolean; publicKey?: string | null; marker?: string } = {}): string {
  const dir = path.join(KEYS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  if (files.privateKey !== false) fs.writeFileSync(path.join(dir, "id_ed25519"), "private");
  if (files.publicKey !== null) fs.writeFileSync(path.join(dir, "id_ed25519.pub"), `${files.publicKey ?? PUBLIC_KEY}\n`);
  if (files.marker) fs.writeFileSync(path.join(dir, "service-holder"), `${files.marker}\n`);
  return dir;
}

function releaser(service: ServiceRelease | Error = "released", host: Error | null = null) {
  const calls: string[] = [];
  const logs: Array<{ line: string; failed: boolean }> = [];
  const releaser: Releaser = {
    releaseServiceKey: async (slug, publicKey) => {
      calls.push(`service:${slug}:${publicKey}`);
      if (service instanceof Error) throw service;
      return service;
    },
    releaseHostKey: async (slug, publicKey) => {
      calls.push(`host:${slug}:${publicKey}`);
      if (host) throw host;
    },
    log: (line, fields) => logs.push({ line, failed: fields?.status === "failed" }),
  };
  return { releaser, calls, logs };
}

afterEach(() => fs.rmSync(KEYS_DIR, { recursive: true, force: true }));

describe("giveUpUserGitKey", () => {
  it("releases the service row, then this pod's own key on the git host, then deletes the key directory", async () => {
    const dir = keyOnDisk("lin", { marker: HOLDER });
    const { releaser: deps, calls } = releaser();

    await expect(giveUpUserGitKey("lin", deps)).resolves.toBe("released");

    expect(calls).toEqual([`service:lin:${PUBLIC_KEY}`, `host:lin:${PUBLIC_KEY}`]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("releases the service row when no marker was ever written for it", async () => {
    const dir = keyOnDisk("lin");
    const { releaser: deps, calls } = releaser();

    await expect(giveUpUserGitKey("lin", deps)).resolves.toBe("released");

    expect(calls).toEqual([`service:lin:${PUBLIC_KEY}`, `host:lin:${PUBLIC_KEY}`]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("releases the service row whatever holder the marker names", async () => {
    keyOnDisk("lin", { marker: "isolated-lin/octogee-gateway-isolated-lin-0" });
    const { releaser: deps, calls } = releaser();

    await giveUpUserGitKey("lin", deps);

    expect(calls).toEqual([`service:lin:${PUBLIC_KEY}`, `host:lin:${PUBLIC_KEY}`]);
  });

  it("releases on the git host alone when the platform does not run the provisioning service", async () => {
    const dir = keyOnDisk("lin", { marker: HOLDER });
    const { releaser: deps, calls, logs } = releaser("not-configured");

    await expect(giveUpUserGitKey("lin", deps)).resolves.toBe("released");

    expect(calls).toEqual([`service:lin:${PUBLIC_KEY}`, `host:lin:${PUBLIC_KEY}`]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(logs.every((entry) => !entry.failed)).toBe(true);
  });

  it("says so when the platform knows no user for the slug, and still releases on the git host", async () => {
    const dir = keyOnDisk("lin");
    const { releaser: deps, calls, logs } = releaser("unknown-user");

    await expect(giveUpUserGitKey("lin", deps)).resolves.toBe("released");

    expect(calls).toEqual([`service:lin:${PUBLIC_KEY}`, `host:lin:${PUBLIC_KEY}`]);
    expect(logs).toContainEqual({ line: expect.stringContaining("the platform has no user for lin"), failed: false });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("fails loudly and keeps the key when the service release fails, after still releasing on the git host", async () => {
    const dir = keyOnDisk("lin", { marker: HOLDER });
    const { releaser: deps, calls, logs } = releaser(new Error("fleet-broker POST /internal/fleet/git-key/release → 502"));

    await expect(giveUpUserGitKey("lin", deps)).rejects.toThrow("502");

    expect(calls).toEqual([`service:lin:${PUBLIC_KEY}`, `host:lin:${PUBLIC_KEY}`]);
    expect(logs).toContainEqual({ line: expect.stringContaining("provisioning service release failed"), failed: true });
    expect(fs.existsSync(path.join(dir, "id_ed25519"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "service-holder"), "utf-8").trim()).toBe(HOLDER);
  });

  it("fails loudly and keeps the key when the git host release fails", async () => {
    const dir = keyOnDisk("lin");
    const { releaser: deps, logs } = releaser("released", new Error("gitea-broker POST /internal/gitea/release-user-key → 502"));

    await expect(giveUpUserGitKey("lin", deps)).rejects.toThrow("release-user-key");

    expect(logs).toContainEqual({ line: expect.stringContaining("git host release failed"), failed: true });
    expect(fs.existsSync(path.join(dir, "id_ed25519"))).toBe(true);
  });

  it("releases nothing for a user without a key directory", async () => {
    const { releaser: deps, calls } = releaser();

    await expect(giveUpUserGitKey("lin", deps)).resolves.toBe("absent");

    expect(calls).toEqual([]);
  });

  it("releases a public key left without its private half", async () => {
    const dir = keyOnDisk("lin", { privateKey: false });
    const { releaser: deps, calls } = releaser();

    await expect(giveUpUserGitKey("lin", deps)).resolves.toBe("released");

    expect(calls).toEqual([`service:lin:${PUBLIC_KEY}`, `host:lin:${PUBLIC_KEY}`]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("deletes a key whose public half cannot be read, and says loudly that its registration was not released", async () => {
    const dir = keyOnDisk("lin", { publicKey: null });
    const { releaser: deps, calls, logs } = releaser();

    await expect(giveUpUserGitKey("lin", deps)).resolves.toBe("unreleasable");

    expect(calls).toEqual([]);
    expect(logs).toContainEqual({ line: expect.stringContaining("public key cannot be read"), failed: true });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses a slug that is not a user name", async () => {
    const { releaser: deps } = releaser();

    await expect(giveUpUserGitKey("../lin", deps)).rejects.toThrow("Invalid SSH key owner");
  });
});
