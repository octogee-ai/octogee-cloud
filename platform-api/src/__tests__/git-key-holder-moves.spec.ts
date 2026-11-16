import { describe, expect, it } from "vitest";

import { createGiteaGitHost, type GiteaGitHost } from "@octogee/core/git-host";
import { gatewayKeyOwnerId, gatewayKeyTitle } from "@octogee/core/gitea-naming";

const SLUG = "acme";

function fakeGitea() {
  const held: Array<{ id: number; title: string; key: string }> = [];
  let nextId = 1;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/v1/, "");
    const method = init?.method ?? "GET";
    if (method === "POST" && path === "/admin/users") return Response.json({ message: "user already exists" }, { status: 422 });
    if (method === "GET" && path === "/users/ws-acme/keys") return Response.json(held);
    if (method === "POST" && path === "/admin/users/ws-acme/keys") {
      const body = JSON.parse(String(init?.body)) as { title: string; key: string };
      if (held.some((existing) => existing.key === body.key)) return Response.json({ message: "key already exists" }, { status: 422 });
      held.push({ id: nextId++, ...body });
      return Response.json(held.at(-1), { status: 201 });
    }
    const deleted = /^\/admin\/users\/ws-acme\/keys\/(\d+)$/.exec(path);
    if (method === "DELETE" && deleted) {
      const index = held.findIndex((key) => key.id === Number(deleted[1]));
      if (index < 0) return new Response(null, { status: 404 });
      held.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected git host request ${method} ${path}`);
  };
  const host = createGiteaGitHost({ apiBaseUrl: "http://gitea.invalid/api/v1", token: () => "token", fetch });
  const deleteTitled = (title: string) => {
    for (let index = held.length - 1; index >= 0; index -= 1) if (held[index].title === title) held.splice(index, 1);
  };
  return { host, deleteTitled, keys: () => held.map(({ key }) => key).sort() };
}

function contractService({ host, deleteTitled }: Pick<ReturnType<typeof fakeGitea>, "host" | "deleteTitled">) {
  const rows = new Map<string, string>();
  const puts: string[] = [];
  return {
    puts,
    rows: () => [...rows.entries()].map(([holder, publicKey]) => ({ holder, publicKey })).sort((a, b) => a.holder.localeCompare(b.holder)),
    async put(holder: string, publicKey: string) {
      puts.push(holder);
      rows.set(holder, publicKey);
      await host.registerKey(SLUG, publicKey, holder);
    },
    async reconcile() {
      for (const [holder, publicKey] of rows) await host.registerKeyUnlessHeld(SLUG, publicKey, holder);
    },
    async release(holder: string, expectedPublicKey: string) {
      if (rows.get(holder) !== expectedPublicKey) return;
      rows.delete(holder);
      deleteTitled(gatewayKeyTitle(holder));
    },
  };
}

type Service = ReturnType<typeof contractService>;

interface Disk {
  key: string | null;
  marker: string | null;
}

let generated = 0;
const newKey = () => `ssh-ed25519 AAAAC3Nza${++generated}Key octogee-acme@gateway`;

function pod(gatewayId: string, podName: string, disk: Disk = { key: null, marker: null }) {
  return { holder: gatewayKeyOwnerId(gatewayId, podName), disk };
}

type Pod = ReturnType<typeof pod>;

function thisBuild(host: GiteaGitHost, service: Service) {
  return {
    async serviceMount(p: Pod) {
      const reusable = p.disk.key !== null && (p.disk.marker === null || p.disk.marker === p.holder);
      const key = reusable ? p.disk.key! : newKey();
      await service.put(p.holder, key);
      p.disk.key = key;
      p.disk.marker = p.holder;
    },
    async legacyRegistration(p: Pod) {
      if (p.disk.marker === p.holder) {
        await service.put(p.holder, p.disk.key!);
        return;
      }
      await host.registerKey(SLUG, p.disk.key!, p.holder);
      p.disk.marker = null;
    },
    async unmount(p: Pod) {
      if (p.disk.marker !== null) await service.release(p.holder, p.disk.key!);
      else await host.releaseKey(SLUG, p.disk.key!, p.holder);
    },
  };
}

function previousBuild(host: GiteaGitHost) {
  return {
    claim: (p: Pod) => host.registerKey(SLUG, p.disk.key!, p.holder),
    unmount: (p: Pod) => host.releaseKey(SLUG, p.disk.key!, p.holder),
  };
}

const carriedDisk = (from: Pod): Disk => ({ ...from.disk });

describe("git keys across a move between builds, under the per-pod holder contract", () => {
  it("ends with one key held by the target pod when a user moves from this build to a previous build", async () => {
    const git = fakeGitea();
    const service = contractService(git);
    const source = pod("shared-blue", "octogee-gateway-shared-blue-5bc59-a1b2c");
    await thisBuild(git.host, service).serviceMount(source);
    const target = pod("isolated-acme", "octogee-gateway-isolated-acme-0", carriedDisk(source));

    await previousBuild(git.host).claim(target);
    // Depends on rule (b), adoption only on a put: reconciling the source's row must not take the key back.
    await service.reconcile();
    // Depends on rule (b), a release deletes only under the row's own title.
    await thisBuild(git.host, service).unmount(source);
    await service.reconcile();

    expect(git.keys()).toEqual([target.disk.key]);
    expect(service.rows()).toEqual([]);
  });

  it("ends with one key held by the target pod when a user moves from a previous build to this build", async () => {
    const git = fakeGitea();
    const service = contractService(git);
    const source = pod("shared-blue", "octogee-gateway-shared-blue-5bc59-a1b2c", { key: newKey(), marker: null });
    await previousBuild(git.host).claim(source);
    const target = pod("isolated-acme", "octogee-gateway-isolated-acme-0", carriedDisk(source));
    const build = thisBuild(git.host, service);

    await build.legacyRegistration(target);
    await build.serviceMount(target);
    await previousBuild(git.host).unmount(source);
    await service.reconcile();

    expect(git.keys()).toEqual([target.disk.key]);
    expect(service.rows()).toEqual([{ holder: target.holder, publicKey: target.disk.key }]);
    expect(target.disk.marker).toBe(target.holder);
  });

  it("keeps a key per pod while one gateway rolls with a surge, and the older pod's unmount removes only its own", async () => {
    const git = fakeGitea();
    const service = contractService(git);
    const build = thisBuild(git.host, service);
    const older = pod("shared-blue", "octogee-gateway-shared-blue-5bc59-a1b2c");
    const newer = pod("shared-blue", "octogee-gateway-shared-blue-7d8e9-f3g4h");

    await build.serviceMount(older);
    await build.serviceMount(newer);

    expect(older.holder).not.toBe(newer.holder);
    expect(git.keys()).toEqual([older.disk.key, newer.disk.key].sort());
    expect(service.rows().map(({ holder }) => holder)).toEqual([older.holder, newer.holder].sort());

    await build.unmount(older);
    await service.reconcile();

    expect(git.keys()).toEqual([newer.disk.key]);
    expect(service.rows()).toEqual([{ holder: newer.holder, publicKey: newer.disk.key }]);
  });

  it("puts the key again when a pod remounts a user with the key it already registered", async () => {
    const git = fakeGitea();
    const service = contractService(git);
    const build = thisBuild(git.host, service);
    const serving = pod("shared-blue", "octogee-gateway-shared-blue-5bc59-a1b2c");

    await build.serviceMount(serving);
    const first = serving.disk.key;
    await build.serviceMount(serving);

    expect(serving.disk.key).toBe(first);
    expect(service.puts).toEqual([serving.holder, serving.holder]);
    expect(git.keys()).toEqual([first]);
  });

  it("registers a fresh key for a replaced machine whose retained home holds the old holder's key, and the old holder's release leaves it", async () => {
    const git = fakeGitea();
    const service = contractService(git);
    const build = thisBuild(git.host, service);
    const replaced = pod("isolated-acme", "octogee-vm-isolated-acme-1111");
    await build.serviceMount(replaced);
    const replacement = pod("isolated-acme", "octogee-vm-isolated-acme-2222", replaced.disk);
    const retainedKey = replacement.disk.key;

    await build.serviceMount(replacement);
    await service.release(replaced.holder, retainedKey!);
    await service.reconcile();

    expect(replacement.disk.key).not.toBe(retainedKey);
    expect(git.keys()).toEqual([replacement.disk.key]);
    expect(service.rows()).toEqual([{ holder: replacement.holder, publicKey: replacement.disk.key }]);
  });
});
