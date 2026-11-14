import { authenticationFailureLimit, authenticatedRequestLimit } from "../middleware/authenticated-request-limit.js";
/* eslint-disable sonarjs/no-duplicate-string */
import { parseGoogleGrantApproval } from "../lib/google-grant-approval.js";
import { approvalDecision, honorNativeDenial, recordApprovalDecision } from "../lib/productivity-approval-decision.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { type Firestore } from "firebase-admin/firestore";

import { timestampMillis } from "@octogee/core/timestamps";
import { connectorReviewerHasWorkspaceAccess } from "../lib/connector-reviewer-access.js";
import { isProjectRecipeId } from "@octogee/shared/types/project";

import { db as defaultDb } from "../lib/db.js";
import { platformStateStore, readSizingKey } from "../lib/platform-state.js";
import type { SizingKeyReader } from "@octogee/core/sizing-key";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { requireAuth } from "../middleware/auth.js";
import { logger } from "../middleware/logging.js";
import { connectorApprovalBinding, connectorApprovalRpc, readConnectorApproval, type ConnectorApprovalRpc } from "../lib/connector-approval-client.js";
import { NativeConnectorApprovalAccessError } from "../lib/native-connector-approval.js";

const PRODUCTIVITY_APPROVALS_COLLECTION = "productivityApprovals";
const NOT_FOUND = { error: "not_found" } as const;
const APPROVAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Deps {
  db: Firestore;
  store: PlatformStateStore;
  readSizingKey: SizingKeyReader;
  now: () => number;
  nativeRpc: ConnectorApprovalRpc;
}

type ApprovalState = "pending" | "approved" | "denied" | "executing" | "succeeded" | "failed" | "unknown";

type ProductivityActionKind =
  | "google-access"
  | "gmail-triage"
  | "gmail-draft-create"
  | "gmail-send"
  | "calendar-create"
  | "calendar-update"
  | "calendar-delete"
  | "docs-create"
  | "docs-append"
  | "tasks-create"
  | "tasks-update"
  | "sheets-create"
  | "sheets-append"
  | "obsidian-write"
  | "project-create"
  | "project-publish";

const APPROVAL_STATES = new Set<ApprovalState>([
  "executing", "succeeded", "failed", "unknown",
]);
const PRODUCTIVITY_ACTION_KINDS = new Set<ProductivityActionKind>([
  "google-access",
  "gmail-triage",
  "gmail-draft-create",
  "gmail-send",
  "calendar-create",
  "calendar-update",
  "calendar-delete",
  "docs-create",
  "docs-append",
  "tasks-create",
  "tasks-update",
  "sheets-create",
  "sheets-append",
  "obsidian-write",
  "project-create",
  "project-publish",
]);
function isApprovalState(value: unknown): value is ApprovalState {
  return typeof value === "string" && APPROVAL_STATES.has(value as ApprovalState);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonceHash(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 16 || value.length > 256) return null;
  return createHash("sha256").update(value).digest("hex");
}

function hashesEqual(left: unknown, right: string | null): boolean {
  if (typeof left !== "string" || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

interface ProductivityApprovalView {
  approvalId: string;
  state: ApprovalState | "expired";
  action: { kind: ProductivityActionKind };
  preview: Record<string, unknown>;
  reason: string | null;
  approvalExpiresAt: string;
}

function requiredText(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error("canonical productivity approval preview is malformed");
  }
  return value;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error("canonical productivity approval preview is malformed");
  }
  return value;
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (
    !Array.isArray(value)
    || value.length > maxItems
    || value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > maxLength)
  ) {
    throw new Error("canonical productivity approval preview is malformed");
  }
  return value as string[];
}

function exactKeys(preview: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const keys = Object.keys(preview);
  if (
    required.some((key) => !Object.hasOwn(preview, key))
    || keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new Error("canonical productivity approval preview is malformed");
  }
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("canonical productivity approval preview is malformed");
  return value;
}

function noNewlineText(value: unknown, maxLength: number): string {
  const result = requiredText(value, maxLength);
  if (/[\r\n]/u.test(result)) throw new Error("canonical productivity approval preview is malformed");
  return result;
}

