import { logger } from "@octogee/core/http/logging";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import Busboy from "busboy";
import {
  AGENT_ACTIVITY_RESERVED_ITEM_IDS,
  agentActivityCanonicalKey,
  type AgentActivityAttachment,
  type AgentActivityDetail,
  type AgentActivityEnvelopeV1,
  type AgentActivityIngressRef,
  type AgentActivityKind,
  type AgentAnswerCommitRecord,
  type AgentAnswerPart,
  type AgentAnswerPartKind,
} from "@octogee/shared/types/agent-conversation";
import {
  createActivitySink,
  ActivitySinkConflictError,
  ActivitySinkInvalidAttachmentError,
  ActivitySinkIntegrityError,
  ActivitySinkUnavailableError,
  type ActivityAttachmentSource,
  type ActivitySink,
  type ActivitySinkResult,
} from "./activity-sink.js";
import {
  type ActivityWriteReceiptStore,
} from "./activity-write-receipts.js";
import type { ActivityMattermostClient } from "./mm-client.js";

const MAX_JSON_BYTES = 256 * 1024;
const MAX_INLINE_DETAIL_BYTES = 48 * 1024;
const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;
const EVENT_KEY = /^[a-f0-9]{64}$/;
const MATTERMOST_MENTION = /^@[a-z0-9._-]{1,64}$/;
const CHANNEL_DOC_PATH = /^workspaces\/[a-z0-9][a-z0-9-]{0,62}\/(?:channels\/[a-z0-9][a-z0-9-]{0,127}|projects\/[a-z0-9][a-z0-9-]{0,62}\/channels\/[a-z0-9][a-z0-9-]{0,127})$/;
const ORIGINS = new Set(["human", "followup", "retry", "scheduled", "subagent"]);
const KINDS = new Set<AgentActivityKind>([
  "commentary",
  "tool",
  "plan",
  "patch",
  "checkpoint",
  "compaction",
  "fallback",
  "approval",
  "error",
]);
const ANSWER_PART_KINDS = new Set<AgentAnswerPartKind>([
  "text",
  "media",
  "voice",
  "poll",
  "card",
  "preview",
  "unknown",
]);
const ANSWER_DELIVERY_OUTCOMES = new Set([
  "delivered",
  "partial",
  "failed",
  "suppressed",
  "not-attempted",
]);
const APPLICATION_TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/xml",
]);

function safeAttachmentFilename(filename: string): boolean {
  const hasControlCharacter = Array.from(filename).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  return (
    Buffer.byteLength(filename, "utf8") <= 255 &&
    filename.trim() === filename &&
    filename !== "." &&
    filename !== ".." &&
    !filename.includes("/") &&
    !filename.includes("\\") &&
    !hasControlCharacter
  );
}

function safeAttachmentMediaType(mediaType: string): boolean {
  return (
    /^text\/[a-z0-9][a-z0-9.+-]{0,63}$/.test(mediaType) ||
    APPLICATION_TEXT_MEDIA_TYPES.has(mediaType)
  );
}

export interface ActiveActivityRunBinding {
  conversationId: string;
  turnId: string;
  runId: string;
  parentRunId?: string;
  retryOfRunId?: string;
  origin: AgentActivityIngressRef["origin"];
  agentId: string;
  sessionKey: string;
  requesterSessionKey?: string;
  mainChannelId: string;
  mainRootPostId: string;
  inputPostId?: string;
  channelDocPath: string;
  channelCreateAt: number;
  defaultAgentMmUserId: string;
  coachToken: string;
  attentionMention: string;
}

export interface ActivityRuntimeRegistry {
  readiness(): "unsynchronized" | "ready";
  resolve(ref: AgentActivityIngressRef): Promise<ActiveActivityRunBinding | null>;
  resolveRun(runId: string): Promise<ActiveActivityRunBinding | null>;
  releaseRun(runId: string): void;
}

export class MutableActivityRuntimeRegistry implements ActivityRuntimeRegistry {
  private synchronized = false;
  private readonly bindings = new Map<string, ActiveActivityRunBinding>();

  readiness(): "unsynchronized" | "ready" {
    return this.synchronized ? "ready" : "unsynchronized";
  }

  async resolve(ref: AgentActivityIngressRef): Promise<ActiveActivityRunBinding | null> {
    return this.bindings.get(ref.runId) ?? null;
  }

  async resolveRun(runId: string): Promise<ActiveActivityRunBinding | null> {
    return this.bindings.get(runId) ?? null;
  }

  releaseRun(runId: string): void {
    this.bindings.delete(runId);
  }

  beginSynchronization(): void {
    this.synchronized = false;
    this.bindings.clear();
  }

  replaceSnapshot(bindings: readonly ActiveActivityRunBinding[]): void {
    const next = new Map<string, ActiveActivityRunBinding>();
    for (const binding of bindings) {
      if (next.has(binding.runId)) {
        throw new Error(`duplicate active Activity run ${binding.runId}`);
      }
      next.set(binding.runId, freezeActiveActivityRunBinding(binding));
    }
    this.bindings.clear();
    for (const [runId, binding] of next) this.bindings.set(runId, binding);
    this.synchronized = true;
  }

