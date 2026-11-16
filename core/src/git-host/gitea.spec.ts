import { createHash } from "node:crypto";

import { describe, it, expect, vi, beforeEach } from "vitest";

import { createGiteaGitHost } from "./gitea.js";

const BASE = "http://gitea.test:3000/api/v1";

function res(status: number, body: unknown = {}): Response {
  const noBody = status === 204 || status === 304;
  return new Response(noBody ? null : JSON.stringify(body), { status });
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>): Array<{ url: string; method: string; body: unknown }> {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init?.method ?? "GET") as string,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }));
}

function keyTitle(owner: string): string {
  return `octogee-gateway-${createHash("sha256").update(owner).digest("hex").slice(0, 16)}`;
}

describe("createGiteaGitHost — managed Gitea admin operations", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let host: ReturnType<typeof createGiteaGitHost>;

  beforeEach(() => {
    fetchMock = vi.fn();
    host = createGiteaGitHost({
      apiBaseUrl: BASE,
      token: () => "admin-tok",
      fetch: fetchMock as unknown as typeof fetch,
    });
  });

  describe("registerKey", () => {
    it("creates the ws-<slug> user and registers the octogee-gateway ssh key", async () => {
      fetchMock
        .mockResolvedValueOnce(res(201, { id: 1 })) // POST /admin/users
        .mockResolvedValueOnce(res(200, [])) // GET existing keys
        .mockResolvedValueOnce(res(201, { id: 9 })); // POST key
      await host.registerKey("acme", "ssh-ed25519 AAAABBB octogee-acme@gateway");

      const calls = callsTo(fetchMock);
      expect(calls[0]).toMatchObject({ url: `${BASE}/admin/users`, method: "POST" });
      expect(calls[0].body).toMatchObject({
        username: "ws-acme",
        email: "acme@users.invalid",
        must_change_password: false,
        visibility: "private",
      });
      expect((calls[0].body as { password?: string }).password).toMatch(/^[0-9a-f]{64}$/);
      expect(calls[1]).toMatchObject({
        url: `${BASE}/users/ws-acme/keys?limit=50&page=1`,
        method: "GET",
      });
      expect(calls[2]).toMatchObject({ url: `${BASE}/admin/users/ws-acme/keys`, method: "POST" });
      expect(calls[2].body).toMatchObject({
        key: "ssh-ed25519 AAAABBB octogee-acme@gateway",
      });
      expect((calls[2].body as { title: string }).title).toMatch(/^octogee-gateway-[0-9a-f]{16}$/);
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("token admin-tok");
    });

    it.each([409, 422])("re-ensures an existing user after %i", async status => {
      fetchMock
        .mockResolvedValueOnce(res(status, { message: "user already exists" }))
        .mockResolvedValueOnce(res(200, []))
        .mockResolvedValueOnce(res(201, {}));
      await expect(host.registerKey("acme", "ssh-ed25519 K")).resolves.toBeUndefined();
    });

    it("does not hide a conflict when the expected user cannot be reconciled", async () => {
      fetchMock
        .mockResolvedValueOnce(res(409, { message: "email already exists" }))
        .mockResolvedValueOnce(res(404))
        .mockResolvedValueOnce(res(404))
        .mockResolvedValueOnce(res(404));
      await expect(host.registerKey("acme", "ssh-ed25519 K")).rejects.toThrow(/register-key.*404/);
      expect(callsTo(fetchMock)).not.toContainEqual(expect.objectContaining({ method: "DELETE" }));
    });

    it("keeps the predecessor pod key while registering a successor key for surge overlap", async () => {
      fetchMock
        .mockResolvedValueOnce(res(422, {})) // user exists
        .mockResolvedValueOnce(res(200, [
          { id: 7, title: "octogee-gateway", key: "ssh-ed25519 OLD predecessor" },
          { id: 8, title: "other", key: "ssh-ed25519 OTHER" },
        ]))
        .mockResolvedValueOnce(res(201, {})); // POST new key
      await host.registerKey("acme", "ssh-ed25519 NEW");

      const calls = callsTo(fetchMock);
      expect(calls).not.toContainEqual(expect.objectContaining({ method: "DELETE" }));
      expect(calls[2]).toMatchObject({ url: `${BASE}/admin/users/ws-acme/keys`, method: "POST" });
      expect((calls[2].body as { title: string }).title).toMatch(/^octogee-gateway-[0-9a-f]{16}$/);
    });

    it("does not replace another pod key when the requested key is already registered", async () => {
      fetchMock
        .mockResolvedValueOnce(res(422, {}))
        .mockResolvedValueOnce(res(200, [
          { id: 7, title: "octogee-gateway-old", key: "ssh-ed25519 OLD predecessor" },
          { id: 9, title: "octogee-gateway-new", key: "ssh-ed25519 WANT current-pod" },
        ]));
      await host.registerKey("acme", "ssh-ed25519 WANT another-comment");

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("reclaims the same managed key when a predecessor owns its title", async () => {
      fetchMock
        .mockResolvedValueOnce(res(422, {}))
        .mockResolvedValueOnce(res(200, [
          {
            id: 9,
            title: "octogee-gateway-predecessor",
            key: "ssh-ed25519 WANT predecessor-pod",
          },
        ]))
        .mockResolvedValueOnce(res(204))
        .mockResolvedValueOnce(res(201, {}));
      await expect(
        host.registerKey("acme", "ssh-ed25519 WANT successor-pod", "walter/pod-new"),
      ).resolves.toBeUndefined();

      expect(callsTo(fetchMock)).toEqual([
        expect.objectContaining({ method: "POST", url: `${BASE}/admin/users` }),
        expect.objectContaining({ method: "GET", url: `${BASE}/users/ws-acme/keys?limit=50&page=1` }),
        expect.objectContaining({ method: "DELETE", url: `${BASE}/admin/users/ws-acme/keys/9` }),
        expect.objectContaining({
          method: "POST",
          url: `${BASE}/admin/users/ws-acme/keys`,
          body: {
            title: "octogee-gateway-95330059c99a4eab",
            key: "ssh-ed25519 WANT successor-pod",
          },
        }),
      ]);
    });

    it("restores the predecessor key when inherited-key ownership transfer fails", async () => {
      const predecessorOwner = "walter/pod-old";
      const predecessorTitle = keyTitle(predecessorOwner);
      const inheritedKey = "ssh-ed25519 WANT inherited-from-source";
      fetchMock
        .mockResolvedValueOnce(res(422, {}))
        .mockResolvedValueOnce(res(200, [{
          id: 9,
          title: predecessorTitle,
          key: inheritedKey,
        }]))
        .mockResolvedValueOnce(res(204))
        .mockResolvedValueOnce(res(500, { message: "target registration failed" }))
        .mockResolvedValueOnce(res(200, []))
        .mockResolvedValueOnce(res(201, {}));
      await expect(
        host.registerKey("acme", inheritedKey, "walter/pod-new"),
      ).rejects.toThrow(/register-key.*500.*target registration failed/);

      const calls = callsTo(fetchMock);
      expect(calls).toEqual([
        expect.objectContaining({ method: "POST", url: `${BASE}/admin/users` }),
        expect.objectContaining({ method: "GET", url: `${BASE}/users/ws-acme/keys?limit=50&page=1` }),
        expect.objectContaining({ method: "DELETE", url: `${BASE}/admin/users/ws-acme/keys/9` }),
        expect.objectContaining({
          method: "POST",
          url: `${BASE}/admin/users/ws-acme/keys`,
          body: { title: keyTitle("walter/pod-new"), key: inheritedKey },
        }),
        expect.objectContaining({ method: "GET", url: `${BASE}/users/ws-acme/keys?limit=50&page=1` }),
        expect.objectContaining({
          method: "POST",
          url: `${BASE}/admin/users/ws-acme/keys`,
          body: { title: predecessorTitle, key: inheritedKey },
        }),
      ]);
    });

    it("transfers an inherited key to the target so source release cannot remove it", async () => {
      const predecessorOwner = "walter/pod-old";
      const successorOwner = "walter/pod-new";
      const inheritedKey = "ssh-ed25519 WANT inherited-from-source";
      let keys = [{ id: 9, title: keyTitle(predecessorOwner), key: inheritedKey }];
      let nextKeyId = 10;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const path = new URL(url).pathname;
        if (method === "POST" && path === "/api/v1/admin/users") return res(422, {});
        if (method === "GET" && path === "/api/v1/users/ws-acme/keys") return res(200, keys);
        if (method === "DELETE" && path.startsWith("/api/v1/admin/users/ws-acme/keys/")) {
          const id = Number(path.split("/").at(-1));
          keys = keys.filter((key) => key.id !== id);
          return res(204);
        }
        if (method === "POST" && path === "/api/v1/admin/users/ws-acme/keys") {
          const body = JSON.parse(String(init?.body)) as { title: string; key: string };
          keys.push({ id: nextKeyId++, ...body });
          return res(201, {});
        }
        throw new Error(`unexpected request: ${method} ${path}`);
      });
      await host.registerKey("acme", inheritedKey, successorOwner);
      await host.releaseKey("acme", inheritedKey, predecessorOwner);

      expect(keys).toEqual([{
        id: 10,
        title: keyTitle(successorOwner),
        key: inheritedKey,
      }]);
      expect(callsTo(fetchMock).filter((call) => call.method === "DELETE")).toEqual([
        expect.objectContaining({ url: `${BASE}/admin/users/ws-acme/keys/9` }),
      ]);
    });

    it("replaces only the retrying pod's prior key and keeps the predecessor key", async () => {
      fetchMock
        .mockResolvedValueOnce(res(422, {}))
        .mockResolvedValueOnce(res(200, [
          { id: 7, title: "octogee-gateway-predecessor", key: "ssh-ed25519 OLD" },
          { id: 9, title: "octogee-gateway-95330059c99a4eab", key: "ssh-ed25519 STALE" },
        ]))
        .mockResolvedValueOnce(res(204))
        .mockResolvedValueOnce(res(201, {}));
      await host.registerKey("acme", "ssh-ed25519 NEW", "walter/pod-new");

      const calls = callsTo(fetchMock);
      expect(calls.filter((call) => call.method === "DELETE")).toEqual([
        expect.objectContaining({ url: `${BASE}/admin/users/ws-acme/keys/9` }),
      ]);
      expect(calls.at(-1)).toMatchObject({
        method: "POST",
        body: { title: "octogee-gateway-95330059c99a4eab", key: "ssh-ed25519 NEW" },
      });
    });

    it("accepts a concurrent registration only after confirming the requested key exists", async () => {
      fetchMock
        .mockResolvedValueOnce(res(422, {}))
        .mockResolvedValueOnce(res(200, [{
          id: 7,
          title: "octogee-gateway-old",
          key: "ssh-ed25519 OLD predecessor",
        }]))
        .mockResolvedValueOnce(res(422, { message: "key already exists" }))
        .mockResolvedValueOnce(res(200, [{
          id: 9,
          title: "octogee-gateway-current",
          key: "ssh-ed25519 WANT current-pod",
        }]));
      await expect(
        host.registerKey("acme", "ssh-ed25519 WANT another-comment"),
      ).resolves.toBeUndefined();
    });

    it("fails loud when existing keys cannot be listed", async () => {
      fetchMock
        .mockResolvedValueOnce(res(422, {}))
        .mockResolvedValueOnce(res(500, { message: "database unavailable" }));
      await expect(host.registerKey("acme", "ssh-ed25519 WANT")).rejects.toThrow(
        /list-keys.*500.*database unavailable/,
      );
    });

    it("throws (no silent failure) when key registration fails", async () => {
      fetchMock
        .mockResolvedValueOnce(res(201, {}))
        .mockResolvedValueOnce(res(200, []))
        .mockResolvedValueOnce(res(500, { message: "boom" }));
      await expect(host.registerKey("acme", "ssh-ed25519 K")).rejects.toThrow();
    });

    it("throws when user creation fails with a non-conflict status", async () => {
      fetchMock.mockResolvedValueOnce(res(500, { message: "down" }));
      await expect(host.registerKey("acme", "ssh-ed25519 K")).rejects.toThrow();
    });
  });

  describe("registerKeyUnlessHeld", () => {
    const servingOwner = "shared-1/octogee-gateway-shared-1-abc-xyz";
    const standbyOwner = "walter/octogee-gateway-walter-vm-123";
    let keys: Array<{ id: number; title: string; key: string }>;

    beforeEach(() => {
      keys = [];
      let nextKeyId = 100;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const path = new URL(url).pathname;
        if (method === "POST" && path === "/api/v1/admin/users") return res(422, {});
        if (method === "GET" && path === "/api/v1/users/ws-acme/keys") return res(200, keys);
        if (method === "DELETE" && path.startsWith("/api/v1/admin/users/ws-acme/keys/")) {
          const id = Number(path.split("/").at(-1));
          keys = keys.filter((key) => key.id !== id);
          return res(204);
        }
        if (method === "POST" && path === "/api/v1/admin/users/ws-acme/keys") {
          const body = JSON.parse(String(init?.body)) as { title: string; key: string };
          if (keys.some((key) => key.key.split(" ")[1] === body.key.split(" ")[1])) {
            return res(422, { message: "Key content has been used as non-deploy key" });
          }
          keys.push({ id: nextKeyId++, ...body });
          return res(201, {});
        }
        throw new Error(`unexpected request: ${method} ${path}`);
      });
    });

    it("leaves a key another gateway holds with that gateway, so the standby's release cannot remove it", async () => {
      const shared = "ssh-ed25519 SHARED carried-by-migration";
      keys = [{ id: 9, title: keyTitle(servingOwner), key: shared }];

      await host.registerKeyUnlessHeld("acme", shared, standbyOwner);
      await host.releaseKey("acme", shared, standbyOwner);

      expect(keys).toEqual([{ id: 9, title: keyTitle(servingOwner), key: shared }]);
      expect(callsTo(fetchMock).filter((call) => call.method === "DELETE")).toEqual([]);
    });

    it("registers a key nobody holds under the standby gateway", async () => {
      await host.registerKeyUnlessHeld("acme", "ssh-ed25519 OWN standby", standbyOwner);

      expect(keys).toEqual([{ id: 100, title: keyTitle(standbyOwner), key: "ssh-ed25519 OWN standby" }]);
    });

    it("replaces the standby gateway's own earlier key and keeps the serving gateway's key", async () => {
      keys = [
        { id: 9, title: keyTitle(servingOwner), key: "ssh-ed25519 SERVING" },
        { id: 10, title: keyTitle(standbyOwner), key: "ssh-ed25519 STALE" },
      ];

      await host.registerKeyUnlessHeld("acme", "ssh-ed25519 FRESH", standbyOwner);

      expect(keys).toEqual([
        { id: 9, title: keyTitle(servingOwner), key: "ssh-ed25519 SERVING" },
        { id: 100, title: keyTitle(standbyOwner), key: "ssh-ed25519 FRESH" },
      ]);
    });
  });

  describe("holdsKey", () => {
    const holder = "shared-1/octogee-gateway-shared-1-abc-xyz";
    const otherHolder = "shared-1/octogee-gateway-shared-1-def-uvw";
    const key = "ssh-ed25519 AAAAHELD octogee-acme@gateway";

    it("is true when the holder's title carries the same key material, whatever the comment, and only reads", async () => {
      fetchMock.mockResolvedValueOnce(res(200, [{ id: 7, title: keyTitle(holder), key: "ssh-ed25519 AAAAHELD stored-comment" }]));

      await expect(host.holdsKey("acme", key, holder)).resolves.toBe(true);

      expect(callsTo(fetchMock)).toEqual([
        { url: `${BASE}/users/ws-acme/keys?limit=50&page=1`, method: "GET", body: undefined },
      ]);
    });

    it("is false when the holder's title carries different key material", async () => {
      fetchMock.mockResolvedValueOnce(res(200, [{ id: 7, title: keyTitle(holder), key: "ssh-ed25519 AAAAOTHER octogee-acme@gateway" }]));

      await expect(host.holdsKey("acme", key, holder)).resolves.toBe(false);
    });

    it("is false when the key is registered under another holder's title or the legacy title", async () => {
      fetchMock.mockResolvedValueOnce(res(200, [{ id: 7, title: keyTitle(otherHolder), key }]));
      await expect(host.holdsKey("acme", key, holder)).resolves.toBe(false);

      fetchMock.mockResolvedValueOnce(res(200, [{ id: 8, title: "octogee-gateway", key }]));
      await expect(host.holdsKey("acme", key, holder)).resolves.toBe(false);
    });

    it("is false when the account has no keys or does not exist", async () => {
      fetchMock.mockResolvedValueOnce(res(200, []));
      await expect(host.holdsKey("acme", key, holder)).resolves.toBe(false);

      fetchMock.mockResolvedValueOnce(res(404, { message: "user does not exist" }));
      await expect(host.holdsKey("acme", key, holder)).resolves.toBe(false);
    });

    it("throws when the keys cannot be read", async () => {
      fetchMock.mockResolvedValueOnce(res(500, { message: "database is locked" }));

      await expect(host.holdsKey("acme", key, holder)).rejects.toThrow(/list-keys failed: 500/);
    });
  });

  describe("listKeys and primaryKey", () => {
    it("returns every managed gateway key so overlapping pods can verify membership", async () => {
      fetchMock.mockResolvedValueOnce(
        res(200, [
          { id: 1, title: "other", key: "ssh-ed25519 OTHER" },
          { id: 2, title: "octogee-gateway", key: "ssh-ed25519 WANT octogee\n" },
          { id: 3, title: "octogee-gateway-new", key: "ssh-ed25519 NEXT successor\n" },
        ]),
      );
      expect(await host.listKeys("acme")).toEqual([
        "ssh-ed25519 WANT octogee",
        "ssh-ed25519 NEXT successor",
      ]);
      expect(callsTo(fetchMock)[0]).toMatchObject({
        url: `${BASE}/users/ws-acme/keys?limit=50&page=1`,
        method: "GET",
      });
    });

    it("keeps the legacy singular reader pinned to the predecessor key during version skew", async () => {
      fetchMock.mockResolvedValueOnce(res(200, [
        { id: 9, title: "octogee-gateway-new", key: "ssh-ed25519 NEXT successor" },
        { id: 2, title: "octogee-gateway", key: "ssh-ed25519 OLD predecessor" },
      ]));
      expect(await host.primaryKey("acme")).toBe("ssh-ed25519 OLD predecessor");
    });

    it("returns an empty list on 404 (user not provisioned)", async () => {
      fetchMock.mockResolvedValueOnce(res(404, {}));
      expect(await host.listKeys("acme")).toEqual([]);
    });

    it("returns an empty list when no managed gateway key is present", async () => {
      fetchMock.mockResolvedValueOnce(res(200, [{ id: 1, title: "other", key: "x" }]));
      expect(await host.listKeys("acme")).toEqual([]);
    });
  });

  describe("releaseKey", () => {
    it("removes only the retiring predecessor key and preserves the successor key", async () => {
      fetchMock
        .mockResolvedValueOnce(res(200, [
          { id: 7, title: "octogee-gateway-old", key: "ssh-ed25519 OLD predecessor" },
          { id: 9, title: "octogee-gateway-new", key: "ssh-ed25519 NEXT successor" },
        ]))
        .mockResolvedValueOnce(res(204));
      await host.releaseKey("acme", "ssh-ed25519 OLD retiring-comment");

      expect(callsTo(fetchMock)).toEqual([
        expect.objectContaining({
          url: `${BASE}/users/ws-acme/keys?limit=50&page=1`,
          method: "GET",
        }),
        expect.objectContaining({
          url: `${BASE}/admin/users/ws-acme/keys/7`,
          method: "DELETE",
        }),
      ]);
    });

    it("cannot delete another pod's managed key even when its public key is submitted", async () => {
      fetchMock.mockResolvedValueOnce(res(200, [
        { id: 7, title: "octogee-gateway-predecessor", key: "ssh-ed25519 OLD" },
      ]));
      await host.releaseKey("acme", "ssh-ed25519 OLD", "walter/pod-new");

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("treats an already-cleaned retiring key as an idempotent success", async () => {
      fetchMock.mockResolvedValueOnce(res(200, [
        { id: 9, title: "octogee-gateway-new", key: "ssh-ed25519 NEXT successor" },
      ]));
      await expect(
        host.releaseKey("acme", "ssh-ed25519 OLD retiring-comment"),
      ).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("ensureOwner", () => {
    it("creates org + builders team + adds the ws user as member", async () => {
      fetchMock
        .mockResolvedValueOnce(res(201, {})) // POST /orgs
        .mockResolvedValueOnce(res(201, { id: 5 })) // POST /orgs/acme/teams
        .mockResolvedValueOnce(res(204)); // PUT member
      await host.ensureOwner("acme");

      const calls = callsTo(fetchMock);
      expect(calls[0]).toMatchObject({ url: `${BASE}/orgs`, method: "POST" });
      expect(calls[0].body).toMatchObject({ username: "acme", visibility: "private" });
      expect(calls[1]).toMatchObject({ url: `${BASE}/orgs/acme/teams`, method: "POST" });
      expect(calls[1].body).toMatchObject({ name: "builders", permission: "write" });
      expect(calls[2]).toMatchObject({ url: `${BASE}/teams/5/members/ws-acme`, method: "PUT" });
    });

    it("resolves an existing builders team when create returns 422", async () => {
      fetchMock
        .mockResolvedValueOnce(res(422, {})) // org exists
        .mockResolvedValueOnce(res(422, {})) // team exists
        .mockResolvedValueOnce(res(200, [{ id: 9, name: "builders" }])) // GET teams
        .mockResolvedValueOnce(res(204)); // PUT member
      await host.ensureOwner("acme");

      const calls = callsTo(fetchMock);
      expect(calls[2]).toMatchObject({ url: `${BASE}/orgs/acme/teams`, method: "GET" });
      expect(calls[3]).toMatchObject({ url: `${BASE}/teams/9/members/ws-acme`, method: "PUT" });
    });
  });

  describe("ensureRepo workspace", () => {
    it("creates the private workspace repo with auto_init false", async () => {
      fetchMock.mockResolvedValueOnce(res(201, {}));
      await host.ensureRepo("acme", { kind: "workspace" });

      const c = callsTo(fetchMock)[0];
      expect(c).toMatchObject({ url: `${BASE}/orgs/acme/repos`, method: "POST" });
      expect(c.body).toMatchObject({ name: "workspace", private: true, auto_init: false });
    });

    it("treats 409 (already exists) as success", async () => {
      fetchMock.mockResolvedValueOnce(res(409, {}));
      await expect(host.ensureRepo("acme", { kind: "workspace" })).resolves.toBeUndefined();
    });
  });

  describe("ensureRepo system-config", () => {
    it("creates the private system_config repo with auto_init false", async () => {
      fetchMock.mockResolvedValueOnce(res(201, {}));
      await host.ensureRepo("acme", { kind: "system-config" });

      const c = callsTo(fetchMock)[0];
      expect(c).toMatchObject({ url: `${BASE}/orgs/acme/repos`, method: "POST" });
      expect(c.body).toMatchObject({ name: "system_config", private: true, auto_init: false });
    });

    it("treats 409 (already exists) as success", async () => {
      fetchMock.mockResolvedValueOnce(res(409, {}));
      await expect(host.ensureRepo("acme", { kind: "system-config" })).resolves.toBeUndefined();
    });
  });

  describe("ensureRepo project", () => {
    it("creates the private project repo named after the project", async () => {
      fetchMock.mockResolvedValueOnce(res(201, {}));
      await host.ensureRepo("acme", { kind: "project", projectSlug: "mygame" });

      const c = callsTo(fetchMock)[0];
      expect(c).toMatchObject({ url: `${BASE}/orgs/acme/repos`, method: "POST" });
      expect(c.body).toMatchObject({ name: "mygame", private: true, auto_init: false });
    });
  });

  describe("repoExists", () => {
    it("returns true on 200", async () => {
      fetchMock.mockResolvedValueOnce(res(200, { id: 1 }));
      expect(await host.repoExists({ owner: "acme", repo: "workspace" })).toBe(true);
      expect(callsTo(fetchMock)[0]).toMatchObject({ url: `${BASE}/repos/acme/workspace`, method: "GET" });
    });

    it("returns false on 404", async () => {
      fetchMock.mockResolvedValueOnce(res(404, {}));
      expect(await host.repoExists({ owner: "acme", repo: "workspace" })).toBe(false);
    });
  });

  describe("archiveRepo and restoreRepo", () => {
    it("PATCHes archived:true", async () => {
      fetchMock.mockResolvedValueOnce(res(200, {}));
      await host.archiveRepo({ owner: "acme", repo: "workspace" });

      const c = callsTo(fetchMock)[0];
      expect(c).toMatchObject({ url: `${BASE}/repos/acme/workspace`, method: "PATCH" });
      expect(c.body).toMatchObject({ archived: true });
    });

    it("PATCHes archived:false when paid project access returns", async () => {
      fetchMock.mockResolvedValueOnce(res(200, {}));
      await host.restoreRepo({ owner: "acme", repo: "workspace" });

      const c = callsTo(fetchMock)[0];
      expect(c).toMatchObject({ url: `${BASE}/repos/acme/workspace`, method: "PATCH" });
      expect(c.body).toEqual({ archived: false });
    });

    it("tolerates 404 (repo already gone) as a no-op", async () => {
      fetchMock.mockResolvedValueOnce(res(404, {}));
      await expect(host.archiveRepo({ owner: "acme", repo: "workspace" })).resolves.toBeUndefined();
    });
  });

  it("refuses to start a request when the admin token is unavailable", async () => {
    const tokenless = createGiteaGitHost({
      apiBaseUrl: BASE,
      token: () => {
        throw new Error("GITEA_TOKEN not configured");
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(tokenless.repoExists({ owner: "acme", repo: "workspace" })).rejects.toThrow(/GITEA_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("ensureRepo project-agents", () => {
    it("creates the private project agents repo on main", async () => {
      fetchMock.mockResolvedValueOnce(res(201, {}));
      await host.ensureRepo("acme", { kind: "project-coaches" });

      const c = callsTo(fetchMock)[0];
      expect(c).toMatchObject({ url: `${BASE}/orgs/acme/repos`, method: "POST" });
      expect(c.body).toMatchObject({
        name: "project_coaches",
        private: true,
        default_branch: "main",
        auto_init: false,
      });
    });

    it("fails loud with the role's operation name", async () => {
      fetchMock.mockResolvedValueOnce(res(500, { message: "boom" }));
      await expect(host.ensureRepo("acme", { kind: "project-coaches" })).rejects.toThrow(
        /create-project-coach-repo failed: 500 boom/,
      );
    });
  });

  describe("setUserPassword", () => {
    it("sets the ws-<slug> password, requires a change at first sign-in, and returns the login", async () => {
      fetchMock.mockResolvedValue(res(200, {}));
      await expect(host.setUserPassword("alice", "s3cret-value")).resolves.toBe("ws-alice");
      expect(callsTo(fetchMock)).toEqual([
        {
          method: "PATCH",
          url: `${BASE}/admin/users/ws-alice`,
          body: { login_name: "ws-alice", source_id: 0, password: "s3cret-value", must_change_password: true },
        },
      ]);
    });

    it("fails loudly when Gitea refuses, without echoing the password", async () => {
      fetchMock.mockResolvedValue(res(422, { message: "password is too weak" }));
      const failure = await host.setUserPassword("alice", "s3cret-value").catch((error: Error) => error);
      expect(String(failure)).toContain("set-password failed: 422");
      expect(String(failure)).not.toContain("s3cret-value");
    });
  });

  describe("blockSignIn", () => {
    it("prohibits the ws-<slug> user from signing in with the admin token", async () => {
      fetchMock.mockResolvedValue(res(200, {}));

      await host.blockSignIn("alice");

      expect(callsTo(fetchMock)).toEqual([
        {
          method: "PATCH",
          url: `${BASE}/admin/users/ws-alice`,
          body: { login_name: "ws-alice", source_id: 0, prohibit_login: true },
        },
      ]);
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("token admin-tok");
    });

    it("treats a user Gitea no longer has as already unable to sign in", async () => {
      const log = vi.fn();
      const logged = createGiteaGitHost({
        apiBaseUrl: BASE,
        token: () => "admin-tok",
        fetch: fetchMock as unknown as typeof fetch,
        log,
      });
      fetchMock.mockResolvedValue(res(404, { message: "user does not exist" }));

      await expect(logged.blockSignIn("ghost")).resolves.toBeUndefined();

      expect(log).toHaveBeenCalledWith(expect.stringContaining("ws-ghost"));
    });

    it("fails with the status when Gitea refuses", async () => {
      fetchMock.mockResolvedValue(res(500, { message: "database is locked" }));

      await expect(host.blockSignIn("alice")).rejects.toThrow("block-sign-in failed: 500 database is locked");
    });
  });

  describe("eraseOwner", () => {
    it("deletes every repo, then the owner org, then the ws-<slug> user with the admin token", async () => {
      fetchMock.mockResolvedValue(res(204));
      await host.eraseOwner("alice", ["workspace", "blog"]);

      expect(callsTo(fetchMock)).toEqual([
        expect.objectContaining({ method: "DELETE", url: `${BASE}/repos/alice/workspace` }),
        expect.objectContaining({ method: "DELETE", url: `${BASE}/repos/alice/blog` }),
        expect.objectContaining({ method: "DELETE", url: `${BASE}/orgs/alice` }),
        expect.objectContaining({ method: "DELETE", url: `${BASE}/admin/users/ws-alice` }),
      ]);
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("token admin-tok");
    });

    it("treats 404 as already gone at every level", async () => {
      fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));
      await expect(host.eraseOwner("ghost", ["missing"])).resolves.toBeUndefined();
    });

    it("throws with the status and body when a delete fails", async () => {
      fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
      await expect(host.eraseOwner("alice", ["x"])).rejects.toThrow(/deleteRepo alice\/x failed: 500 boom/);
    });
  });
});
