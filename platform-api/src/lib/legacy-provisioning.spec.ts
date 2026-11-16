import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  GitKey,
  ProvisioningCondition,
  ProvisioningConditionReason,
  ProvisioningCredential,
  UserProvisioning,
  UserProvisioningConditionType,
} from "@octogee/shared/types/provisioning-service";
import { createProvisioningServiceClient, ProvisioningServiceError } from "@octogee/core/provisioning-service-client";
import { logger } from "@octogee/core/http/logging";
import {
  createLegacyProvisioning,
  LEGACY_ROUTE_DEADLINE_MS,
  legacyProvisioningFromEnvironment,
  routeBudget,
  type LegacyProvisioningClient,
  type RouteBudget,
} from "./legacy-provisioning.js";

const NOW = Date.parse("2026-11-15T18:00:00Z");
const CHAT = { userId: "mm-lin", teamId: "team-lin", channels: { general: "ch-general", agent: "ch-agent" }, agentBotUserId: "bot-lin" };

function condition(type: UserProvisioningConditionType, status: "True" | "False", reason: ProvisioningConditionReason): ProvisioningCondition<UserProvisioningConditionType> {
  return { type, status, reason, message: "", lastTransitionTime: "2026-11-15T17:59:00Z", observedGeneration: 1 };
}

function resource(overrides: {
  generation?: number;
  observedGeneration?: number;
  conditions?: ProvisioningCondition<UserProvisioningConditionType>[];
  chat?: typeof CHAT;
  systemConfigRepository?: boolean;
  work?: UserProvisioning["status"]["work"];
} = {}): UserProvisioning {
  return {
    uid: "uid-lin",
    generation: overrides.generation ?? 1,
    resourceVersion: "7",
    spec: {
      slug: "lin",
      displayName: { first: "Lin", last: "Wu" },
      email: "lin@example.test",
      avatarUrl: null,
      chat: { teamDisplayName: "Lin", defaultAgent: { enabled: true } },
      git: { repositories: ["workspace", "project-coaches"], systemConfigRepository: overrides.systemConfigRepository ?? true },
      agentIds: ["octogee-lin-coach"],
    },
    status: {
      observedGeneration: overrides.observedGeneration ?? 1,
      conditions: overrides.conditions ?? [],
      outputs: { ...(overrides.chat ? { chat: overrides.chat } : {}), credentials: [] },
      work: overrides.work ?? { state: "idle", attempts: 1, nextAttemptAt: null, lastAttemptAt: null },
    },
  };
}

function gitKey(overrides: { generation?: number; observedGeneration?: number; registered?: "True" | "False"; reason?: ProvisioningConditionReason; message?: string } = {}): GitKey {
  const generation = overrides.generation ?? 1;
  return {
    uid: "uid-lin",
    gatewayId: "walter",
    generation,
    resourceVersion: "9",
    deletionRequestedAt: null,
    spec: { publicKey: "ssh-ed25519 AAAA lin" },
    status: {
      observedGeneration: overrides.observedGeneration ?? generation,
      conditions: overrides.registered === undefined ? [] : [{
        type: "Registered",
        status: overrides.registered,
        reason: overrides.reason ?? (overrides.registered === "True" ? "Converged" : "GitKeyFailed"),
        message: overrides.message ?? "",
        lastTransitionTime: "2026-11-15T17:59:00Z",
        observedGeneration: overrides.observedGeneration ?? generation,
      }],
    },
  };
}

function fakeClient(answers: Array<UserProvisioning | null | Error>, credential: ProvisioningCredential | null | Error = null, keys: Array<GitKey | Error> = []) {
  const calls: Array<{ uid: string; options: unknown }> = [];
  const keyPuts: Array<{ uid: string; gatewayId: string; spec: unknown; options: unknown }> = [];
  const client: LegacyProvisioningClient = {
    getProvisioning: vi.fn(async (uid, options) => {
      calls.push({ uid, options });
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    }),
    getCredential: vi.fn(async () => {
      if (credential instanceof Error) throw credential;
      return credential;
    }),
    putGitKey: vi.fn(async (uid, gatewayId, spec, options) => {
      keyPuts.push({ uid, gatewayId, spec, options });
      const answer = keys.length > 1 ? keys.shift() : keys[0];
      if (answer === undefined) throw new Error("no git key answer left");
      if (answer instanceof Error) throw answer;
      return { outcome: "unchanged" as const, key: answer };
    }),
  };
  return { client, calls, keyPuts };
}

