import { createHash } from "node:crypto";
import type {
  ActivitySourceSpool,
  ActivitySourceSpoolOutcome,
  ActivitySourceSpoolRecord,
} from "./durable-source-spool.js";
import type {
  ActivityRunTarget,
  AgentAnswerCommit,
  AgentAnswerPart,
  AgentAnswerPartKind,
  AgentAnswerTerminalOutcome,
  AgentActivityAppend,
  AgentActivityEnvelopeV1,
  AgentActivityIngressRef,
  AgentActivityKind,
  SourceAgentEvent,
} from "./activity-types.js";

type ItemStatus = "completed" | "failed" | "waiting";
type PendingTerminal = {
  outcome: AgentAnswerTerminalOutcome;
  error?: string;
  emittedAt: string;
};
type AnswerCommitIdentity = Omit<
  ActivityRunTarget,
  "requesterSessionKey"
>;
type SourceAnswerCommit = AgentAnswerCommit & AnswerCommitIdentity;
type SourceAction =
  | { type: "start" }
  | { type: "item"; itemId: string; kind: AgentActivityKind; status: ItemStatus; body: string; summary: string }
  | { type: "terminal"; outcome: AgentAnswerTerminalOutcome; error?: string }
  | { type: "answer"; commit: SourceAnswerCommit };
type BufferedCommentary = { body: string; emittedAt: string };
type PublicationState = {
  laneId: string;
  commentary: Map<string, BufferedCommentary>;
  versions: Map<string, { bodyHash: string; version: number }>;
  ordinal: number;
  started: boolean;
  finalized: boolean;
  pendingTerminal?: PendingTerminal;
  recoveryEmittedAt?: string;
  terminalSpoolId?: string;
  target: ActivityRunTarget;
};
export type StoredPublicationState = {
  schemaVersion: 1;
  laneId: string;
  commentary: Array<[string, BufferedCommentary]>;
  versions: Array<[string, { bodyHash: string; version: number }]>;
  ordinal: number;
  started: boolean;
  finalized: boolean;
  pendingTerminal?: PendingTerminal;
  recoveryEmittedAt?: string;
  terminalSpoolId?: string;
  target: ActivityRunTarget;
};

export interface ActivitySourceStateStore {
  register(key: string, value: StoredPublicationState): Promise<void>;
  lookup(key: string): Promise<StoredPublicationState | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<Array<{ key: string; value: StoredPublicationState }>>;
}

export interface ActivitySourceParams {
  resolveRun(event: SourceAgentEvent, context: unknown): Promise<ActivitySourceRunResolution>;
  append(item: AgentActivityAppend): Promise<void>;
  spool: ActivitySourceSpool<ActivitySourcePreparedEvent>;
  stateStore: ActivitySourceStateStore;
  releaseRunTarget?: (target: ActivityRunTarget) => Promise<void>;
  sourceIdentity?: (event: SourceAgentEvent, context: unknown) => string;
  now?: () => Date;
  log?: (message: string, fields: Record<string, unknown>) => void;
}

export type ActivitySourcePreparedEvent = {
  event: SourceAgentEvent;
  action: SourceAction;
  context: unknown;
  emittedAt: string;
};

export type ActivitySourceRunResolution = ActivityRunTarget | null | "ignore";

class ActivitySourcePermanentError extends Error {}

const MAX_SUMMARY_CHARS = 4_000;
const MAX_INLINE_DETAIL_BYTES = 48 * 1024;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ITEM_ID_CHARS = 256;
const MAX_TRACKED_ITEMS = 1_024;
const MAX_PUBLICATION_STATE_BYTES = 900 * 1024;
const MAX_COMMENTARY_BYTES = 384 * 1024;
const MAX_ANSWER_POSTS = 512;
const MAX_ANSWER_PARTS = 1_024;
const MAX_ANSWER_ID_CHARS = 512;
const ANSWER_TERMINAL_OUTCOMES = ["completed", "failed", "stopped"] as const;
const ANSWER_DELIVERY_OUTCOMES = [
  "delivered",
  "partial",
  "failed",
  "suppressed",
  "not-attempted",
] as const;
const ANSWER_ORIGINS = ["human", "followup", "retry", "scheduled", "subagent"] as const;
const ANSWER_PART_KINDS = [
  "text",
  "media",
  "voice",
  "poll",
  "card",
  "preview",
  "unknown",
] as const satisfies readonly AgentAnswerPartKind[];
const MUTABLE_KINDS = new Set<AgentActivityKind>(["commentary", "plan", "patch", "checkpoint", "compaction", "fallback"]);
const COMPLETION_SUMMARY = {
  completed: "✅ Run completed",
  failed: "❌ Run failed",
  stopped: "🛑 Run stopped",
} as const;
const RESTART_RECOVERY_ERROR = "Gateway restarted before OpenClaw committed final answer delivery";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiresAnswerCommit(target: ActivityRunTarget): boolean {
  const [agentPrefix, agentId, provider, peerKind, channelId, ...rest] =
    target.sessionKey.split(":");
  return target.origin === "human"
    && target.parentRunId === undefined
    && target.retryOfRunId === undefined
    && target.requesterSessionKey === undefined
    && typeof target.inputPostId === "string"
    && target.inputPostId.length > 0
    && agentPrefix === "agent"
    && agentId === target.agentId
    && provider === "mattermost"
    && (peerKind === "channel" || peerKind === "group")
    && channelId === target.mainChannelId
    && channelId === target.conversationId
    && rest.length === 0;
}

