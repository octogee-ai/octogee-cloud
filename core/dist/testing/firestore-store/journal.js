import { GLM_OPERATIONS_COLLECTION, isOperationAuditRecord, isOperationAuditRow } from "@octogee/shared/types/glm";
import { operationAuditDocumentId } from "../../operation-audit.js";
import { MalformedRecordError, MissingRecordError } from "../../platform-state/errors.js";
import { assertFenceEquals, assertFenceOneOf } from "../../platform-state/documents/fences.js";
import { assertRevisionFence } from "./fences.js";
import { STORED_AS_NUMBERS, decodeDocumentData, encodeDocument, encodePatch, revisionOf, storedAsTimestamps } from "./values.js";
export const GATEWAY_RECOVERY_RECEIPTS_COLLECTION = "gatewayRecoveryReceipts";
const JOURNAL_TIMES = storedAsTimestamps("expireAt");
const IDENTITY_FIELDS = ["id", "revision"];
const operationKey = (operationId) => ({ aggregate: "operation", key: operationId });
const auditKey = (auditId) => ({ aggregate: "operation-audit", key: auditId });
const receiptKey = (receiptId) => ({ aggregate: "gateway-recovery-receipt", key: receiptId });
function isPresent(value) {
    return value !== null;
}
function stored(snapshot, data) {
    return { ...data, id: snapshot.id, revision: revisionOf(snapshot) };
}
export function decodeOperation(snapshot) {
    if (!snapshot.exists)
        return null;
    const data = decodeDocumentData(snapshot);
    if (isOperationAuditRow(data))
        return null;
    return stored(snapshot, data);
}
export function decodeOperationAudit(snapshot) {
    if (!snapshot.exists)
        return null;
    const data = decodeDocumentData(snapshot);
    if (!isOperationAuditRow(data))
        return null;
    if (!isOperationAuditRecord(data)) {
        throw new MalformedRecordError(auditKey(snapshot.id), "fails the operation audit schema");
    }
    return stored(snapshot, data);
}
function decodeJournalRecord(snapshot) {
    return decodeOperationAudit(snapshot) ?? decodeOperation(snapshot);
}
function decodeRecoveryReceipt(snapshot) {
    if (!snapshot.exists)
        return null;
    return stored(snapshot, decodeDocumentData(snapshot));
}
function whereStatusIn(query, statuses) {
    return statuses.length === 1 ? query.where("status", "==", statuses[0]) : query.where("status", "in", [...statuses]);
}
function mergeById(lists) {
    const merged = new Map();
    for (const list of lists)
        for (const item of list)
            merged.set(item.id, item);
    return [...merged.values()];
}
function operationsCollection(session) {
    return session.db.collection(GLM_OPERATIONS_COLLECTION);
}
function createOperationsRepository(session) {
    const collection = () => operationsCollection(session);
    const ref = (operationId) => collection().doc(operationId);
    const list = async (operation, query) => (await session.query(operation, query)).docs.map(decodeOperation).filter(isPresent);
    return {
        async get(operationId) {
            return decodeOperation(await session.read("journal.operations.get", ref(operationId)));
        },
        async getMany(operationIds) {
            const snapshots = await session.readAll("journal.operations.getMany", operationIds.map(ref));
            const found = new Map();
            for (const record of snapshots.map(decodeOperation))
                if (record !== null)
                    found.set(record.id, record);
            return found;
        },
        async listByStatus(statuses) {
            if (statuses.length === 0)
                return [];
            return list("journal.operations.listByStatus", whereStatusIn(collection(), statuses));
        },
        async listUnreleasedSchedulerHandoffs(statuses) {
            if (statuses.length === 0)
                return [];
            return list("journal.operations.listUnreleasedSchedulerHandoffs", collection().where("status", "in", [...statuses]).where("schedulerHandoffReleased", "==", false));
        },
        async listByGateway(gatewayId, limit) {
            const query = collection().where("gatewayId", "==", gatewayId);
            return list("journal.operations.listByGateway", limit === undefined ? query : query.limit(limit));
        },
        async listByInputGateway(gatewayId) {
            return list("journal.operations.listByInputGateway", collection().where("input.gatewayId", "==", gatewayId));
        },
        async listForUid(uid, filter) {
            if (filter.statuses !== undefined && filter.statuses.length === 0)
                return [];
            let query = collection().where("inputUid", "==", uid);
            if (filter.statuses !== undefined)
                query = whereStatusIn(query, filter.statuses);
            if (filter.kind !== undefined)
                query = query.where("kind", "==", filter.kind);
            return list("journal.operations.listForUid", query);
        },
        async listByKind(kind, statuses) {
            if (statuses !== undefined && statuses.length === 0)
                return [];
            const query = collection().where("kind", "==", kind);
            return list("journal.operations.listByKind", statuses === undefined ? query : whereStatusIn(query, statuses));
        },
        async listReferencingUid(uid) {
            const lists = await Promise.all(["inputUid", "input.uid", "createdBy"].map((field) => list("journal.operations.listReferencingUid", collection().where(field, "==", uid))));
            return mergeById(lists);
        },
        async listByInputUserSlugPrefix(prefix) {
            return list("journal.operations.listByInputBuilderSlugPrefix", collection().where("input.userSlug", ">=", prefix).where("input.userSlug", "<", `${prefix}`));
        },
        async enqueue(operation) {
            const doc = collection().doc();
            await session.create("journal.operations.enqueue", operationKey(doc.id), doc, encodeDocument(operation, JOURNAL_TIMES, IDENTITY_FIELDS));
            return doc.id;
        },
        async create(operation) {
            await session.create("journal.operations.create", operationKey(operation.id), ref(operation.id), encodeDocument(operation, JOURNAL_TIMES, IDENTITY_FIELDS));
        },
        async put(operation) {
            await session.set("journal.operations.put", operationKey(operation.id), ref(operation.id), encodeDocument(operation, JOURNAL_TIMES, IDENTITY_FIELDS));
        },
        async patch(operationId, patch, fence) {
            const name = "journal.operations.patch";
            const key = operationKey(operationId);
            const data = encodePatch(patch, JOURNAL_TIMES);
            if (fence === undefined) {
                await session.update(name, key, ref(operationId), data);
                return;
            }
            await session.atomically(name, async (fenced) => {
                const current = decodeOperation(await fenced.readForFence(name, ref(operationId)));
                if (current === null)
                    throw new MissingRecordError(key);
                assertRevisionFence(key, fence.revision, current.revision);
                assertFenceOneOf(key, "status", fence.status, current.status);
                assertFenceEquals(key, "startedAt", fence.startedAt, current.startedAt);
                await fenced.update(name, key, ref(operationId), data);
            });
        },
        async delete(operationId) {
            await session.delete("journal.operations.delete", operationKey(operationId), ref(operationId));
        },
    };
}
function createOperationAuditsRepository(session) {
    const ref = (auditId) => operationsCollection(session).doc(auditId);
    const get = async (operation, auditId) => decodeOperationAudit(await session.read(operation, ref(auditId)));
    return {
        get(auditId) {
            return get("journal.audits.get", auditId);
        },
        getByIdempotencyKey(idempotencyKey) {
            return get("journal.audits.getByIdempotencyKey", operationAuditDocumentId(idempotencyKey));
        },
        async create(audit) {
            await session.create("journal.audits.create", auditKey(audit.id), ref(audit.id), encodeDocument(audit, JOURNAL_TIMES, IDENTITY_FIELDS));
        },
        async patch(auditId, patch, fence) {
            const name = "journal.audits.patch";
            const key = auditKey(auditId);
            const data = encodePatch(patch, JOURNAL_TIMES);
            if (fence === undefined) {
                await session.update(name, key, ref(auditId), data);
                return;
            }
            await session.atomically(name, async (fenced) => {
                const current = decodeOperationAudit(await fenced.readForFence(name, ref(auditId)));
                if (current === null)
                    throw new MissingRecordError(key);
                assertRevisionFence(key, fence.revision, current.revision);
                assertFenceOneOf(key, "status", fence.status, current.status);
                assertFenceEquals(key, "actionClaimId", fence.actionClaimId, current.actionClaimId);
                assertFenceEquals(key, "startedAt", fence.actionStartedAt, current.actionStartedAt);
                await fenced.update(name, key, ref(auditId), data);
            });
        },
        async delete(auditId) {
            await session.delete("journal.audits.delete", auditKey(auditId), ref(auditId));
        },
    };
}
function createRecoveryReceiptsRepository(session) {
    const collection = () => session.db.collection(GATEWAY_RECOVERY_RECEIPTS_COLLECTION);
    const ref = (receiptId) => collection().doc(receiptId);
    const list = async (operation, query) => (await session.query(operation, query)).docs.map(decodeRecoveryReceipt).filter(isPresent);
    return {
        async get(receiptId) {
            return decodeRecoveryReceipt(await session.read("journal.recoveryReceipts.get", ref(receiptId)));
        },
        async listReferencingUid(uid) {
            const lists = await Promise.all(["inputUid", "input.uid"].map((field) => list("journal.recoveryReceipts.listReferencingUid", collection().where(field, "==", uid))));
            return mergeById(lists);
        },
        async create(receipt) {
            await session.create("journal.recoveryReceipts.create", receiptKey(receipt.id), ref(receipt.id), encodeDocument(receipt, STORED_AS_NUMBERS, IDENTITY_FIELDS));
        },
        async patch(receiptId, patch, fence) {
            const name = "journal.recoveryReceipts.patch";
            const key = receiptKey(receiptId);
            const data = encodePatch(patch, STORED_AS_NUMBERS);
            if (fence?.revision === undefined) {
                await session.update(name, key, ref(receiptId), data);
                return;
            }
            await session.atomically(name, async (fenced) => {
                const current = decodeRecoveryReceipt(await fenced.readForFence(name, ref(receiptId)));
                if (current === null)
                    throw new MissingRecordError(key);
                assertRevisionFence(key, fence.revision, current.revision);
                await fenced.update(name, key, ref(receiptId), data);
            });
        },
        async delete(receiptId) {
            await session.delete("journal.recoveryReceipts.delete", receiptKey(receiptId), ref(receiptId));
        },
    };
}
async function listRecentJournalRecords(session, page) {
    const name = "journal.listRecent";
    let query = operationsCollection(session).orderBy("createdAt", "desc");
    if (page.after !== undefined) {
        const cursor = await session.read(name, operationsCollection(session).doc(page.after));
        if (!cursor.exists)
            throw new MissingRecordError(operationKey(page.after));
        query = query.startAfter(cursor);
    }
    const docs = (await session.query(name, query.limit(page.limit + 1))).docs;
    const pageDocs = docs.slice(0, page.limit);
    return {
        items: pageDocs.map(decodeJournalRecord).filter(isPresent),
        next: docs.length > page.limit ? pageDocs[pageDocs.length - 1].id : null,
    };
}
export function createFirestoreJournalRepositories(session) {
    return {
        operations: createOperationsRepository(session),
        audits: createOperationAuditsRepository(session),
        recoveryReceipts: createRecoveryReceiptsRepository(session),
        async getRecord(recordId) {
            return decodeJournalRecord(await session.read("journal.getRecord", operationsCollection(session).doc(recordId)));
        },
        listRecent(page) {
            return listRecentJournalRecords(session, page);
        },
    };
}
export const firestoreOperationsWatchSource = (db, filter) => ({
    operation: "watch operations",
    targets: filter.statuses.length === 0
        ? []
        : [
            {
                query: whereStatusIn(db.collection(GLM_OPERATIONS_COLLECTION), filter.statuses),
                key: (snapshot) => snapshot.id,
                decode: decodeOperation,
            },
        ],
});