function projectGmailMessagePreview(
  preview: Record<string, unknown>,
  options: { includeDraftId: boolean; maxRecipients: number; requireContent: boolean },
): Record<string, unknown> {
  const required = options.includeDraftId
    ? ["draftId", "to", "cc", "bcc", "subject", "bodyText"]
    : ["to", "cc", "bcc", "subject", "bodyText"];
  exactKeys(preview, required);
  const to = stringList(preview.to, options.maxRecipients, 320);
  if (to.length === 0) throw new Error("canonical productivity approval preview is malformed");
  return {
    ...(options.includeDraftId ? { draftId: noNewlineText(preview.draftId, 200) } : {}),
    to,
    cc: stringList(preview.cc, options.maxRecipients, 320),
    bcc: stringList(preview.bcc, options.maxRecipients, 320),
    subject: options.requireContent ? requiredText(preview.subject, 500) : optionalText(preview.subject, 500) ?? "",
    bodyText: options.requireContent ? requiredText(preview.bodyText, 100_000) : optionalText(preview.bodyText, 100_000) ?? "",
  };
}

function projectGmailAttachment(value: unknown): Record<string, unknown> {
  const attachment = record(value);
  if (!attachment) throw new Error("canonical productivity approval preview is malformed");
  exactKeys(attachment, ["filename", "mimeType", "disposition", "contentId", "sizeBytes", "sha256"]);
  const filename = optionalText(attachment.filename, 512);
  const mimeType = requiredText(attachment.mimeType, 255);
  const contentId = optionalText(attachment.contentId, 998);
  const disposition = attachment.disposition;
  const sizeBytes = attachment.sizeBytes;
  const sha256 = attachment.sha256;
  if (
    filename === undefined
    || contentId === undefined
    || !["attachment", "inline", "unspecified"].includes(String(disposition))
    || !Number.isInteger(sizeBytes)
    || Number(sizeBytes) < 0
    || Number(sizeBytes) > 25 * 1024 * 1024
    || typeof sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(sha256)
  ) throw new Error("canonical productivity approval preview is malformed");
  return { filename, mimeType, disposition, contentId, sizeBytes, sha256 };
}

function projectGmailAttachments(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("canonical productivity approval preview is malformed");
  }
  return value.map(projectGmailAttachment);
}

function projectGmailSendPreview(preview: Record<string, unknown>): Record<string, unknown> {
  exactKeys(preview, [
    "draftId", "from", "sender", "replyTo", "to", "cc", "bcc", "subject", "bodyText", "bodyHtml",
    "messageSizeBytes", "attachments", "sourceDraftRetained",
  ]);
  const from = optionalText(preview.from, 1_000);
  const sender = optionalText(preview.sender, 1_000);
  const replyTo = stringList(preview.replyTo, 100, 1_000);
  const to = stringList(preview.to, 100, 1_000);
  const cc = stringList(preview.cc, 100, 1_000);
  const bcc = stringList(preview.bcc, 100, 1_000);
  const subject = optionalText(preview.subject, 998);
  const bodyText = optionalText(preview.bodyText, 100_000);
  const bodyHtml = optionalText(preview.bodyHtml, 100_000);
  const messageSizeBytes = preview.messageSizeBytes;
  if (
    from === undefined
    || sender === undefined
    || subject === undefined
    || bodyText === undefined
    || bodyHtml === undefined
    || Buffer.byteLength(bodyText, "utf8") + Buffer.byteLength(bodyHtml, "utf8") > 512 * 1024
    || to.length + cc.length + bcc.length === 0
    || !Number.isInteger(messageSizeBytes)
    || Number(messageSizeBytes) <= 0
    || Number(messageSizeBytes) > 25 * 1024 * 1024
    || preview.sourceDraftRetained !== true
  ) throw new Error("canonical productivity approval preview is malformed");
  return {
    draftId: noNewlineText(preview.draftId, 200),
    from,
    sender,
    replyTo,
    to,
    cc,
    bcc,
    subject,
    bodyText,
    bodyHtml,
    messageSizeBytes,
    attachments: projectGmailAttachments(preview.attachments),
    sourceDraftRetained: true,
  };
}

function validCalendarTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value)
    || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value);
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function optionalCalendarTime(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const result = requiredText(value, 128);
  if (!validCalendarTime(result)) {
    throw new Error("canonical productivity approval preview is malformed");
  }
  return result;
}

function optionalCalendarFields(preview: Record<string, unknown>): Record<string, unknown> {
  const start = optionalCalendarTime(preview.start);
  const end = optionalCalendarTime(preview.end);
  if ((start === undefined) !== (end === undefined)) {
    throw new Error("canonical productivity approval preview is malformed");
  }
  const timeZone = optionalText(preview.timeZone, 128);
  if (timeZone !== undefined && !validTimeZone(timeZone)) {
    throw new Error("canonical productivity approval preview is malformed");
  }
  return {
    ...(preview.summary === undefined ? {} : { summary: requiredText(preview.summary, 500) }),
    ...(preview.description === undefined ? {} : { description: optionalText(preview.description, 8_000) }),
    ...(preview.location === undefined ? {} : { location: requiredText(preview.location, 500) }),
    ...(start === undefined ? {} : { start, end }),
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(preview.attendees === undefined ? {} : { attendees: stringList(preview.attendees, 25, 200) }),
  };
}

// eslint-disable-next-line complexity
function projectCalendarPreview(kind: ProductivityActionKind, preview: Record<string, unknown>): Record<string, unknown> {
  const optional = ["summary", "description", "location", "start", "end", "timeZone", "attendees"];
  if (kind === "calendar-create") {
    exactKeys(preview, ["summary", "start", "end", "attendees"], ["description", "location", "timeZone", "reminders"]);
    if (preview.reminders !== undefined && preview.reminders !== "default" && preview.reminders !== "none") {
      throw new Error("canonical productivity approval preview is malformed");
    }
    const result = optionalCalendarFields(preview);
    if (result.start === undefined || result.end === undefined || result.summary === undefined) {
      throw new Error("canonical productivity approval preview is malformed");
    }
    return { ...result, reminders: preview.reminders ?? "default" };
  }
  const currentOptional = ["currentSummary", "currentStart", "currentEnd", "currentTimeZone"];
  exactKeys(
    preview,
    kind === "calendar-delete" ? ["eventId", "attendees"] : ["eventId", "currentAttendees"],
    kind === "calendar-update" ? [...optional, ...currentOptional] : optional,
  );
  const eventId = noNewlineText(preview.eventId, 1_024);
  if (!/^[a-v0-9_-]+$/u.test(eventId)) throw new Error("canonical productivity approval preview is malformed");
  if (kind === "calendar-delete") return { eventId, ...optionalCalendarFields(preview) };
  const currentStart = optionalCalendarTime(preview.currentStart);
  const currentEnd = optionalCalendarTime(preview.currentEnd);
  if ((currentStart === undefined) !== (currentEnd === undefined)) {
    throw new Error("canonical productivity approval preview is malformed");
  }
  const currentTimeZone = optionalText(preview.currentTimeZone, 128);
  if (currentTimeZone !== undefined && !validTimeZone(currentTimeZone)) {
    throw new Error("canonical productivity approval preview is malformed");
  }
  const mutation = optionalCalendarFields(preview);
  if (Object.keys(mutation).length === 0) throw new Error("canonical productivity approval preview is malformed");
  return {
    eventId,
    ...(preview.currentSummary === undefined ? {} : { currentSummary: requiredText(preview.currentSummary, 500) }),
    ...(currentStart === undefined ? {} : { currentStart, currentEnd }),
    ...(currentTimeZone === undefined ? {} : { currentTimeZone }),
    currentAttendees: stringList(preview.currentAttendees, 25, 200),
    ...mutation,
  };
}

