import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UserProvisioningSpec } from "@octogee/shared/types/provisioning-service";
import { startFakeProvisioningService, type FakeProvisioningService } from "./fixtures/provisioning-service-fake.js";
import {
  createProvisioningServiceClient,
  provisioningServiceConfigFromEnvironment,
  ProvisioningServiceError,
  startProvisioningWatch,
  type ProvisioningChange,
  type ProvisioningServiceClientOptions,
  type ProvisioningServiceRequestOutcome,
} from "./provisioning-service-client.js";

const SPEC: UserProvisioningSpec = {
  slug: "lin",
  displayName: { first: "lin", last: "Wu" },
  email: "lin@example.test",
  avatarUrl: null,
  chat: { teamDisplayName: "Lin's Workspace", defaultAgent: { enabled: true } },
  git: { repositories: ["workspace", "project-coaches"], systemConfigRepository: true },
  agentIds: ["octogee-lin-coach"],
};

const describeChange = (change: ProvisioningChange) => change.kind === "deleted" ? `deleted ${change.uid}` : `upsert ${change.resource.uid}`;
const versionOf = (change: ProvisioningChange) => change.kind === "deleted" ? change.resourceVersion : change.resource.resourceVersion;

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
}

let fake: FakeProvisioningService;
let token: string;
let outcomes: ProvisioningServiceRequestOutcome[];
let sleeps: number[];

function client(overrides: Partial<ProvisioningServiceClientOptions> = {}) {
  return createProvisioningServiceClient({
    baseUrl: fake.url,
    tokenPath: "/var/run/secrets/provisioning-service/token",
    readToken: async () => token,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    onRequest: (outcome) => outcomes.push(outcome),
    ...overrides,
  });
}

beforeEach(async () => {
  fake = await startFakeProvisioningService({ tokens: ["token-1"] });
  token = "token-1";
  outcomes = [];
  sleeps = [];
});

afterEach(async () => {
  await fake.close();
});

describe("provisioning service configuration", () => {
  it("is off when no service URL is set", () => {
    expect(provisioningServiceConfigFromEnvironment({})).toBeNull();
  });

  it("refuses a service URL without a token path", () => {
    expect(() => provisioningServiceConfigFromEnvironment({ PROVISIONING_SERVICE_URL: "http://svc" })).toThrow(/TOKEN_PATH/);
  });

  it("reads the URL and token path", () => {
    expect(provisioningServiceConfigFromEnvironment({
      PROVISIONING_SERVICE_URL: "http://svc",
      PROVISIONING_SERVICE_TOKEN_PATH: "/token",
    })).toEqual({ baseUrl: "http://svc", tokenPath: "/token" });
  });
});