  upsert(binding: ActiveActivityRunBinding): void {
    if (!this.synchronized) throw new Error("Activity runtime registry is unsynchronized");
    this.bindings.set(binding.runId, freezeActiveActivityRunBinding(binding));
  }

  remove(runId: string): void {
    if (!this.synchronized) throw new Error("Activity runtime registry is unsynchronized");
    this.bindings.delete(runId);
  }
}

function bindingString(binding: ActiveActivityRunBinding, key: keyof ActiveActivityRunBinding): string {
  const value = binding[key];
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new ActivityIntakeError(403, "invalid_runtime_binding", false);
  }
  return value;
}

export function freezeActiveActivityRunBinding(
  value: ActiveActivityRunBinding,
): Readonly<ActiveActivityRunBinding> {
  const binding = structuredClone(value);
  for (const key of [
    "conversationId",
    "turnId",
    "runId",
    "origin",
    "agentId",
    "sessionKey",
    "mainChannelId",
    "mainRootPostId",
    "channelDocPath",
    "defaultAgentMmUserId",
    "coachToken",
    "attentionMention",
  ] as const) {
    bindingString(binding, key);
  }
  if (binding.parentRunId !== undefined) bindingString(binding, "parentRunId");
  if (binding.retryOfRunId !== undefined) bindingString(binding, "retryOfRunId");
  if (binding.inputPostId !== undefined) bindingString(binding, "inputPostId");
  if (binding.requesterSessionKey !== undefined) bindingString(binding, "requesterSessionKey");
  if (
    !ORIGINS.has(binding.origin) ||
    binding.conversationId !== binding.mainChannelId ||
    !Number.isSafeInteger(binding.channelCreateAt) ||
    binding.channelCreateAt < 0 ||
    !CHANNEL_DOC_PATH.test(binding.channelDocPath) ||
    !MATTERMOST_MENTION.test(binding.attentionMention)
  ) {
    throw new ActivityIntakeError(403, "invalid_runtime_binding", false);
  }
  return Object.freeze(binding);
}

export interface ActivityIntakeDeps {
  registry: ActivityRuntimeRegistry;
  sinkFor(binding: ActiveActivityRunBinding): Pick<ActivitySink, "append">;
  log?: (event: string, meta: Record<string, unknown>) => void;
  onPersisted?: (input: {
    envelope: AgentActivityEnvelopeV1;
    binding: Readonly<ActiveActivityRunBinding>;
    activityRootPostId: string;
    outcome: ActivitySinkResult["outcome"];
  }) => void;
}

export interface ActivityIntakeRequest {
  remoteAddress: string | undefined;
  envelope: unknown;
  attachment?: Uint8Array | ActivityAttachmentSource;
  transportFilename?: string;
  transportMediaType?: string;
}

export interface ActivityIntakeResponse {
  status: 200 | 201;
  body: {
    outcome: "persisted" | "duplicate";
    postIds: string[];
    activityRootPostId: string;
  };
}

export class ActivityIntakeError extends Error {
  override readonly name = "ActivityIntakeError";

  constructor(
    readonly status: 401 | 403 | 409 | 413 | 422 | 503,
    readonly code: string,
    readonly retryable = status === 503,
  ) {
    super(code);
  }
}

function record(value: unknown, code = "invalid_envelope"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ActivityIntakeError(422, code, false);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new ActivityIntakeError(422, code, false);
  }
}

function stringField(
  value: Record<string, unknown>,
  name: string,
  code = "invalid_envelope",
): string {
  const field = value[name];
  if (typeof field !== "string" || field.length === 0) {
    throw new ActivityIntakeError(422, code, false);
  }
  return field;
}

function optionalString(value: Record<string, unknown>, name: string): string | undefined {
  const field = value[name];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || !field) {
    throw new ActivityIntakeError(422, "invalid_envelope", false);
  }
  return field;
}

function positiveInteger(
  value: Record<string, unknown>,
  name: string,
  allowZero = false,
): number {
  const field = value[name];
  if (!Number.isSafeInteger(field) || (field as number) < (allowZero ? 0 : 1)) {
    throw new ActivityIntakeError(422, "invalid_envelope", false);
  }
  return field as number;
}