function redact(value: string): string {
  return value
    .replace(
      /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/giu,
      "[redacted: private key]",
    )
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)\S+/giu, "$1***")
    .replace(/(cookie\s*:\s*)[^\r\n]+/giu, "$1***")
    .replace(/\b(?:bearer\s+)?(?:sk|rk|pk|gsk)[_-][a-z0-9._-]{12,}\b/giu, "***")
    .replace(/\b(?:bearer\s+)?(?:xox[baprs]|gh[pousr]|github_pat|glpat)[_-][a-z0-9._-]{12,}\b/giu, "***")
    .replace(/\b(?:bearer\s+)?(?:AIza|hf|pplx|fal|npm|pypi|dapi)[_-][a-z0-9._-]{12,}\b/giu, "***")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "***")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, "***")
    .replace(/((?:api[_-]?key|access[_-]?token|token|secret|credential|signature)\s*[:=]\s*)[^\s,}\]]+/giu, "$1***")
    .replace(/((?:password|passwd|passphrase|session|cookie)\s*[:=]\s*)[^\s,}\]]+/giu, "$1***")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password|signature|session)=)[^&#\s]+/giu, "$1***")
    .replace(/:\/\/([^\s/:@]+):[^\s@/]+@/gu, "://$1:***@");
}

function publicText(value: unknown): string {
  return redact(text(value)).slice(0, MAX_SUMMARY_CHARS);
}

function publicBody(value: unknown): string {
  return redact(text(value));
}

function credentialField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return [
    "authorization",
    "cookie",
    "credential",
    "passphrase",
    "passwd",
    "password",
    "privatekey",
    "secret",
    "session",
    "sessionkey",
    "signature",
    "token",
  ].some((suffix) => normalized === suffix || normalized.endsWith(suffix))
    || normalized.endsWith("apikey");
}

function publicJson(value: unknown, fallback: string): string {
  try {
    const serialized = JSON.stringify(value, (key, field) => (
      credentialField(key) ? "***" : field
    ), 2);
    return typeof serialized === "string" ? redact(serialized) : fallback;
  } catch {
    return fallback;
  }
}

function singleLine(value: unknown, fallback: string): string {
  return (publicText(value) || fallback).replace(/\s+/gu, " ");
}

function fencedBlock(language: string, value: string): string {
  const safe = value
    .split("\n")
    .map((line) => /^(?: {0,3})```/u.test(line) ? `    ${line}` : line)
    .join("\n");
  return `\`\`\`${language}\n${safe}\n\`\`\``;
}

function toolSummary(name: string, phase: "input" | "result", meta: string): string {
  return `### 🔧 ${name} · ${[phase, meta].filter(Boolean).join(" · ")}`
    .slice(0, MAX_SUMMARY_CHARS);
}

function durationMs(value: unknown): number | null {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function trimDecimal(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "0") end -= 1;
  if (end > 0 && value[end - 1] === ".") end -= 1;
  return value.slice(0, end);
}

function toolDurationLabel(data: Record<string, unknown>): string {
  const result = data.result && typeof data.result === "object" && !Array.isArray(data.result)
    ? data.result as Record<string, unknown>
    : null;
  const milliseconds = durationMs(data.durationMs) ?? durationMs(result?.durationMs);
  if (milliseconds === null || milliseconds === 0) return "0s";
  return `${trimDecimal((milliseconds / 1_000).toFixed(3))}s`;
}

function lower(value: unknown): string {
  return text(value).toLowerCase();
}

function sourceId(value: unknown, fallback: string): string {
  const candidate = text(value) || fallback;
  return candidate.startsWith("octogee:") ? `source:${candidate}` : candidate;
}

function sourceItemId(event: SourceAgentEvent, fallback: string): string {
  return sourceId(event.data.itemId ?? event.data.toolCallId, fallback);
}

function toolPhaseItemId(toolCallId: string, phase: "input" | "result"): string {
  const candidate = `${sourceId(toolCallId, "tool")}:${phase}`;
  if (candidate.length <= MAX_ITEM_ID_CHARS) return candidate;
  const digest = createHash("sha256").update(toolCallId).digest("hex");
  return `tool:${digest}:${phase}`;
}

function providerSummary(data: Record<string, unknown>, fallback: string): string {
  return publicText(data.summary) || publicText(data.progressText) || publicText(data.title) || fallback;
}

function approvalStatus(value: string): ItemStatus | null {
  if (value === "pending") return "waiting";
  if (value === "approved") return "completed";
  if (["denied", "failed", "unavailable"].includes(value)) return "failed";
  return null;
}

function providerDetail(data: Record<string, unknown>, fallback: string): string {
  for (const value of [data.detail, data.output, data.result]) {
    if (typeof value === "string") {
      const direct = publicBody(value);
      if (direct) return direct;
      continue;
    }
    if (value !== undefined) return publicJson(value, fallback);
  }
  return providerSummary(data, fallback);
}

function statusFor(data: Record<string, unknown>, fallback: ItemStatus): ItemStatus {
  const status = lower(data.status);
  if (["failed", "error", "errored", "denied"].includes(status)) return "failed";
  if (["waiting", "pending", "approval", "blocked", "running"].includes(status)) return "waiting";
  if (["completed", "complete", "done", "success", "succeeded"].includes(status)) return "completed";
  return fallback;
}

function pathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => typeof entry === "string" && entry.trim() ? [entry.trim()] : []).slice(0, 200);
}

function planBody(data: Record<string, unknown>): string {
  const explanation = publicBody(data.explanation);
  const steps = Array.isArray(data.steps)
    ? data.steps.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const step = publicText((entry as Record<string, unknown>).step);
      const status = lower((entry as Record<string, unknown>).status);
      if (!step) return [];
      let marker = " ";
      if (status === "completed") marker = "x";
      if (status === "in_progress") marker = ">";
      return [`- [${marker}] ${step}`];
    })
    : [];
  return [explanation, steps.join("\n")].filter(Boolean).join("\n\n");
}

function patchBody(data: Record<string, unknown>): string {
  const sections = [["Added", pathList(data.added)], ["Modified", pathList(data.modified)], ["Deleted", pathList(data.deleted)]] as const;
  const files = sections
    .filter(([, paths]) => paths.length > 0)
    .map(([label, paths]) => {
      const entries = paths.map((path) => `- ${publicBody(path)}`).join("\n");
      return `${label}:\n${entries}`;
    });
  return [publicBody(data.summary), ...files].filter(Boolean).join("\n\n");
}

