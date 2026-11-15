import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ProvisioningCondition,
  ProvisioningConditionReason,
  ProvisioningCredential,
  UserProvisioning,
  UserProvisioningConditionType,
} from "@octogee/shared/types/provisioning-service";
import { ProvisioningServiceError } from "@octogee/core/provisioning-service-client";
import { logger } from "@octogee/core/http/logging";
import { createLegacyProvisioning, legacyProvisioningFromEnvironment, type LegacyProvisioningClient } from "./legacy-provisioning.js";

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

function fakeClient(answers: Array<UserProvisioning | null | Error>, credential: ProvisioningCredential | null | Error = null) {
  const calls: Array<{ uid: string; options: unknown }> = [];
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
  };
  return { client, calls };
}

function adapter(client: LegacyProvisioningClient) {
  return createLegacyProvisioning({ client, now: () => NOW, longPollSeconds: 10 });
}

afterEach(() => vi.restoreAllMocks());

describe("legacy provisioning adapter: chat", () => {
  it("answers the chat outputs once ChatReady is True for the current generation", async () => {
    const { client, calls } = fakeClient([resource({ conditions: [condition("ChatReady", "True", "Converged")], chat: CHAT })]);

    await expect(adapter(client).chat("uid-lin")).resolves.toEqual({ ready: true, value: { slug: "lin", chat: CHAT } });
    expect(calls).toEqual([{ uid: "uid-lin", options: undefined }]);
  });

  it("long-polls for a generation the service has not observed yet", async () => {
    const { client, calls } = fakeClient([
      resource({ generation: 2, observedGeneration: 1 }),
      resource({ generation: 2, observedGeneration: 2, conditions: [condition("ChatReady", "True", "Converged")], chat: CHAT }),
    ]);

    await expect(adapter(client).chat("uid-lin")).resolves.toMatchObject({ ready: true });
    expect(calls[1]).toEqual({ uid: "uid-lin", options: { waitForGeneration: 2, timeoutSeconds: 10 } });
  });

  it("is not ready while chat is retrying, with the condition's reason and the service's next attempt", async () => {
    const { client } = fakeClient([resource({
      conditions: [condition("ChatReady", "False", "ChatTeamFailed")],
      work: { state: "retrying", attempts: 3, nextAttemptAt: "2026-11-15T18:00:42Z", lastAttemptAt: "2026-11-15T17:59:00Z" },
    })]);

    await expect(adapter(client).chat("uid-lin")).resolves.toEqual({ ready: false, reason: "ChatTeamFailed", retryAfterSeconds: 42 });
  });

  it("is not ready while the generation is still unobserved after the long-poll", async () => {
    const { client } = fakeClient([
      resource({ generation: 2, observedGeneration: 1, conditions: [condition("ChatReady", "True", "Converged")], chat: CHAT }),
      resource({ generation: 2, observedGeneration: 1, conditions: [condition("ChatReady", "True", "Converged")], chat: CHAT }),
    ]);

    await expect(adapter(client).chat("uid-lin")).resolves.toEqual({ ready: false, reason: "GenerationNotObserved", retryAfterSeconds: 5 });
  });

  it("is not ready and logs the uid when the service has no resource for the user", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { client } = fakeClient([null]);

    await expect(adapter(client).chat("uid-lin")).resolves.toEqual({ ready: false, reason: "NotProvisioned", retryAfterSeconds: 5 });
    expect(logged).toHaveBeenCalledWith("legacy provisioning: no provisioning resource exists for the user", { uid: "uid-lin" });
  });

  it("logs a parked user's reason", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { client } = fakeClient([resource({
      conditions: [condition("ChatReady", "False", "ChatUserFailed")],
      work: { state: "parked", attempts: 9, nextAttemptAt: null, lastAttemptAt: "2026-11-15T17:59:00Z" },
    })]);

    await expect(adapter(client).chat("uid-lin")).resolves.toEqual({ ready: false, reason: "ChatUserFailed", retryAfterSeconds: 5 });
    expect(logged).toHaveBeenCalledWith("legacy provisioning: the user's provisioning is parked", { uid: "uid-lin", reason: "ChatUserFailed" });
  });

  it("is not ready while the service is unavailable, honouring its Retry-After", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const { client } = fakeClient([new ProvisioningServiceError(503, "unavailable", "down", 30_000)]);

    await expect(adapter(client).chat("uid-lin")).resolves.toEqual({ ready: false, reason: "ProvisioningServiceUnavailable", retryAfterSeconds: 30 });
  });

  it("throws a refusal from the service", async () => {
    const refusal = new ProvisioningServiceError(403, "forbidden", "role");
    const { client } = fakeClient([refusal]);

    await expect(adapter(client).chat("uid-lin")).rejects.toBe(refusal);
  });
});

