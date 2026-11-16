import type { Response } from "express";
import type {
  ChatOutputs,
  GitKey,
  GitRepositoryRole,
  UserProvisioning,
  UserProvisioningConditionType,
} from "@octogee/shared/types/provisioning-service";
import { chatReady } from "@octogee/core/provisioning-mirror";
import {
  createProvisioningServiceClient,
  provisioningServiceConfigFromEnvironment,
  ProvisioningServiceError,
  type DeleteGitKeyOutcome,
  type ProvisioningServiceClient,
} from "@octogee/core/provisioning-service-client";
import { logger } from "@octogee/core/http/logging";

export const LEGACY_PROVISIONING_LONG_POLL_SECONDS = 10;
export const LEGACY_ROUTE_DEADLINE_MS = 40_000;
const RESERVED_AFTER_LONG_POLL_MS = 10_000;
const GIT_KEY_POLL_MS = 2_000;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const MAX_RETRY_AFTER_SECONDS = 300;

export type ProvisioningWait<T> =
  | { readonly ready: true; readonly value: T }
  | { readonly ready: false; readonly reason: string; readonly retryAfterSeconds: number };

export type LegacyGitRepository = GitRepositoryRole | "system-config";

export interface RouteBudget {
  readonly signal: AbortSignal;
  remainingMs(): number;
}

export function routeBudget(totalMs = LEGACY_ROUTE_DEADLINE_MS, now: () => number = Date.now): RouteBudget {
  const end = now() + totalMs;
  return { signal: AbortSignal.timeout(totalMs), remainingMs: () => Math.max(0, end - now()) };
}

export interface ReadyChat {
  readonly slug: string;
  readonly chat: ChatOutputs;
  readonly resource: UserProvisioning;
}

export interface LegacyProvisioning {
  chat(uid: string, budget: RouteBudget): Promise<ProvisioningWait<ReadyChat>>;
  git(uid: string, repository: LegacyGitRepository | null, budget: RouteBudget): Promise<ProvisioningWait<void>>;
  agentChatToken(uid: string, budget: RouteBudget): Promise<ProvisioningWait<string>>;
  gitKey(uid: string, gatewayId: string, publicKey: string, budget: RouteBudget): Promise<ProvisioningWait<void>>;
  releaseGitKey(uid: string, gatewayId: string, publicKey: string, budget: RouteBudget): Promise<DeleteGitKeyOutcome>;
}

export type LegacyProvisioningClient = Pick<ProvisioningServiceClient, "getProvisioning" | "getCredential" | "putGitKey" | "deleteGitKey">;

