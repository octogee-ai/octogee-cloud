import { createHash, randomUUID } from "node:crypto";
import type { PlatformStateStore, PlatformStateTransaction, WorkspaceChannelScope } from "../../../platform-state/index.js";

export type ActivityAttachmentReceiptV1 =
  | { state: "none" }
  | {
      state: "session-created" | "uploading";
      uploadId: string;
      fileOffset: number;
      filename: string;
      sha256: string;
      byteLength: number;
    }
  | {
      state: "uploaded";
      uploadId: string;
      fileId: string;
      filename: string;
      sha256: string;
      byteLength: number;
    }
  | { state: "attached"; fileId: string; sha256: string; byteLength: number }
  | {
      state: "upload-result-unknown";
      uploadId: string;
      filename: string;
      sha256: string;
      byteLength: number;
      reason: string;
    };

export interface ActivityWriteReceiptV1 {
  eventKey: string;
  payloadDigest: string;
  state: "claimed" | "posted" | "committed";
  historyAnchorPostId: string;
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAt: number;
  attachment: ActivityAttachmentReceiptV1;
  postId?: string;
  updatedAt: number;
}

export interface ActivityReceiptClaimInput {
  eventKey: string;
  payloadDigest: string;
  historyAnchorPostId: string;
  leaseOwner: string;
  now: number;
  leaseMs: number;
}

export type ActivityReceiptClaim =
  | { outcome: "claimed"; receipt: ActivityWriteReceiptV1; recovered: boolean }
  | { outcome: "duplicate"; receipt: ActivityWriteReceiptV1 };

export interface ActivityWriteReceiptStore {
  claim(input: ActivityReceiptClaimInput): Promise<ActivityReceiptClaim>;
  read(eventKey: string): Promise<ActivityWriteReceiptV1 | null>;
  markPosted(eventKey: string, leaseToken: string, postId: string, now: number): Promise<void>;
  updateAttachment(
    eventKey: string,
    leaseToken: string,
    attachment: ActivityAttachmentReceiptV1,
    now: number,
  ): Promise<void>;
  commit(eventKey: string, leaseToken: string, now: number): Promise<void>;
}

export class ActivityReceiptConflictError extends Error {
  override readonly name = "ActivityReceiptConflictError";
}

export class ActivityReceiptLeaseError extends Error {
  override readonly name = "ActivityReceiptLeaseError";
}

export class ActivityReceiptUnavailableError extends Error {
  override readonly name = "ActivityReceiptUnavailableError";
}