function projectTriagePreview(preview: Record<string, unknown>): Record<string, unknown> {
  const flags = ["archive", "markRead", "markUnread", "star", "unstar"];
  exactKeys(preview, ["messageId", "sender", "subject", "labelIds", ...flags]);
  const projected = Object.fromEntries(flags.map((flag) => [flag, requiredBoolean(preview[flag])]));
  if (!Object.values(projected).some(Boolean)) throw new Error("canonical productivity approval preview is malformed");
  const labelIds = stringList(preview.labelIds, 100, 200);
  if (labelIds.some((labelId, index) => (
    /[\r\n]/u.test(labelId)
    || (index > 0 && labelIds[index - 1]! >= labelId)
  ))) {
    throw new Error("canonical productivity approval preview is malformed");
  }
  return {
    messageId: noNewlineText(preview.messageId, 200),
    sender: optionalText(preview.sender, 1_000) ?? "",
    subject: optionalText(preview.subject, 998) ?? "",
    labelIds,
    ...projected,
  };
}

function projectTitlePreview(preview: Record<string, unknown>): Record<string, unknown> {
  exactKeys(preview, ["title"]);
  return { title: requiredText(preview.title, 300) };
}

function projectDocsAppendPreview(preview: Record<string, unknown>): Record<string, unknown> {
  exactKeys(preview, ["documentId", "documentTitle", "text"]);
  return {
    documentId: noNewlineText(preview.documentId, 200),
    documentTitle: requiredText(preview.documentTitle, 300),
    text: requiredText(preview.text, 50_000),
  };
}

// eslint-disable-next-line complexity
function projectTaskPreview(kind: ProductivityActionKind, preview: Record<string, unknown>): Record<string, unknown> {
  if (kind === "tasks-create") {
    exactKeys(preview, ["tasklistId", "title"], ["notes", "due"]);
  } else {
    exactKeys(
      preview,
      ["tasklistId", "taskId", "currentTitle", "currentStatus"],
      ["title", "notes", "due", "status"],
    );
  }
  const title = optionalText(preview.title, 500);
  const notes = optionalText(preview.notes, 8_000);
  const due = optionalText(preview.due, 10);
  const status = optionalText(preview.status, 11);
  const currentTitle = kind === "tasks-update" ? requiredText(preview.currentTitle, 1_024) : undefined;
  const currentStatus = optionalText(preview.currentStatus, 11);
  if (due !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(due)) {
    throw new Error("canonical productivity approval preview is malformed");
  }
  if (status !== undefined && status !== "needsAction" && status !== "completed") {
    throw new Error("canonical productivity approval preview is malformed");
  }
  if (
    kind === "tasks-update"
    && (
      currentStatus !== "needsAction" && currentStatus !== "completed"
    )
  ) throw new Error("canonical productivity approval preview is malformed");
  if (kind === "tasks-update" && title === undefined && notes === undefined && due === undefined && status === undefined) {
    throw new Error("canonical productivity approval preview is malformed");
  }
  return {
    tasklistId: noNewlineText(preview.tasklistId, 200),
    ...(kind === "tasks-update" ? { taskId: noNewlineText(preview.taskId, 200) } : {}),
    ...(kind === "tasks-update" ? { currentTitle, currentStatus } : {}),
    ...(title === undefined ? {} : { title }),
    ...(notes === undefined ? {} : { notes }),
    ...(due === undefined ? {} : { due }),
    ...(status === undefined ? {} : { status }),
  };
}

function projectSheetsAppendPreview(preview: Record<string, unknown>): Record<string, unknown> {
  exactKeys(preview, ["spreadsheetId", "spreadsheetTitle", "range", "rows", "appendSemantics"]);
  if (preview.appendSemantics !== "latest-table-state") {
    throw new Error("canonical productivity approval preview is malformed");
  }
  if (!Array.isArray(preview.rows) || preview.rows.length === 0 || preview.rows.length > 100) {
    throw new Error("canonical productivity approval preview is malformed");
  }
  let totalChars = 0;
  const rows = preview.rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("canonical productivity approval preview is malformed");
    }
    exactKeys(row, ["cells"]);
    if (!Array.isArray(row.cells) || row.cells.length === 0 || row.cells.length > 40) {
      throw new Error("canonical productivity approval preview is malformed");
    }
    return row.cells.map((cell: unknown) => {
      if (
        (typeof cell !== "string" && typeof cell !== "number" && typeof cell !== "boolean")
        || (typeof cell === "number" && !Number.isFinite(cell))
      ) throw new Error("canonical productivity approval preview is malformed");
      totalChars += String(cell).length;
      if (totalChars > 100_000) throw new Error("canonical productivity approval preview is malformed");
      return cell;
    });
  });
  return {
    spreadsheetId: noNewlineText(preview.spreadsheetId, 200),
    spreadsheetTitle: requiredText(preview.spreadsheetTitle, 300),
    range: noNewlineText(preview.range, 200),
    rows,
    appendSemantics: preview.appendSemantics,
  };
}