const SIGNAL = new AbortController().signal;

function budget(remainingMs = LEGACY_ROUTE_DEADLINE_MS): RouteBudget {
  return { signal: SIGNAL, remainingMs: () => remainingMs };
}

function adapter(client: LegacyProvisioningClient) {
  return createLegacyProvisioning({ client, now: () => NOW, longPollSeconds: 10 });
}

afterEach(() => vi.restoreAllMocks());

describe("legacy provisioning adapter: chat", () => {
  it("answers the chat outputs once ChatReady is True for the current generation", async () => {
    const { client, calls } = fakeClient([resource({ conditions: [condition("ChatReady", "True", "Converged")], chat: CHAT })]);

    await expect(adapter(client).chat("uid-lin", budget())).resolves.toEqual({ ready: true, value: { slug: "lin", chat: CHAT, resource: expect.objectContaining({ uid: "uid-lin" }) } });
    expect(calls).toEqual([{ uid: "uid-lin", options: { signal: SIGNAL } }]);
  });

  it("long-polls for a generation the service has not observed yet", async () => {
    const { client, calls } = fakeClient([
      resource({ generation: 2, observedGeneration: 1 }),
      resource({ generation: 2, observedGeneration: 2, conditions: [condition("ChatReady", "True", "Converged")], chat: CHAT }),
    ]);

    await expect(adapter(client).chat("uid-lin", budget())).resolves.toMatchObject({ ready: true });
    expect(calls[1]).toEqual({ uid: "uid-lin", options: { waitForGeneration: 2, timeoutSeconds: 10, signal: SIGNAL } });
  });

  it("is not ready while chat is retrying, with the condition's reason and the service's next attempt", async () => {
    const { client } = fakeClient([resource({
      conditions: [condition("ChatReady", "False", "ChatTeamFailed")],
      work: { state: "retrying", attempts: 3, nextAttemptAt: "2026-11-15T18:00:42Z", lastAttemptAt: "2026-11-15T17:59:00Z" },
    })]);

    await expect(adapter(client).chat("uid-lin", budget())).resolves.toEqual({ ready: false, reason: "ChatTeamFailed", retryAfterSeconds: 42 });
  });

  it("is not ready while the generation is still unobserved after the long-poll", async () => {
    const { client } = fakeClient([
      resource({ generation: 2, observedGeneration: 1, conditions: [condition("ChatReady", "True", "Converged")], chat: CHAT }),
      resource({ generation: 2, observedGeneration: 1, conditions: [condition("ChatReady", "True", "Converged")], chat: CHAT }),
    ]);

    await expect(adapter(client).chat("uid-lin", budget())).resolves.toEqual({ ready: false, reason: "GenerationNotObserved", retryAfterSeconds: 5 });
  });

  it("is not ready and logs the uid when the service has no resource for the user", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { client } = fakeClient([null]);

    await expect(adapter(client).chat("uid-lin", budget())).resolves.toEqual({ ready: false, reason: "NotProvisioned", retryAfterSeconds: 5 });
    expect(logged).toHaveBeenCalledWith("legacy provisioning: no provisioning resource exists for the user", { uid: "uid-lin" });
  });

  it("marks a parked user's wait refused and logs its reason", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { client } = fakeClient([resource({
      conditions: [condition("ChatReady", "False", "ChatUserFailed")],
      work: { state: "parked", attempts: 9, nextAttemptAt: null, lastAttemptAt: "2026-11-15T17:59:00Z" },
    })]);

    await expect(adapter(client).chat("uid-lin", budget())).resolves.toEqual({ ready: false, reason: "ChatUserFailed", retryAfterSeconds: 5, refused: true });
    expect(logged).toHaveBeenCalledWith("legacy provisioning: the user's provisioning is parked", { uid: "uid-lin", reason: "ChatUserFailed" });
  });

  it("is not ready while the service is unavailable, honouring its Retry-After", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const { client } = fakeClient([new ProvisioningServiceError(503, "unavailable", "down", 30_000)]);

    await expect(adapter(client).chat("uid-lin", budget())).resolves.toEqual({ ready: false, reason: "ProvisioningServiceUnavailable", retryAfterSeconds: 30 });
  });

  it("throws a refusal from the service", async () => {
    const refusal = new ProvisioningServiceError(403, "forbidden", "role");
    const { client } = fakeClient([refusal]);

    await expect(adapter(client).chat("uid-lin", budget())).rejects.toBe(refusal);
  });
});

