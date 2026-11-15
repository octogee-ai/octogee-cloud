import type {
  ProvisioningCondition,
  ProvisioningConditionReason,
  ProvisioningCredentialName,
  ProvisioningStep,
  ProvisioningStepRecord,
  UserProvisioningConditionType,
  UserProvisioningOutputs,
  UserProvisioningSpec,
} from "@octogee/shared/types/provisioning-service";
import { applyConditions, type ConditionUpdate } from "../resources/conditions.js";
import type { ChatHost } from "../hosts/chat-host.js";
import { LeaseLostError, type CredentialStore } from "../hosts/credential-store.js";
import type { GitHost, GitRepositoryKind } from "../hosts/git-host.js";
import { HostError, hostErrorKind, type HostErrorKind } from "../hosts/host-error.js";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import type { Database } from "../store/database.js";
import type { GitKeyRow } from "../store/provisioning-store.js";
import { HEARTBEAT_MS, type Claim, type FinishResult, type WorkQueue } from "./queue.js";

export interface AttemptDependencies {
  db: Database;
  queue: WorkQueue;
  credentials: CredentialStore;
  chat: ChatHost;
  git: GitHost;
  metrics: Metrics;
  log: Logger;
  heartbeatMs?: number;
}

type StoredOutputs = Omit<UserProvisioningOutputs, "credentials">;

interface Snapshot {
  generation: number;
  spec: UserProvisioningSpec;
  outputs: StoredOutputs;
  conditions: ProvisioningCondition<UserProvisioningConditionType>[];
  keys: GitKeyRow[];
}

interface Failure {
  reason: ProvisioningConditionReason;
  message: string;
  kind: HostErrorKind;
}

class StepFailed extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
  }
}