describe("provisioning service client", () => {
  it("creates, leaves unchanged and changes a user's spec with the projected token", async () => {
    const api = client();

    const created = await api.putProvisioning("u1", SPEC);
    const unchanged = await api.putProvisioning("u1", SPEC);
    const changed = await api.putProvisioning("u1", { ...SPEC, email: "new@example.test" });

    expect([created.outcome, unchanged.outcome, changed.outcome]).toEqual(["created", "unchanged", "changed"]);
    expect(changed.resource.generation).toBe(2);
    expect(fake.requests[0]).toMatchObject({ method: "PUT", path: "/v1/users/u1/provisioning", authorization: "Bearer token-1" });
  });

  it("sends expectedResourceVersion and surfaces precondition-failed without retrying", async () => {
    const api = client();
    await api.putProvisioning("u1", SPEC);

    const error = await api.putProvisioning("u1", SPEC, { expectedResourceVersion: "999" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProvisioningServiceError);
    expect(error).toMatchObject({ status: 409, code: "precondition-failed" });
    expect(fake.requests.at(-1)?.body).toEqual({ spec: SPEC, expectedResourceVersion: "999" });
    expect(sleeps).toEqual([]);
  });

  it("answers null for a user the service does not manage", async () => {
    await expect(client().getProvisioning("nobody")).resolves.toBeNull();
    await expect(client().getProvisioningEvents("nobody")).resolves.toBeNull();
  });

  it("long-polls a single resource with waitForGeneration", async () => {
    const api = client();
    await api.putProvisioning("u1", SPEC);

    await api.getProvisioning("u1", { waitForGeneration: 1, timeoutSeconds: 5 });

    expect(fake.requests.at(-1)?.query).toEqual({ waitForGeneration: "1", timeoutSeconds: "5" });
  });

  it("retries transient failures with backoff, honouring Retry-After", async () => {
    fake.failNext(503, 1, 2);
    fake.failNext(500);

    await client().putProvisioning("u1", SPEC);

    expect(sleeps).toEqual([2000, 1000]);
    expect(outcomes).toEqual(["server-error", "server-error", "ok"]);
  });

  it("gives up after the configured attempts and reports the last error", async () => {
    fake.failNext(503, 5);

    await expect(client().putProvisioning("u1", SPEC)).rejects.toMatchObject({ status: 503, transient: true });
    expect(outcomes).toEqual(["server-error", "server-error", "server-error", "server-error"]);
  });

  it("reports an unreachable service as a transient error", async () => {
    await fake.close();
    const api = client({ retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 } });

    await expect(api.listProvisionings()).rejects.toMatchObject({ code: "unreachable", transient: true });
    expect(outcomes).toEqual(["unreachable", "unreachable"]);
    fake = await startFakeProvisioningService();
  });

  it("re-reads a rotated token when the service rejects the cached one", async () => {
    const api = client();
    await api.putProvisioning("u1", SPEC);
    fake.acceptedTokens = new Set(["token-2"]);
    token = "token-2";

    await api.getProvisioning("u1");

    expect(fake.requests.slice(-2).map((request) => request.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("does not retry a request the service refuses", async () => {
    fake.acceptedTokens = new Set(["other"]);

    await expect(client().getProvisioning("u1")).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(sleeps).toEqual([]);
  });

  it("lists every page and returns the first page's resource version", async () => {
    const api = client();
    for (const uid of ["a", "b", "c"]) await api.putProvisioning(uid, SPEC);

    const listed = await api.listAllProvisionings({ limit: 2 });

    expect(listed.items.map((item) => item.uid)).toEqual(["a", "b", "c"]);
    expect(listed.resourceVersion).toBe("3");
  });

  it("passes the ready filter through", async () => {
    await client().listProvisionings({ ready: false });

    expect(fake.requests.at(-1)?.query).toEqual({ ready: "false" });
  });

  it("sends the retry with its idempotency key", async () => {
    const api = client();
    await api.putProvisioning("u1", SPEC);

    await api.retryProvisioning("u1", { expectedAttempts: 0 }, "key-1");

    expect(fake.requests.at(-1)).toMatchObject({ method: "POST", path: "/v1/users/u1/provisioning/retry", idempotencyKey: "key-1", body: { expectedAttempts: 0 } });
  });

  it("waits out a rate limit with its capped Retry-After, then succeeds", async () => {
    fake.failNext(429, 1, 3600);

    await client().putProvisioning("u1", SPEC);

    expect(sleeps).toEqual([10_000]);
    expect(outcomes).toEqual(["client-error", "ok"]);
    expect(fake.resources.has("u1")).toBe(true);
  });

  it("caps a long Retry-After at the retry policy's maximum delay", async () => {
    fake.failNext(503, 1, 3600);

    await client().putProvisioning("u1", SPEC);

    expect(sleeps).toEqual([10_000]);
  });

  it("sends any uid the platform admits as one encoded path segment", async () => {
    const api = client();

    await api.getProvisioning("lin@example.test/x?y#z %").catch(() => undefined);
    await api.getCredential("../provisionings", "user-chat-token").catch(() => undefined);

    expect(fake.requests.map((request) => request.path)).toEqual([
      "/v1/users/lin%40example.test%2Fx%3Fy%23z%20%25/provisioning",
      "/v1/users/..%2Fprovisionings/credentials/user-chat-token",
    ]);
  });

  it("refuses only the dot segments a URL path cannot carry, without a request", async () => {
    const api = client();

    await expect(api.getProvisioning("..")).rejects.toMatchObject({ status: 400, code: "invalid-request" });
    await expect(api.getProvisioning(".")).rejects.toMatchObject({ status: 400, code: "invalid-request" });
    expect(fake.requests).toEqual([]);
  });

  it("stops a request and its retries when the caller aborts", async () => {
    let fetches = 0;
    const api = client({
      retry: { attempts: 5, baseDelayMs: 1, maxDelayMs: 1 },
      fetch: (_url, init) => {
        fetches += 1;
        return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await expect(api.getProvisioning("u1", { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    await expect(api.listProvisionings({}, { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    await expect(api.getProvisioningEvents("u1", { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });

    expect(fetches).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("refuses to follow redirects", async () => {
    const seen: RequestInit[] = [];
    const api = client({
      fetch: async (url, init) => {
        seen.push(init ?? {});
        return fetch(url, init);
      },
    });

    await api.getProvisioning("u1");

    expect(seen.map((init) => init.redirect)).toEqual(["error"]);
  });

  it("answers deleted for a provisioning it removes or that was already gone", async () => {
    const api = client();
    await api.putProvisioning("u1", SPEC);

    await expect(api.deleteProvisioning("u1")).resolves.toBe("deleted");
    await expect(api.deleteProvisioning("u1")).resolves.toBe("deleted");
  });

  it("answers unnameable, not an error, for a uid the service cannot name", async () => {
    await expect(client().deleteProvisioning("lin@example.test")).resolves.toBe("unnameable");
    await expect(client().deleteProvisioning("..")).resolves.toBe("unnameable");
  });

  it("answers unexpected-response when an accepted retry has a body that is not JSON", async () => {
    const api = client({ fetch: async () => new Response("<html>accepted</html>", { status: 202 }) });

    await expect(api.retryProvisioning("u1", {}, "k1")).rejects.toMatchObject({ status: 202, code: "unexpected-response" });
  });

  it("reads an issued credential and answers null while it is not issued", async () => {
    const api = client();
    await api.putProvisioning("u1", SPEC);

    await expect(api.getCredential("u1", "user-chat-token")).resolves.toBeNull();
    fake.issueCredential("u1", "user-chat-token", "user-token-1");

    await expect(api.getCredential("u1", "user-chat-token")).resolves.toEqual({ name: "user-chat-token", value: "user-token-1", version: 1 });
    expect(fake.requests.at(-1)?.path).toBe("/v1/users/u1/credentials/user-chat-token");
  });

  it("surfaces a refused credential read as a 403 without retrying", async () => {
    const api = client();
    await api.putProvisioning("u1", SPEC);
    fake.credentialReader = false;

    await expect(api.getCredential("u1", "agent-chat-token")).rejects.toMatchObject({ status: 403, code: "forbidden", transient: false });
    expect(sleeps).toEqual([]);
  });
});

describe("provisioning watch", () => {
  it("lists, then watches from the list's version, and relists after the version expires", async () => {
    const api = client();
    await api.putProvisioning("a", SPEC);
    const snapshots: string[][] = [];
    const changes: string[][] = [];
    let resolveSecondSnapshot: () => void = () => undefined;
    const secondSnapshot = new Promise<void>((resolve) => {
      resolveSecondSnapshot = resolve;
    });

    const watch = startProvisioningWatch(api, {
      onSnapshot: async (items) => {
        snapshots.push(items.map((item) => item.uid));
        if (snapshots.length === 1) {
          await api.putProvisioning("b", SPEC);
        } else {
          resolveSecondSnapshot();
        }
      },
      onChanges: async (page: readonly ProvisioningChange[]) => {
        changes.push(page.map(describeChange));
        fake.expireBefore(100);
      },
      onError: (error) => {
        throw error;
      },
    }, { timeoutSeconds: 1 });

    await secondSnapshot;
    watch.stop();
    fake.expireBefore(0);
    await api.putProvisioning("c", SPEC);
    await watch.stopped;

    expect(snapshots).toEqual([["a"], ["a", "b"]]);
    expect(changes).toEqual([["upsert b"]]);
  });

  it("applies a page's deletions and changes in resource version order", async () => {
    const api = client();
    const pages: string[][] = [];
    const watch = startProvisioningWatch(api, {
      onSnapshot: async () => {
        await api.putProvisioning("a", SPEC);
        await api.deleteProvisioning("a");
        await api.putProvisioning("a", SPEC);
      },
      onChanges: async (page) => {
        pages.push(page.map((change) => `${describeChange(change)} ${versionOf(change)}`));
      },
      onError: (error) => {
        throw error;
      },
    }, { timeoutSeconds: 1 });

    await until(() => pages.length > 0);
    watch.stop();
    await api.putProvisioning("z", SPEC);
    await watch.stopped;

    expect(pages[0]).toEqual(["deleted a 2", "upsert a 3"]);
  });

  it("follows watch pages until it has caught up", async () => {
    const api = client();
    const seen: string[] = [];
    const watch = startProvisioningWatch(api, {
      onSnapshot: async () => {
        for (const uid of ["a", "b", "c", "d", "e"]) await api.putProvisioning(uid, SPEC);
      },
      onChanges: async (page) => {
        seen.push(...page.map(describeChange));
      },
      onError: (error) => {
        throw error;
      },
    }, { timeoutSeconds: 1, pageLimit: 2 });

    await until(() => seen.length === 5);
    watch.stop();
    await api.putProvisioning("z", SPEC);
    await watch.stopped;

    const watches = fake.requests.filter((request) => request.query.watch === "true");
    expect(seen).toEqual(["upsert a", "upsert b", "upsert c", "upsert d", "upsert e"]);
    expect(watches.slice(0, 3).map((request) => [request.query.limit, request.query.resourceVersion])).toEqual([["2", "0"], ["2", "2"], ["2", "4"]]);
  });

  it("backs off before relisting when the resource version keeps expiring", async () => {
    const watchSleeps: number[] = [];
    let lists = 0;
    const expiring = {
      listAllProvisionings: async () => {
        lists += 1;
        if (lists === 4) watch.stop();
        return { items: [], resourceVersion: "1" };
      },
      watchProvisionings: async () => {
        throw new ProvisioningServiceError(410, "resource-version-expired", "too old");
      },
    };

    const watch = startProvisioningWatch(expiring, {
      onSnapshot: async () => undefined,
      onChanges: async () => undefined,
      onError: () => undefined,
    }, {
      random: () => 0.5,
      retry: { baseDelayMs: 100, maxDelayMs: 1_000 },
      sleep: async (ms) => {
        watchSleeps.push(ms);
      },
    });
    await watch.stopped;

    expect(watchSleeps).toEqual([100, 200]);
  });

  it("backs off and reports while the service is unreachable", async () => {
    const api = client({ retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
    fake.failNext(503, 2);
    const failures: number[] = [];
    let resolveSnapshot: () => void = () => undefined;
    const snapshot = new Promise<void>((resolve) => {
      resolveSnapshot = resolve;
    });
    const watchSleeps: number[] = [];

    const watch = startProvisioningWatch(api, {
      onSnapshot: async () => {
        resolveSnapshot();
      },
      onChanges: async () => undefined,
      onError: (_error, consecutive) => failures.push(consecutive),
    }, {
      timeoutSeconds: 1,
      random: () => 0.5,
      sleep: async (ms) => {
        watchSleeps.push(ms);
      },
    });

    await snapshot;
    watch.stop();
    await watch.stopped;

    expect(failures).toEqual([1, 2]);
    expect(watchSleeps).toEqual([1000, 2000]);
  });
});
