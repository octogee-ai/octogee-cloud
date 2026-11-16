import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { gatewayKeyOwnerId } from "@octogee/core/gitea-naming";
import { logger } from "@octogee/core/http/logging";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { NO_BROKER_RECORDS } from "../lib/broker-records.js";
import { createLegacyProvisioning } from "../lib/legacy-provisioning.js";
import { createFleetBrokerRoutes } from "../routes/fleet-broker.js";
import { createInternalGiteaAdminRoutes } from "../routes/internal/gitea-admin.js";
import { fakeGitHost, gitKeyServiceContract, type FakeGitHost, type GitKeyServiceContract } from "../test-helpers/git-key-service-contract.js";

const state = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  git: null as { host: unknown } | null,
}));

vi.mock("@octogee/core/identity/platform-state-store", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(state.docs) };
});

vi.mock("../lib/git-host.js", () => ({ gitHost: () => state.git?.host }));

vi.mock("../routes/projects/provisioning.js", () => ({
  ensureProjectGiteaRepo: vi.fn(),
  deleteProjectGiteaRepo: vi.fn(),
  ProjectRepoProvisioningError: class ProjectRepoProvisioningError extends Error {},
}));

const USER = { uid: "uid-acme", slug: "acme" };

interface Pod {
  gatewayId: string;
  podName: string;
  holder: string;
  disk: { key: string | null; marker: string | null };
}

