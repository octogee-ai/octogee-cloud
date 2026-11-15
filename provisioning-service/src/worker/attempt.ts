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
import type { AuthorizedGitKey, GitHost, GitRepositoryKind } from "../hosts/git-host.js";
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
type ChatOutputs = NonNullable<StoredOutputs["chat"]>;

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

interface ChatResult {
  chat?: Failure;
  credentials?: Failure;
}

interface GitResult {
  git?: Failure;
  keys?: Failure;
}

class StepFailed extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
  }
}

export type AttemptResult = FinishResult | { state: "lease-lost" } | { state: "gone" };

const CHAT_STEPS: ProvisioningStep[] = ["chat-user", "chat-team", "chat-channels", "chat-agent", "user-chat-token"];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readiness(failure: Failure | undefined, type: UserProvisioningConditionType): ConditionUpdate<UserProvisioningConditionType> {
  return failure
    ? { type, status: "False", reason: failure.reason, message: failure.message }
    : { type, status: "True", reason: "Converged" };
}

function readyCondition(chat: ChatResult, git: GitResult): ConditionUpdate<UserProvisioningConditionType> {
  if (chat.chat) return { type: "Ready", status: "False", reason: "ChatNotReady" };
  if (git.git) return { type: "Ready", status: "False", reason: "GitNotReady" };
  if (chat.credentials) return { type: "Ready", status: "False", reason: "CredentialsNotIssued" };
  return { type: "Ready", status: "True", reason: "Converged" };
}

function staleKeys(key: GitKeyRow): string[] {
  const candidates = [key.registered_public_key, key.deletion_requested_at ? key.public_key : null];
  const unique = [...new Set(candidates.filter((value): value is string => value !== null))];
  return key.deletion_requested_at !== null ? unique : unique.filter((value) => value !== key.public_key);
}

class Attempt {
  private readonly startedAt = new Date();
  private readonly steps: ProvisioningStepRecord[] = [];
  private readonly abort = new AbortController();
  private readonly outputs: StoredOutputs;
  private leaseLost = false;
  private confirmedAt: number;
  private deadline: NodeJS.Timeout | undefined;

  constructor(private readonly deps: AttemptDependencies, private readonly claim: Claim, private readonly snapshot: Snapshot) {
    this.outputs = structuredClone(snapshot.outputs);
    this.confirmedAt = claim.claimedAt;
  }

  private get signal(): AbortSignal {
    return this.abort.signal;
  }

  private get spec(): UserProvisioningSpec {
    return this.snapshot.spec;
  }

  async run(): Promise<AttemptResult> {
    const heartbeat = setInterval(() => this.beat(), this.deps.heartbeatMs ?? HEARTBEAT_MS);
    this.armDeadline();
    try {
      const [chat, git] = await Promise.all([this.chatBranch(), this.gitBranch()]);
      return await this.finish(chat, git);
    } catch (error) {
      if (!(error instanceof LeaseLostError) && !this.leaseLost) throw error;
      return await this.recordLeaseLost();
    } finally {
      clearInterval(heartbeat);
      clearTimeout(this.deadline);
      this.abort.abort();
    }
  }