function parseRef(value: unknown): AgentActivityIngressRef {
  const ref = record(value);
  exactKeys(ref, [
    "conversationId",
    "turnId",
    "runId",
    "parentRunId",
    "retryOfRunId",
    "agentId",
    "sessionKey",
    "requesterSessionKey",
    "origin",
    "mainChannelId",
    "mainRootPostId",
    "inputPostId",
    "itemId",
    "ordinal",
    "semanticVersion",
  ], "invalid_ref");
  const origin = stringField(ref, "origin");
  if (!ORIGINS.has(origin)) throw new ActivityIntakeError(422, "invalid_ref", false);
  const parsed: AgentActivityIngressRef = {
    conversationId: stringField(ref, "conversationId"),
    turnId: stringField(ref, "turnId"),
    runId: stringField(ref, "runId"),
    ...(optionalString(ref, "parentRunId") ? { parentRunId: optionalString(ref, "parentRunId") } : {}),
    ...(optionalString(ref, "retryOfRunId") ? { retryOfRunId: optionalString(ref, "retryOfRunId") } : {}),
    agentId: stringField(ref, "agentId"),
    sessionKey: stringField(ref, "sessionKey"),
    ...(optionalString(ref, "requesterSessionKey")
      ? { requesterSessionKey: optionalString(ref, "requesterSessionKey") }
      : {}),
    origin: origin as AgentActivityIngressRef['origin'],
    mainChannelId: stringField(ref, "mainChannelId"),
    mainRootPostId: stringField(ref, "mainRootPostId"),
    ...(optionalString(ref, "inputPostId") ? { inputPostId: optionalString(ref, "inputPostId") } : {}),
    itemId: stringField(ref, "itemId"),
    ordinal: positiveInteger(ref, "ordinal", true),
    semanticVersion: positiveInteger(ref, "semanticVersion"),
  };
  if (parsed.conversationId !== parsed.mainChannelId) {
    throw new ActivityIntakeError(422, "conversation_channel_mismatch", false);
  }
  return parsed;
}

function parseRedaction(value: unknown): AgentActivityEnvelopeV1['redaction'] {
  const redaction = record(value, "invalid_redaction");
  exactKeys(redaction, ["policy", "appliedAt"], "invalid_redaction");
  if (redaction.policy !== "octogee-v1" || redaction.appliedAt !== "producer") {
    throw new ActivityIntakeError(422, "invalid_redaction", false);
  }
  return { policy: "octogee-v1", appliedAt: "producer" };
}

function parseDetail(value: unknown): AgentActivityDetail | undefined {
  if (value === undefined) return undefined;
  const raw = record(value);
  exactKeys(raw, ["format", "text"], "invalid_detail");
  if (raw.format !== "text" && raw.format !== "markdown" && raw.format !== "json") {
    throw new ActivityIntakeError(422, "invalid_detail", false);
  }
  const text = stringField(raw, "text", "invalid_detail");
  if (Buffer.byteLength(text, "utf8") > MAX_INLINE_DETAIL_BYTES) {
    throw new ActivityIntakeError(413, "inline_detail_too_large", false);
  }
  return { format: raw.format, text };
}

function parseAttachment(value: unknown): AgentActivityAttachment | undefined {
  if (value === undefined) return undefined;
  const raw = record(value);
  exactKeys(
    raw,
    ["filename", "mediaType", "byteLength", "sha256", "multipartField"],
    "invalid_attachment",
  );
  const filename = stringField(raw, "filename", "invalid_attachment");
  const mediaType = stringField(raw, "mediaType", "invalid_attachment");
  const sha256 = stringField(raw, "sha256", "invalid_attachment");
  if (
    !safeAttachmentFilename(filename) ||
    !safeAttachmentMediaType(mediaType) ||
    !EVENT_KEY.test(sha256) ||
    raw.multipartField !== "detail"
  ) {
    throw new ActivityIntakeError(422, "invalid_attachment", false);
  }
  return {
    filename,
    mediaType,
    byteLength: positiveInteger(raw, "byteLength"),
    sha256,
    multipartField: "detail",
  };
}

function parseItem(value: unknown) {
  const item = record(value);
  exactKeys(item, ["kind", "status", "summary", "detail", "attachment"], "invalid_item");
  const kind = stringField(item, "kind");
  const status = stringField(item, "status");
  if (!KINDS.has(kind as AgentActivityKind)) {
    throw new ActivityIntakeError(422, "invalid_item", false);
  }
  if (status !== "completed" && status !== "failed" && status !== "waiting") {
    throw new ActivityIntakeError(422, "invalid_item", false);
  }
  const detail = parseDetail(item.detail);
  const attachment = parseAttachment(item.attachment);
  if (detail && attachment) throw new ActivityIntakeError(422, "duplicate_detail", false);
  return {
    kind: kind as AgentActivityKind,
    status: status as "completed" | "failed" | "waiting",
    summary: stringField(item, "summary", "invalid_item"),
    ...(detail ? { detail } : {}),
    ...(attachment ? { attachment } : {}),
  };
}

