import type {
  ChatOutputs,
  GitRepositoryRole,
  UserProvisioning,
  UserProvisioningConditionType,
} from "@octogee/shared/types/provisioning-service";
import { chatReady } from "@octogee/core/provisioning-mirror";
import {
  createProvisioningServiceClient,
  provisioningServiceConfigFromEnvironment,
  ProvisioningServiceError,
  type ProvisioningServiceClient,
} from "@octogee/core/provisioning-service-client";
import { logger } from "@octogee/core/http/logging";

export const LEGACY_PROVISIONING_LONG_POLL_SECONDS = 10;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const MAX_RETRY_AFTER_SECONDS = 300;

export type ProvisioningWait<T> =
  | { readonly ready: true; readonly value: T }
  | { readonly ready: false; readonly reason: string; readonly retryAfterSeconds: number };

export type LegacyGitRepository = GitRepositoryRole | "system-config";

export interface LegacyProvisioning {
  chat(uid: string): Promise<ProvisioningWait<{ slug: string; chat: ChatOutputs }>>;
  git(uid: string, repository: LegacyGitRepository | null): Promise<ProvisioningWait<void>>;
  agentChatToken(uid: string): Promise<string | null>;
}

export type LegacyProvisioningClient = Pick<ProvisioningServiceClient, "getProvisioning" | "getCredential">;

export interface LegacyProvisioningDeps {
  readonly client: LegacyProvisioningClient;
  readonly now?: () => number;
  readonly longPollSeconds?: number;
}

function clampSeconds(seconds: number): number {
  return Math.min(Math.max(Math.ceil(seconds), 1), MAX_RETRY_AFTER_SECONDS);
}

export function createLegacyProvisioning(deps: LegacyProvisioningDeps): LegacyProvisioning {
  const now = deps.now ?? Date.now;
  const longPollSeconds = deps.longPollSeconds ?? LEGACY_PROVISIONING_LONG_POLL_SECONDS;

  function notReady(reason: string, resource: UserProvisioning | null): ProvisioningWait<never> {
    const nextAttemptAt = resource?.status.work.nextAttemptAt;
    const due = nextAttemptAt ? Date.parse(nextAttemptAt) - now() : Number.NaN;
    return {
      ready: false,
      reason,
      retryAfterSeconds: Number.isFinite(due) && due > 0 ? clampSeconds(due / 1000) : DEFAULT_RETRY_AFTER_SECONDS,
    };
  }

  async function current(uid: string): Promise<{ resource: UserProvisioning } | { wait: ProvisioningWait<never> }> {
    try {
      let resource = await deps.client.getProvisioning(uid);
      if (resource !== null && resource.status.observedGeneration < resource.generation) {
        resource = await deps.client.getProvisioning(uid, { waitForGeneration: resource.generation, timeoutSeconds: longPollSeconds });
      }
      if (resource === null) {
        logger.error("legacy provisioning: no provisioning resource exists for the user", { uid });
        return { wait: notReady("NotProvisioned", null) };
      }
      return { resource };
    } catch (error) {
      if (!(error instanceof ProvisioningServiceError) || !error.transient) throw error;
      logger.error("legacy provisioning: the provisioning service is unavailable", { uid, err: error });
      return {
        wait: {
          ready: false,
          reason: "ProvisioningServiceUnavailable",
          retryAfterSeconds: error.retryAfterMs === null ? DEFAULT_RETRY_AFTER_SECONDS : clampSeconds(error.retryAfterMs / 1000),
        },
      };
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
    async chat(uid) {
      const read = await current(uid);
      if ("wait" in read) return read.wait;
      const chat = observed(read.resource, "ChatReady") ? chatReady(read.resource) : null;
      if (chat === null) return pending(uid, read.resource, "ChatReady");
      return { ready: true, value: { slug: read.resource.spec.slug, chat } };
    },

    async git(uid, repository) {
      const read = await current(uid);
      if ("wait" in read) return read.wait;
      if (repository !== null && !carries(read.resource, repository)) {
        logger.error("legacy provisioning: the user's spec carries no such repository", { uid, repository });
        return notReady("RepositoryNotInSpec", null);
      }
      if (!observed(read.resource, "GitReady")) return pending(uid, read.resource, "GitReady");
      return { ready: true, value: undefined };
    },

    async agentChatToken(uid) {
      return (await deps.client.getCredential(uid, "agent-chat-token"))?.value ?? null;
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