function projectObsidianPreview(preview: Record<string, unknown>): Record<string, unknown> {
  exactKeys(preview, ["path", "mode", "content"]);
  const path = noNewlineText(preview.path, 1_000);
  if (preview.mode !== "create" && preview.mode !== "replace" && preview.mode !== "append") {
    throw new Error("canonical productivity approval preview is malformed");
  }
  const content = typeof preview.content === "string" ? preview.content : null;
  if (content === null || Buffer.byteLength(content, "utf8") > 250_000) {
    throw new Error("canonical productivity approval preview is malformed");
  }
  return { path, mode: preview.mode, content };
}

function projectCreatePreview(preview: Record<string, unknown>): Record<string, unknown> {
  exactKeys(preview, ["name", "agentName", "slug", "tagline", "projectType", "recipe"]);
  const name = requiredText(preview.name, 80);
  const agentName = preview.agentName === null ? null : requiredText(preview.agentName, 80);
  const slug = requiredText(preview.slug, 16);
  const tagline = preview.tagline;
  const projectType = preview.projectType;
  const recipe = preview.recipe;
  if (
    name.trim().length === 0
    || (agentName !== null && agentName.trim().length === 0)
    || !/^[a-z0-9]{1,16}$/u.test(slug)
    || typeof tagline !== "string"
    || tagline.length > 300
    || (projectType !== null && !["game", "social", "planner", "trip", "other"].includes(String(projectType)))
    || !isProjectRecipeId(recipe)
  ) throw new Error("canonical productivity approval preview is malformed");
  return { name, agentName, slug, tagline, projectType, recipe };
}

function validProjectPublishUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && /^ogp-[a-f0-9]{26}\.web\.app$/u.test(url.hostname)
      && url.port === ""
      && url.pathname === "/"
      && value === url.origin
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function projectPublishPreview(preview: Record<string, unknown>): Record<string, unknown> {
  exactKeys(preview, [
    "projectName", "projectSlug", "publicUrl", "runId", "sourceCommit", "fileCount", "totalBytes",
  ]);
  const projectName = requiredText(preview.projectName, 80);
  const projectSlug = requiredText(preview.projectSlug, 16);
  const publicUrl = requiredText(preview.publicUrl, 2_048);
  const runId = requiredText(preview.runId, 36);
  const sourceCommit = requiredText(preview.sourceCommit, 40);
  const fileCount = preview.fileCount;
  const totalBytes = preview.totalBytes;
  if (
    projectName.trim().length === 0
    || !/^[a-z0-9]{1,16}$/u.test(projectSlug)
    || !validProjectPublishUrl(publicUrl)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId)
    || !/^[a-f0-9]{40}$/u.test(sourceCommit)
    || !Number.isSafeInteger(fileCount)
    || Number(fileCount) < 1
    || Number(fileCount) > 1_000
    || !Number.isSafeInteger(totalBytes)
    || Number(totalBytes) < 0
    || Number(totalBytes) > 24 * 1024 * 1024
  ) throw new Error("canonical productivity approval preview is malformed");
  return { projectName, projectSlug, publicUrl, runId, sourceCommit, fileCount, totalBytes };
}