export interface LegacyProvisioningDeps {
  readonly client: LegacyProvisioningClient;
  readonly now?: () => number;
  readonly longPollSeconds?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

function clampSeconds(seconds: number): number {
  return Math.min(Math.max(Math.ceil(seconds), 1), MAX_RETRY_AFTER_SECONDS);
}

export interface NotReadyAnswer {
  readonly route: string;
  readonly uid?: string;
  readonly slug?: string;
}

export function respondProvisioningPending(
  res: Response,
  answer: NotReadyAnswer,
  wait: { reason: string; retryAfterSeconds: number },
): void {
  logger.warn("legacy provisioning: answering not ready", { ...answer, reason: wait.reason, retryAfterSeconds: wait.retryAfterSeconds });
  res.set("Retry-After", String(wait.retryAfterSeconds)).status(503).json({ error: "provisioning_pending", reason: wait.reason });
}

function unavailable(uid: string, error: unknown): ProvisioningWait<never> {
  if (error instanceof ProvisioningServiceError && error.code === "aborted") {
    logger.error("legacy provisioning: the route's deadline passed before the provisioning service answered", { uid });
    return { ready: false, reason: "ProvisioningServiceTimeout", retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS };
  }
  if (!(error instanceof ProvisioningServiceError) || !error.transient) throw error;
  logger.error("legacy provisioning: the provisioning service is unavailable", { uid, err: error });
  return {
    ready: false,
    reason: "ProvisioningServiceUnavailable",
    retryAfterSeconds: error.retryAfterMs === null ? DEFAULT_RETRY_AFTER_SECONDS : clampSeconds(error.retryAfterMs / 1000),
  };
}

function notProvisioned(uid: string): ProvisioningWait<never> {
  logger.error("legacy provisioning: no provisioning resource exists for the user", { uid });
  return { ready: false, reason: "NotProvisioned", retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS };
}

function registeredCondition(key: GitKey) {
  return key.status.observedGeneration >= key.generation
    ? key.status.conditions.find((candidate) => candidate.type === "Registered") ?? null
    : null;
}

export function createLegacyProvisioning(deps: LegacyProvisioningDeps): LegacyProvisioning {
  const now = deps.now ?? Date.now;
  const longPollSeconds = deps.longPollSeconds ?? LEGACY_PROVISIONING_LONG_POLL_SECONDS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  function notReady(reason: string, resource: UserProvisioning | null): ProvisioningWait<never> {
    const nextAttemptAt = resource?.status.work.nextAttemptAt;
    const due = nextAttemptAt ? Date.parse(nextAttemptAt) - now() : Number.NaN;
    return {
      ready: false,
      reason,
      retryAfterSeconds: Number.isFinite(due) && due > 0 ? clampSeconds(due / 1000) : DEFAULT_RETRY_AFTER_SECONDS,
    };
  }

  function keyNotRegistered(key: GitKey, registered: NonNullable<ReturnType<typeof registeredCondition>>): ProvisioningWait<never> {
    logger.error("legacy provisioning: the provisioning service has not registered the gateway's git key", {
      uid: key.uid,
      gatewayId: key.gatewayId,
      reason: registered.reason,
      message: registered.message,
    });
    const due = key.status.nextAttemptAt === null ? Number.NaN : Date.parse(key.status.nextAttemptAt) - now();
    return {
      ready: false,
      reason: registered.reason,
      retryAfterSeconds: Number.isFinite(due) && due > 0 ? clampSeconds(due / 1000) : DEFAULT_RETRY_AFTER_SECONDS,
    };
  }

  function longPollFor(budget: RouteBudget): number {
    return Math.min(longPollSeconds, Math.floor((budget.remainingMs() - RESERVED_AFTER_LONG_POLL_MS) / 1000));
  }

  async function current(uid: string, budget: RouteBudget): Promise<{ resource: UserProvisioning } | { wait: ProvisioningWait<never> }> {
    const { signal } = budget;
    try {
      let resource = await deps.client.getProvisioning(uid, { signal });
      const timeoutSeconds = longPollFor(budget);
      if (resource !== null && resource.status.observedGeneration < resource.generation && timeoutSeconds >= 1) {
        resource = await deps.client.getProvisioning(uid, { waitForGeneration: resource.generation, timeoutSeconds, signal });
      }
      if (resource === null) return { wait: notProvisioned(uid) };
      return { resource };
    } catch (error) {
      return { wait: unavailable(uid, error) };
    }
  }

  function pending(uid: string, resource: UserProvisioning, type: UserProvisioningConditionType): ProvisioningWait<never> {
    if (resource.status.observedGeneration < resource.generation) return notReady("GenerationNotObserved", resource);
    const reason = resource.status.conditions.find((candidate) => candidate.type === type)?.reason ?? `${type}Unknown`;
    if (resource.status.work.state === "parked") {
      logger.error("legacy provisioning: the user's provisioning is parked", { uid, reason });
    }
    return notReady(reason, resource);
  }

  function observed(resource: UserProvisioning, type: UserProvisioningConditionType): boolean {
    return resource.status.observedGeneration >= resource.generation &&
      resource.status.conditions.some((candidate) => candidate.type === type && candidate.status === "True");
  }

  function carries(resource: UserProvisioning, repository: LegacyGitRepository): boolean {
    return repository === "system-config"
      ? resource.spec.git.systemConfigRepository
      : resource.spec.git.repositories.includes(repository);
  }

  return {
    async chat(uid, budget) {
      const read = await current(uid, budget);
      if ("wait" in read) return read.wait;
      const chat = observed(read.resource, "ChatReady") ? chatReady(read.resource) : null;
      if (chat === null) return pending(uid, read.resource, "ChatReady");
      return { ready: true, value: { slug: read.resource.spec.slug, chat, resource: read.resource } };
    },

    async git(uid, repository, budget) {
      const read = await current(uid, budget);
      if ("wait" in read) return read.wait;
      if (repository !== null && !carries(read.resource, repository)) {
        logger.error("legacy provisioning: the user's spec carries no such repository", { uid, repository });
        return notReady("RepositoryNotInSpec", null);
      }
      if (!observed(read.resource, "GitReady")) return pending(uid, read.resource, "GitReady");
      return { ready: true, value: undefined };
    },

    async agentChatToken(uid, budget) {
      let credential: Awaited<ReturnType<LegacyProvisioningClient["getCredential"]>>;
      try {
        credential = await deps.client.getCredential(uid, "agent-chat-token", { signal: budget.signal });
      } catch (error) {
        if (error instanceof ProvisioningServiceError && error.status === 404) return notProvisioned(uid);
        return unavailable(uid, error);
      }
      if (credential === null) {
        logger.error("legacy provisioning: the user's agent chat token is not issued", { uid });
        return { ready: false, reason: "CredentialsNotIssued", retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS };
      }
      return { ready: true, value: credential.value };
    },

    async gitKey(uid, gatewayId, publicKey, budget) {
      for (;;) {
        let key: GitKey;
        try {
          key = (await deps.client.putGitKey(uid, gatewayId, { publicKey }, { signal: budget.signal })).key;
        } catch (error) {
          if (error instanceof ProvisioningServiceError && error.status === 404) return notProvisioned(uid);
          return unavailable(uid, error);
        }
        const registered = registeredCondition(key);
        if (registered?.status === "True") return { ready: true, value: undefined };
        if (registered !== null) return keyNotRegistered(key, registered);
        if (budget.remainingMs() - GIT_KEY_POLL_MS < RESERVED_AFTER_LONG_POLL_MS) {
          const reason = key.status.observedGeneration < key.generation ? "GenerationNotObserved" : "RegisteredUnknown";
          return { ready: false, reason, retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS };
        }
        await sleep(GIT_KEY_POLL_MS);
      }
    },

    releaseGitKey(uid, gatewayId, publicKey, budget) {
      return deps.client.deleteGitKey(uid, gatewayId, { expectedPublicKey: publicKey, signal: budget.signal });
    },
  };
}

export function legacyProvisioningFromEnvironment(env: NodeJS.ProcessEnv): LegacyProvisioning | null {
  const config = provisioningServiceConfigFromEnvironment(env);
  if (config === null) return null;
  return createLegacyProvisioning({
    client: createProvisioningServiceClient({ ...config, retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 } }),
  });
}
