import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import { RETIRED_VM_BINDING_DENIAL_REASON } from "@octogee/shared/types/fleet-broker";
import {
  createUserNpmProxyCredentialsProvider,
  guardRetiredRuntimeBrokerClient,
  createRetriableIsolatedToolchainStatusPublication,
  createIsolatedToolchainStatusPublisher,
  probeUserInteractiveReadiness,
  resolveIsolatedToolchainHydratorConfig,
  waitForIsolatedToolchainShutdown,
} from "../entrypoints/isolated-toolchain-hydrator.js";
import { runIsolatedToolchainHydrationLoop } from "../lib/isolated-toolchain-hydrator.js";
import { FleetBrokerHttpError } from "../lib/fleet-broker-client.js";
import { withUserClaim } from "./helpers/user-claim.js";

describe("Isolated toolchain hydrator entrypoint", () => {
  it("resolves the image-pinned npm lock and managed proxy contract", () => {
    expect(resolveIsolatedToolchainHydratorConfig({
      HOME: "/home/builder",
      ...withUserClaim({ GATEWAY_ID: "walter" }, "alice"),
      FLEET_CONTROLLER_PORT: "4111",
      OCTOGEE_BUILDER_TOOLCHAIN_PACKAGE_JSON_PATH: "/octogee/toolchain/package.json",
      OCTOGEE_BUILDER_TOOLCHAIN_PACKAGE_LOCK_PATH: "/octogee/toolchain/package-lock.json",
      OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256: "a".repeat(64),
      OCTOGEE_BUILDER_TOOL_GROUPS_PATH: "/octogee/toolchain/groups.json",
      OCTOGEE_BUILDER_TOOL_GROUPS_SHA256: "b".repeat(64),
    })).toEqual({
      root: "/home/builder/.octogee/toolchains",
      gatewayId: "walter",
      builderSlug: "alice",
      readinessUrl: "http://127.0.0.1:4111/toolchain-ready",
      packageJsonPath: "/octogee/toolchain/package.json",
      packageLockPath: "/octogee/toolchain/package-lock.json",
      packageLockSha256: "a".repeat(64),
      groupsPath: "/octogee/toolchain/groups.json",
      groupsSha256: "b".repeat(64),
      fallbackRegistryUrl: "https://registry.npmjs.org/",
    });
  });

  it("gets an opaque short-lived capability from the assignment-bound broker", async () => {
    const credentials = {
      registryUrl: "http://octogee-npm-cache-proxy.octogee.svc.cluster.local:3005/",
      token: "n".repeat(43),
      expiresAt: "2026-08-30T00:10:00.000Z",
    };
    const client = { npmRegistryCredentials: vi.fn(async () => credentials) };
    const provide = createUserNpmProxyCredentialsProvider({ client, builderSlug: "alice" });

    await expect(provide()).resolves.toEqual(credentials);
    expect(client.npmRegistryCredentials).toHaveBeenCalledWith("alice");
  });

  it("projects exact states through the assigned-gateway broker and resolves the uid once", async () => {
    const client = {
      uidForSlug: vi.fn(async () => "uid-alice"),
      setToolchainStatus: vi.fn(async () => undefined),
    };
    const publish = createIsolatedToolchainStatusPublisher({ client, builderSlug: "alice" });

    await publish({ schemaVersion: 1, status: "pending", updatedAt: "2026-08-30T00:00:00Z" });
    await publish({ schemaVersion: 1, status: "ready", updatedAt: "2026-08-30T00:01:00Z" });

    expect(client.uidForSlug).toHaveBeenCalledTimes(1);
    expect(client.setToolchainStatus.mock.calls).toEqual([
      ["uid-alice", "pending"],
      ["uid-alice", "ready"],
    ]);
  });

  it("retries assigned-user resolution after a fail-soft broker outage", async () => {
    const client = {
      uidForSlug: vi.fn()
        .mockRejectedValueOnce(new Error("broker unavailable"))
        .mockResolvedValueOnce("uid-alice"),
      setToolchainStatus: vi.fn(async () => undefined),
    };
    const publish = createIsolatedToolchainStatusPublisher({ client, builderSlug: "alice" });
    const artifact = {
      schemaVersion: 1 as const,
      status: "ready" as const,
      updatedAt: "2026-08-30T00:00:00.000Z",
    };

    await expect(publish(artifact)).rejects.toThrow("broker unavailable");
    await expect(publish(artifact)).resolves.toBeUndefined();
    expect(client.uidForSlug).toHaveBeenCalledTimes(2);
    expect(client.setToolchainStatus).toHaveBeenCalledWith("uid-alice", "ready");
  });

  it("republishes an immutable ready artifact after canonical assignment cutover", async () => {
    const client = {
      uidForSlug: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("uid-alice"),
      setToolchainStatus: vi.fn(async () => undefined),
    };
    const publication = createRetriableIsolatedToolchainStatusPublication({
      client,
      builderSlug: "alice",
    });
    const ready = {
      schemaVersion: 1 as const,
      status: "ready" as const,
      updatedAt: "2026-08-30T00:00:00.000Z",
    };

    await expect(publication.publishStatus(ready)).rejects.toThrow(
      "configured user is not assigned to this gateway",
    );
    await expect(publication.ensureReadyPublished(ready)).resolves.toBeUndefined();
    await expect(publication.ensureReadyPublished(ready)).resolves.toBeUndefined();

    expect(client.uidForSlug).toHaveBeenCalledTimes(2);
    expect(client.setToolchainStatus.mock.calls).toEqual([["uid-alice", "ready"]]);
  });

  it("retries ready after a pre-cutover status rejection without rehydrating", async () => {
    const client = {
      uidForSlug: vi.fn(async () => "uid-alice"),
      setToolchainStatus: vi.fn()
        .mockRejectedValueOnce(new Error("fleet-broker set-toolchain-status → 403"))
        .mockResolvedValueOnce(undefined),
    };
    const publication = createRetriableIsolatedToolchainStatusPublication({
      client,
      builderSlug: "alice",
    });
    const ready = {
      schemaVersion: 1 as const,
      status: "ready" as const,
      updatedAt: "2026-08-30T00:00:00.000Z",
    };
    const hydrate = vi.fn(async () => {
      await publication.publishStatus(ready).catch(() => undefined);
      return ready;
    });
    const ensureReadyPublished = vi.fn(publication.ensureReadyPublished);

    await runIsolatedToolchainHydrationLoop({
      probeInteractiveReadiness: async () => true,
      hydrate,
      ensureReadyPublished,
      writeStatus: async () => {},
      waitForShutdown: async () => {},
    });

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(ensureReadyPublished).toHaveBeenCalledWith(ready);
    expect(client.uidForSlug).toHaveBeenCalledTimes(1);
    expect(client.setToolchainStatus.mock.calls).toEqual([
      ["uid-alice", "ready"],
      ["uid-alice", "ready"],
    ]);
  });

  it("stops calling the broker once it reports this computer's runtime retired", async () => {
    const retired = new FleetBrokerHttpError(
      "fleet-broker POST /internal/fleet/npm-registry-credentials → 403",
      403,
      RETIRED_VM_BINDING_DENIAL_REASON,
    );
    const client = {
      npmRegistryCredentials: vi.fn().mockRejectedValue(retired),
      uidForSlug: vi.fn(async () => "uid-alice"),
      setToolchainStatus: vi.fn(async () => undefined),
    };
    const log = vi.fn();
    const guarded = guardRetiredRuntimeBrokerClient(client, log);

    await expect(guarded.npmRegistryCredentials("alice")).rejects.toMatchObject({
      reasonCode: "runtime-retired",
      cause: retired,
    });
    await expect(guarded.setToolchainStatus("uid-alice", "pending")).rejects.toMatchObject({
      reasonCode: "runtime-retired",
    });
    await expect(guarded.uidForSlug("alice")).rejects.toMatchObject({ reasonCode: "runtime-retired" });
    await expect(guarded.npmRegistryCredentials("alice")).rejects.toMatchObject({
      reasonCode: "runtime-retired",
    });

    expect(client.npmRegistryCredentials).toHaveBeenCalledTimes(1);
    expect(client.setToolchainStatus).not.toHaveBeenCalled();
    expect(client.uidForSlug).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([[
      "[isolated-toolchain] broker reports this computer's runtime retired; " +
        "stopping npm credential and toolchain status requests",
    ]]);
  });

  it("passes an unassigned-User denial through so assignment polling continues", async () => {
    const unassigned = new FleetBrokerHttpError(
      "fleet-broker POST /internal/fleet/npm-registry-credentials → 403",
      403,
      null,
    );
    const client = {
      npmRegistryCredentials: vi.fn()
        .mockRejectedValueOnce(unassigned)
        .mockResolvedValueOnce({ registryUrl: "r", token: "t", expiresAt: "e" }),
      uidForSlug: vi.fn(async () => "uid-alice"),
      setToolchainStatus: vi.fn(async () => undefined),
    };
    const guarded = guardRetiredRuntimeBrokerClient(client, vi.fn());

    await expect(guarded.npmRegistryCredentials("alice")).rejects.toBe(unassigned);
    await expect(guarded.npmRegistryCredentials("alice")).resolves.toEqual({
      registryUrl: "r",
      token: "t",
      expiresAt: "e",
    });
  });

  it("treats only a successful preparation-readiness response as permission to hydrate", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(probeUserInteractiveReadiness("http://127.0.0.1:3003/toolchain-ready", fetchImpl))
      .resolves.toBe(false);
    await expect(probeUserInteractiveReadiness("http://127.0.0.1:3003/toolchain-ready", fetchImpl))
      .resolves.toBe(true);
  });
});

describe("Isolated toolchain hydrator shutdown", () => {
  it("keeps the ready runner alive until SIGTERM, then exits cleanly", async () => {
    const entrypoint = new URL("../entrypoints/isolated-toolchain-hydrator.ts", import.meta.url).href;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      import { waitForIsolatedToolchainShutdown } from ${JSON.stringify(entrypoint)};
      const controller = new AbortController();
      process.once("SIGTERM", () => controller.abort());
      waitForIsolatedToolchainShutdown(controller.signal).then(() => process.stdout.write("stopped\\n"));
      process.stdout.write("ready\\n");
    `], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    try {
      await Promise.race([
        new Promise<void>((resolve) => child.stdout.on("data", (chunk) => {
          if (String(chunk).includes("ready")) resolve();
        })),
        exited.then(() => { throw new Error(`runner exited before ready: ${stderr}`); }),
      ]);
      expect(await Promise.race([exited.then(() => "exited"), delay(250, "alive")])).toBe("alive");
      child.kill("SIGTERM");
      await expect(exited).resolves.toEqual([0, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  it("resolves immediately when already stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForIsolatedToolchainShutdown(controller.signal)).resolves.toBeUndefined();
  });
});