// eslint-disable-next-line complexity
function projectActionPreview(kind: ProductivityActionKind, value: unknown): Record<string, unknown> {
  if (kind === "google-access") {
    const request = parseGoogleGrantApproval(value);
    return { memberName: request.memberName, workspaceId: request.workspaceId, accountLabel: request.accountLabel,
      operationLabel: request.operationLabel, channelName: request.channelName, resourceIds: request.permissions[0].resourceIds };
  }
  const preview = record(value);
  if (!preview) throw new Error("canonical productivity approval preview is malformed");
  if (kind === "gmail-triage") return projectTriagePreview(preview);
  if (kind === "gmail-draft-create") {
    return projectGmailMessagePreview(preview, { includeDraftId: false, maxRecipients: 10, requireContent: true });
  }
  if (kind === "gmail-send") {
    return projectGmailSendPreview(preview);
  }
  if (kind === "calendar-create" || kind === "calendar-update" || kind === "calendar-delete") {
    return projectCalendarPreview(kind, preview);
  }
  if (kind === "docs-create" || kind === "sheets-create") return projectTitlePreview(preview);
  if (kind === "docs-append") return projectDocsAppendPreview(preview);
  if (kind === "tasks-create" || kind === "tasks-update") return projectTaskPreview(kind, preview);
  if (kind === "sheets-append") return projectSheetsAppendPreview(preview);
  if (kind === "obsidian-write") return projectObsidianPreview(preview);
  if (kind === "project-create") return projectCreatePreview(preview);
  if (kind === "project-publish") return projectPublishPreview(preview);
  throw new Error("canonical productivity approval action is unsupported");
}

function projectedApprovalState(data: Record<string, unknown>, approvalExpiresAt: number, now: number): ApprovalState | "expired" {
  const executionLeaseExpiresAt = timestampMillis(data.executionLeaseExpiresAt);
  let state: ApprovalState | "expired" = data.state as ApprovalState;
  if (data.state === "prepared") {
    const decision = approvalDecision(data);
    state = decision?.state ?? (approvalExpiresAt <= now ? "expired" : "pending");
  }
  else if (
    data.state === "executing"
    && (typeof executionLeaseExpiresAt !== "number" || executionLeaseExpiresAt <= now)
  ) state = Object.hasOwn(data, "providerStartedAt") ? "unknown" : "failed";
  return state;
}

function projectApproval(id: string, data: Record<string, unknown>, now: number): ProductivityApprovalView {
  const approvalExpiresAt = timestampMillis(data.approvalExpiresAt);
  const action = record(data.action);
  if (
    !(data.state === "prepared" || isApprovalState(data.state))
    || typeof approvalExpiresAt !== "number"
    || !action
    || typeof action.kind !== "string"
    || !PRODUCTIVITY_ACTION_KINDS.has(action.kind as ProductivityActionKind)
  ) {
    throw new Error("canonical productivity approval is malformed");
  }
  const kind = action.kind as ProductivityActionKind;
  return {
    approvalId: id,
    state: projectedApprovalState(data, approvalExpiresAt, now),
    action: { kind },
    preview: projectActionPreview(kind, data.preview),
    reason: typeof data.reason === "string" ? data.reason : null,
    approvalExpiresAt: new Date(approvalExpiresAt).toISOString(),
  };
}

async function loadAuthorizedApproval(
  deps: Deps,
  approvalId: string,
  uid: string,
  providedNonceHash: string | null,
): Promise<Record<string, unknown> | null> {
  if (!APPROVAL_ID_PATTERN.test(approvalId)) return null;
  const snap = await deps.db.doc(`${PRODUCTIVITY_APPROVALS_COLLECTION}/${approvalId}`).get();
  const data = snap.data();
  if (!snap.exists || !data || !hashesEqual(data.nonceHash, providedNonceHash)
    || !(await connectorReviewerHasWorkspaceAccess(deps, data, uid))) {
    return null;
  }
  return data;
}

interface Reviewer { uid: string; authorization: string; authTime: number | null }

function reviewerOf(req: Request): Reviewer {
  return { uid: req.uid!, authorization: req.headers.authorization ?? "", authTime: req.authTime ?? null };
}