describe("legacy provisioning adapter: git", () => {
  it("is ready for the owner and a spec repository once GitReady is True", async () => {
    const ready = () => resource({ conditions: [condition("GitReady", "True", "Converged")] });
    const { client } = fakeClient([ready(), ready()]);
    const provisioning = adapter(client);

    await expect(provisioning.git("uid-lin", null, budget())).resolves.toEqual({ ready: true, value: undefined });
    await expect(provisioning.git("uid-lin", "workspace", budget())).resolves.toEqual({ ready: true, value: undefined });
  });

  it("is not ready while git is retrying", async () => {
    const { client } = fakeClient([resource({ conditions: [condition("GitReady", "False", "GitRepositoryFailed")] })]);

    await expect(adapter(client).git("uid-lin", "workspace", budget())).resolves.toEqual({ ready: false, reason: "GitRepositoryFailed", retryAfterSeconds: 5 });
  });

  it("refuses and logs a repository the user's spec does not carry", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { client } = fakeClient([resource({ systemConfigRepository: false, conditions: [condition("GitReady", "True", "Converged")] })]);

    await expect(adapter(client).git("uid-lin", "system-config", budget())).resolves.toEqual({ ready: false, reason: "RepositoryNotInSpec", retryAfterSeconds: 5 });
    expect(logged).toHaveBeenCalledWith("legacy provisioning: the user's spec carries no such repository", { uid: "uid-lin", repository: "system-config" });
  });
});

describe("legacy provisioning adapter: credentials", () => {
  it("reads the service's agent chat token", async () => {
    const { client } = fakeClient([], { name: "agent-chat-token", value: "agent-token", version: 1 });

    await expect(adapter(client).agentChatToken("uid-lin", budget())).resolves.toEqual({ ready: true, value: "agent-token" });
    expect(client.getCredential).toHaveBeenCalledWith("uid-lin", "agent-chat-token", { signal: SIGNAL });
  });

  it("is not ready and logs the uid before the service has issued it", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { client } = fakeClient([], null);

    await expect(adapter(client).agentChatToken("uid-lin", budget())).resolves.toEqual({ ready: false, reason: "CredentialsNotIssued", retryAfterSeconds: 5 });
    expect(logged).toHaveBeenCalledWith("legacy provisioning: the user's agent chat token is not issued", { uid: "uid-lin" });
  });

  it("is not ready for a user the service has no resource for, apart from an outage", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const missing = fakeClient([], new ProvisioningServiceError(404, "not-found", "no provisioning for this user"));
    const outage = fakeClient([], new ProvisioningServiceError(503, "unavailable", "down", 30_000));

    await expect(adapter(missing.client).agentChatToken("uid-lin", budget())).resolves.toEqual({ ready: false, reason: "NotProvisioned", retryAfterSeconds: 5 });
    await expect(adapter(outage.client).agentChatToken("uid-lin", budget())).resolves.toEqual({ ready: false, reason: "ProvisioningServiceUnavailable", retryAfterSeconds: 30 });
  });

  it("throws a refusal from the service", async () => {
    const refusal = new ProvisioningServiceError(403, "forbidden", "role");
    const { client } = fakeClient([], refusal);

    await expect(adapter(client).agentChatToken("uid-lin", budget())).rejects.toBe(refusal);
  });
});