  private armDeadline(): void {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => {
      if (this.leaseLost) return;
      this.deps.log.error("provisioning lease ran out without a confirmed heartbeat; attempt stopped", { uid: this.claim.uid, leaseMs: this.deps.queue.leaseMs });
      this.loseLease();
    }, Math.max(0, this.confirmedAt + this.deps.queue.leaseMs - Date.now()));
  }

  private loseLease(): void {
    this.leaseLost = true;
    clearTimeout(this.deadline);
    this.abort.abort();
  }

  private leaseConfirmed(): boolean {
    return !this.leaseLost && Date.now() - this.confirmedAt < this.deps.queue.leaseMs;
  }

  private beat(): void {
    const sentAt = Date.now();
    this.deps.queue.heartbeat(this.claim.uid, this.claim.leaseToken).then((held) => {
      if (!held) return this.loseLease();
      if (this.leaseLost) return;
      this.confirmedAt = Math.max(this.confirmedAt, sentAt);
      this.armDeadline();
    }).catch((error: unknown) => this.deps.log.error("lease heartbeat failed", { uid: this.claim.uid, error: message(error) }));
  }

  private saveOutputs(): Promise<void> {
    const t = this.deps.db.table;
    return this.deps.queue.fenced(this.claim.uid, this.claim.leaseToken, async (client, bumpVersion) => {
      const version = await bumpVersion();
      await client.query(`UPDATE ${t("provisionings")} SET outputs = $2, resource_version = $3 WHERE uid = $1`,
        [this.claim.uid, JSON.stringify(this.outputs), version.toString()]);
    });
  }

  private async hostCall<T>(host: "chat" | "git", operation: string, call: () => Promise<T>): Promise<T> {
    if (!this.leaseConfirmed()) throw new LeaseLostError(this.claim.uid);
    const began = performance.now();
    try {
      const result = await call();
      this.deps.metrics.hostCall(host, operation, "ok", (performance.now() - began) / 1_000);
      return result;
    } catch (error) {
      this.deps.metrics.hostCall(host, operation, hostErrorKind(error), (performance.now() - began) / 1_000);
      throw error;
    }
  }

  private async step(name: ProvisioningStep, reason: ProvisioningConditionReason, body: () => Promise<string[] | void>): Promise<void> {
    if (!this.leaseConfirmed()) throw new LeaseLostError(this.claim.uid);
    const began = performance.now();
    try {
      const warnings = await body();
      this.steps.push({ step: name, outcome: "succeeded", durationMs: Math.round(performance.now() - began), ...(warnings?.length ? { message: warnings.join("; ") } : {}) });
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      if (this.leaseLost) throw new LeaseLostError(this.claim.uid);
      const failure = { reason, message: message(error), kind: hostErrorKind(error) };
      this.steps.push({ step: name, outcome: "failed", reason, message: failure.message, durationMs: Math.round(performance.now() - began) });
      this.deps.log.error("provisioning step failed", { uid: this.claim.uid, generation: this.snapshot.generation, step: name, reason, kind: failure.kind, error: failure.message });
      throw new StepFailed(failure);
    }
  }

  private skip(names: ProvisioningStep[]): void {
    for (const name of names) this.steps.push({ step: name, outcome: "skipped", durationMs: 0 });
  }

  private async issueOnce(name: ProvisioningCredentialName, issue: () => Promise<{ token: string }>): Promise<void> {
    if (await this.deps.credentials.read(this.claim.uid, name)) return;
    const { token } = await issue();
    await this.deps.credentials.write(this.claim.uid, name, token, this.claim.leaseToken);
  }

  private async chatBranch(): Promise<ChatResult> {
    let completed = 0;
    try {
      const chat = await this.chatUser();
      completed = 1;
      await this.chatTeam(chat);
      completed = 2;
      await this.chatChannels(chat);
      completed = 3;
      await this.chatAgent(chat);
    } catch (error) {
      if (!(error instanceof StepFailed)) throw error;
      this.skip(CHAT_STEPS.slice(completed + 1));
      return { chat: error.failure, credentials: { reason: "ChatNotReady", message: "", kind: error.failure.kind } };
    }
    try {
      const userId = this.outputs.chat!.userId;
      await this.step("user-chat-token", "UserChatTokenFailed", () =>
        this.issueOnce("user-chat-token", () => this.hostCall("chat", "issueUserToken", () => this.deps.chat.issueUserToken({ userId }, this.signal))));
    } catch (error) {
      if (!(error instanceof StepFailed)) throw error;
      return { credentials: error.failure };
    }
    return {};
  }

  private async chatUser(): Promise<ChatOutputs> {
    const { spec } = this;
    await this.step("chat-user", "ChatUserFailed", async () => {
      const knownUserId = this.outputs.chat?.userId;
      const result = await this.hostCall("chat", "ensureUser", () => this.deps.chat.ensureUser({
        uid: this.claim.uid, slug: spec.slug, email: spec.email, displayName: spec.displayName, avatarUrl: spec.avatarUrl,
        ...(knownUserId ? { knownUserId } : {}),
      }, this.signal));
      this.outputs.chat = { ...(this.outputs.chat ?? { teamId: "", channels: { general: "" } }), userId: result.userId };
      await this.saveOutputs();
      return result.warnings;
    });
    return this.outputs.chat!;
  }

  private chatTeam(chat: ChatOutputs): Promise<void> {
    return this.step("chat-team", "ChatTeamFailed", async () => {
      const { teamId } = await this.hostCall("chat", "ensureTeam", () => this.deps.chat.ensureTeam({
        slug: this.spec.slug, displayName: this.spec.chat.teamDisplayName, userId: chat.userId, ...(chat.teamId ? { knownTeamId: chat.teamId } : {}),
      }, this.signal));
      chat.teamId = teamId;
      await this.saveOutputs();
    });
  }

  private ownerFirstName(): string {
    return this.spec.displayName.first.trim() || this.spec.slug;
  }

  private chatChannels(chat: ChatOutputs): Promise<void> {
    return this.step("chat-channels", "ChatChannelsFailed", async () => {
      const known = { ...(chat.channels.general ? { general: chat.channels.general } : {}), ...(chat.channels.agent ? { agent: chat.channels.agent } : {}) };
      chat.channels = await this.hostCall("chat", "ensureChannels", () => this.deps.chat.ensureChannels({
        slug: this.spec.slug, ownerFirstName: this.ownerFirstName(), teamId: chat.teamId, userId: chat.userId,
        agentChannel: this.spec.chat.defaultAgent.enabled, known,
      }, this.signal));
      await this.saveOutputs();
    });
  }

  private async chatAgent(chat: ChatOutputs): Promise<void> {
    if (!this.spec.chat.defaultAgent.enabled) {
      this.skip(["chat-agent"]);
      return;
    }
    await this.step("chat-agent", "ChatAgentFailed", async () => {
      const { botUserId } = await this.hostCall("chat", "ensureAgentBot", () => this.deps.chat.ensureAgentBot({
        slug: this.spec.slug, ownerFirstName: this.ownerFirstName(), teamId: chat.teamId,
        ...(chat.channels.general ? { generalChannelId: chat.channels.general } : {}),
        ...(chat.channels.agent ? { agentChannelId: chat.channels.agent } : {}),
        ...(chat.agentBotUserId ? { knownBotUserId: chat.agentBotUserId } : {}),
      }, this.signal));
      chat.agentBotUserId = botUserId;
      await this.saveOutputs();
      await this.issueOnce("agent-chat-token", () => this.hostCall("chat", "issueAgentToken", () => this.deps.chat.issueAgentToken({ botUserId }, this.signal)));
    });
  }

  private async gitBranch(): Promise<GitResult> {
    let owner: string | undefined;
    try {
      owner = await this.gitOwner();
      await this.gitRepositories(owner);
    } catch (error) {
      if (!(error instanceof StepFailed)) throw error;
      this.skip(owner === undefined ? ["git-repositories", "git-keys"] : ["git-keys"]);
      return { git: error.failure };
    }
    if (this.snapshot.keys.length === 0) return {};
    try {
      await this.step("git-keys", "GitKeyFailed", () => this.reconcileKeys(owner!));
    } catch (error) {
      if (!(error instanceof StepFailed)) throw error;
      return { keys: error.failure };
    }
    return {};
  }

  private async gitOwner(): Promise<string> {
    await this.step("git-owner", "GitOwnerFailed", async () => {
      const knownOwner = this.outputs.git?.owner;
      const result = await this.hostCall("git", "ensureOwner", () => this.deps.git.ensureOwner({ slug: this.spec.slug, ...(knownOwner ? { knownOwner } : {}) }, this.signal));
      this.outputs.git = { owner: result.owner, repositories: this.outputs.git?.repositories ?? {} };
      await this.saveOutputs();
    });
    return this.outputs.git!.owner;
  }

  private gitRepositories(owner: string): Promise<void> {
    return this.step("git-repositories", "GitRepositoryFailed", async () => {
      const kinds: GitRepositoryKind[] = [...this.spec.git.repositories, ...(this.spec.git.systemConfigRepository ? ["system-config" as const] : [])];
      for (const kind of kinds) {
        const repository = await this.hostCall("git", "ensureRepository", () => this.deps.git.ensureRepository({ owner, kind }, this.signal));
        this.outputs.git!.repositories[kind] = repository;
        await this.saveOutputs();
      }
    });
  }

  private async reconcileKeys(owner: string): Promise<void> {
    const present = await this.hostCall("git", "listKeys", () => this.deps.git.listKeys({ owner, holders: this.snapshot.keys.map((key) => key.gateway_id) }, this.signal));
    const failures: string[] = [];
    let kind: HostErrorKind = "transient";
    for (const key of this.snapshot.keys) {
      try {
        await this.reconcileKey(owner, key, present);
      } catch (error) {
        if (error instanceof LeaseLostError || this.leaseLost) throw error;
        failures.push(`${key.gateway_id}: ${message(error)}`);
        if (hostErrorKind(error) === "terminal") kind = "terminal";
        if (key.deletion_requested_at === null) {
          await this.writeKeyStatus(key, { type: "Registered", status: "False", reason: "GitKeyFailed", message: message(error) }, key.registered_public_key);
        }
      }
    }
    if (failures.length) throw new HostError(kind, failures.join("; "));
  }

  private async reconcileKey(owner: string, key: GitKeyRow, present: AuthorizedGitKey[]): Promise<void> {
    const has = (publicKey: string) => present.some((existing) => existing.publicKey === publicKey && existing.holder === key.gateway_id);
    for (const publicKey of staleKeys(key).filter(has)) {
      await this.hostCall("git", "releaseKey", () => this.deps.git.releaseKey({ owner, publicKey, holder: key.gateway_id }, this.signal));
    }
    if (key.deletion_requested_at !== null) {
      await this.deps.queue.fenced(this.claim.uid, this.claim.leaseToken, (client) =>
        client.query(`DELETE FROM ${this.deps.db.table("git_keys")} WHERE uid = $1 AND gateway_id = $2 AND generation = $3 AND deletion_requested_at IS NOT NULL`,
          [this.claim.uid, key.gateway_id, key.generation]));
      return;
    }
    if (has(key.public_key)) {
      await this.writeKeyStatus(key, { type: "Registered", status: "True", reason: "Converged" }, key.public_key);
      return;
    }
    if (present.some((existing) => existing.publicKey === key.public_key && existing.holder === null)) {
      this.deps.log.warn("git key is registered under a holder this service does not manage; left unchanged", { uid: this.claim.uid, gatewayId: key.gateway_id });
      await this.writeKeyStatus(key, { type: "Registered", status: "False", reason: "GitKeyFailed", message: "registered under a holder this service does not manage; left unchanged" }, key.registered_public_key);
      return;
    }
    await this.hostCall("git", "registerKey", () => this.deps.git.registerKey({ owner, publicKey: key.public_key, holder: key.gateway_id }, this.signal));
    await this.writeKeyStatus(key, { type: "Registered", status: "True", reason: "Converged" }, key.public_key);
  }

  private writeKeyStatus(key: GitKeyRow, update: ConditionUpdate<"Registered">, registered: string | null): Promise<void> {
    return this.deps.queue.fenced(this.claim.uid, this.claim.leaseToken, async (client, bumpVersion) => {
      const conditions = applyConditions(key.conditions, [update], key.generation, new Date());
      const version = await bumpVersion();
      await client.query(
        `UPDATE ${this.deps.db.table("git_keys")} SET conditions = $4, observed_generation = $3, registered_public_key = $5, resource_version = $6
          WHERE uid = $1 AND gateway_id = $2 AND generation = $3`,
        [this.claim.uid, key.gateway_id, key.generation, JSON.stringify(conditions), registered, version.toString()]);
    });
  }

  private async finish(chat: ChatResult, git: GitResult): Promise<FinishResult> {
    const { uid } = this.claim;
    const { generation } = this.snapshot;
    const updates = [
      readiness(chat.chat, "ChatReady"),
      readiness(git.git, "GitReady"),
      readiness(chat.credentials, "CredentialsIssued"),
      readyCondition(chat, git),
    ];
    const failures = [chat.chat, chat.chat ? undefined : chat.credentials, git.git, git.keys].filter((failure): failure is Failure => failure !== undefined);
    const first = failures[0];
    const finishedAt = new Date();
    const result = await this.deps.queue.finish(uid, this.claim.leaseToken, {
      generation,
      conditions: applyConditions(this.snapshot.conditions, updates, generation, finishedAt),
      attempt: { generation, startedAt: this.startedAt.toISOString(), finishedAt: finishedAt.toISOString(), ...(first ? { reason: first.reason } : {}), steps: this.steps },
      outcome: first
        ? { kind: "failed", errorKind: failures.some((failure) => failure.kind === "terminal") ? "terminal" : "transient", reason: first.reason, message: failures.map((failure) => failure.message).join("; ") }
        : { kind: "succeeded" },
    });
    const reason = first?.reason ?? "Converged";
    let outcome = "succeeded";
    if (result.state === "parked") outcome = "parked";
    else if (first) outcome = "failed";
    this.deps.metrics.attempt(outcome, reason);
    this.deps.log.info("provisioning attempt finished", {
      uid, generation, state: result.state, attempts: result.attempts, reason, durationMs: finishedAt.getTime() - this.startedAt.getTime(),
      steps: this.steps.map((record) => ({ step: record.step, outcome: record.outcome, durationMs: record.durationMs })),
    });
    if (result.state === "parked") this.deps.log.error("provisioning work parked", { uid, generation, reason, attempts: result.attempts });
    return result;
  }

  private async recordLeaseLost(): Promise<AttemptResult> {
    const finishedAt = new Date();
    this.deps.log.error("provisioning lease lost; attempt stopped", { uid: this.claim.uid, generation: this.snapshot.generation });
    this.deps.metrics.attempt("lease-lost", "LeaseLost");
    await this.deps.queue.recordLeaseLost(this.claim.uid, {
      generation: this.snapshot.generation, startedAt: this.startedAt.toISOString(), finishedAt: finishedAt.toISOString(), steps: this.steps,
    }).catch((error: unknown) => this.deps.log.error("recording a lost lease failed", { uid: this.claim.uid, error: message(error) }));
    return { state: "lease-lost" };
  }
}

export async function runAttempt(deps: AttemptDependencies, claim: Claim): Promise<AttemptResult> {
  const t = deps.db.table;
  const loaded = await deps.db.pool.query<Omit<Snapshot, "keys">>(
    `SELECT generation, spec, outputs, conditions FROM ${t("provisionings")} WHERE uid = $1`, [claim.uid]);
  if (!loaded.rows[0]) return { state: "gone" };
  const keys = await deps.db.pool.query<GitKeyRow>(`SELECT * FROM ${t("git_keys")} WHERE uid = $1 ORDER BY gateway_id`, [claim.uid]);
  return new Attempt(deps, claim, { ...loaded.rows[0], keys: keys.rows }).run();
}