function lifecycleAction(event: SourceAgentEvent): SourceAction | null {
  const phase = lower(event.data.phase);
  if (phase === "start") return { type: "start" };
  const outcome = lower(event.data.outcome);
  const status = lower(event.data.status);
  const stopReason = lower(event.data.stopReason);
  const stopped = event.data.aborted === true ||
    ["abort", "aborted", "cancelled", "canceled", "stopped"].includes(phase) ||
    ["aborted", "cancelled", "canceled", "stopped", "superseded"].includes(outcome) ||
    ["aborted", "cancelled", "canceled", "stopped", "superseded"].includes(status) ||
    ["aborted", "cancelled", "canceled", "gateway_restart", "restart", "rpc", "stopped", "superseded"].includes(stopReason);
  if (stopped) return { type: "terminal", outcome: "stopped" };
  if (phase === "error") return { type: "terminal", outcome: "failed", error: providerSummary(event.data, "Agent run failed") };
  if (phase !== "end") return null;
  if (
    ["failed", "error", "timed_out", "timeout"].includes(outcome) ||
    ["failed", "error", "timed_out", "timeout"].includes(status) ||
    ["error", "timeout"].includes(stopReason)
  ) {
    return { type: "terminal", outcome: "failed", error: providerSummary(event.data, "Agent run failed") };
  }
  return { type: "terminal", outcome: "completed" };
}

function boundedAnswerString(value: unknown, field: string, maxChars: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxChars
    || value.trim() !== value
  ) {
    throw new ActivitySourcePermanentError(`answer commit ${field} is invalid`);
  }
  return value;
}

function optionalAnswerString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return boundedAnswerString(value, field, MAX_ANSWER_ID_CHARS);
}

function answerEnum<const TValue extends string>(
  value: unknown,
  field: string,
  allowed: readonly TValue[],
): TValue {
  if (typeof value !== "string" || !allowed.some((candidate) => candidate === value)) {
    throw new ActivitySourcePermanentError(`answer commit ${field} is invalid`);
  }
  return value as TValue;
}

