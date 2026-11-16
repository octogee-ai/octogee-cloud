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
import { publicKeyIdentity } from "@octogee/core/gitea-naming";
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
  keys: SnapshotKey[];
}

type SnapshotKey = GitKeyRow & { backing_off: boolean };

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

const KEY_REFUSAL_BACKOFF_MS = 60_000;
const KEY_REFUSAL_MAX_BACKOFF_MS = 6 * 60 * 60_000;

type KeyRefusalReason = "GitKeyHeldElsewhere" | "GitKeyNotOnHost" | "GitKeyReplacedOnHost" | "GitNotReady";

const BACKOFF_EXPONENT_CAP = 20;
const BACKOFF_SQL = `now() + LEAST($4::double precision * power(2, LEAST(refusals, ${BACKOFF_EXPONENT_CAP})), $5::double precision) * interval '1 millisecond'`;

class KeyRefused extends Error {
  constructor(override readonly cause: HostError, readonly reason: KeyRefusalReason = "GitKeyHeldElsewhere", readonly repeated = false) {
    super(cause.message);
    this.name = "KeyRefused";
  }
}

const HELD_ELSEWHERE = "the key is held under another managed title; it is taken only while its gateway puts it";

function registeredCondition(key: GitKeyRow): { status: string; reason: string; message?: string } | undefined {
  return key.conditions.find((condition) => condition.type === "Registered");
}

function observedMismatch(key: GitKeyRow, observed: "GitKeyHeldElsewhere" | "GitKeyNotOnHost" | "GitKeyReplacedOnHost"): KeyRefused {
  const previous = registeredCondition(key);
  const kept = observed === "GitKeyNotOnHost" && previous?.status === "False" && previous.reason === "GitKeyHeldElsewhere" ? "GitKeyHeldElsewhere" : observed;
  const repeated = previous?.status === "False" && previous.reason === kept;
  const details: Record<typeof kept, string> = {
    GitKeyHeldElsewhere: HELD_ELSEWHERE,
    GitKeyNotOnHost: "the git host holds no key under this holder's title; the service writes the key only when its gateway puts it",
    GitKeyReplacedOnHost: "the git host holds a different key under this holder's title; the service writes the key only when its gateway puts it",
  };
  return new KeyRefused(new HostError("terminal", details[kept], kept === "GitKeyHeldElsewhere" ? { code: "key-held-elsewhere" } : {}), kept, repeated);
}

const REFUSAL_LOGS: Record<KeyRefusalReason, string> = {
  GitKeyHeldElsewhere: "the git host refused the git key; recorded on the key and the rest of the attempt continues",
  GitKeyNotOnHost: "the git host does not hold the row's key under its title; recorded on the key and left for its gateway's next put",
  GitKeyReplacedOnHost: "the git host does not hold the row's key under its title; recorded on the key and left for its gateway's next put",
  GitNotReady: "the user's git account does not exist yet; the put key is refused until provisioning creates it",
};

function deletionsFirst(keys: readonly SnapshotKey[]): SnapshotKey[] {
  return [...keys.filter((key) => key.deletion_requested_at !== null), ...keys.filter((key) => key.deletion_requested_at === null)];
}

interface KeyListing {
  current(): Promise<AuthorizedGitKey[]>;
  changed(): void;
  readonly writes: number;
}

function holdsKey(present: readonly AuthorizedGitKey[], key: GitKeyRow): boolean {
  const wanted = publicKeyIdentity(key.public_key);
  return present.some((existing) => existing.holder === key.holder && publicKeyIdentity(existing.publicKey) === wanted);
}