describe("legacy provisioning adapter: git key", () => {
  function clockedAdapter(client: LegacyProvisioningClient) {
    let clock = NOW;
    const sleeps: number[] = [];
    const provisioning = createLegacyProvisioning({
      client,
      now: () => clock,
      longPollSeconds: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    return { provisioning, sleeps, budget: () => routeBudget(LEGACY_ROUTE_DEADLINE_MS, () => clock) };
  }

  it("puts the gateway's key and is ready once the service reports it registered for the key's current generation", async () => {
    const { client, keyPuts } = fakeClient([], null, [
      gitKey({ generation: 2, observedGeneration: 1, registered: "True" }),
      gitKey({ generation: 2, observedGeneration: 2, registered: "True" }),
    ]);
    const { provisioning, sleeps, budget: route } = clockedAdapter(client);

    await expect(provisioning.gitKey("uid-lin", "walter", "ssh-ed25519 AAAA lin", route())).resolves.toEqual({ ready: true, value: undefined });

    expect(keyPuts.map(({ uid, gatewayId, spec }) => ({ uid, gatewayId, spec }))).toEqual([
      { uid: "uid-lin", gatewayId: "walter", spec: { publicKey: "ssh-ed25519 AAAA lin" } },
      { uid: "uid-lin", gatewayId: "walter", spec: { publicKey: "ssh-ed25519 AAAA lin" } },
    ]);
    expect(sleeps).toEqual([2_000]);
  });

  it("stops waiting inside the route's budget and logs the service's refusal to register the key", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { client, keyPuts } = fakeClient([], null, [gitKey({ registered: "False", reason: "GitKeyFailed", message: "422 from git host" })]);
    const { provisioning, sleeps, budget: route } = clockedAdapter(client);

    await expect(provisioning.gitKey("uid-lin", "walter", "ssh-ed25519 AAAA lin", route()))
      .resolves.toEqual({ ready: false, reason: "GitKeyFailed", retryAfterSeconds: 5 });

    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(LEGACY_ROUTE_DEADLINE_MS - 10_000);
    expect(keyPuts.length).toBe(sleeps.length + 1);
    expect(logged).toHaveBeenCalledWith("legacy provisioning: the provisioning service has not registered the gateway's git key", {
      uid: "uid-lin",
      gatewayId: "walter",
      reason: "GitKeyFailed",
      message: "422 from git host",
    });
  });

  it("is not ready while the service has not observed the key's generation", async () => {
    const { client } = fakeClient([], null, [gitKey({ generation: 1, observedGeneration: 0 })]);
    const { provisioning, budget: route } = clockedAdapter(client);

    await expect(provisioning.gitKey("uid-lin", "walter", "ssh-ed25519 AAAA lin", route()))
      .resolves.toEqual({ ready: false, reason: "GenerationNotObserved", retryAfterSeconds: 5 });
  });

  it("is not ready for a user the service has no resource for, apart from an outage", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const missing = fakeClient([], null, [new ProvisioningServiceError(404, "not-found", "no provisioning for this user")]);
    const down = fakeClient([], null, [new ProvisioningServiceError(503, "unavailable", "down", 7_000)]);

    await expect(clockedAdapter(missing.client).provisioning.gitKey("uid-lin", "walter", "ssh-ed25519 AAAA lin", budget()))
      .resolves.toEqual({ ready: false, reason: "NotProvisioned", retryAfterSeconds: 5 });
    await expect(clockedAdapter(down.client).provisioning.gitKey("uid-lin", "walter", "ssh-ed25519 AAAA lin", budget()))
      .resolves.toEqual({ ready: false, reason: "ProvisioningServiceUnavailable", retryAfterSeconds: 7 });
  });

  it("throws a refusal from the service", async () => {
    const refusal = new ProvisioningServiceError(403, "forbidden", "this caller lacks the key-writer role");
    const { client } = fakeClient([], null, [refusal]);

    await expect(clockedAdapter(client).provisioning.gitKey("uid-lin", "walter", "ssh-ed25519 AAAA lin", budget())).rejects.toBe(refusal);
  });
});