function answerPart(value: unknown, expectedIndex: number): AgentAnswerPart {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ActivitySourcePermanentError("answer commit part is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.index !== expectedIndex) {
    throw new ActivitySourcePermanentError("answer commit part indexes are not sequential");
  }
  const rootPostId = optionalAnswerString(record.rootPostId, "part rootPostId");
  const threadId = optionalAnswerString(record.threadId, "part threadId");
  return {
    postId: boundedAnswerString(record.postId, "part postId", MAX_ANSWER_ID_CHARS),
    kind: answerEnum(record.kind, "part kind", ANSWER_PART_KINDS),
    index: expectedIndex,
    ...(rootPostId ? { rootPostId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

function answerPostIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ANSWER_POSTS) {
    throw new ActivitySourcePermanentError("answer commit postIds are invalid");
  }
  const postIds = value.map((postId) => (
    boundedAnswerString(postId, "postId", MAX_ANSWER_ID_CHARS)
  ));
  if (new Set(postIds).size !== postIds.length) {
    throw new ActivitySourcePermanentError("answer commit postIds are not unique");
  }
  return postIds;
}

function answerParts(value: unknown): AgentAnswerPart[] {
  if (!Array.isArray(value) || value.length > MAX_ANSWER_PARTS) {
    throw new ActivitySourcePermanentError("answer commit parts are invalid");
  }
  return value.map(answerPart);
}

function assertAnswerDelivery(
  deliveryOutcome: SourceAnswerCommit["deliveryOutcome"],
  postIds: string[],
  parts: AgentAnswerPart[],
): void {
  if (
    parts.length !== postIds.length
    || parts.some((part, index) => part.postId !== postIds[index])
  ) {
    throw new ActivitySourcePermanentError("answer commit postIds do not match ordered parts");
  }
  const hasDeliveredParts = deliveryOutcome === "delivered" || deliveryOutcome === "partial";
  if (hasDeliveredParts !== (postIds.length > 0)) {
    throw new ActivitySourcePermanentError("answer commit delivery outcome does not match posts");
  }
}

function sourceAnswerCommit(data: Record<string, unknown>): SourceAnswerCommit {
  const terminalOutcome = answerEnum(
    data.terminalOutcome,
    "terminalOutcome",
    ANSWER_TERMINAL_OUTCOMES,
  );
  const deliveryOutcome = answerEnum(
    data.deliveryOutcome,
    "deliveryOutcome",
    ANSWER_DELIVERY_OUTCOMES,
  );
  const postIds = answerPostIds(data.postIds);
  const parts = answerParts(data.parts);
  assertAnswerDelivery(deliveryOutcome, postIds, parts);

  const parentRunId = optionalAnswerString(data.parentRunId, "parentRunId");
  const retryOfRunId = optionalAnswerString(data.retryOfRunId, "retryOfRunId");
  const inputPostId = optionalAnswerString(data.inputPostId, "inputPostId");
  return {
    conversationId: boundedAnswerString(data.conversationId, "conversationId", MAX_ANSWER_ID_CHARS),
    turnId: boundedAnswerString(data.turnId, "turnId", MAX_ANSWER_ID_CHARS),
    runId: boundedAnswerString(data.runId, "runId", MAX_ANSWER_ID_CHARS),
    agentId: boundedAnswerString(data.agentId, "agentId", MAX_ANSWER_ID_CHARS),
    sessionKey: boundedAnswerString(data.sessionKey, "sessionKey", MAX_ANSWER_ID_CHARS),
    origin: answerEnum(data.origin, "origin", ANSWER_ORIGINS),
    mainChannelId: boundedAnswerString(data.mainChannelId, "mainChannelId", MAX_ANSWER_ID_CHARS),
    mainRootPostId: boundedAnswerString(data.mainRootPostId, "mainRootPostId", MAX_ANSWER_ID_CHARS),
    terminalOutcome,
    deliveryOutcome,
    postIds,
    parts,
    ...(parentRunId ? { parentRunId } : {}),
    ...(retryOfRunId ? { retryOfRunId } : {}),
    ...(inputPostId ? { inputPostId } : {}),
  };
}

function answerCommitMatchesEvent(commit: SourceAnswerCommit, event: SourceAgentEvent): boolean {
  return commit.runId === event.runId
    && commit.agentId === event.agentId
    && (event.sessionKey === undefined || commit.sessionKey === event.sessionKey);
}

function answerCommitAction(event: SourceAgentEvent): SourceAction | null {
  const data = event.data;
  if (data.kind !== "answer-commit") return null;
  if (data.schemaVersion !== 1) {
    throw new ActivitySourcePermanentError("answer commit schemaVersion is invalid");
  }
  const commit = sourceAnswerCommit(data);
  if (!answerCommitMatchesEvent(commit, event)) {
    throw new ActivitySourcePermanentError("answer commit source identity does not match event");
  }
  return { type: "answer", commit };
}

function commentaryAction(event: SourceAgentEvent): SourceAction | null {
  const kind = lower(event.data.kind);
  if (kind !== "preamble" && kind !== "commentary") return null;
  const body = publicBody(event.data.progressText) || publicBody(event.data.summary);
  if (!body) return null;
  return { type: "item", itemId: sourceItemId(event, `commentary:${event.seq}`), kind: "commentary", status: "completed", body, summary: body.slice(0, MAX_SUMMARY_CHARS) };
}

function toolAction(event: SourceAgentEvent): SourceAction | null {
  const phase = lower(event.data.phase);
  const toolCallId = text(event.data.toolCallId);
  if (!toolCallId) return null;
  const name = singleLine(event.data.name, "tool");
  const meta = singleLine(event.data.meta, "");
  if (phase === "start") {
    const summary = toolSummary(name, "input", meta);
    const args = publicJson(event.data.args, "Arguments unavailable");
    const body = fencedBlock("json", args);
    return {
      type: "item",
      itemId: toolPhaseItemId(toolCallId, "input"),
      kind: "tool",
      status: "waiting",
      body,
      summary,
    };
  }
  if (phase !== "result" && phase !== "end") return null;
  const status = event.data.isError === true ? "failed" : statusFor(event.data, "completed");
  const summary = toolSummary(name, "result", meta);
  const blocks: string[] = [];
  if (event.data.args !== undefined) {
    blocks.push(fencedBlock("json", publicJson(event.data.args, "Arguments unavailable")));
  }
  blocks.push(fencedBlock("", providerDetail(event.data, `${status === "failed" ? "Failed" : "Completed"} ${name}`)));
  blocks.push(`_${toolDurationLabel(event.data)} · ${status}_`);
  return {
    type: "item",
    itemId: toolPhaseItemId(toolCallId, "result"),
    kind: "tool",
    status,
    body: blocks.join("\n\n"),
    summary,
  };
}

function approvalAction(event: SourceAgentEvent): SourceAction | null {
  const phase = lower(event.data.phase);
  if (phase !== "requested" && phase !== "resolved") return null;
  const nativeStatus = lower(event.data.status);
  const status = approvalStatus(nativeStatus);
  if (!status) return null;
  const eventIdentity = `event-${event.seq}`;
  const itemIdentity = text(event.data.itemId);
  const sourceIdentity = text(event.data.toolCallId)
    || text(event.data.approvalId)
    || text(event.data.approvalSlug)
    || (itemIdentity ? `${itemIdentity}:${eventIdentity}` : eventIdentity);
  const candidate = `octogee:approval:${sourceId(sourceIdentity, eventIdentity)}:${phase}`;
  const itemId = candidate.length <= MAX_ITEM_ID_CHARS
    ? candidate
    : `octogee:approval:${createHash("sha256").update(sourceIdentity).digest("hex")}:${phase}`;
  const summary = providerSummary(event.data, phase === "requested" ? "Approval requested" : "Approval resolved");
  const detail: Record<string, string | boolean> = Object.fromEntries([
    ["phase", phase],
    ["kind", text(event.data.kind)],
    ["status", nativeStatus],
    ["title", text(event.data.title)],
    ["itemId", text(event.data.itemId)],
    ["toolCallId", text(event.data.toolCallId)],
    ["approvalId", text(event.data.approvalId)],
    ["approvalSlug", text(event.data.approvalSlug)],
    ["command", text(event.data.command)],
    ["host", text(event.data.host)],
    ["reason", text(event.data.reason)],
    ["scope", text(event.data.scope)],
    ["message", text(event.data.message)],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])));
  for (const field of ["commandPreviewOmitted", "reasonPreviewOmitted"] as const) {
    if (typeof event.data[field] === "boolean") detail[field] = event.data[field];
  }
  const body = fencedBlock("json", publicJson(detail, summary));
  return { type: "item", itemId, kind: "approval", status, body, summary };
}

function patchAction(event: SourceAgentEvent): SourceAction | null {
  if (lower(event.data.phase) !== "end") return null;
  const body = patchBody(event.data) || providerSummary(event.data, "Patch applied");
  return { type: "item", itemId: sourceItemId(event, "source:patch"), kind: "patch", status: "completed", body, summary: providerSummary(event.data, "Patch applied") };
}

function planAction(event: SourceAgentEvent): SourceAction | null {
  const body = planBody(event.data);
  if (!body) return null;
  return { type: "item", itemId: "source:plan", kind: "plan", status: "completed", body, summary: providerSummary(event.data, "Plan updated") };
}

function checkpointAction(event: SourceAgentEvent): SourceAction | null {
  const body = providerSummary(event.data, "Checkpoint updated");
  return { type: "item", itemId: sourceItemId(event, "source:checkpoint"), kind: "checkpoint", status: statusFor(event.data, "completed"), body, summary: providerSummary(event.data, "Checkpoint updated") };
}

function compactionAction(event: SourceAgentEvent): SourceAction | null {
  if (lower(event.data.phase) !== "end") return null;
  const completed = event.data.completed !== false && lower(event.data.outcome) !== "failed";
  const body = providerSummary(event.data, completed ? "Compaction completed" : "Compaction failed");
  return { type: "item", itemId: "source:compaction", kind: "compaction", status: completed ? "completed" : "failed", body, summary: body };
}

