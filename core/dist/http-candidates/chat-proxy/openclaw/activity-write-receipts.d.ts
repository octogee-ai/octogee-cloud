import type { PlatformStateStore, WorkspaceChannelScope } from "../../../platform-state/index.js";
export type ActivityAttachmentReceiptV1 = {
    state: "none";
} | {
    state: "session-created" | "uploading";
    uploadId: string;
    fileOffset: number;
    filename: string;
    sha256: string;
    byteLength: number;
} | {
    state: "uploaded";
    uploadId: string;
    fileId: string;
    filename: string;
    sha256: string;
    byteLength: number;
} | {
    state: "attached";
    fileId: string;
    sha256: string;
    byteLength: number;
} | {
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
export type ActivityReceiptClaim = {
    outcome: "claimed";
    receipt: ActivityWriteReceiptV1;
    recovered: boolean;
} | {
    outcome: "duplicate";
    receipt: ActivityWriteReceiptV1;
};
export interface ActivityWriteReceiptStore {
    claim(input: ActivityReceiptClaimInput): Promise<ActivityReceiptClaim>;
    read(eventKey: string): Promise<ActivityWriteReceiptV1 | null>;
    markPosted(eventKey: string, leaseToken: string, postId: string, now: number): Promise<void>;
    updateAttachment(eventKey: string, leaseToken: string, attachment: ActivityAttachmentReceiptV1, now: number): Promise<void>;
    commit(eventKey: string, leaseToken: string, now: number): Promise<void>;
}
export declare class ActivityReceiptConflictError extends Error {
    readonly name = "ActivityReceiptConflictError";
}
export declare class ActivityReceiptLeaseError extends Error {
    readonly name = "ActivityReceiptLeaseError";
}
export declare class ActivityReceiptUnavailableError extends Error {
    readonly name = "ActivityReceiptUnavailableError";
}
export declare function receiptDocumentId(eventKey: string): string;
export declare class InMemoryActivityWriteReceiptStore implements ActivityWriteReceiptStore {
    private readonly receipts;
    claim(input: ActivityReceiptClaimInput): Promise<ActivityReceiptClaim>;
    read(eventKey: string): Promise<ActivityWriteReceiptV1 | null>;
    markPosted(eventKey: string, leaseToken: string, postId: string, now: number): Promise<void>;
    updateAttachment(eventKey: string, leaseToken: string, attachment: ActivityAttachmentReceiptV1, now: number): Promise<void>;
    commit(eventKey: string, leaseToken: string, now: number): Promise<void>;
    private update;
}
export declare function isValidActivityAttachmentReceipt(value: unknown): value is ActivityAttachmentReceiptV1;
export interface ActivityReceiptChannel {
    readonly scope: WorkspaceChannelScope;
    readonly channelId: string;
}
export declare class PlatformStateActivityWriteReceiptStore implements ActivityWriteReceiptStore {
    private readonly store;
    private readonly channel;
    constructor(store: PlatformStateStore, channel: ActivityReceiptChannel);
    claim(input: ActivityReceiptClaimInput): Promise<ActivityReceiptClaim>;
    read(eventKey: string): Promise<ActivityWriteReceiptV1 | null>;
    markPosted(eventKey: string, leaseToken: string, postId: string, now: number): Promise<void>;
    updateAttachment(eventKey: string, leaseToken: string, attachment: ActivityAttachmentReceiptV1, now: number): Promise<void>;
    commit(eventKey: string, leaseToken: string, now: number): Promise<void>;
    private current;
    private write;
    private update;
}