let generated = 0;
const newKey = () => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${String(++generated).padStart(4, "0")}Key octogee-acme@gateway`;

function pod(gatewayId: string, podName: string, disk: Pod["disk"] = { key: null, marker: null }): Pod {
  return { gatewayId, podName, holder: gatewayKeyOwnerId(gatewayId, podName), disk: { ...disk } };
}

function assign(gatewayId: string): void {
  state.docs.set(`users/${USER.uid}`, { username: USER.slug, provisioning: { openclaw: { slug: USER.slug, gatewayId } } });
}

function platform(git: FakeGitHost, service: GitKeyServiceContract | null) {
  const legacyProvisioning = service === null
    ? null
    : createLegacyProvisioning({ client: service.client, sleep: () => service.attempt() });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.boundTenant = { kind: "gateway", gatewayId: req.header("x-gateway-id"), podName: req.header("x-pod-name"), tokenSource: "ksa" } as never;
    next();
  });
  app.use("/internal/fleet", createFleetBrokerRoutes({ store: platformStateStore, records: NO_BROKER_RECORDS, legacyProvisioning }));
  app.use("/internal/gitea", createInternalGiteaAdminRoutes({ legacyProvisioning }));
  const call = (from: Pod, path: string, body: Record<string, unknown>) =>
    request(app).post(path).set("x-gateway-id", from.gatewayId).set("x-pod-name", from.podName).send(body);

  const thisBuild = {
    async serviceMount(p: Pod) {
      const publicKey = p.disk.key ?? newKey();
      p.disk.key = publicKey;
      await call(p, "/internal/fleet/git-key", { uid: USER.uid, publicKey }).expect(204);
      p.disk.marker = p.holder;
    },
    async register(p: Pod) {
      const marked = p.disk.marker === null ? {} : { serviceHolder: p.disk.marker };
      const answer = await call(p, "/internal/gitea/ensure-user", { slug: USER.slug, pubKey: p.disk.key, ...marked });
      expect([200, 204]).toContain(answer.status);
      if (answer.body?.registeredOn === "git-host") p.disk.marker = null;
    },
    async giveUp(p: Pod) {
      const released = await call(p, "/internal/fleet/git-key/release", { slug: USER.slug, publicKey: p.disk.key });
      if (released.status !== 204) expect(released.body).toEqual({ error: "provisioning_service_not_configured" });
      await call(p, "/internal/gitea/release-user-key", { slug: USER.slug, pubKey: p.disk.key }).expect(204);
      p.disk = { key: null, marker: null };
    },
  };
  const previousBuild = {
    claim: (p: Pod) => call(p, "/internal/gitea/ensure-user", { slug: USER.slug, pubKey: p.disk.key }).expect(204),
    unmount: (p: Pod) => call(p, "/internal/gitea/release-user-key", { slug: USER.slug, pubKey: p.disk.key }).expect(204),
  };
  return { thisBuild, previousBuild };
}

function setup() {
  const git = fakeGitHost(USER.slug);
  state.git = git;
  const service = gitKeyServiceContract(USER, git);
  return { git, service, ...platform(git, service) };
}

const hostKeys = (git: FakeGitHost) => git.held().map(({ key }) => key).sort();

beforeEach(() => {
  state.docs.clear();
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
});

describe("git keys across moves and rolls, through the platform's routes and adapter", () => {
  it("ends with one key under the target pod's title and no row when a user moves from this build to a previous build", async () => {
    const { git, service, thisBuild, previousBuild } = setup();
    assign("shared-blue");
    const source = pod("shared-blue", "octogee-gateway-shared-blue-5bc59-a1b2c");
    await thisBuild.serviceMount(source);
    const target = pod("isolated-acme", "octogee-gateway-isolated-acme-0", { key: source.disk.key, marker: null });
    const carried = source.disk.key;

    assign("isolated-acme");
    await previousBuild.claim(target);
    await service.attempt();

    expect(git.titled(target.holder)).toEqual([carried]);
    expect(service.row(source.holder)?.status.conditions[0]).toMatchObject({ status: "False", reason: "GitKeyHeldElsewhere" });

    await thisBuild.giveUp(source);
    await service.attempt();

    expect(git.titled(target.holder)).toEqual([carried]);
    expect(hostKeys(git)).toEqual([carried]);
    expect(service.rows()).toEqual([]);
  });

  it("ends with one key and one row for the target pod when a user moves from a previous build to this build", async () => {
    const { git, service, thisBuild, previousBuild } = setup();
    assign("shared-blue");
    const source = pod("shared-blue", "octogee-gateway-shared-blue-5bc59-a1b2c", { key: newKey(), marker: null });
    await previousBuild.claim(source);
    const target = pod("shared-green", "octogee-gateway-shared-green-7d8e9-f3g4h", { key: source.disk.key, marker: null });

    assign("shared-green");
    await thisBuild.register(target);
    await thisBuild.serviceMount(target);

    expect(service.row(target.holder)).toMatchObject({ putSequence: 1, status: { observedPutSequence: 1, conditions: [{ status: "True" }] } });

    await previousBuild.unmount(source);
    await service.attempt();

    expect(git.titled(target.holder)).toEqual([target.disk.key]);
    expect(hostKeys(git)).toEqual([target.disk.key]);
    expect(service.rows()).toEqual([{ holder: target.holder, publicKey: target.disk.key }]);
    expect(target.disk.marker).toBe(target.holder);
  });

  it("holds a key and a row per pod while one gateway id rolls with a surge, and the older pod's unmount removes only its own", async () => {
    const { git, service, thisBuild } = setup();
    assign("shared-blue");
    const older = pod("shared-blue", "octogee-gateway-shared-blue-5bc59-a1b2c");
    const newer = pod("shared-blue", "octogee-gateway-shared-blue-7d8e9-f3g4h");

    await thisBuild.serviceMount(older);
    await thisBuild.serviceMount(newer);

    expect(older.holder).not.toBe(newer.holder);
    expect(git.titled(older.holder)).toEqual([older.disk.key]);
    expect(git.titled(newer.holder)).toEqual([newer.disk.key]);
    expect(service.rows()).toEqual([{ holder: older.holder, publicKey: older.disk.key }, { holder: newer.holder, publicKey: newer.disk.key }]);
    const kept = newer.disk.key;

    await thisBuild.giveUp(older);
    await service.attempt();

    expect(hostKeys(git)).toEqual([kept]);
    expect(service.rows()).toEqual([{ holder: newer.holder, publicKey: kept }]);
  });

  it("puts the key again when a pod remounts a user with the key it already registered, and waits for the attempt that follows that put", async () => {
    const { git, service, thisBuild } = setup();
    assign("shared-blue");
    const serving = pod("shared-blue", "octogee-gateway-shared-blue-5bc59-a1b2c");

    await thisBuild.serviceMount(serving);
    const first = serving.disk.key;
    await thisBuild.serviceMount(serving);

    expect(serving.disk.key).toBe(first);
    expect(service.puts).toEqual([serving.holder, serving.holder]);
    expect(service.row(serving.holder)).toMatchObject({ generation: 1, putSequence: 2, status: { observedPutSequence: 2 } });
    expect(hostKeys(git)).toEqual([first]);
  });

  it("registers a replaced machine's retained key under its new title on the git host, with no row for the new holder", async () => {
    const { git, service, thisBuild } = setup();
    assign("isolated-acme");
    const replaced = pod("isolated-acme", "octogee-gateway-isolated-acme-vm-1111");
    await thisBuild.serviceMount(replaced);
    const retained = replaced.disk.key;
    const machine = pod("isolated-acme", "octogee-gateway-isolated-acme-vm-2222", { key: retained, marker: replaced.holder });

    await thisBuild.register(machine);
    await service.attempt();

    expect(machine.disk.marker).toBeNull();
    expect(git.titled(machine.holder)).toEqual([retained]);
    expect(service.rows()).toEqual([{ holder: replaced.holder, publicKey: retained }]);
    expect(service.puts).toEqual([replaced.holder]);

    service.releaseHolder(replaced.holder);
    await service.attempt();

    expect(hostKeys(git)).toEqual([retained]);
    expect(git.titled(machine.holder)).toEqual([retained]);
    expect(service.rows()).toEqual([]);
  });

  it("releases on the git host and registers there once the service is switched off after a service mount", async () => {
    const { git, service, thisBuild } = setup();
    assign("shared-blue");
    const serving = pod("shared-blue", "octogee-gateway-shared-blue-5bc59-a1b2c");
    await thisBuild.serviceMount(serving);
    const registered = serving.disk.key;
    const switchedOff = platform(git, null);

    await switchedOff.thisBuild.register(serving);

    expect(serving.disk.marker).toBeNull();
    expect(git.titled(serving.holder)).toEqual([registered]);

    serving.disk.marker = serving.holder;
    await switchedOff.thisBuild.giveUp(serving);

    expect(hostKeys(git)).toEqual([]);
    expect(service.puts).toEqual([serving.holder]);
  });

  it("answers a mount 503 with the service's reason while the user's work is parked, registering nothing", async () => {
    const { git, service } = setup();
    assign("shared-blue");
    service.park("GitOwnerFailed");
    const serving = pod("shared-blue", "octogee-gateway-shared-blue-5bc59-a1b2c", { key: newKey(), marker: null });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.boundTenant = { kind: "gateway", gatewayId: serving.gatewayId, podName: serving.podName, tokenSource: "ksa" } as never;
      next();
    });
    app.use("/internal/fleet", createFleetBrokerRoutes({
      store: platformStateStore, records: NO_BROKER_RECORDS,
      legacyProvisioning: createLegacyProvisioning({ client: service.client, sleep: () => service.attempt() }),
    }));

    const answer = await request(app).post("/internal/fleet/git-key").send({ uid: USER.uid, publicKey: serving.disk.key }).expect(503);

    expect(answer.body).toEqual({ error: "provisioning_pending", reason: "GitOwnerFailed" });
    expect(hostKeys(git)).toEqual([]);
  });
});