describe("legacy provisioning adapter: git", () => {
  it("is ready for the owner and a spec repository once GitReady is True", async () => {
    const ready = () => resource({ conditions: [condition("GitReady", "True", "Converged")] });
    const { client } = fakeClient([ready(), ready()]);
    const provisioning = adapter(client);

    await expect(provisioning.git("uid-lin", null)).resolves.toEqual({ ready: true, value: undefined });
    await expect(provisioning.git("uid-lin", "workspace")).resolves.toEqual({ ready: true, value: undefined });
  });

  it("is not ready while git is retrying", async () => {
    const { client } = fakeClient([resource({ conditions: [condition("GitReady", "False", "GitRepositoryFailed")] })]);

    await expect(adapter(client).git("uid-lin", "workspace")).resolves.toEqual({ ready: false, reason: "GitRepositoryFailed", retryAfterSeconds: 5 });
  });

  it("refuses and logs a repository the user's spec does not carry", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { client } = fakeClient([resource({ systemConfigRepository: false, conditions: [condition("GitReady", "True", "Converged")] })]);

    await expect(adapter(client).git("uid-lin", "system-config")).resolves.toEqual({ ready: false, reason: "RepositoryNotInSpec", retryAfterSeconds: 5 });
    expect(logged).toHaveBeenCalledWith("legacy provisioning: the user's spec carries no such repository", { uid: "uid-lin", repository: "system-config" });
  });
});

describe("legacy provisioning adapter: credentials", () => {
  it("reads the service's agent chat token", async () => {
    const { client } = fakeClient([], { name: "agent-chat-token", value: "agent-token", version: 1 });

    await expect(adapter(client).agentChatToken("uid-lin")).resolves.toEqual({ ready: true, value: "agent-token" });
    expect(client.getCredential).toHaveBeenCalledWith("uid-lin", "agent-chat-token");
  });

  it("is not ready and logs the uid before the service has issued it", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { client } = fakeClient([], null);

    await expect(adapter(client).agentChatToken("uid-lin")).resolves.toEqual({ ready: false, reason: "CredentialsNotIssued", retryAfterSeconds: 5 });
    expect(logged).toHaveBeenCalledWith("legacy provisioning: the user's agent chat token is not issued", { uid: "uid-lin" });
  });

  it("is not ready for a user the service has no resource for, apart from an outage", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const missing = fakeClient([], new ProvisioningServiceError(404, "not-found", "no provisioning for this user"));
    const outage = fakeClient([], new ProvisioningServiceError(503, "unavailable", "down", 30_000));

    await expect(adapter(missing.client).agentChatToken("uid-lin")).resolves.toEqual({ ready: false, reason: "NotProvisioned", retryAfterSeconds: 5 });
    await expect(adapter(outage.client).agentChatToken("uid-lin")).resolves.toEqual({ ready: false, reason: "ProvisioningServiceUnavailable", retryAfterSeconds: 30 });
  });

  it("throws a refusal from the service", async () => {
    const refusal = new ProvisioningServiceError(403, "forbidden", "role");
    const { client } = fakeClient([], refusal);

    await expect(adapter(client).agentChatToken("uid-lin")).rejects.toBe(refusal);
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
