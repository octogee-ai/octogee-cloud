import { describe, expect, it, vi } from "vitest";
import {
  createPreStopGiteaKeyRelease,
  createPreStopSessionQuiesce,
  createPreStopSystemConfigFlush,
  PRESTOP_SESSION_QUIESCE_TIMEOUT_MS,
  resolvePreStopFlushConfig,
} from "../entrypoints/prestop-flush.js";
import { withUserClaim } from "./helpers/user-claim.js";

describe("prestop-flush entrypoint config", () => {
  it("normalizes the local gateway id to default", () => {
    expect(resolvePreStopFlushConfig(
      withUserClaim({}, "alice"),
      { gatewayClass: "standard", gatewayId: "local" },
    )).toEqual({
      gatewayId: "default",
      gatewayClass: "standard",
      builderSlug: "alice",
    });
  });

  it("keeps dedicated gateway ids and leaves the user slug empty when the pod is shared", () => {
    expect(resolvePreStopFlushConfig(
      {},
      { gatewayClass: "dedicated", gatewayId: "gw-alice" },
    )).toEqual({
      gatewayId: "gw-alice",
      gatewayClass: "dedicated",
      builderSlug: "",
    });
  });

  it("requires an accepted durable system config checkpoint", async () => {
    const sync = vi.fn(() => ({
      committed: true,
      pushed: false,
      pending: true,
      errorCode: "push-failed",
    }));
    const flush = createPreStopSystemConfigFlush("alice", () => {}, sync);

    await expect(flush?.()).rejects.toThrow("push-failed");
    expect(sync).toHaveBeenCalledWith("alice", expect.objectContaining({
      durablePolicy: true,
      source: "auto-watch",
    }));
  });

  it("reports the dedicated user's accepted system config commit", async () => {
    const acceptedCommit = "a".repeat(40);
    const sync = vi.fn(() => ({
      committed: true,
      pushed: true,
      pending: false,
      acceptedCommit,
    }));
    const flush = createPreStopSystemConfigFlush("alice", () => {}, sync);

    await expect(flush?.()).resolves.toEqual({ acceptedCommit });
  });

  it("skips system config on shared gateways", () => {
    const sync = vi.fn();

    expect(createPreStopSystemConfigFlush("", () => {}, sync)).toBeUndefined();
    expect(sync).not.toHaveBeenCalled();
  });

  it("quiesces only the dedicated user before its preStop checkpoint", async () => {
    const quiesce = vi.fn(async () => ({ drained: true, runningCount: 0 }));
    const run = createPreStopSessionQuiesce("alice", {
      listUserSlugs: () => ["alice", "bob"],
      quiesce,
    });

    await run();

    expect(quiesce).toHaveBeenCalledTimes(1);
    expect(quiesce).toHaveBeenCalledWith("alice", expect.objectContaining({
      timeoutMs: PRESTOP_SESSION_QUIESCE_TIMEOUT_MS,
    }));
  });

  it("attempts every shared user and fails loud after bounded quiescence", async () => {
    const quiesce = vi.fn(async (slug: string) => slug === "alice"
      ? { drained: false, runningCount: 2 }
      : { drained: true, runningCount: 0 });
    const run = createPreStopSessionQuiesce("", {
      listUserSlugs: () => ["alice", "bob"],
      quiesce,
    });

    await expect(run()).rejects.toThrow(/alice.*2 session/u);
    expect(quiesce).toHaveBeenCalledTimes(2);
  });

  it("builds exact-key cleanup for a retiring tenant-bound pod", async () => {
    const releaseKey = vi.fn(async () => {});
    const release = createPreStopGiteaKeyRelease("alice", {
      readLocalUserPubKey: () => "ssh-ed25519 OLD predecessor",
      releaseKey,
    });

    await release?.();
    expect(releaseKey).toHaveBeenCalledWith("alice", "ssh-ed25519 OLD predecessor");
  });

  it("fails loud instead of reporting cleanup when the local public key is missing", async () => {
    const release = createPreStopGiteaKeyRelease("alice", {
      readLocalUserPubKey: () => null,
      listLocalUserPubKeys: () => [],
      releaseKey: vi.fn(async () => {}),
    });
    await expect(release?.()).rejects.toThrow(/local SSH public key is missing/);
  });

  it("releases every exact local user key from a retiring shared gateway", async () => {
    const releaseKey = vi.fn(async () => {});
    const release = createPreStopGiteaKeyRelease("", {
      readLocalUserPubKey: () => null,
      listLocalUserPubKeys: () => [
        { slug: "alice", pubKey: "ssh-ed25519 ALICE predecessor" },
        { slug: "bob", pubKey: "ssh-ed25519 BOB predecessor" },
      ],
      releaseKey,
    });

    await release?.();
    expect(releaseKey.mock.calls).toEqual([
      ["alice", "ssh-ed25519 ALICE predecessor"],
      ["bob", "ssh-ed25519 BOB predecessor"],
    ]);
  });

  it("reports shared-gateway key cleanup failure after attempting every local user", async () => {
    const releaseKey = vi.fn(async (slug: string) => {
      if (slug === "alice") throw new Error("broker unavailable");
    });
    const release = createPreStopGiteaKeyRelease("", {
      readLocalUserPubKey: () => null,
      listLocalUserPubKeys: () => [
        { slug: "alice", pubKey: "ssh-ed25519 ALICE predecessor" },
        { slug: "bob", pubKey: "ssh-ed25519 BOB predecessor" },
      ],
      releaseKey,
    });

    await expect(release?.()).rejects.toThrow(/alice.*broker unavailable/i);
    expect(releaseKey).toHaveBeenCalledTimes(2);
  });
});