function fallbackAction(event: SourceAgentEvent): SourceAction | null {
  const from = publicText(event.data.fromModel);
  const to = publicText(event.data.toModel);
  if (!from || !to) return null;
  const body = `Switched from ${from} to ${to}`;
  return { type: "item", itemId: "source:fallback", kind: "fallback", status: "completed", body, summary: body };
}

function errorAction(event: SourceAgentEvent): SourceAction {
  const body = providerSummary(event.data, "Agent error");
  return { type: "item", itemId: "octogee:terminal-error", kind: "error", status: "failed", body, summary: body };
}

function actionFor(event: SourceAgentEvent): SourceAction | null {
  switch (event.stream) {
    case "lifecycle": return lifecycleAction(event);
    case "delivery": return answerCommitAction(event);
    case "item": return commentaryAction(event);
    case "tool": return toolAction(event);
    case "approval": return approvalAction(event);
    case "patch": return patchAction(event);
    case "plan": return planAction(event);
    case "checkpoint": return checkpointAction(event);
    case "compaction": return compactionAction(event);
    case "fallback": return fallbackAction(event);
    case "error": return errorAction(event);
    default: return null;
  }
}

function eventKey(ref: AgentActivityIngressRef): string {
  return createHash("sha256").update(`v1\n${ref.conversationId}\n${ref.runId}\n${ref.itemId}\n${ref.semanticVersion}`).digest("hex");
}

function refFor(target: ActivityRunTarget, itemId: string, ordinal: number, semanticVersion = 1): AgentActivityIngressRef {
  return { ...target, itemId, ordinal, semanticVersion };
}

function envelopeBase(ref: AgentActivityIngressRef, emittedAt: string): Pick<AgentActivityEnvelopeV1, "schemaVersion" | "eventKey" | "emittedAt" | "ref" | "redaction"> {
  return { schemaVersion: 1, eventKey: eventKey(ref), emittedAt, ref, redaction: { policy: "octogee-v1", appliedAt: "producer" } };
}

function safeFilename(itemId: string): string {
  const normalized = itemId.replace(/[^a-zA-Z0-9._-]+/g, "-");
  let start = 0;
  let end = normalized.length;
  while (start < end && (normalized[start] === "-" || normalized[start] === ".")) start += 1;
  while (end > start && (normalized[end - 1] === "-" || normalized[end - 1] === ".")) end -= 1;
  const stem = normalized.slice(start, end);
  return `${stem || "activity-detail"}.md`;
}

function storedState(state: PublicationState): StoredPublicationState {
  return {
    schemaVersion: 1,
    laneId: state.laneId,
    commentary: [...state.commentary],
    versions: [...state.versions],
    ordinal: state.ordinal,
    started: state.started,
    finalized: state.finalized,
    ...(state.pendingTerminal ? { pendingTerminal: state.pendingTerminal } : {}),
    ...(state.recoveryEmittedAt ? { recoveryEmittedAt: state.recoveryEmittedAt } : {}),
    ...(state.terminalSpoolId ? { terminalSpoolId: state.terminalSpoolId } : {}),
    target: state.target,
  };
}

function validStoredCommentary(stored: StoredPublicationState): boolean {
  return Array.isArray(stored.commentary) && stored.commentary.every(([itemId, pending]) => (
    typeof itemId === "string"
    && itemId.length <= MAX_ITEM_ID_CHARS
    && pending
    && typeof pending === "object"
    && typeof pending.body === "string"
    && Buffer.byteLength(pending.body, "utf8") <= MAX_COMMENTARY_BYTES
    && typeof pending.emittedAt === "string"
    && Number.isFinite(Date.parse(pending.emittedAt))
  ));
}

function validStoredVersions(stored: StoredPublicationState): boolean {
  return Array.isArray(stored.versions) && stored.versions.every(([itemId, version]) => (
    typeof itemId === "string"
    && itemId.length <= MAX_ITEM_ID_CHARS
    && version
    && typeof version === "object"
    && typeof version.bodyHash === "string"
    && /^[a-f0-9]{64}$/u.test(version.bodyHash)
    && Number.isInteger(version.version)
    && version.version >= 1
  ));
}

function validStoredPendingTerminal(value: PendingTerminal | undefined): boolean {
  return value === undefined || (
    Boolean(value)
    && typeof value === "object"
    && ["completed", "failed", "stopped"].includes(value.outcome)
    && (value.error === undefined || typeof value.error === "string")
    && typeof value.emittedAt === "string"
    && Number.isFinite(Date.parse(value.emittedAt))
  );
}