export function receiptDocumentId(eventKey: string): string {
  return createHash("sha256").update(eventKey, "utf8").digest("hex");
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateClaimInput(input: ActivityReceiptClaimInput): void {
  if (
    !/^[a-f0-9]{64}$/.test(input.eventKey) ||
    !/^[a-f0-9]{64}$/.test(input.payloadDigest) ||
    !input.historyAnchorPostId ||
    !input.leaseOwner ||
    !safeNonNegativeInteger(input.now) ||
    !Number.isSafeInteger(input.leaseMs) ||
    input.leaseMs <= 0 ||
    !Number.isSafeInteger(input.now + input.leaseMs)
  ) {
    throw new ActivityReceiptUnavailableError("Activity receipt claim is malformed");
  }
}

function copyReceipt(receipt: ActivityWriteReceiptV1): ActivityWriteReceiptV1 {
  return structuredClone(receipt);
}

function nextClaim(
  current: ActivityWriteReceiptV1 | null,
  input: ActivityReceiptClaimInput,
): ActivityReceiptClaim {
  validateClaimInput(input);
  if (!current) {
    return {
      outcome: "claimed",
      recovered: false,
      receipt: {
        eventKey: input.eventKey,
        payloadDigest: input.payloadDigest,
        state: "claimed",
        historyAnchorPostId: input.historyAnchorPostId,
        leaseOwner: input.leaseOwner,
        leaseToken: randomUUID(),
        leaseExpiresAt: input.now + input.leaseMs,
        attachment: { state: "none" },
        updatedAt: input.now,
      },
    };
  }
  if (current.eventKey !== input.eventKey || current.payloadDigest !== input.payloadDigest) {
    throw new ActivityReceiptConflictError("event-key payload digest conflict");
  }
  if (current.state === "committed") {
    return { outcome: "duplicate", receipt: copyReceipt(current) };
  }
  if (current.leaseExpiresAt > input.now) {
    throw new ActivityReceiptLeaseError("Activity receipt is leased by another writer");
  }
  return {
    outcome: "claimed",
    recovered: true,
    receipt: {
      ...copyReceipt(current),
      leaseOwner: input.leaseOwner,
      leaseToken: randomUUID(),
      leaseExpiresAt: input.now + input.leaseMs,
      updatedAt: input.now,
    },
  };
}

function updateOwnedReceipt(
  current: ActivityWriteReceiptV1 | null,
  eventKey: string,
  leaseToken: string,
  now: number,
  update: (receipt: ActivityWriteReceiptV1) => ActivityWriteReceiptV1,
): ActivityWriteReceiptV1 {
  if (!current || current.eventKey !== eventKey) {
    throw new ActivityReceiptUnavailableError("Activity receipt disappeared");
  }
  if (current.leaseToken !== leaseToken) {
    throw new ActivityReceiptLeaseError("Activity receipt lease token changed");
  }
  if (current.state === "committed") {
    throw new ActivityReceiptLeaseError("Activity receipt is already committed");
  }
  return update({ ...copyReceipt(current), updatedAt: now });
}

export class InMemoryActivityWriteReceiptStore implements ActivityWriteReceiptStore {
  private readonly receipts = new Map<string, ActivityWriteReceiptV1>();

  async claim(input: ActivityReceiptClaimInput): Promise<ActivityReceiptClaim> {
    const key = receiptDocumentId(input.eventKey);
    const result = nextClaim(this.receipts.get(key) ?? null, input);
    if (result.outcome === "claimed") {
      this.receipts.set(key, copyReceipt(result.receipt));
    }
    return structuredClone(result);
  }

  async read(eventKey: string): Promise<ActivityWriteReceiptV1 | null> {
    const receipt = this.receipts.get(receiptDocumentId(eventKey));
    return receipt ? copyReceipt(receipt) : null;
  }

  async markPosted(
    eventKey: string,
    leaseToken: string,
    postId: string,
    now: number,
  ): Promise<void> {
    this.update(eventKey, leaseToken, now, (receipt) => ({
      ...receipt,
      state: "posted",
      postId,
    }));
  }

  async updateAttachment(
    eventKey: string,
    leaseToken: string,
    attachment: ActivityAttachmentReceiptV1,
    now: number,
  ): Promise<void> {
    this.update(eventKey, leaseToken, now, (receipt) => ({ ...receipt, attachment }));
  }

  async commit(eventKey: string, leaseToken: string, now: number): Promise<void> {
    this.update(eventKey, leaseToken, now, (receipt) => ({ ...receipt, state: "committed" }));
  }

  private update(
    eventKey: string,
    leaseToken: string,
    now: number,
    change: (receipt: ActivityWriteReceiptV1) => ActivityWriteReceiptV1,
  ): void {
    const key = receiptDocumentId(eventKey);
    const updated = updateOwnedReceipt(
      this.receipts.get(key) ?? null,
      eventKey,
      leaseToken,
      now,
      change,
    );
    this.receipts.set(key, updated);
  }
}

function validReceiptStrings(data: Record<string, unknown>): boolean {
  return (
    nonBlankString(data.eventKey) &&
    /^[a-f0-9]{64}$/.test(data.eventKey) &&
    nonBlankString(data.payloadDigest) &&
    /^[a-f0-9]{64}$/.test(data.payloadDigest) &&
    nonBlankString(data.historyAnchorPostId) &&
    nonBlankString(data.leaseOwner) &&
    nonBlankString(data.leaseToken) &&
    (data.postId === undefined || nonBlankString(data.postId))
  );
}

function validReceiptState(data: Record<string, unknown>): boolean {
  return data.state === "claimed" || data.state === "posted" || data.state === "committed";
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function exactKeys(data: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(data).length === expected.size && Object.keys(data).every((key) => expected.has(key));
}

function validAttachmentIdentity(data: Record<string, unknown>): boolean {
  return (
    /^[a-f0-9]{64}$/.test(typeof data.sha256 === "string" ? data.sha256 : "") &&
    Number.isSafeInteger(data.byteLength) &&
    (data.byteLength as number) > 0
  );
}

function validAttachedAttachmentReceipt(data: Record<string, unknown>): boolean {
  return (
    exactKeys(data, ["state", "fileId", "sha256", "byteLength"]) &&
    nonBlankString(data.fileId)
  );
}

function validUploadedAttachmentReceipt(data: Record<string, unknown>): boolean {
  return (
    exactKeys(data, [
      "state", "uploadId", "fileId", "filename", "sha256", "byteLength",
    ]) &&
    nonBlankString(data.fileId)
  );
}

function validUnknownAttachmentReceipt(data: Record<string, unknown>): boolean {
  return (
    exactKeys(data, [
      "state", "uploadId", "filename", "sha256", "byteLength", "reason",
    ]) &&
    nonBlankString(data.reason)
  );
}

function validUploadProgressReceipt(data: Record<string, unknown>): boolean {
  return (
    exactKeys(data, [
      "state", "uploadId", "fileOffset", "filename", "sha256", "byteLength",
    ]) &&
    safeNonNegativeInteger(data.fileOffset) &&
    data.fileOffset <= (data.byteLength as number)
  );
}

export function isValidActivityAttachmentReceipt(
  value: unknown,
): value is ActivityAttachmentReceiptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (data.state === "none") return exactKeys(data, ["state"]);
  if (!validAttachmentIdentity(data)) return false;
  if (data.state === "attached") return validAttachedAttachmentReceipt(data);
  if (!nonBlankString(data.uploadId) || !nonBlankString(data.filename)) return false;
  if (data.state === "uploaded") return validUploadedAttachmentReceipt(data);
  if (data.state === "upload-result-unknown") return validUnknownAttachmentReceipt(data);
  return (data.state === "session-created" || data.state === "uploading") &&
    validUploadProgressReceipt(data);
}

function validReceiptMetadata(data: Record<string, unknown>): boolean {
  return (
    safeNonNegativeInteger(data.leaseExpiresAt) &&
    safeNonNegativeInteger(data.updatedAt) &&
    isValidActivityAttachmentReceipt(data.attachment)
  );
}

function receiptFromData(data: Record<string, unknown> | undefined): ActivityWriteReceiptV1 {
  if (
    !data ||
    !exactKeys(data, [
      "eventKey",
      "payloadDigest",
      "state",
      "historyAnchorPostId",
      "leaseOwner",
      "leaseToken",
      "leaseExpiresAt",
      "attachment",
      "updatedAt",
      ...(data.postId === undefined ? [] : ["postId"]),
    ]) ||
    !validReceiptStrings(data) ||
    !validReceiptState(data) ||
    !validReceiptMetadata(data)
  ) {
    throw new ActivityReceiptUnavailableError("Activity receipt is malformed");
  }
  return structuredClone(data) as unknown as ActivityWriteReceiptV1;
}

export interface ActivityReceiptChannel {
  readonly scope: WorkspaceChannelScope;
  readonly channelId: string;
}

type ActivityReceiptReader = Pick<PlatformStateTransaction, "workspaces">;

export class PlatformStateActivityWriteReceiptStore implements ActivityWriteReceiptStore {
  constructor(
    private readonly store: PlatformStateStore,
    private readonly channel: ActivityReceiptChannel,
  ) {}

  async claim(input: ActivityReceiptClaimInput): Promise<ActivityReceiptClaim> {
    return this.store.transaction({ label: "activity-receipt-claim" }, async (transaction) => {
      const result = nextClaim(await this.current(transaction, input.eventKey), input);
      if (result.outcome === "claimed") await this.write(transaction, result.receipt);
      return result;
    });
  }

  read(eventKey: string): Promise<ActivityWriteReceiptV1 | null> {
    return this.current(this.store, eventKey);
  }

  async markPosted(
    eventKey: string,
    leaseToken: string,
    postId: string,
    now: number,
  ): Promise<void> {
    await this.update(eventKey, leaseToken, now, (receipt) => ({
      ...receipt,
      state: "posted",
      postId,
    }));
  }

  async updateAttachment(
    eventKey: string,
    leaseToken: string,
    attachment: ActivityAttachmentReceiptV1,
    now: number,
  ): Promise<void> {
    await this.update(eventKey, leaseToken, now, (receipt) => ({ ...receipt, attachment }));
  }

  async commit(eventKey: string, leaseToken: string, now: number): Promise<void> {
    await this.update(eventKey, leaseToken, now, (receipt) => ({ ...receipt, state: "committed" }));
  }

  private async current(reader: ActivityReceiptReader, eventKey: string): Promise<ActivityWriteReceiptV1 | null> {
    const stored = await reader.workspaces.activityReceipts.get({ ...this.channel, receiptId: receiptDocumentId(eventKey) });
    if (stored === null) return null;
    const receipt = receiptFromData(stored.receipt);
    if (receipt.eventKey !== eventKey) {
      throw new ActivityReceiptUnavailableError("Activity receipt event key does not match its record");
    }
    return receipt;
  }

  private write(transaction: PlatformStateTransaction, receipt: ActivityWriteReceiptV1): Promise<void> {
    return transaction.workspaces.activityReceipts.put({
      ...this.channel,
      receiptId: receiptDocumentId(receipt.eventKey),
      receipt: { ...receipt },
    });
  }

  private async update(
    eventKey: string,
    leaseToken: string,
    now: number,
    change: (receipt: ActivityWriteReceiptV1) => ActivityWriteReceiptV1,
  ): Promise<void> {
    await this.store.transaction({ label: "activity-receipt-update" }, async (transaction) => {
      const current = await this.current(transaction, eventKey);
      await this.write(transaction, updateOwnedReceipt(current, eventKey, leaseToken, now, change));
    });
  }
}