function parseAnswerPart(value: unknown, expectedIndex: number): AgentAnswerPart {
  const part = record(value, "invalid_answer_commit");
  exactKeys(
    part,
    ["postId", "kind", "index", "rootPostId", "threadId"],
    "invalid_answer_commit",
  );
  const kind = stringField(part, "kind", "invalid_answer_commit");
  if (!ANSWER_PART_KINDS.has(kind as AgentAnswerPartKind)) {
    throw new ActivityIntakeError(422, "invalid_answer_commit", false);
  }
  const index = positiveInteger(part, "index", true);
  if (index !== expectedIndex) {
    throw new ActivityIntakeError(422, "invalid_answer_commit", false);
  }
  const rootPostId = optionalString(part, "rootPostId");
  const threadId = optionalString(part, "threadId");
  return {
    postId: stringField(part, "postId", "invalid_answer_commit"),
    kind: kind as AgentAnswerPartKind,
    index,
    ...(rootPostId ? { rootPostId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

function parseAnswerCommit(value: unknown): AgentAnswerCommitRecord {
  const answer = record(value, "invalid_answer_commit");
  exactKeys(
    answer,
    ["terminalOutcome", "deliveryOutcome", "postIds", "parts"],
    "invalid_answer_commit",
  );
  const terminalOutcome = parseOutcome(answer.terminalOutcome);
  const deliveryOutcome = stringField(answer, "deliveryOutcome", "invalid_answer_commit");
  if (!ANSWER_DELIVERY_OUTCOMES.has(deliveryOutcome)) {
    throw new ActivityIntakeError(422, "invalid_answer_commit", false);
  }
  if (!Array.isArray(answer.postIds) || !Array.isArray(answer.parts)) {
    throw new ActivityIntakeError(422, "invalid_answer_commit", false);
  }
  const postIds = answer.postIds.map((postId) => {
    if (typeof postId !== "string" || !postId) {
      throw new ActivityIntakeError(422, "invalid_answer_commit", false);
    }
    return postId;
  });
  const parts = answer.parts.map(parseAnswerPart);
  const hasDuplicatePostIds = new Set(postIds).size !== postIds.length;
  const aligned = postIds.length === parts.length && parts.every(
    (part, index) => part.postId === postIds[index],
  );
  const requiresPosts = deliveryOutcome === "delivered" || deliveryOutcome === "partial";
  if (
    hasDuplicatePostIds ||
    !aligned ||
    (requiresPosts ? postIds.length === 0 : postIds.length !== 0)
  ) {
    throw new ActivityIntakeError(422, "invalid_answer_commit", false);
  }
  return {
    terminalOutcome,
    deliveryOutcome: deliveryOutcome as AgentAnswerCommitRecord["deliveryOutcome"],
    postIds,
    parts,
  };
}

function assertStartedIdentity(ref: AgentActivityIngressRef): void {
  if (
    ref.itemId !== AGENT_ACTIVITY_RESERVED_ITEM_IDS.runRoot ||
    ref.ordinal !== 0 ||
    ref.semanticVersion !== 1
  ) {
    throw new ActivityIntakeError(422, "invalid_run_root", false);
  }
}

function assertFinalizedIdentity(ref: AgentActivityIngressRef): void {
  if (
    ref.itemId !== AGENT_ACTIVITY_RESERVED_ITEM_IDS.turnFinalized ||
    ref.semanticVersion !== 1
  ) {
    throw new ActivityIntakeError(422, "invalid_finalization", false);
  }
}

function assertAnswerCommitIdentity(ref: AgentActivityIngressRef): void {
  if (
    ref.itemId !== AGENT_ACTIVITY_RESERVED_ITEM_IDS.answerCommit ||
    ref.semanticVersion !== 1
  ) {
    throw new ActivityIntakeError(422, "invalid_answer_commit", false);
  }
}

function assertCompletedIdentity(
  envelope: Extract<AgentActivityEnvelopeV1, { type: "item.completed" }>,
): void {
  const { ref, item } = envelope;
  const approvalId =
    ref.itemId.startsWith(AGENT_ACTIVITY_RESERVED_ITEM_IDS.approvalPrefix) &&
    ref.itemId.length > AGENT_ACTIVITY_RESERVED_ITEM_IDS.approvalPrefix.length;
  if (
    item.kind === "approval" &&
    (!approvalId || ref.semanticVersion !== 1)
  ) {
    throw new ActivityIntakeError(422, "invalid_approval", false);
  }
  if (item.kind !== "approval" && ref.itemId.startsWith(AGENT_ACTIVITY_RESERVED_ITEM_IDS.approvalPrefix)) {
    throw new ActivityIntakeError(422, "invalid_approval", false);
  }
  if (
    ref.itemId === AGENT_ACTIVITY_RESERVED_ITEM_IDS.terminalError &&
    (item.kind !== "error" || item.status !== "failed" || ref.semanticVersion !== 1)
  ) {
    throw new ActivityIntakeError(422, "invalid_terminal_error", false);
  }
  if (!ref.itemId.startsWith("octogee:")) return;
  const allowed =
    ref.itemId === AGENT_ACTIVITY_RESERVED_ITEM_IDS.terminalError ||
    ref.itemId.startsWith(AGENT_ACTIVITY_RESERVED_ITEM_IDS.approvalPrefix);
  if (!allowed) throw new ActivityIntakeError(422, "unknown_reserved_item", false);
}

function assertSemanticIdentity(envelope: AgentActivityEnvelopeV1): void {
  switch (envelope.type) {
    case "turn.started":
      assertStartedIdentity(envelope.ref);
      return;
    case "turn.finalized":
      assertFinalizedIdentity(envelope.ref);
      return;
    case "answer.committed":
      assertAnswerCommitIdentity(envelope.ref);
      return;
    case "item.completed":
      assertCompletedIdentity(envelope);
  }
}

type ParsedEnvelopeBase = Omit<AgentActivityEnvelopeV1, "type" | "item" | "outcome" | "answer">;

function parseOutcome(value: unknown): "completed" | "failed" | "stopped" {
  if (value !== "completed" && value !== "failed" && value !== "stopped") {
    throw new ActivityIntakeError(422, "invalid_outcome", false);
  }
  return value;
}

function parseEnvelopeVariant(
  type: string,
  envelope: Record<string, unknown>,
  base: ParsedEnvelopeBase,
  common: string[],
): AgentActivityEnvelopeV1 {
  switch (type) {
    case "turn.started":
      exactKeys(envelope, common, "invalid_envelope");
      return { ...base, type };
    case "item.completed":
      exactKeys(envelope, [...common, "item"], "invalid_envelope");
      return { ...base, type, item: parseItem(envelope.item) };
    case "turn.finalized":
      exactKeys(envelope, [...common, "outcome"], "invalid_envelope");
      return { ...base, type, outcome: parseOutcome(envelope.outcome) };
    case "answer.committed":
      exactKeys(envelope, [...common, "answer"], "invalid_envelope");
      return { ...base, type, answer: parseAnswerCommit(envelope.answer) };
    default:
      throw new ActivityIntakeError(422, "invalid_event_type", false);
  }
}

export function parseActivityEnvelope(value: unknown): AgentActivityEnvelopeV1 {
  const envelope = record(value);
  const type = stringField(envelope, "type");
  const common = ["schemaVersion", "eventKey", "emittedAt", "ref", "redaction", "type"];
  if (envelope.schemaVersion !== 1) {
    throw new ActivityIntakeError(422, "invalid_schema_version", false);
  }
  const emittedAt = stringField(envelope, "emittedAt");
  if (!Number.isFinite(Date.parse(emittedAt))) {
    throw new ActivityIntakeError(422, "invalid_emitted_at", false);
  }
  const ref = parseRef(envelope.ref);
  const base = {
    schemaVersion: 1 as const,
    eventKey: stringField(envelope, "eventKey"),
    emittedAt,
    ref,
    redaction: parseRedaction(envelope.redaction),
  };
  const parsed = parseEnvelopeVariant(type, envelope, base, common);
  assertSemanticIdentity(parsed);
  const recomputed = createHash("sha256")
    .update(agentActivityCanonicalKey(parsed.ref), "utf8")
    .digest("hex");
  if (!EVENT_KEY.test(parsed.eventKey) || parsed.eventKey !== recomputed) {
    throw new ActivityIntakeError(422, "event_key_mismatch", false);
  }
  return parsed;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address?.startsWith("::ffff:127.") === true;
}

function attachmentIdentity(
  attachment: Uint8Array | ActivityAttachmentSource,
): { byteLength: number; sha256: string } {
  if (attachment instanceof Uint8Array) {
    return {
      byteLength: attachment.byteLength,
      sha256: createHash("sha256").update(attachment).digest("hex"),
    };
  }
  return { byteLength: attachment.byteLength, sha256: attachment.sha256 };
}

function assertAttachment(
  envelope: AgentActivityEnvelopeV1,
  request: Pick<ActivityIntakeRequest, "attachment" | "transportFilename" | "transportMediaType">,
): void {
  const declared = envelope.type === "item.completed" ? envelope.item.attachment : undefined;
  if (!declared && request.attachment) {
    throw new ActivityIntakeError(422, "unexpected_attachment", false);
  }
  if (declared && !request.attachment) {
    throw new ActivityIntakeError(422, "attachment_missing", false);
  }
  if (!declared || !request.attachment) return;
  if (request.transportFilename !== undefined && request.transportFilename !== declared.filename) {
    throw new ActivityIntakeError(422, "attachment_filename_mismatch", false);
  }
  if (request.transportMediaType !== undefined && request.transportMediaType !== declared.mediaType) {
    throw new ActivityIntakeError(422, "attachment_media_type_mismatch", false);
  }
  const actual = attachmentIdentity(request.attachment);
  if (actual.byteLength !== declared.byteLength) {
    throw new ActivityIntakeError(422, "attachment_length_mismatch", false);
  }
  if (actual.sha256 !== declared.sha256) {
    throw new ActivityIntakeError(422, "attachment_hash_mismatch", false);
  }
}

function bindingMatches(ref: AgentActivityIngressRef, binding: ActiveActivityRunBinding): boolean {
  return (
    ref.conversationId === binding.conversationId &&
    ref.turnId === binding.turnId &&
    ref.runId === binding.runId &&
    ref.parentRunId === binding.parentRunId &&
    ref.retryOfRunId === binding.retryOfRunId &&
    ref.origin === binding.origin &&
    ref.agentId === binding.agentId &&
    ref.sessionKey === binding.sessionKey &&
    ref.requesterSessionKey === binding.requesterSessionKey &&
    ref.mainChannelId === binding.mainChannelId &&
    ref.mainRootPostId === binding.mainRootPostId &&
    ref.inputPostId === binding.inputPostId
  );
}

function mapSinkError(error: unknown): never {
  if (error instanceof ActivityIntakeError) throw error;
  if (error instanceof ActivitySinkConflictError) {
    throw new ActivityIntakeError(409, "payload_conflict", false);
  }
  if (error instanceof ActivitySinkInvalidAttachmentError) {
    throw new ActivityIntakeError(422, "invalid_attachment_encoding", false);
  }
  if (error instanceof ActivitySinkIntegrityError) {
    throw new ActivityIntakeError(503, "activity_integrity_failure", true);
  }
  if (error instanceof ActivitySinkUnavailableError) {
    throw new ActivityIntakeError(503, "activity_unavailable", true);
  }
  throw error;
}

function assertActivityAcknowledgement(
  result: Awaited<ReturnType<ActivitySink["append"]>>,
  envelope: AgentActivityEnvelopeV1,
  binding: Readonly<ActiveActivityRunBinding>,
): void {
  const activityRootPostId = result.receipt.activityRootPostId;
  const receiptMatches =
    result.receipt.eventKey === envelope.eventKey &&
    Boolean(activityRootPostId) &&
    activityRootPostId !== binding.mainRootPostId;
  const postMatches = envelope.type === "turn.finalized"
    ? result.postIds.length === 0 && result.receipt.postId === undefined
    : result.postIds.length === 1 && result.receipt.postId === result.postIds[0];
  const rootMatches = envelope.type !== "turn.started" || (
    result.receipt.postId === activityRootPostId
  );
  if (!receiptMatches || !postMatches || !rootMatches) {
    throw new ActivitySinkIntegrityError(
      "Activity acknowledgement failed exact root/channel verification",
    );
  }
}

export async function processActivityIntake(
  request: ActivityIntakeRequest,
  deps: ActivityIntakeDeps,
): Promise<ActivityIntakeResponse> {
  if (!isLoopback(request.remoteAddress)) {
    throw new ActivityIntakeError(401, "non_loopback", false);
  }
  const envelope = parseActivityEnvelope(request.envelope);
  assertAttachment(envelope, request);
  if (deps.registry.readiness() !== "ready") {
    throw new ActivityIntakeError(503, "runtime_unsynchronized", true);
  }
  const binding = await deps.registry.resolve(envelope.ref);
  if (!binding) {
    throw new ActivityIntakeError(403, "binding_mismatch", false);
  }
  const frozenBinding = freezeActiveActivityRunBinding(binding);
  if (!bindingMatches(envelope.ref, frozenBinding)) {
    throw new ActivityIntakeError(403, "binding_mismatch", false);
  }
  try {
    const result = await deps.sinkFor(frozenBinding).append({
      envelope,
      binding: frozenBinding,
      attachment: request.attachment,
    });
    deps.log?.("activity_intake", {
      outcome: result.outcome,
      eventKey: envelope.eventKey,
      runId: envelope.ref.runId,
      itemId: envelope.ref.itemId,
    });
    assertActivityAcknowledgement(result, envelope, frozenBinding);
    if (envelope.type === "turn.finalized") {
      deps.registry.releaseRun(envelope.ref.runId);
    }
    try {
      deps.onPersisted?.({
        envelope,
        binding: frozenBinding,
        activityRootPostId: result.receipt.activityRootPostId,
        outcome: result.outcome,
      });
    } catch (error) {
      deps.log?.("activity_intake_observer_failed", {
        eventKey: envelope.eventKey,
        runId: envelope.ref.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      status: result.outcome === "persisted" ? 201 : 200,
      body: {
        outcome: result.outcome,
        postIds: result.postIds,
        activityRootPostId: result.receipt.activityRootPostId,
      },
    };
  } catch (error) {
    return mapSinkError(error);
  }
}

function readJsonBody(req: IncomingMessage, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      cleanup();
      req.resume();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.byteLength;
      if (size > MAX_JSON_BYTES) {
        fail(new ActivityIntakeError(413, "json_too_large", false));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new ActivityIntakeError(422, "invalid_json", false));
      }
    };
    const onError = (error: Error): void => fail(error);
    const timeout = setTimeout(() => {
      fail(new ActivityIntakeError(503, "body_read_timeout", true));
    }, timeoutMs);
    timeout.unref?.();
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

class TemporaryActivityAttachment implements ActivityAttachmentSource {
  private handle: FileHandle | null = null;

  constructor(
    private readonly filePath: string,
    readonly byteLength: number,
    readonly sha256: string,
  ) {}

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.handle ??= await open(this.filePath, "r");
    const buffer = Buffer.allocUnsafe(Math.min(length, this.byteLength - offset));
    const result = await this.handle.read(buffer, 0, buffer.byteLength, offset);
    return buffer.subarray(0, result.bytesRead);
  }

  async dispose(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
    await unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

interface MultipartActivityBody {
  envelope: unknown;
  attachment?: ActivityAttachmentSource;
  transportFilename?: string;
  transportMediaType?: string;
}

async function removeFailedSpool(filePath: string, originalError: unknown): Promise<never> {
  try {
    await unlink(filePath);
  } catch (cleanupError) {
    const code = (cleanupError as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new AggregateError([originalError, cleanupError]);
  }
  throw originalError;
}

function spoolActivityAttachment(stream: Readable, filePath: string): Promise<ActivityAttachmentSource> {
  const output = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
  const hash = createHash("sha256");
  let size = 0;
  const completed = new Promise<ActivityAttachmentSource>((resolve, reject) => {
    output.on("finish", () => {
      resolve(new TemporaryActivityAttachment(filePath, size, hash.digest("hex")));
    });
    output.on("error", reject);
    stream.on("error", reject);
  });
  stream.on("data", (chunk: Buffer) => {
    size += chunk.byteLength;
    hash.update(chunk);
  });
  stream.pipe(output);
  return completed.catch((error) => removeFailedSpool(filePath, error));
}

function readMultipartBody(
  req: IncomingMessage,
  maxAttachmentBytes: number,
  timeoutMs: number,
): Promise<MultipartActivityBody> {
  return new Promise((resolve, reject) => {
    let envelopeText: string | undefined;
    let attachmentPromise: Promise<ActivityAttachmentSource> | undefined;
    let transportFilename: string | undefined;
    let transportMediaType: string | undefined;
    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: {
          fields: 1,
          files: 1,
          fieldSize: MAX_JSON_BYTES,
          fileSize: maxAttachmentBytes,
        },
      });
    } catch {
      reject(new ActivityIntakeError(422, "invalid_multipart", false));
      return;
    }
    let rejected = false;
    const fail = (error: Error): void => {
      if (rejected) return;
      rejected = true;
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => {
      fail(new ActivityIntakeError(503, "body_read_timeout", true));
      req.unpipe(parser);
      parser.destroy(new Error("body_read_timeout"));
      req.resume();
    }, timeoutMs);
    timeout.unref?.();
    parser.on("field", (name, value, info) => {
      if (name !== "envelope" || info.valueTruncated) {
        fail(new ActivityIntakeError(info.valueTruncated ? 413 : 422, "invalid_multipart_envelope", false));
        return;
      }
      envelopeText = value;
    });
    parser.on("file", (name, stream, info) => {
      if (name !== "detail") {
        stream.resume();
        fail(new ActivityIntakeError(422, "invalid_multipart_attachment", false));
        return;
      }
      transportFilename = info.filename;
      transportMediaType = info.mimeType;
      const filePath = path.join(tmpdir(), `octogee-activity-${randomUUID()}`);
      attachmentPromise = spoolActivityAttachment(stream, filePath);
      stream.on("limit", () => fail(new ActivityIntakeError(413, "attachment_too_large", false)));
    });
    parser.on("filesLimit", () => fail(new ActivityIntakeError(413, "too_many_attachments", false)));
    parser.on("fieldsLimit", () => fail(new ActivityIntakeError(413, "too_many_fields", false)));
    parser.on("error", () => fail(new ActivityIntakeError(422, "invalid_multipart", false)));
    parser.on("close", () => {
      clearTimeout(timeout);
      const finalize = async (): Promise<void> => {
        const attachment = attachmentPromise ? await attachmentPromise : undefined;
        if (rejected) {
          await attachment?.dispose?.();
          return;
        }
        if (!envelopeText) {
          await attachment?.dispose?.();
          fail(new ActivityIntakeError(422, "multipart_envelope_missing", false));
          return;
        }
        try {
          resolve({
            envelope: JSON.parse(envelopeText) as unknown,
            ...(attachment ? { attachment } : {}),
            ...(transportFilename ? { transportFilename } : {}),
            ...(transportMediaType ? { transportMediaType } : {}),
          });
        } catch {
          await attachment?.dispose?.();
          fail(new ActivityIntakeError(422, "invalid_json", false));
        }
      };
      finalize().catch((error) => fail(
        error instanceof Error ? error : new ActivityIntakeError(503, "multipart_spool_failed", true),
      ));
    });
    req.pipe(parser);
  });
}

export interface ActivityIntakeHttpOptions {
  gatewayToken: string;
  maxAttachmentBytes?: number;
  bodyTimeoutMs?: number;
}

export interface ProductionActivityIntakeOptions extends ActivityIntakeHttpOptions {
  registry: ActivityRuntimeRegistry;
  receiptsFor(binding: ActiveActivityRunBinding): ActivityWriteReceiptStore;
  mmClientFor(token: string): ActivityMattermostClient;
  leaseOwner: string;
  alerts?: Parameters<typeof createActivitySink>[0]['alerts'];
  log?: ActivityIntakeDeps['log'];
  onPersisted?: ActivityIntakeDeps['onPersisted'];
}

export function createProductionActivityIntakeHandler(
  options: ProductionActivityIntakeOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return createActivityIntakeHttpHandler(
    {
      registry: options.registry,
      sinkFor: (binding) => createActivitySink({
        mm: options.mmClientFor(binding.coachToken),
        receipts: options.receiptsFor(binding),
        leaseOwner: options.leaseOwner,
        alerts: options.alerts,
      }),
      log: options.log,
      onPersisted: options.onPersisted,
    },
    {
      gatewayToken: options.gatewayToken,
      maxAttachmentBytes: options.maxAttachmentBytes,
      bodyTimeoutMs: options.bodyTimeoutMs,
    },
  );
}

function rejectUnsupportedHttpRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === "POST") return false;
  req.resume();
  res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
  res.end(JSON.stringify({ error: "method_not_allowed", retryable: false }));
  return true;
}

function authorizedLocalRelay(value: string | undefined, expected: string): boolean {
  const supplied = value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : "";
  const actual = Buffer.from(supplied);
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

async function parseHttpActivityBody(
  req: IncomingMessage,
  maxAttachmentBytes: number,
  bodyTimeoutMs: number,
): Promise<MultipartActivityBody> {
  const contentType = req.headers["content-type"] ?? "";
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (
    contentType.startsWith("application/json") &&
    Number.isFinite(contentLength) &&
    contentLength > MAX_JSON_BYTES
  ) {
    req.resume();
    throw new ActivityIntakeError(413, "json_too_large", false);
  }
  if (contentType.startsWith("application/json")) {
    return { envelope: await readJsonBody(req, bodyTimeoutMs) };
  }
  if (contentType.startsWith("multipart/form-data")) {
    return readMultipartBody(req, maxAttachmentBytes, bodyTimeoutMs);
  }
  req.resume();
  throw new ActivityIntakeError(422, "unsupported_content_type", false);
}

function writeJsonResponse(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function normalizeHttpIntakeError(error: unknown): ActivityIntakeError {
  return error instanceof ActivityIntakeError
    ? error
    : new ActivityIntakeError(503, "activity_intake_unavailable", true);
}

async function disposeParsedAttachment(
  parsed: MultipartActivityBody | undefined,
  log: ActivityIntakeDeps['log'],
): Promise<void> {
  try {
    await parsed?.attachment?.dispose?.();
  } catch (error) {
    (log ?? ((event, meta) => logger.error(event, meta)))(
      "activity_attachment_cleanup_error",
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
}

export function createActivityIntakeHttpHandler(
  deps: ActivityIntakeDeps,
  options: ActivityIntakeHttpOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const gatewayToken = options.gatewayToken.trim();
  const maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  if (!gatewayToken) throw new Error("activity intake gateway token is required");
  if (!Number.isSafeInteger(maxAttachmentBytes) || maxAttachmentBytes <= 0) {
    throw new Error("maxAttachmentBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs <= 0) {
    throw new Error("bodyTimeoutMs must be a positive safe integer");
  }
  return async (req, res) => {
    let parsed: MultipartActivityBody | undefined;
    let response: { status: number; body: Record<string, unknown> } | undefined;
    try {
      if (rejectUnsupportedHttpRequest(req, res)) return;
      if (!isLoopback(req.socket.remoteAddress)) {
        req.resume();
        throw new ActivityIntakeError(401, "non_loopback", false);
      }
      if (!authorizedLocalRelay(req.headers.authorization, gatewayToken)) {
        req.resume();
        throw new ActivityIntakeError(401, "unauthorized", false);
      }
      parsed = await parseHttpActivityBody(req, maxAttachmentBytes, bodyTimeoutMs);
      const result = await processActivityIntake(
        {
          remoteAddress: req.socket.remoteAddress,
          envelope: parsed.envelope,
          attachment: parsed.attachment,
          transportFilename: parsed.transportFilename,
          transportMediaType: parsed.transportMediaType,
        },
        deps,
      );
      response = result;
    } catch (error) {
      const intakeError = normalizeHttpIntakeError(error);
      const log = deps.log ?? ((event: string, meta: Record<string, unknown>) => {
        logger.error(event, meta);
      });
      log("activity_intake_error", {
        code: intakeError.code,
        status: intakeError.status,
        retryable: intakeError.retryable,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        response = {
          status: intakeError.status,
          body: {
            error: intakeError.code,
            retryable: intakeError.retryable,
          },
        };
      }
    } finally {
      await disposeParsedAttachment(parsed, deps.log);
    }
    if (response && !res.headersSent) writeJsonResponse(res, response.status, response.body);
  };
}