describe("legacy provisioning requests", () => {
  it("only ever reads from the provisioning service, apart from putting the gateway's own git key", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const methods: string[] = [];
    const answers: Response[] = [
      Response.json(resource({ generation: 2, observedGeneration: 1 })),
      Response.json(resource({ generation: 2, observedGeneration: 1 })),
      Response.json({ code: "not-found", error: "no provisioning for this user" }, { status: 404 }),
      Response.json({ code: "unavailable", error: "down" }, { status: 503, headers: { "retry-after": "7" } }),
      Response.json(resource({ conditions: [condition("GitReady", "False", "GitRepositoryFailed")] })),
      Response.json({ code: "not-issued", error: "not issued" }, { status: 409 }),
      Response.json({ code: "not-found", error: "no provisioning for this user" }, { status: 404 }),
      Response.json(gitKey({ registered: "True" })),
    ];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      methods.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url.pathname.replace(/^\/v1\/users\/[^/]+\//, "users/{uid}/")}`);
      const answer = answers.shift();
      if (!answer) throw new Error("no answer left");
      return answer;
    };
    const client = createProvisioningServiceClient({
      baseUrl: "http://provisioning.invalid",
      tokenPath: "/token",
      readToken: async () => "token",
      fetch,
      retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });
    const provisioning = adapter(client);

    await provisioning.chat("uid-lin", budget());
    await provisioning.chat("uid-lin", budget());
    await provisioning.chat("uid-lin", budget());
    await provisioning.git("uid-lin", "workspace", budget());
    await provisioning.agentChatToken("uid-lin", budget());
    await provisioning.agentChatToken("uid-lin", budget());
    await provisioning.gitKey("uid-lin", "walter", "ssh-ed25519 AAAA lin", budget());

    expect(answers).toEqual([]);
    expect(new Set(methods)).toEqual(new Set([
      "GET users/{uid}/provisioning",
      "GET users/{uid}/credentials/agent-chat-token",
      "PUT users/{uid}/git-keys/walter",
    ]));
  });
});

describe("legacy provisioning deadline", () => {
  it("shortens the long poll to what the route's budget leaves after the time reserved for the rest of the route", async () => {
    const { client, calls } = fakeClient([resource({ generation: 2, observedGeneration: 1 }), resource({ generation: 2, observedGeneration: 1 })]);

    await adapter(client).chat("uid-lin", budget(14_000));

    expect(calls[1]).toEqual({ uid: "uid-lin", options: { waitForGeneration: 2, timeoutSeconds: 4, signal: SIGNAL } });
  });

  it("skips the long poll when the budget cannot hold one", async () => {
    const { client, calls } = fakeClient([resource({ generation: 2, observedGeneration: 1 })]);

    await expect(adapter(client).chat("uid-lin", budget(10_500))).resolves.toEqual({ ready: false, reason: "GenerationNotObserved", retryAfterSeconds: 5 });
    expect(calls).toHaveLength(1);
  });

  it("answers a logged timeout within the route's deadline when the service hangs", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const hanging: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const client = createProvisioningServiceClient({
      baseUrl: "http://provisioning.invalid",
      tokenPath: "/token",
      readToken: async () => "token",
      fetch: hanging,
      retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });
    const started = Date.now();
    const route = routeBudget(100);

    await expect(adapter(client).chat("uid-lin", route)).resolves.toEqual({ ready: false, reason: "ProvisioningServiceTimeout", retryAfterSeconds: 5 });
    await expect(adapter(client).agentChatToken("uid-lin", route)).resolves.toEqual({ ready: false, reason: "ProvisioningServiceTimeout", retryAfterSeconds: 5 });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(logged).toHaveBeenCalledWith("legacy provisioning: the route's deadline passed before the provisioning service answered", { uid: "uid-lin" });
  });

  it("keeps the route's whole deadline well inside the gateway's 60 second request timeout", () => {
    expect(LEGACY_ROUTE_DEADLINE_MS).toBeLessThanOrEqual(45_000);
  });
});

describe("legacy provisioning configuration", () => {
  it("is off without a service URL", () => {
    expect(legacyProvisioningFromEnvironment({})).toBeNull();
  });

  it("is on with a service URL and token path", () => {
    expect(legacyProvisioningFromEnvironment({
      PROVISIONING_SERVICE_URL: "http://provisioning-service",
      PROVISIONING_SERVICE_TOKEN_PATH: "/var/run/secrets/provisioning-service/token",
    })).not.toBeNull();
  });
});