export type AttemptResult = FinishResult | { state: "lease-lost" } | { state: "gone" };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runAttempt(deps: AttemptDependencies, claim: Claim): Promise<AttemptResult> {
  const { db, queue, log } = deps;
  const t = db.table;
  const startedAt = new Date();
  const loaded = await db.pool.query<{ generation: number; spec: UserProvisioningSpec; outputs: StoredOutputs; conditions: Snapshot["conditions"] }>(
    `SELECT generation, spec, outputs, conditions FROM ${t("provisionings")} WHERE uid = $1`, [claim.uid]);
  if (!loaded.rows[0]) return { state: "gone" };
  const keys = await db.pool.query<GitKeyRow>(`SELECT * FROM ${t("git_keys")} WHERE uid = $1 ORDER BY gateway_id`, [claim.uid]);
  const snapshot: Snapshot = { ...loaded.rows[0], keys: keys.rows };
  const outputs: StoredOutputs = structuredClone(snapshot.outputs);
  const steps: ProvisioningStepRecord[] = [];
  const abort = new AbortController();
  let leaseLost = false;

  const heartbeat = setInterval(() => {
    queue.heartbeat(claim.uid, claim.leaseToken).then((held) => {
      if (!held) {
        leaseLost = true;
        abort.abort();
      }
    }).catch((error: unknown) => log.error("lease heartbeat failed", { uid: claim.uid, error: message(error) }));
  }, deps.heartbeatMs ?? HEARTBEAT_MS);

  const saveOutputs = () => queue.fenced(claim.uid, claim.leaseToken, async (client, bumpVersion) => {
    const version = await bumpVersion();
    await client.query(`UPDATE ${t("provisionings")} SET outputs = $2, resource_version = $3 WHERE uid = $1`,
      [claim.uid, JSON.stringify(outputs), version.toString()]);
  });

  const hostCall = async <T>(host: "chat" | "git", operation: string, call: () => Promise<T>): Promise<T> => {
    const began = performance.now();
    try {
      const result = await call();
      deps.metrics.hostCall(host, operation, "ok", (performance.now() - began) / 1_000);
      return result;
    } catch (error) {
      deps.metrics.hostCall(host, operation, hostErrorKind(error), (performance.now() - began) / 1_000);
      throw error;
    }
  };

  const step = async (name: ProvisioningStep, reason: ProvisioningConditionReason, body: () => Promise<string[] | void>): Promise<void> => {
    const began = performance.now();
    try {
      const warnings = await body();
      steps.push({ step: name, outcome: "succeeded", durationMs: Math.round(performance.now() - began), ...(warnings?.length ? { message: warnings.join("; ") } : {}) });
    } catch (error) {
      if (error instanceof LeaseLostError || leaseLost) throw error instanceof LeaseLostError ? error : new LeaseLostError(claim.uid);
      const failure = { reason, message: message(error), kind: hostErrorKind(error) };
      steps.push({ step: name, outcome: "failed", reason, message: failure.message, durationMs: Math.round(performance.now() - began) });
      log.error("provisioning step failed", { uid: claim.uid, generation: snapshot.generation, step: name, reason, kind: failure.kind, error: failure.message });
      throw new StepFailed(failure);
    }
  };

  const skip = (names: ProvisioningStep[]) => {
    for (const name of names) steps.push({ step: name, outcome: "skipped", durationMs: 0 });
  };

  const issueOnce = async (name: ProvisioningCredentialName, issue: () => Promise<{ token: string }>) => {
    if (await deps.credentials.read(claim.uid, name)) return;
    const { token } = await issue();
    await deps.credentials.write(claim.uid, name, token, claim.leaseToken);
  };

  const { spec } = snapshot;
  const signal = abort.signal;

  const chatBranch = async (): Promise<{ chat?: Failure; credentials?: Failure }> => {
    const ownerFirstName = spec.displayName.first.trim() || spec.slug;
    const order: ProvisioningStep[] = ["chat-user", "chat-team", "chat-channels", "chat-agent", "user-chat-token"];
    let index = 0;
    try {
      await step("chat-user", "ChatUserFailed", async () => {
        const result = await hostCall("chat", "ensureUser", () => deps.chat.ensureUser({
          uid: claim.uid, slug: spec.slug, email: spec.email, displayName: spec.displayName, avatarUrl: spec.avatarUrl,
          ...(outputs.chat?.userId ? { knownUserId: outputs.chat.userId } : {}),
        }, signal));
        outputs.chat = { ...(outputs.chat ?? { teamId: "", channels: { general: "" } }), userId: result.userId };
        await saveOutputs();
        return result.warnings;
      });
      const chat = outputs.chat!;
      index = 1;
      await step("chat-team", "ChatTeamFailed", async () => {
        const { teamId } = await hostCall("chat", "ensureTeam", () => deps.chat.ensureTeam({
          slug: spec.slug, displayName: spec.chat.teamDisplayName, userId: chat.userId, ...(chat.teamId ? { knownTeamId: chat.teamId } : {}),
        }, signal));
        chat.teamId = teamId;
        await saveOutputs();
      });
      index = 2;
      await step("chat-channels", "ChatChannelsFailed", async () => {
        const channels = await hostCall("chat", "ensureChannels", () => deps.chat.ensureChannels({
          slug: spec.slug, ownerFirstName, teamId: chat.teamId, userId: chat.userId, agentChannel: spec.chat.defaultAgent.enabled,
          known: { ...(chat.channels.general ? { general: chat.channels.general } : {}), ...(chat.channels.agent ? { agent: chat.channels.agent } : {}) },
        }, signal));
        chat.channels = channels;
        await saveOutputs();
      });
      index = 3;
      if (spec.chat.defaultAgent.enabled) {
        await step("chat-agent", "ChatAgentFailed", async () => {
          const { botUserId } = await hostCall("chat", "ensureAgentBot", () => deps.chat.ensureAgentBot({
            slug: spec.slug, ownerFirstName, teamId: chat.teamId,
            ...(chat.channels.general ? { generalChannelId: chat.channels.general } : {}),
            ...(chat.channels.agent ? { agentChannelId: chat.channels.agent } : {}),
            ...(chat.agentBotUserId ? { knownBotUserId: chat.agentBotUserId } : {}),
          }, signal));
          chat.agentBotUserId = botUserId;
          await saveOutputs();
          await issueOnce("agent-chat-token", () => hostCall("chat", "issueAgentToken", () => deps.chat.issueAgentToken({ botUserId }, signal)));
        });
      } else {
        skip(["chat-agent"]);
      }
    } catch (error) {
      if (!(error instanceof StepFailed)) throw error;
      skip(order.slice(index + 1));
      return { chat: error.failure, credentials: { reason: "ChatNotReady", message: "", kind: error.failure.kind } };
    }
    try {
      await step("user-chat-token", "UserChatTokenFailed", () =>
        issueOnce("user-chat-token", () => hostCall("chat", "issueUserToken", () => deps.chat.issueUserToken({ userId: outputs.chat!.userId }, signal))));
    } catch (error) {
      if (!(error instanceof StepFailed)) throw error;
      return { credentials: error.failure };
    }
    return {};
  };

  const gitBranch = async (): Promise<{ git?: Failure; keys?: Failure }> => {
    let owner: string;
    try {
      await step("git-owner", "GitOwnerFailed", async () => {
        const result = await hostCall("git", "ensureOwner", () => deps.git.ensureOwner({ slug: spec.slug, ...(outputs.git?.owner ? { knownOwner: outputs.git.owner } : {}) }, signal));
        outputs.git = { owner: result.owner, repositories: outputs.git?.repositories ?? {} };
        await saveOutputs();
      });
      owner = outputs.git!.owner;
      await step("git-repositories", "GitRepositoryFailed", async () => {
        const kinds: GitRepositoryKind[] = [...spec.git.repositories, ...(spec.git.systemConfigRepository ? ["system-config" as const] : [])];
        for (const kind of kinds) {
          const repository = await hostCall("git", "ensureRepository", () => deps.git.ensureRepository({ owner, kind }, signal));
          outputs.git!.repositories[kind] = repository;
          await saveOutputs();
        }
      });
    } catch (error) {
      if (!(error instanceof StepFailed)) throw error;
      skip(steps.some((record) => record.step === "git-owner" && record.outcome === "failed") ? ["git-repositories", "git-keys"] : ["git-keys"]);
      return { git: error.failure };
    }
    if (snapshot.keys.length === 0) return {};
    try {
      await step("git-keys", "GitKeyFailed", () => reconcileKeys(owner));
    } catch (error) {
      if (!(error instanceof StepFailed)) throw error;
      return { keys: error.failure };
    }
    return {};
  };

  const reconcileKeys = async (owner: string): Promise<void> => {
    const present = await hostCall("git", "listKeys", () => deps.git.listKeys({ owner, holders: snapshot.keys.map((key) => key.gateway_id) }, signal));
    const has = (publicKey: string, holder: string) => present.some((key) => key.publicKey === publicKey && key.holder === holder);
    const failures: string[] = [];
    let kind: HostErrorKind = "transient";
    for (const key of snapshot.keys) {
      try {
        const stale = [key.registered_public_key, key.deletion_requested_at ? key.public_key : null]
          .filter((value, position, all): value is string => value !== null && all.indexOf(value) === position)
          .filter((value) => key.deletion_requested_at !== null || value !== key.public_key);
        for (const publicKey of stale) {
          if (has(publicKey, key.gateway_id)) {
            await hostCall("git", "releaseKey", () => deps.git.releaseKey({ owner, publicKey, holder: key.gateway_id }, signal));
          }
        }
        if (key.deletion_requested_at !== null) {
          await queue.fenced(claim.uid, claim.leaseToken, (client) =>
            client.query(`DELETE FROM ${t("git_keys")} WHERE uid = $1 AND gateway_id = $2 AND generation = $3 AND deletion_requested_at IS NOT NULL`,
              [claim.uid, key.gateway_id, key.generation]));
          continue;
        }
        if (!has(key.public_key, key.gateway_id)) {
          await hostCall("git", "registerKey", () => deps.git.registerKey({ owner, publicKey: key.public_key, holder: key.gateway_id }, signal));
        }
        await writeKeyStatus(key, { type: "Registered", status: "True", reason: "Converged" }, key.public_key);
      } catch (error) {
        if (error instanceof LeaseLostError || leaseLost) throw error;
        failures.push(`${key.gateway_id}: ${message(error)}`);
        if (hostErrorKind(error) === "terminal") kind = "terminal";
        if (key.deletion_requested_at === null) {
          await writeKeyStatus(key, { type: "Registered", status: "False", reason: "GitKeyFailed", message: message(error) }, key.registered_public_key);
        }
      }
    }
    if (failures.length) throw new HostError(kind, failures.join("; "));
  };

  const writeKeyStatus = (key: GitKeyRow, update: ConditionUpdate<"Registered">, registered: string | null) =>
    queue.fenced(claim.uid, claim.leaseToken, async (client, bumpVersion) => {
      const conditions = applyConditions(key.conditions, [update], key.generation, new Date());
      const version = await bumpVersion();
      await client.query(
        `UPDATE ${t("git_keys")} SET conditions = $4, observed_generation = $3, registered_public_key = $5, resource_version = $6
          WHERE uid = $1 AND gateway_id = $2 AND generation = $3`,
        [claim.uid, key.gateway_id, key.generation, JSON.stringify(conditions), registered, version.toString()]);
    });

  try {
    const [chat, git] = await Promise.all([chatBranch(), gitBranch()]);
    const updates: ConditionUpdate<UserProvisioningConditionType>[] = [
      chat.chat ? { type: "ChatReady", status: "False", reason: chat.chat.reason, message: chat.chat.message } : { type: "ChatReady", status: "True", reason: "Converged" },
      git.git ? { type: "GitReady", status: "False", reason: git.git.reason, message: git.git.message } : { type: "GitReady", status: "True", reason: "Converged" },
      chat.credentials
        ? { type: "CredentialsIssued", status: "False", reason: chat.credentials.reason, message: chat.credentials.message }
        : { type: "CredentialsIssued", status: "True", reason: "Converged" },
      chat.chat ? { type: "Ready", status: "False", reason: "ChatNotReady" }
        : git.git ? { type: "Ready", status: "False", reason: "GitNotReady" }
          : chat.credentials ? { type: "Ready", status: "False", reason: "CredentialsNotIssued" }
            : { type: "Ready", status: "True", reason: "Converged" },
    ];
    const failures = [chat.chat, chat.chat ? undefined : chat.credentials, git.git, git.keys].filter((failure): failure is Failure => failure !== undefined);
    const first = failures[0];
    const finishedAt = new Date();
    const result = await queue.finish(claim.uid, claim.leaseToken, {
      generation: snapshot.generation,
      conditions: applyConditions(snapshot.conditions, updates, snapshot.generation, finishedAt),
      attempt: { generation: snapshot.generation, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), ...(first ? { reason: first.reason } : {}), steps },
      outcome: first
        ? { kind: "failed", errorKind: failures.some((failure) => failure.kind === "terminal") ? "terminal" : "transient", reason: first.reason, message: failures.map((failure) => failure.message).join("; ") }
        : { kind: "succeeded" },
    });
    deps.metrics.attempt(result.state === "parked" ? "parked" : first ? "failed" : "succeeded", first?.reason ?? "Converged");
    log.info("provisioning attempt finished", {
      uid: claim.uid, generation: snapshot.generation, state: result.state, attempts: result.attempts, reason: first?.reason ?? "Converged",
      durationMs: finishedAt.getTime() - startedAt.getTime(), steps: steps.map((record) => ({ step: record.step, outcome: record.outcome, durationMs: record.durationMs })),
    });
    if (result.state === "parked") log.error("provisioning work parked", { uid: claim.uid, generation: snapshot.generation, reason: first?.reason, attempts: result.attempts });
    return result;
  } catch (error) {
    if (!(error instanceof LeaseLostError) && !leaseLost) throw error;
    const finishedAt = new Date();
    log.error("provisioning lease lost; attempt stopped", { uid: claim.uid, generation: snapshot.generation });
    deps.metrics.attempt("lease-lost", "LeaseLost");
    await queue.recordLeaseLost(claim.uid, { generation: snapshot.generation, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), steps })
      .catch((recordError: unknown) => log.error("recording a lost lease failed", { uid: claim.uid, error: message(recordError) }));
    return { state: "lease-lost" };
  } finally {
    clearInterval(heartbeat);
    abort.abort();
  }
}
