import { createHash, randomUUID } from "node:crypto";
export class ActivityReceiptConflictError extends Error {
    name = "ActivityReceiptConflictError";
}
export class ActivityReceiptLeaseError extends Error {
    name = "ActivityReceiptLeaseError";
}
export class ActivityReceiptUnavailableError extends Error {
    name = "ActivityReceiptUnavailableError";
}
export function receiptDocumentId(eventKey) {
    return createHash("sha256").update(eventKey, "utf8").digest("hex");
}
function safeNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}
function validateClaimInput(input) {
    if (!/^[a-f0-9]{64}$/.test(input.eventKey) ||
        !/^[a-f0-9]{64}$/.test(input.payloadDigest) ||
        !input.historyAnchorPostId ||
        !input.leaseOwner ||
        !safeNonNegativeInteger(input.now) ||
        !Number.isSafeInteger(input.leaseMs) ||
        input.leaseMs <= 0 ||
        !Number.isSafeInteger(input.now + input.leaseMs)) {
        throw new ActivityReceiptUnavailableError("Activity receipt claim is malformed");
    }
}
function copyReceipt(receipt) {
    return structuredClone(receipt);
}
function nextClaim(current, input) {
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
function updateOwnedReceipt(current, eventKey, leaseToken, now, update) {
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
export class InMemoryActivityWriteReceiptStore {
    receipts = new Map();
    async claim(input) {
        const key = receiptDocumentId(input.eventKey);
        const result = nextClaim(this.receipts.get(key) ?? null, input);
        if (result.outcome === "claimed") {
            this.receipts.set(key, copyReceipt(result.receipt));
        }
        return structuredClone(result);
    }
    async read(eventKey) {
        const receipt = this.receipts.get(receiptDocumentId(eventKey));
        return receipt ? copyReceipt(receipt) : null;
    }
    async markPosted(eventKey, leaseToken, postId, now) {
        this.update(eventKey, leaseToken, now, (receipt) => ({
            ...receipt,
            state: "posted",
            postId,
        }));
    }
    async updateAttachment(eventKey, leaseToken, attachment, now) {
        this.update(eventKey, leaseToken, now, (receipt) => ({ ...receipt, attachment }));
    }
    async commit(eventKey, leaseToken, now) {
        this.update(eventKey, leaseToken, now, (receipt) => ({ ...receipt, state: "committed" }));
    }
    update(eventKey, leaseToken, now, change) {
        const key = receiptDocumentId(eventKey);
        const updated = updateOwnedReceipt(this.receipts.get(key) ?? null, eventKey, leaseToken, now, change);
        this.receipts.set(key, updated);
    }
}
function validReceiptStrings(data) {
    return (nonBlankString(data.eventKey) &&
        /^[a-f0-9]{64}$/.test(data.eventKey) &&
        nonBlankString(data.payloadDigest) &&
        /^[a-f0-9]{64}$/.test(data.payloadDigest) &&
        nonBlankString(data.historyAnchorPostId) &&
        nonBlankString(data.leaseOwner) &&
        nonBlankString(data.leaseToken) &&
        (data.postId === undefined || nonBlankString(data.postId)));
}
function validReceiptState(data) {
    return data.state === "claimed" || data.state === "posted" || data.state === "committed";
}
function nonBlankString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function exactKeys(data, keys) {
    const expected = new Set(keys);
    return Object.keys(data).length === expected.size && Object.keys(data).every((key) => expected.has(key));
}
function validAttachmentIdentity(data) {
    return (/^[a-f0-9]{64}$/.test(typeof data.sha256 === "string" ? data.sha256 : "") &&
        Number.isSafeInteger(data.byteLength) &&
        data.byteLength > 0);
}
function validAttachedAttachmentReceipt(data) {
    return (exactKeys(data, ["state", "fileId", "sha256", "byteLength"]) &&
        nonBlankString(data.fileId));
}
function validUploadedAttachmentReceipt(data) {
    return (exactKeys(data, [
        "state", "uploadId", "fileId", "filename", "sha256", "byteLength",
    ]) &&
        nonBlankString(data.fileId));
}
function validUnknownAttachmentReceipt(data) {
    return (exactKeys(data, [
        "state", "uploadId", "filename", "sha256", "byteLength", "reason",
    ]) &&
        nonBlankString(data.reason));
}
function validUploadProgressReceipt(data) {
    return (exactKeys(data, [
        "state", "uploadId", "fileOffset", "filename", "sha256", "byteLength",
    ]) &&
        safeNonNegativeInteger(data.fileOffset) &&
        data.fileOffset <= data.byteLength);
}
export function isValidActivityAttachmentReceipt(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const data = value;
    if (data.state === "none")
        return exactKeys(data, ["state"]);
    if (!validAttachmentIdentity(data))
        return false;
    if (data.state === "attached")
        return validAttachedAttachmentReceipt(data);
    if (!nonBlankString(data.uploadId) || !nonBlankString(data.filename))
        return false;
    if (data.state === "uploaded")
        return validUploadedAttachmentReceipt(data);
    if (data.state === "upload-result-unknown")
        return validUnknownAttachmentReceipt(data);
    return (data.state === "session-created" || data.state === "uploading") &&
        validUploadProgressReceipt(data);
}
function validReceiptMetadata(data) {
    return (safeNonNegativeInteger(data.leaseExpiresAt) &&
        safeNonNegativeInteger(data.updatedAt) &&
        isValidActivityAttachmentReceipt(data.attachment));
}
function receiptFromData(data) {
    if (!data ||
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
        !validReceiptMetadata(data)) {
        throw new ActivityReceiptUnavailableError("Activity receipt is malformed");
    }
    return structuredClone(data);
}
export class PlatformStateActivityWriteReceiptStore {
    store;
    channel;
    constructor(store, channel) {
        this.store = store;
        this.channel = channel;
    }
    async claim(input) {
        return this.store.transaction({ label: "activity-receipt-claim" }, async (transaction) => {
            const result = nextClaim(await this.current(transaction, input.eventKey), input);
            if (result.outcome === "claimed")
                await this.write(transaction, result.receipt);
            return result;
        });
    }
    read(eventKey) {
        return this.current(this.store, eventKey);
    }
    async markPosted(eventKey, leaseToken, postId, now) {
        await this.update(eventKey, leaseToken, now, (receipt) => ({
            ...receipt,
            state: "posted",
            postId,
        }));
    }
    async updateAttachment(eventKey, leaseToken, attachment, now) {
        await this.update(eventKey, leaseToken, now, (receipt) => ({ ...receipt, attachment }));
    }
    async commit(eventKey, leaseToken, now) {
        await this.update(eventKey, leaseToken, now, (receipt) => ({ ...receipt, state: "committed" }));
    }
    async current(reader, eventKey) {
        const stored = await reader.workspaces.activityReceipts.get({ ...this.channel, receiptId: receiptDocumentId(eventKey) });
        if (stored === null)
            return null;
        const receipt = receiptFromData(stored.receipt);
        if (receipt.eventKey !== eventKey) {
            throw new ActivityReceiptUnavailableError("Activity receipt event key does not match its record");
        }
        return receipt;
    }
    write(transaction, receipt) {
        return transaction.workspaces.activityReceipts.put({
            ...this.channel,
            receiptId: receiptDocumentId(receipt.eventKey),
            receipt: { ...receipt },
        });
    }
    async update(eventKey, leaseToken, now, change) {
        await this.store.transaction({ label: "activity-receipt-update" }, async (transaction) => {
            const current = await this.current(transaction, eventKey);
            await this.write(transaction, updateOwnedReceipt(current, eventKey, leaseToken, now, change));
        });
    }
}