async function requireReviewerAuthority(deps: Deps, data: Record<string, unknown>, reviewer: Reviewer): Promise<void> {
  if (data.ownerUid === reviewer.uid) return;
  await readConnectorApproval(deps.nativeRpc, connectorApprovalBinding(data), { uid: reviewer.uid, authorization: reviewer.authorization });
}

function withNativeDenial(deps: Deps, approvalId: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return honorNativeDenial(deps.db, approvalId, data,
    () => readConnectorApproval(deps.nativeRpc, connectorApprovalBinding(data)), deps.now);
}

async function mirrorNativeDenial(deps: Deps, approvalId: string, data: Record<string, unknown>, reviewer: Reviewer): Promise<void> {
  try {
    await readConnectorApproval(deps.nativeRpc, connectorApprovalBinding(data),
      { uid: reviewer.uid, authorization: reviewer.authorization }, "deny");
  } catch (error) {
    logger.warn("productivity approval native denial mirror failed", { approvalId, error: error instanceof Error ? error.message : String(error) });
  }
}

function respondWithAccessError(res: Response, next: NextFunction, error: unknown): void {
  if (error instanceof NativeConnectorApprovalAccessError) {
    res.status(error.status).set("cache-control", "no-store").json({ error: error.code });
    return;
  }
  next(error);
}

async function preview(deps: Deps, req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const approvalId = typeof req.params.approvalId === "string" ? req.params.approvalId : "";
    const data = await loadAuthorizedApproval(deps, approvalId, req.uid!, nonceHash(req.query.nonce));
    if (!data) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (data.state === "prepared" && !data.nativeApprovalId) {
      res.status(409).json({ error: "approval_preparing" }); return;
    }
    await requireReviewerAuthority(deps, data, reviewerOf(req));
    const current = await withNativeDenial(deps, approvalId, data);
    res.set("cache-control", "no-store").json(projectApproval(approvalId, current, deps.now()));
  } catch (error) {
    respondWithAccessError(res, next, error);
  }
}

async function respondToApproval(
  deps: Deps,
  targetState: "approved" | "denied",
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const providedHash = nonceHash(record(req.body)?.nonce);
    if (!providedHash) {
      res.status(400).json({ error: "invalid-request" });
      return;
    }
    const approvalId = String(req.params.approvalId);
    const data = await loadAuthorizedApproval(deps, approvalId, req.uid!, providedHash);
    if (!data) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (data.state === "prepared" && !data.nativeApprovalId) {
      res.status(409).json({ error: "approval_preparing" }); return;
    }
    const reviewer = reviewerOf(req);
    await requireReviewerAuthority(deps, data, reviewer);
    await withNativeDenial(deps, approvalId, data);
    const now = deps.now();
    const { data: updated, recorded } = await recordApprovalDecision(deps.db, deps.store, approvalId, {
      state: targetState, reviewerUid: reviewer.uid, reviewerAuthTime: reviewer.authTime, nowMs: now,
    });
    if (recorded && targetState === "denied") await mirrorNativeDenial(deps, approvalId, updated, reviewer);
    res.set("cache-control", "no-store").json(projectApproval(approvalId, updated, now));
  } catch (error) {
    respondWithAccessError(res, next, error);
  }
}

export function createProductivityApprovalRoutes(options: Partial<Deps> = {}): Router {
  const store = options.store ?? platformStateStore;
  const deps: Deps = {
    db: options.db ?? defaultDb,
    store,
    readSizingKey: options.readSizingKey ?? readSizingKey,
    now: options.now ?? Date.now,
    nativeRpc: options.nativeRpc ?? connectorApprovalRpc(store),
  };
  const router = Router();
  router.get("/:approvalId", (req, res, next) => preview(deps, req, res, next));
  router.post("/:approvalId/approve", (req, res, next) => {
    void respondToApproval(deps, "approved", req, res, next);
  });
  router.post("/:approvalId/deny", (req, res, next) => {
    void respondToApproval(deps, "denied", req, res, next);
  });
  return router;
}

const router = Router();
router.use(authenticationFailureLimit, requireAuth, authenticatedRequestLimit(120));
router.use(createProductivityApprovalRoutes());

export default router;
