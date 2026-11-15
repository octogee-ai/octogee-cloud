import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROVISIONING_CONDITION_REASONS, PROVISIONING_ERROR_CODES } from "@octogee/shared/types/provisioning-service";
import { condition, dsn, spec, startImplementation, TOKENS, untilReady, type Implementation } from "./harness.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA gateway-a";

function expectContractError(response: { status: number; body: any }, status: number, code: string): void {
  expect(response.status).toBe(status);
  expect(PROVISIONING_ERROR_CODES).toContain(response.body.code);
  expect(response.body).toEqual({ code, error: expect.any(String) });
}

function expectKnownReasons(resource: any): void {
  for (const entry of resource.status.conditions) expect(PROVISIONING_CONDITION_REASONS).toContain(entry.reason);
}

describe.skipIf(!dsn)("provisioning service conformance", { timeout: 120_000 }, () => {
  let implementation: Implementation;

  beforeAll(async () => {
    implementation = await startImplementation();
  }, 120_000);

  afterAll(async () => {
    await implementation?.stop();
  });

  const put = (uid: string, body: unknown, token?: string) => implementation.request("PUT", `/v1/users/${uid}/provisioning`, { body, ...(token ? { token } : {}) });

  it("serves health, readiness and metrics without authentication", async () => {
    for (const path of ["/healthz", "/readyz", "/metrics"]) {
      expect((await fetch(`${implementation.url}${path}`)).status).toBe(200);
    }
    const metrics = await (await fetch(`${implementation.url}/metrics`)).text();
    for (const name of ["provisioning_work", "provisioning_oldest_due_seconds", "provisioning_generation_lag_seconds", "provisioning_lease_expired_total"]) {
      expect(metrics).toContain(name);
    }
  });

  describe("authentication", () => {
    it("answers 401 without a token or for a token of another audience", async () => {
      expectContractError(await implementation.request("GET", "/v1/provisionings", { token: null }), 401, "unauthenticated");
      expectContractError(await implementation.request("GET", "/v1/provisionings", { token: TOKENS.wrongAudience }), 401, "unauthenticated");
    });

    it("answers 403 for a service account outside the role table or outside the caller namespace", async () => {
      expectContractError(await implementation.request("GET", "/v1/provisionings", { token: TOKENS.stranger }), 403, "forbidden");
      expectContractError(await implementation.request("GET", "/v1/provisionings", { token: TOKENS.otherNamespace }), 403, "forbidden");
    });

    it("limits each role to its routes", async () => {
      expectContractError(await put("auth-1", { spec: spec("auth-one") }, TOKENS.platformApi), 403, "forbidden");
      expect((await put("auth-1", { spec: spec("auth-one") })).status).toBe(201);
      expect((await implementation.request("GET", "/v1/users/auth-1/provisioning", { token: TOKENS.platformApi })).status).toBe(200);
      expectContractError(await implementation.request("POST", "/v1/users/auth-1/provisioning/retry", { token: TOKENS.platformApi, body: {} }), 403, "forbidden");
      expectContractError(await implementation.request("DELETE", "/v1/users/auth-1/provisioning", { token: TOKENS.platformApi }), 403, "forbidden");
      expectContractError(await implementation.request("PUT", "/v1/users/auth-1/git-keys/gw-1", { body: { spec: { publicKey: KEY } } }), 403, "forbidden");
      expect((await implementation.request("GET", "/v1/users/auth-1/credentials/user-chat-token")).status).not.toBe(403);
    });
  });

  describe("desired state", () => {
    it("converges a new spec to Ready with its outputs and credentials", async () => {
      const created = await put("conv-1", { spec: spec("conv-one", { git: { repositories: ["workspace", "project-coaches"], systemConfigRepository: true } }) });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ uid: "conv-1", generation: 1, resourceVersion: expect.any(String) });
      const resource = await untilReady(implementation, "conv-1", 1);
      expect(resource.status.observedGeneration).toBe(1);
      for (const type of ["ChatReady", "GitReady", "CredentialsIssued", "Ready"]) expect(condition(resource, type)).toMatchObject({ status: "True" });
      expectKnownReasons(resource);
      expect(resource.status.work.state).toBe("idle");
      expect(resource.status.outputs.chat).toMatchObject({ userId: expect.any(String), teamId: expect.any(String), channels: { general: expect.any(String) } });
      expect(Object.keys(resource.status.outputs.git.repositories).sort()).toEqual(["project-coaches", "system-config", "workspace"]);
      expect([...resource.status.outputs.credentials].sort()).toEqual(["agent-chat-token", "user-chat-token"]);
      const events = await implementation.request("GET", "/v1/users/conv-1/provisioning/events");
      expect(events.body.items[0]).toMatchObject({ generation: 1, result: "succeeded", steps: expect.any(Array) });
    });

    it("does not bump the generation or the resource version for an identical spec", async () => {
      const first = await put("same-1", { spec: spec("same-one") });
      const again = await put("same-1", { spec: spec("same-one") });
      expect(again.status).toBe(200);
      expect(again.body.generation).toBe(1);
      const resource = await untilReady(implementation, "same-1", 1);
      const settled = await put("same-1", { spec: spec("same-one") });
      expect(settled).toMatchObject({ status: 200, body: { generation: 1, resourceVersion: resource.resourceVersion } });
      expect(BigInt(resource.resourceVersion)).toBeGreaterThanOrEqual(BigInt(first.body.resourceVersion));
    });

    it("answers a changed spec with 202 and a new generation", async () => {
      await put("chg-1", { spec: spec("chg-one") });
      const changed = await put("chg-1", { spec: spec("chg-one", { agentIds: ["main", "second"] }) });
      expect(changed.status).toBe(202);
      expect(changed.body.generation).toBe(2);
      expect((await untilReady(implementation, "chg-1", 2)).status.observedGeneration).toBe(2);
    });

    it("answers 409 precondition-failed and writes nothing when expectedResourceVersion no longer holds", async () => {
      const created = await put("pre-1", { spec: spec("pre-one") });
      await put("pre-1", { spec: spec("pre-one", { agentIds: ["other"] }) });
      expectContractError(await put("pre-1", { spec: spec("pre-changed"), expectedResourceVersion: created.body.resourceVersion }), 409, "precondition-failed");
      expect((await implementation.request("GET", "/v1/users/pre-1/provisioning")).body.spec.slug).toBe("pre-one");
    });

    it("rejects an invalid spec with 400 invalid-request", async () => {
      expectContractError(await put("bad-1", { spec: { slug: "bad-one" } }), 400, "invalid-request");
      expectContractError(await put("bad-1", { spec: spec("bad-one", { git: { repositories: ["no-such-role" as "workspace"], systemConfigRepository: false } }) }), 400, "invalid-request");
    });

    it("answers 404 for an unknown user and stops managing a deleted one", async () => {
      expectContractError(await implementation.request("GET", "/v1/users/never-1/provisioning"), 404, "not-found");
      await put("del-1", { spec: spec("del-one") });
      await untilReady(implementation, "del-1", 1);
      expect((await implementation.request("DELETE", "/v1/users/del-1/provisioning")).status).toBe(204);
      expect((await implementation.request("DELETE", "/v1/users/del-1/provisioning")).status).toBe(204);
      expectContractError(await implementation.request("GET", "/v1/users/del-1/provisioning"), 404, "not-found");
    });

    it("refuses to retry work that is neither parked nor retrying", async () => {
      await put("rty-1", { spec: spec("rty-one") });
      await untilReady(implementation, "rty-1", 1);
      expectContractError(await implementation.request("POST", "/v1/users/rty-1/provisioning/retry", { body: {} }), 409, "not-retryable");
      expectContractError(await implementation.request("POST", "/v1/users/rty-1/provisioning/retry", { body: { expectedAttempts: 9 } }), 409, "precondition-failed");
      expectContractError(await implementation.request("POST", "/v1/users/rty-none/provisioning/retry", { body: {} }), 404, "not-found");
    });
  });

  describe("git keys and credentials", () => {
    it("authorizes a key for a provisioned user and reports it registered", async () => {
      expectContractError(await implementation.request("PUT", "/v1/users/key-none/git-keys/gw-1", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY } } }), 404, "not-found");
      await put("key-1", { spec: spec("key-one") });
      const created = await implementation.request("PUT", "/v1/users/key-1/git-keys/gw-1", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY } } });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ uid: "key-1", gatewayId: "gw-1", generation: 1, deletionRequestedAt: null, spec: { publicKey: KEY } });
      await untilReady(implementation, "key-1", 1);
      let registered: any;
      for (let poll = 0; poll < 50; poll += 1) {
        registered = await implementation.request("PUT", "/v1/users/key-1/git-keys/gw-1", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY } } });
        if (registered.body.status.conditions.some((entry: { type: string; status: string }) => entry.type === "Registered" && entry.status === "True")) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(registered.status).toBe(200);
      expect(registered.body.status.conditions).toContainEqual(expect.objectContaining({ type: "Registered", status: "True" }));
      expect((await implementation.request("DELETE", "/v1/users/key-1/git-keys/gw-1", { token: TOKENS.platformApi })).status).toBe(202);
    });

    it("serves an issued credential with no-store and answers 404 for an unknown name", async () => {
      await put("cred-1", { spec: spec("cred-one") });
      await untilReady(implementation, "cred-1", 1);
      const credential = await implementation.request("GET", "/v1/users/cred-1/credentials/user-chat-token", { token: TOKENS.platformApi });
      expect(credential.status).toBe(200);
      expect(credential.headers.get("cache-control")).toBe("no-store");
      expect(credential.body).toEqual({ name: "user-chat-token", value: expect.any(String), version: expect.any(Number) });
      expectContractError(await implementation.request("GET", "/v1/users/cred-1/credentials/no-such-name", { token: TOKENS.platformApi }), 404, "not-found");
      expectContractError(await implementation.request("GET", "/v1/users/cred-none/credentials/user-chat-token", { token: TOKENS.platformApi }), 404, "not-found");
    });
  });

  describe("list and watch", () => {
    it("pages a list with an opaque token and filters by readiness", async () => {
      for (const uid of ["list-a", "list-b", "list-c"]) await put(uid, { spec: spec(uid) });
      for (const uid of ["list-a", "list-b", "list-c"]) await untilReady(implementation, uid, 1);
      const uids: string[] = [];
      let pageToken: string | undefined;
      do {
        const page = await implementation.request("GET", `/v1/provisionings?limit=2${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
        expect(page.status).toBe(200);
        expect(page.body.items.length).toBeLessThanOrEqual(2);
        expect(page.body.resourceVersion).toEqual(expect.any(String));
        uids.push(...page.body.items.map((item: { uid: string }) => item.uid));
        pageToken = page.body.nextPageToken;
      } while (pageToken);
      expect(uids).toEqual(expect.arrayContaining(["list-a", "list-b", "list-c"]));
      expect(new Set(uids).size).toBe(uids.length);
      const ready = await implementation.request("GET", "/v1/provisionings?ready=true&limit=500");
      expect(ready.body.items.every((item: any) => condition(item, "Ready")?.status === "True")).toBe(true);
    });

    it("sees every change from many concurrent writers, in version order, while reconnecting at random", async () => {
      const writers = 1_000;
      const start = (await implementation.request("GET", "/v1/provisionings?limit=1")).body.resourceVersion as string;
      const seen = new Map<string, any>();
      let from = start;
      let previous = BigInt(start);
      let writing = true;

      const watching = (async () => {
        while (writing || seen.size < writers) {
          const controller = new AbortController();
          const reconnect = setTimeout(() => controller.abort(), Math.floor(Math.random() * 300));
          let response: Response;
          try {
            response = await fetch(`${implementation.url}/v1/provisionings?watch=true&resourceVersion=${from}&timeoutSeconds=2`, {
              headers: { authorization: `Bearer ${TOKENS.writer}` }, signal: controller.signal,
            });
          } catch {
            continue;
          } finally {
            clearTimeout(reconnect);
          }
          let body: any;
          try {
            body = await response.json();
          } catch {
            continue;
          }
          expect(response.status).toBe(200);
          const version = BigInt(body.resourceVersion);
          expect(version).toBeGreaterThanOrEqual(previous);
          let last = BigInt(from);
          for (const item of body.items) {
            const itemVersion = BigInt(item.resourceVersion);
            expect(itemVersion).toBeGreaterThan(last);
            expect(itemVersion).toBeLessThanOrEqual(version);
            last = itemVersion;
            if (item.uid.startsWith("watch-")) seen.set(item.uid, item);
          }
          previous = version;
          from = body.resourceVersion;
        }
      })();

      const uids = Array.from({ length: writers }, (_, index) => `watch-${index}`);
      for (let offset = 0; offset < uids.length; offset += 50) {
        await Promise.all(uids.slice(offset, offset + 50).map((uid) => put(uid, { spec: spec(uid) }).then((response) => expect(response.status).toBe(201))));
      }
      writing = false;
      await watching;
      expect([...seen.keys()].sort()).toEqual([...uids].sort());
    });

    it("reports a deleted user in the watch, before a re-create of the same uid, and answers a waiter on it with 404", async () => {
      expect((await put("gone-1", { spec: spec("gone-one") })).status).toBe(201);
      const from = (await implementation.request("GET", "/v1/provisionings")).body.resourceVersion;
      const waiting = implementation.request("GET", "/v1/users/gone-1/provisioning?waitForGeneration=99&timeoutSeconds=30");
      await new Promise((resolve) => setTimeout(resolve, 200));
      const began = Date.now();
      expect((await implementation.request("DELETE", "/v1/users/gone-1/provisioning")).status).toBe(204);
      expectContractError(await waiting, 404, "not-found");
      expect(Date.now() - began).toBeLessThan(5_000);
      expect((await put("gone-1", { spec: spec("gone-one") })).status).toBe(201);
      const watched = (await implementation.request("GET", `/v1/provisionings?watch=true&resourceVersion=${from}&timeoutSeconds=0`)).body;
      expect(watched.deleted.map((entry: { uid: string }) => entry.uid)).toEqual(["gone-1"]);
      const recreated = watched.items.find((item: { uid: string }) => item.uid === "gone-1");
      expect(BigInt(watched.deleted[0].resourceVersion)).toBeLessThan(BigInt(recreated.resourceVersion));
    });

    it("answers 410 resource-version-expired for a version outside the retained window", async () => {
      expectContractError(await implementation.request("GET", "/v1/provisionings?watch=true&resourceVersion=999999999999&timeoutSeconds=0"), 410, "resource-version-expired");
    });
  });
});