function validOptionalTimestamp(value: string | undefined): boolean {
  return value === undefined
    || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function validStoredPublicationShape(stored: StoredPublicationState): boolean {
  return stored.schemaVersion === 1
    && typeof stored.laneId === "string"
    && Boolean(stored.laneId)
    && Number.isInteger(stored.ordinal)
    && stored.ordinal >= 0
    && typeof stored.started === "boolean"
    && typeof stored.finalized === "boolean"
    && Boolean(stored.target)
    && typeof stored.target === "object";
}

function validStoredPublication(stored: StoredPublicationState): boolean {
  return validStoredPublicationShape(stored)
    && validStoredCommentary(stored)
    && validStoredVersions(stored)
    && validStoredPendingTerminal(stored.pendingTerminal)
    && validOptionalTimestamp(stored.recoveryEmittedAt);
}

function publicationState(stored: StoredPublicationState): PublicationState {
  if (!validStoredPublication(stored)) {
    throw new Error("durable activity source state is invalid");
  }
  return {
    laneId: stored.laneId,
    commentary: new Map(stored.commentary),
    versions: new Map(stored.versions),
    ordinal: stored.ordinal,
    started: stored.started,
    finalized: stored.finalized,
    ...(stored.pendingTerminal ? { pendingTerminal: stored.pendingTerminal } : {}),
    ...(stored.recoveryEmittedAt ? { recoveryEmittedAt: stored.recoveryEmittedAt } : {}),
    ...(stored.terminalSpoolId ? { terminalSpoolId: stored.terminalSpoolId } : {}),
    target: stored.target,
  };
}

async function registerPublication(params: ActivitySourceParams, state: PublicationState): Promise<void> {
  const stored = storedState(state);
  if (Buffer.byteLength(JSON.stringify(stored), "utf8") > MAX_PUBLICATION_STATE_BYTES) {
    throw new ActivitySourcePermanentError(`activity publication state exceeds ${MAX_PUBLICATION_STATE_BYTES} bytes`);
  }
  await params.stateStore.register(state.laneId, stored);
}

function targetSignature(target: ActivityRunTarget): string {
  return JSON.stringify([
    target.conversationId,
    target.turnId,
    target.runId,
    target.parentRunId ?? null,
    target.retryOfRunId ?? null,
    target.agentId,
    target.sessionKey,
    target.requesterSessionKey ?? null,
    target.origin,
    target.mainChannelId,
    target.mainRootPostId,
    target.inputPostId ?? null,
  ]);
}

function answerTargetSignature(target: AnswerCommitIdentity): string {
  return JSON.stringify([
    target.conversationId,
    target.turnId,
    target.runId,
    target.parentRunId ?? null,
    target.retryOfRunId ?? null,
    target.agentId,
    target.sessionKey,
    target.origin,
    target.mainChannelId,
    target.mainRootPostId,
    target.inputPostId ?? null,
  ]);
}

async function publicationFor(
  params: ActivitySourceParams,
  laneId: string,
  target: ActivityRunTarget,
): Promise<PublicationState> {
  const stored = await params.stateStore.lookup(laneId);
  if (!stored) {
    const state: PublicationState = {
      laneId,
      commentary: new Map(),
      versions: new Map(),
      ordinal: 0,
      started: false,
      finalized: false,
      target,
    };
    await registerPublication(params, state);
    return state;
  }
  const state = publicationState(stored);
  if (targetSignature(state.target) !== targetSignature(target)) {
    throw new Error(`durable activity target changed for run ${target.runId}`);
  }
  return state;
}

async function appendRoot(
  params: ActivitySourceParams,
  target: ActivityRunTarget,
  state: PublicationState,
  emittedAt: string,
): Promise<void> {
  if (state.started) return;
  const ref = refFor(target, "octogee:run-root", 0);
  await params.append({ envelope: { ...envelopeBase(ref, emittedAt), type: "turn.started" } });
  state.started = true;
}

function itemFingerprint(action: Extract<SourceAction, { type: "item" }>): string {
  const hash = createHash("sha256");
  if (MUTABLE_KINDS.has(action.kind)) hash.update(action.status).update("\0");
  return hash.update(action.body).digest("hex");
}

async function appendItem(
  params: ActivitySourceParams,
  target: ActivityRunTarget,
  state: PublicationState,
  action: Extract<SourceAction, { type: "item" }>,
  emittedAt: string,
): Promise<void> {
  const previous = state.versions.get(action.itemId);
  const bodyHash = itemFingerprint(action);
  if (previous?.bodyHash === bodyHash || (previous && !MUTABLE_KINDS.has(action.kind))) return;
  if (!previous && state.versions.size >= MAX_TRACKED_ITEMS) {
    throw new ActivitySourcePermanentError(`activity item count exceeds ${MAX_TRACKED_ITEMS}`);
  }
  const semanticVersion = (previous?.version ?? 0) + 1;
  const bodyBytes = Buffer.byteLength(action.body, "utf8");
  if (bodyBytes > MAX_ATTACHMENT_BYTES) {
    throw new ActivitySourcePermanentError(`activity detail exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
  }
  const ordinal = state.ordinal + 1;
  const ref = refFor(target, action.itemId, ordinal, semanticVersion);
  const item: Extract<AgentActivityEnvelopeV1, { type: "item.completed" }>["item"] = {
    kind: action.kind,
    status: action.status,
    summary: action.summary,
  };
  if (bodyBytes > MAX_INLINE_DETAIL_BYTES) {
    item.attachment = {
      filename: safeFilename(action.itemId),
      mediaType: "text/markdown",
      byteLength: bodyBytes,
      sha256: createHash("sha256").update(action.body).digest("hex"),
      multipartField: "detail",
    };
    await params.append({
      envelope: { ...envelopeBase(ref, emittedAt), type: "item.completed", item },
      attachmentBody: action.body,
    });
  } else {
    item.detail = { format: "markdown", text: action.body };
    await params.append({ envelope: { ...envelopeBase(ref, emittedAt), type: "item.completed", item } });
  }
  state.versions.set(action.itemId, { bodyHash, version: semanticVersion });
  state.ordinal = ordinal;
}

async function appendAnswerCommit(
  params: ActivitySourceParams,
  target: ActivityRunTarget,
  state: PublicationState,
  answer: AgentAnswerCommit,
  emittedAt: string,
): Promise<void> {
  const ordinal = state.ordinal + 1;
  const ref = refFor(target, "octogee:answer-commit", ordinal);
  await params.append({
    envelope: {
      ...envelopeBase(ref, emittedAt),
      type: "answer.committed",
      answer,
    },
  });
  state.ordinal = ordinal;
}

function assertBufferable(body: string): void {
  if (Buffer.byteLength(body, "utf8") > MAX_ATTACHMENT_BYTES) {
    throw new ActivitySourcePermanentError(`activity detail exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
  }
}

async function flushCommentary(
  params: ActivitySourceParams,
  target: ActivityRunTarget,
  state: PublicationState,
): Promise<void> {
  for (const [itemId, pending] of state.commentary) {
    await appendItem(params, target, state, {
      type: "item",
      itemId,
      kind: "commentary",
      status: "completed",
      body: pending.body,
      summary: pending.body.slice(0, MAX_SUMMARY_CHARS),
    }, pending.emittedAt);
  }
  state.commentary.clear();
}

async function processItemAction(input: {
  params: ActivitySourceParams;
  target: ActivityRunTarget;
  state: PublicationState;
  action: Extract<SourceAction, { type: "item" }>;
  emittedAt: string;
}): Promise<ActivitySourceSpoolOutcome> {
  const { params, target, state, action, emittedAt } = input;
  await flushCommentary(params, target, state);
  await appendItem(params, target, state, action, emittedAt);
  await registerPublication(params, state);
  return { kind: "completed" };
}

async function finalizePublication(input: {
  params: ActivitySourceParams;
  target: ActivityRunTarget;
  state: PublicationState;
  terminal: Pick<PendingTerminal, "outcome" | "error">;
  answer?: AgentAnswerCommit;
  emittedAt: string;
  spoolId: string;
  laneId: string;
}): Promise<ActivitySourceSpoolOutcome> {
  const { params, target, state, terminal, answer, emittedAt, spoolId, laneId } = input;
  await flushCommentary(params, target, state);
  if (terminal.error) {
    await appendItem(params, target, state, {
      type: "item",
      itemId: "octogee:terminal-error",
      kind: "error",
      status: "failed",
      body: terminal.error,
      summary: terminal.error,
    }, emittedAt);
  }
  if (answer) await appendAnswerCommit(params, target, state, answer, emittedAt);
  const completion = COMPLETION_SUMMARY[terminal.outcome];
  await appendItem(params, target, state, {
    type: "item",
    itemId: "activity.run-complete",
    kind: "checkpoint",
    status: terminal.outcome === "completed" ? "completed" : "failed",
    body: completion,
    summary: completion,
  }, emittedAt);
  const ordinal = state.ordinal + 1;
  const ref = refFor(target, "octogee:turn-finalized", ordinal);
  await params.append({
    envelope: { ...envelopeBase(ref, emittedAt), type: "turn.finalized", outcome: terminal.outcome },
  });
  state.ordinal = ordinal;
  state.finalized = true;
  state.pendingTerminal = undefined;
  state.terminalSpoolId = spoolId;
  await registerPublication(params, state);
  return { kind: "completed", cleanupKey: laneId };
}

async function processResolvedRecord(input: {
  params: ActivitySourceParams;
  record: ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>;
  spoolId: string;
  target: ActivityRunTarget;
  state: PublicationState;
}): Promise<ActivitySourceSpoolOutcome> {
  const { params, record, spoolId, target, state } = input;
  const { action, emittedAt } = record.payload;
  await appendRoot(params, target, state, emittedAt);
  if (action.type === "start") {
    await registerPublication(params, state);
    return { kind: "completed" };
  }
  if (action.type === "item") {
    return processItemAction({ params, target, state, action, emittedAt });
  }
  if (action.type === "terminal") {
    const pendingTerminal: PendingTerminal = {
      outcome: action.outcome,
      ...(action.error ? { error: action.error } : {}),
      emittedAt,
    };
    if (!requiresAnswerCommit(target)) {
      return finalizePublication({
        params,
        target,
        state,
        terminal: pendingTerminal,
        emittedAt,
        spoolId,
        laneId: record.laneId,
      });
    }
    if (
      state.pendingTerminal
      && (
        state.pendingTerminal.outcome !== pendingTerminal.outcome
        || state.pendingTerminal.error !== pendingTerminal.error
      )
    ) {
      throw new ActivitySourcePermanentError("activity lifecycle terminal changed before answer delivery");
    }
    state.pendingTerminal ??= pendingTerminal;
    await registerPublication(params, state);
    return { kind: "completed" };
  }
  if (!requiresAnswerCommit(target)) {
    throw new ActivitySourcePermanentError("answer commit is unsupported for this activity target");
  }
  if (answerTargetSignature(action.commit) !== answerTargetSignature(target)) {
    throw new ActivitySourcePermanentError("answer commit identity does not match activity target");
  }
  if (!state.pendingTerminal) {
    throw new ActivitySourcePermanentError("answer commit arrived before lifecycle terminal");
  }
  if (state.pendingTerminal.outcome !== action.commit.terminalOutcome) {
    throw new ActivitySourcePermanentError("answer commit outcome does not match lifecycle terminal");
  }
  const answer: AgentAnswerCommit = {
    terminalOutcome: action.commit.terminalOutcome,
    deliveryOutcome: action.commit.deliveryOutcome,
    postIds: action.commit.postIds,
    parts: action.commit.parts,
  };
  return finalizePublication({
    params,
    target,
    state,
    terminal: state.pendingTerminal,
    answer,
    emittedAt,
    spoolId,
    laneId: record.laneId,
  });
}

async function processRecord(
  params: ActivitySourceParams,
  record: ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>,
  spoolId: string,
): Promise<ActivitySourceSpoolOutcome> {
  const { context, event } = record.payload;
  try {
    const hintedState = await params.stateStore.lookup(record.laneId);
    const hintedPublication = hintedState ? publicationState(hintedState) : null;
    if (hintedPublication && hintedPublication.laneId !== record.laneId) {
      throw new ActivitySourcePermanentError(`durable activity state does not match source lane ${record.laneId}`);
    }
    const resolution = hintedPublication?.target ?? await params.resolveRun(event, context);
    if (resolution === "ignore") return { kind: "completed" };
    if (!resolution) throw new Error(`activity target is unresolved for source lane ${record.laneId}`);
    const state = hintedPublication ?? await publicationFor(params, record.laneId, resolution);
    if (state.finalized) return { kind: "completed", cleanupKey: record.laneId };
    return await processResolvedRecord({ params, record, spoolId, target: resolution, state });
  } catch (error) {
    if (error instanceof ActivitySourcePermanentError) {
      return { kind: "failed", reason: "invalid_activity_event", message: error.message };
    }
    throw error;
  }
}

function recoverySpoolId(laneId: string): string {
  return createHash("sha256").update(`octogee-activity-recovery-v1\n${laneId}`).digest("hex");
}

async function recoverInterruptedPublication(
  params: ActivitySourceParams,
  state: PublicationState,
  recoveryNow: string,
): Promise<void> {
  if (!state.recoveryEmittedAt) {
    state.recoveryEmittedAt = recoveryNow;
    await registerPublication(params, state);
  }
  await appendRoot(params, state.target, state, state.recoveryEmittedAt);
  const sealed = requiresAnswerCommit(state.target);
  await finalizePublication({
    params,
    target: state.target,
    state,
    terminal: {
      outcome: "stopped",
      error: sealed
        ? RESTART_RECOVERY_ERROR
        : "Gateway restarted before OpenClaw emitted a terminal event",
    },
    ...(sealed ? {
      answer: {
        terminalOutcome: "stopped" as const,
        deliveryOutcome: "not-attempted" as const,
        postIds: [],
        parts: [],
      },
    } : {}),
    emittedAt: state.recoveryEmittedAt,
    spoolId: recoverySpoolId(state.laneId),
    laneId: state.laneId,
  });
  await params.releaseRunTarget?.(state.target);
  await params.stateStore.delete(state.laneId);
  params.log?.("activity publication stopped after gateway restart", {
    laneId: state.laneId,
    runId: state.target.runId,
  });
}

async function reconcile(
  params: ActivitySourceParams,
  pendingLaneIds: ReadonlySet<string>,
  recoveryNow: string,
  restartCandidates: Set<string>,
): Promise<void> {
  const entries = await params.stateStore.entries();
  const storedLaneIds = new Set(entries.map((entry) => entry.key));
  for (const entry of entries) {
    const state = publicationState(entry.value);
    if (state.laneId !== entry.key) {
      throw new Error(`durable activity source state key mismatch for ${entry.key}`);
    }
    if (!state.finalized) {
      if (restartCandidates.has(state.laneId) && !pendingLaneIds.has(state.laneId)) {
        await recoverInterruptedPublication(params, state, recoveryNow);
        restartCandidates.delete(state.laneId);
      }
      continue;
    }
    if (!state.terminalSpoolId) {
      throw new Error(`finalized activity source state lacks a spool id for ${entry.key}`);
    }
    const record = await params.spool.inspect(state.terminalSpoolId);
    if (!record) {
      await params.releaseRunTarget?.(state.target);
      await params.stateStore.delete(entry.key);
    }
  }
  for (const laneId of restartCandidates) {
    if (!storedLaneIds.has(laneId) && !pendingLaneIds.has(laneId)) {
      restartCandidates.delete(laneId);
    }
  }
}

function validatePreparedAction(action: SourceAction): void {
  if (action.type !== "item") return;
  assertBufferable(action.body);
  const commentaryBytes = Buffer.byteLength(action.body, "utf8");
  if (action.kind === "commentary" && commentaryBytes > MAX_COMMENTARY_BYTES) {
    throw new ActivitySourcePermanentError(`activity commentary exceeds ${MAX_COMMENTARY_BYTES} bytes`);
  }
  if (action.itemId.length > MAX_ITEM_ID_CHARS) {
    throw new ActivitySourcePermanentError(`activity item id exceeds ${MAX_ITEM_ID_CHARS} characters`);
  }
}

function resolutionEvent(event: SourceAgentEvent): SourceAgentEvent {
  return {
    runId: event.runId,
    seq: event.seq,
    stream: event.stream,
    ...(event.ts === undefined ? {} : { ts: event.ts }),
    ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
    ...(event.agentId ? { agentId: event.agentId } : {}),
    data: {},
  };
}

async function enqueueSourceEvent(
  params: ActivitySourceParams,
  now: () => Date,
  event: SourceAgentEvent,
  context: unknown,
): Promise<void> {
  if (!Number.isInteger(event.seq) || event.seq < 1) {
    throw new Error("activity source event sequence must be a positive integer");
  }
  const action = actionFor(event);
  if (!action) return;
  validatePreparedAction(action);
  const laneId = params.sourceIdentity?.(event, context) ?? event.runId;
  if (!laneId) throw new Error("activity source event identity is required");
  await params.spool.enqueue(laneId, event.seq, {
    event: resolutionEvent(event),
    action,
    context,
    emittedAt: now().toISOString(),
  });
}

export function createActivitySource(params: ActivitySourceParams) {
  const now = params.now ?? (() => new Date());
  const log = params.log ?? (() => undefined);
  let stopped = false;
  let started = false;
  let starting: Promise<void> | null = null;
  let restartCandidates: Set<string> | null = null;
  const consumer = {
    process: (
      record: ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>,
      spoolId: string,
    ) => processRecord(params, record, spoolId),
    completed: async (cleanupKey: string) => {
      const stored = await params.stateStore.lookup(cleanupKey);
      if (stored) {
        const state = publicationState(stored);
        if (!state.finalized) {
          throw new Error(`activity publication cleanup requested before finalization for ${cleanupKey}`);
        }
        await params.releaseRunTarget?.(state.target);
      }
      await params.stateStore.delete(cleanupKey);
    },
    reconcile: async (pendingLaneIds: ReadonlySet<string>) => {
      if (restartCandidates === null) {
        restartCandidates = new Set(
          [
            ...pendingLaneIds,
            ...(await params.stateStore.entries())
            .filter((entry) => !publicationState(entry.value).finalized)
            .map((entry) => entry.key),
          ],
        );
      }
      await reconcile(
        params,
        pendingLaneIds,
        now().toISOString(),
        restartCandidates,
      );
    },
  };

  return {
    async start(): Promise<void> {
      if (started) return;
      if (starting) return starting;
      starting = params.spool.start(consumer)
        .then(() => {
          started = true;
        })
        .finally(() => {
          starting = null;
        });
      return starting;
    },
    async handle(event: SourceAgentEvent, context: unknown = undefined): Promise<void> {
      if (stopped) throw new Error("activity source is stopped");
      if (!started) throw new Error("activity source is not started");
      await enqueueSourceEvent(params, now, event, context);
    },
    drain: () => params.spool.drain(),
    stop(): void {
      stopped = true;
      params.spool.stop();
      log("activity source stopped with durable spool preserved", {});
    },
  };
}