function staleKeys(key: GitKeyRow): string[] {
  const candidates = [key.registered_public_key, key.deletion_requested_at ? key.public_key : null];
  const unique = [...new Set(candidates.filter((value): value is string => value !== null))];
  if (key.deletion_requested_at !== null) return unique;
  const wanted = publicKeyIdentity(key.public_key);
  return unique.filter((value) => publicKeyIdentity(value) !== wanted);
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

  run(): Promise<AttemptResult> {
    return this.leased(async () => {
      const [chat, git] = await Promise.all([this.chatBranch(), this.gitBranch()]);
      return this.finish(chat, git);
    });
  }

  runParkedKeys(): Promise<AttemptResult> {
    return this.leased(async () => {
      await this.reconcileParkedKeys();
      return this.deps.queue.finishParkedKeys(this.claim.uid, this.claim.leaseToken);
    });
  }

  private async leased(body: () => Promise<FinishResult>): Promise<AttemptResult> {
    const heartbeat = setInterval(() => this.beat(), this.deps.heartbeatMs ?? HEARTBEAT_MS);
    this.armDeadline();
    try {
      return await body();
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

  private keyListing(owner: string, keys: readonly SnapshotKey[]): KeyListing {
    let present: AuthorizedGitKey[] | null = null;
    let writes = 0;
    return {
      current: async () => {
        present ??= await this.hostCall("git", "listKeys", () => this.deps.git.listKeys({ owner, holders: keys.map((key) => key.holder) }, this.signal));
        return present;
      },
      changed: () => { present = null; writes += 1; },
      get writes() { return writes; },
    };
  }

  private async refuseKeysTakenLater(listing: KeyListing, registered: readonly SnapshotKey[], writesBefore: ReadonlyMap<SnapshotKey, number>): Promise<void> {
    const overtaken = registered.filter((key) => listing.writes > (writesBefore.get(key) ?? 0));
    if (overtaken.length === 0) return;
    listing.changed();
    const present = await listing.current();
    for (const key of overtaken.filter((candidate) => !holdsKey(present, candidate))) {
      await this.writeKeyRefusal(key, new KeyRefused(new HostError("terminal", "another holder of this user took the key later in the same attempt", { code: "key-held-elsewhere" })));
    }
  }

  private async reconcileKeys(owner: string): Promise<string[]> {
    const keys = deletionsFirst(this.snapshot.keys);
    const listing = this.keyListing(owner, keys);
    await listing.current();
    const failures: string[] = [];
    const refused: string[] = [];
    const registered: SnapshotKey[] = [];
    const writesAt = new Map<SnapshotKey, number>();
    let kind: HostErrorKind = "transient";
    for (const key of keys) {
      try {
        if (await this.reconcileKey(owner, key, listing)) {
          registered.push(key);
          writesAt.set(key, listing.writes);
        }
      } catch (error) {
        if (error instanceof LeaseLostError || this.leaseLost) throw error;
        if (error instanceof KeyRefused) {
          await this.writeKeyRefusal(key, error);
          refused.push(`${key.holder}: ${message(error.cause)}`);
          continue;
        }
        failures.push(`${key.holder}: ${message(error)}`);
        if (hostErrorKind(error) === "terminal") kind = "terminal";
        if (key.deletion_requested_at === null) {
          await this.writeKeyStatus(key, { type: "Registered", status: "False", reason: "GitKeyFailed", message: message(error) }, key.registered_public_key);
        }
      }
    }
    await this.refuseKeysTakenLater(listing, registered, writesAt);
    if (failures.length) throw new HostError(kind, failures.join("; "));
    return refused;
  }

  private async reconcileParkedKeys(): Promise<void> {
    const due = this.snapshot.keys.filter((key) => key.deletion_requested_at === null || !key.backing_off);
    const owner = this.outputs.git?.owner;
    if (owner === undefined) {
      await this.settleKeysWithoutGitAccount(due);
      return;
    }
    const keys = deletionsFirst(due);
    const listing = this.keyListing(owner, keys);
    try {
      await listing.current();
    } catch (error) {
      if (error instanceof LeaseLostError || this.leaseLost) throw error;
      await this.recordParkedListingFailure(keys, error);
      return;
    }
    const registered: SnapshotKey[] = [];
    const writesAt = new Map<SnapshotKey, number>();
    for (const key of keys) {
      if (await this.reconcileParkedKey(owner, key, listing)) {
        registered.push(key);
        writesAt.set(key, listing.writes);
      }
    }
    try {
      await this.refuseKeysTakenLater(listing, registered, writesAt);
    } catch (error) {
      if (error instanceof LeaseLostError || this.leaseLost) throw error;
      this.deps.log.error("checking a parked user's registered git keys after the key pass failed; checked again on the next pass", { uid: this.claim.uid, error: message(error) });
    }
  }

  private async settleKeysWithoutGitAccount(keys: readonly SnapshotKey[]): Promise<void> {
    for (const key of keys) {
      if (key.deletion_requested_at !== null) await this.deleteReleasedRow(key);
      else if (!key.backing_off && key.put_sequence > key.observed_put_sequence) {
        await this.writeKeyRefusal(key, new KeyRefused(new HostError("terminal", "the user's git account does not exist yet; put the key again once provisioning has created it"), "GitNotReady"));
      }
    }
  }

  private async recordParkedListingFailure(keys: readonly SnapshotKey[], error: unknown): Promise<void> {
    const writing = keys.filter((key) => key.deletion_requested_at !== null || (!key.backing_off && key.put_sequence > key.observed_put_sequence));
    for (const key of writing) await this.writeParkedKeyFailure(key, error);
    this.deps.log.error("listing a parked user's git keys failed; observed again on the next pass", { uid: this.claim.uid, error: message(error) });
  }

  private async reconcileParkedKey(owner: string, key: SnapshotKey, listing: KeyListing): Promise<boolean> {
    try {
      return await this.reconcileKey(owner, key, listing);
    } catch (error) {
      if (error instanceof LeaseLostError || this.leaseLost) throw error;
      if (error instanceof KeyRefused) await this.writeKeyRefusal(key, error);
      else await this.writeParkedKeyFailure(key, error);
      return false;
    }
  }

  private writeParkedKeyFailure(key: GitKeyRow, error: unknown): Promise<void> {
    const [action, noun] = key.deletion_requested_at === null ? ["registering", "registration"] : ["releasing", "release"];
    return this.deps.queue.fenced(this.claim.uid, this.claim.leaseToken, async (client, bumpVersion) => {
      const version = await bumpVersion();
      const { rows } = await client.query<{ retry_after: Date }>(
        `UPDATE ${this.deps.db.table("git_keys")} SET refusals = refusals + 1, resource_version = $6,
            retry_after = ${BACKOFF_SQL}
          WHERE uid = $1 AND holder = $2 AND generation = $3 AND put_sequence = $7 RETURNING retry_after`,
        [this.claim.uid, key.holder, key.generation, KEY_REFUSAL_BACKOFF_MS, KEY_REFUSAL_MAX_BACKOFF_MS, version.toString(), key.put_sequence]);
      const nextAttemptAt = rows[0]?.retry_after.toISOString() ?? null;
      const conditions = applyConditions(key.conditions,
        [{ type: "Registered", status: "Unknown", reason: "GitKeyFailed", message: `${noun} failed: ${message(error)}; next attempt after ${nextAttemptAt}` }], key.generation, new Date());
      await client.query(`UPDATE ${this.deps.db.table("git_keys")} SET conditions = $4 WHERE uid = $1 AND holder = $2 AND generation = $3`,
        [this.claim.uid, key.holder, key.generation, JSON.stringify(conditions)]);
      this.deps.log.error(`${action} a parked user's git key failed; recorded on the key and retried after backoff`, {
        uid: this.claim.uid, holder: key.holder, nextAttemptAt, error: message(error),
      });
    });
  }

  private deleteReleasedRow(key: GitKeyRow): Promise<unknown> {
    return this.deps.queue.fenced(this.claim.uid, this.claim.leaseToken, (client) =>
      client.query(`DELETE FROM ${this.deps.db.table("git_keys")} WHERE uid = $1 AND holder = $2 AND generation = $3 AND deletion_requested_at IS NOT NULL`,
        [this.claim.uid, key.holder, key.generation]));
  }

  private async reconcileKey(owner: string, key: SnapshotKey, listing: KeyListing): Promise<boolean> {
    const sameKey = (left: string, right: string) => publicKeyIdentity(left) === publicKeyIdentity(right);
    const initial = await listing.current();
    const held = (publicKey: string) => initial.some((existing) => sameKey(existing.publicKey, publicKey) && existing.holder === key.holder);
    const putPending = key.put_sequence > key.observed_put_sequence;
    const writes = putPending || key.deletion_requested_at !== null;
    for (const publicKey of writes ? staleKeys(key).filter(held) : []) {
      listing.changed();
      await this.hostCall("git", "releaseKey", () => this.deps.git.releaseKey({ owner, publicKey, holder: key.holder }, this.signal));
    }
    if (key.deletion_requested_at !== null) {
      await this.deleteReleasedRow(key);
      return false;
    }
    const present = await listing.current();
    if (holdsKey(present, key)) {
      await this.writeKeyStatus(key, { type: "Registered", status: "True", reason: "Converged" }, key.public_key);
      return true;
    }
    if (key.backing_off) return false;
    const elsewhere = present.some((existing) => sameKey(existing.publicKey, key.public_key) && existing.holder !== key.holder);
    if (!putPending) {
      if (elsewhere) throw observedMismatch(key, "GitKeyHeldElsewhere");
      throw observedMismatch(key, present.some((existing) => existing.holder === key.holder) ? "GitKeyReplacedOnHost" : "GitKeyNotOnHost");
    }
    if (elsewhere) {
      this.deps.log.info("adopting the identical git key the user's account holds under another managed title, at its gateway's put", { uid: this.claim.uid, holder: key.holder });
    }
    listing.changed();
    try {
      await this.hostCall("git", "registerKey", () => this.deps.git.registerKey({ owner, publicKey: key.public_key, holder: key.holder }, this.signal));
    } catch (error) {
      if (error instanceof HostError && error.code === "key-held-elsewhere") throw new KeyRefused(error);
      throw error;
    }
    await this.writeKeyStatus(key, { type: "Registered", status: "True", reason: "Converged" }, key.public_key);
    return true;
  }

  private writeKeyRefusal(key: GitKeyRow, refusal: KeyRefused): Promise<void> {
    const { cause: error, reason, repeated } = refusal;
    return this.deps.queue.fenced(this.claim.uid, this.claim.leaseToken, async (client, bumpVersion) => {
      const version = await bumpVersion();
      const { rows } = await client.query<{ retry_after: Date }>(
        `UPDATE ${this.deps.db.table("git_keys")} SET refusals = refusals + 1,
            retry_after = ${BACKOFF_SQL}
          WHERE uid = $1 AND holder = $2 AND generation = $3 AND put_sequence = $6 RETURNING retry_after`,
        [this.claim.uid, key.holder, key.generation, KEY_REFUSAL_BACKOFF_MS, KEY_REFUSAL_MAX_BACKOFF_MS, key.put_sequence]);
      const nextAttemptAt = rows[0]?.retry_after.toISOString() ?? null;
      const conditions = applyConditions(key.conditions, [{ type: "Registered", status: "False", reason, message: `${message(error)}; next attempt after ${nextAttemptAt}` }], key.generation, new Date());
      await client.query(
        `UPDATE ${this.deps.db.table("git_keys")} SET conditions = $4, observed_generation = $3, resource_version = $5,
            observed_put_sequence = GREATEST(observed_put_sequence, $6)
          WHERE uid = $1 AND holder = $2 AND generation = $3`,
        [this.claim.uid, key.holder, key.generation, JSON.stringify(conditions), version.toString(), key.put_sequence]);
      const fields = { uid: this.claim.uid, holder: key.holder, reason, nextAttemptAt, error: message(error) };
      const mismatch = reason === "GitKeyNotOnHost" || reason === "GitKeyReplacedOnHost";
      if (mismatch && !repeated) this.deps.log.warn(REFUSAL_LOGS[reason], fields);
      else this.deps.log.error(REFUSAL_LOGS[reason], fields);
    });
  }

  private writeKeyStatus(key: GitKeyRow, update: ConditionUpdate<"Registered">, registered: string | null): Promise<void> {
    return this.deps.queue.fenced(this.claim.uid, this.claim.leaseToken, async (client, bumpVersion) => {
      const conditions = applyConditions(key.conditions, [update], key.generation, new Date());
      const version = await bumpVersion();
      const cleared = update.status === "True" ? ", refusals = 0, retry_after = NULL, observed_put_sequence = GREATEST(observed_put_sequence, $7)" : "";
      await client.query(
        `UPDATE ${this.deps.db.table("git_keys")} SET conditions = $4, observed_generation = $3, registered_public_key = $5, resource_version = $6${cleared}
          WHERE uid = $1 AND holder = $2 AND generation = $3`,
        [this.claim.uid, key.holder, key.generation, JSON.stringify(conditions), registered, version.toString(), ...(update.status === "True" ? [key.put_sequence] : [])]);
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
  const keys = await deps.db.pool.query<SnapshotKey>(
    `SELECT *, (retry_after IS NOT NULL AND retry_after > now()) AS backing_off FROM ${t("git_keys")} WHERE uid = $1 ORDER BY holder`, [claim.uid]);
  const attempt = new Attempt(deps, claim, { ...loaded.rows[0], keys: keys.rows });
  return claim.keysOnly ? attempt.runParkedKeys() : attempt.run();
}
