import { isDeepStrictEqual } from "node:util";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { SCHEDULE_TRANSFERS_SUBCOLLECTION } from "@octogee/shared/types/fleet-controller";
import { PLACEMENT_RECEIPTS_SUBCOLLECTION, placementReceiptDocId } from "@octogee/shared/types/placement-receipts";
import { DuplicateRecordError, FenceMismatchError, MissingRecordError, UnsupportedOperationError } from "../../platform-state/errors.js";
import { assertFenceEquals, assertFenceOneOf } from "../../platform-state/documents/fences.js";
import { assertRevisionFence } from "./fences.js";
import { STORED_AS_NUMBERS, decodeDocumentData, encodeDocument, encodeMergeDocument, encodePatch, formatTimestamp, isClearField, revisionOf, storedAsTimestamps } from "./values.js";
import { ACTIVATED_AGENTS_PATH, ADMITTED_STEP, AGENT_IDS_PATH, AUXILIARY_STORED_KIND, GATEWAY_STATE_KIND, MATTERMOST_USER_ID_PATH, OPENCLAW_PATHS, PROVISIONING_PATHS, SLUG_PATH, USER_ACTIVATION_LEASE_PATH, USER_FENCE_PATHS, USER_MIRROR_PATHS, agentStoreFromData, agentStoreKey, agentStoreKeyOf, mappedGroup, userKey, userPatchPaths, userRecordFromData, userRoleFromData } from "../../platform-state/documents/users.js";
export const USERS_COLLECTION = "users";
export const AGENT_STORES_SUBCOLLECTION = "agentStores";
const VM_INSTANCE_ID_PATH = "provisioning.computer.instanceId";
const CREATED_AT_TIMESTAMP = storedAsTimestamps("createdAt");
const receiptKey = (uid, receiptId) => ({ aggregate: "placement-receipt", key: `${uid}/${receiptId}` });
const transferKey = (uid, migrationId) => ({ aggregate: "schedule-transfer", key: `${uid}/${migrationId}` });
function usersCollection(db) {
    return db.collection(USERS_COLLECTION);
}
function systemConfigRef(userRef) {
    return userRef.collection("system").doc("config");
}
function decodeRole(uid, config) {
    if (config === undefined || !config.exists)
        return null;
    return userRoleFromData(uid, decodeDocumentData(config));
}
function userRevision(user, config) {
    const configTime = config?.exists === true ? config.updateTime : undefined;
    const userTime = user.updateTime;
    if (configTime === undefined || userTime === undefined || configTime.valueOf() <= userTime.valueOf())
        return revisionOf(user);
    return formatTimestamp(configTime);
}
export function decodeUser(snapshot, config) {
    if (!snapshot.exists)
        return null;
    const record = userRecordFromData(snapshot.id, decodeDocumentData(snapshot), snapshot.updateTime.toMillis(), decodeRole(snapshot.id, config));
    return { ...record, revision: userRevision(snapshot, config) };
}
function userPatchFields(patch) {
    return encodePatch(userPatchPaths(patch), STORED_AS_NUMBERS);
}
function userFenceMismatch(record, field, expected, actual) {
    return new FenceMismatchError(record, expected === null || expected === undefined ? "absent" : "present", { [field]: expected }, { [field]: actual });
}
function assertUserFence(record, fence, current) {
    if (fence === undefined)
        return;
    assertRevisionFence(record, fence.revision, current.revision);
    if (fence.gatewayId !== undefined && fence.gatewayId !== (current.gateway?.gatewayId ?? null)) {
        throw userFenceMismatch(record, "gatewayId", fence.gatewayId, current.gateway?.gatewayId ?? null);
    }
    if (fence.provisioningStatus === "absent") {
        if (current.provisioning.status !== undefined) {
            throw userFenceMismatch(record, "provisioningStatus", null, current.provisioning.status);
        }
    }
    else {
        assertFenceEquals(record, "status", fence.provisioningStatus, current.provisioning.status);
    }
}
function assertActivationLeaseFence(record, fence, lease) {
    assertFenceEquals(record, "leaseId", fence.leaseId, lease?.leaseId ?? null);
    assertFenceEquals(record, "generation", fence.generation, lease?.generation ?? null);
    assertFenceOneOf(record, "status", fence.status, lease?.status);
}
async function readSystemConfigs(session, operation, userSnapshots) {
    const configs = await session.readAll(operation, userSnapshots.map((snapshot) => systemConfigRef(snapshot.ref)));
    return new Map(userSnapshots.map((snapshot, index) => [snapshot.id, configs[index]]));
}
function storedUsers(userSnapshots, configs) {
    const records = [];
    for (const snapshot of userSnapshots) {
        const record = decodeUser(snapshot, configs.get(snapshot.id));
        if (record !== null)
            records.push(record);
    }
    return records;
}
function uniqueByUid(snapshots) {
    return [...new Map(snapshots.map((snapshot) => [snapshot.id, snapshot])).values()];
}
function userRecordAccess(session) {
    const collection = () => usersCollection(session.db);
    const ref = (uid) => collection().doc(uid);
    const queryRecords = async (operation, queries) => {
        const results = await Promise.all(queries.map((query) => session.query(operation, query)));
        const docs = uniqueByUid(results.flatMap((result) => result.docs));
        return storedUsers(docs, await readSystemConfigs(session, operation, docs));
    };
    const findUnique = async (operation, lookup, value, queries, matches = () => true) => {
        const found = (await queryRecords(operation, queries)).filter(matches);
        if (found.length > 1) {
            throw new DuplicateRecordError("builder", lookup, value, found.map((record) => record.uid));
        }
        return found[0] ?? null;
    };
    const readCurrent = async (fenced, operation, uid) => {
        const user = await fenced.readForFence(operation, ref(uid));
        const config = await fenced.readForFence(operation, systemConfigRef(ref(uid)));
        const current = decodeUser(user, config);
        if (current === null)
            throw new MissingRecordError(userKey(uid));
        return current;
    };
    const update = async (operation, uid, data, fence) => {
        if (fence === undefined) {
            await session.update(operation, userKey(uid), ref(uid), data);
            return;
        }
        await session.atomically(operation, async (fenced) => {
            assertUserFence(userKey(uid), fence, await readCurrent(fenced, operation, uid));
            await fenced.update(operation, userKey(uid), ref(uid), data);
        });
    };
    const updateActivationLease = async (operation, uid, fence, data) => {
        await session.atomically(operation, async (fenced) => {
            const current = await readCurrent(fenced, operation, uid);
            assertActivationLeaseFence(userKey(uid), fence, current.activationLease);
            await fenced.update(operation, userKey(uid), ref(uid), data(current.activationLease));
        });
    };
    return { session, collection, ref, queryRecords, findUnique, readCurrent, update, updateActivationLease };
}
function userRecordReads(access) {
    const { session, collection, ref, queryRecords, findUnique } = access;
    return {
        async get(uid) {
            const name = "builders.records.get";
            const [user, config] = await session.readAll(name, [ref(uid), systemConfigRef(ref(uid))]);
            return decodeUser(user, config);
        },
        async getRole(uid) {
            return decodeRole(uid, await session.read("builders.records.getRole", systemConfigRef(ref(uid))));
        },
        async getMany(uids) {
            const name = "builders.records.getMany";
            const unique = [...new Set(uids)];
            const snapshots = await session.readAll(name, unique.flatMap((uid) => [ref(uid), systemConfigRef(ref(uid))]));
            const found = new Map();
            unique.forEach((uid, index) => {
                const record = decodeUser(snapshots[index * 2], snapshots[index * 2 + 1]);
                if (record !== null)
                    found.set(uid, record);
            });
            return found;
        },
        findBySlug(slug) {
            return findUnique("builders.records.findBySlug", "slug", slug, [collection().where(SLUG_PATH, "==", slug).limit(2), collection().where("username", "==", slug).limit(2)], (record) => record.slug === slug);
        },
        findByMattermostUserId(mattermostUserId) {
            return findUnique("builders.records.findByMattermostUserId", "mattermostUserId", mattermostUserId, [
                collection().where(MATTERMOST_USER_ID_PATH, "==", mattermostUserId).limit(2),
            ]);
        },
        findByVmInstanceId(instanceId) {
            return findUnique("builders.records.findByComputerInstanceId", "vmInstanceId", instanceId, [
                collection().where(VM_INSTANCE_ID_PATH, "==", instanceId).limit(2),
            ]);
        },
        listByAgentId(agentId, limit) {
            return queryRecords("builders.records.listByAgentId", [
                collection().where(OPENCLAW_PATHS.agentId, "==", agentId).limit(limit),
                collection().where(AGENT_IDS_PATH, "array-contains", agentId).limit(limit),
            ]);
        },
        listByGateway(gatewayId, filter = {}) {
            let query = collection().where(USER_MIRROR_PATHS.gatewayId, "==", gatewayId);
            if (filter.openclawStatus !== undefined)
                query = query.where(OPENCLAW_PATHS.status, "==", filter.openclawStatus);
            if (filter.limit !== undefined)
                query = query.limit(filter.limit);
            return queryRecords("builders.records.listByGateway", [query]);
        },
        async listGatewayFenceHolders(gatewayId) {
            const name = "builders.records.listGatewayFenceHolders";
            const results = await Promise.all([
                USER_MIRROR_PATHS.gatewayId,
                `${USER_FENCE_PATHS.sourceTransferFence}.sourceGatewayId`,
                `${USER_FENCE_PATHS.sourceTransferFence}.targetGatewayId`,
                `${USER_FENCE_PATHS.computerRecovery}.gatewayId`,
            ].map((path) => session.query(name, collection().where(path, "==", gatewayId))));
            const configs = await readSystemConfigs(session, name, uniqueByUid(results.flatMap((result) => result.docs)));
            const [assigned, sourceTransferSource, sourceTransferTarget, computerRecovery] = results.map((result) => storedUsers(result.docs, configs));
            return { assigned, sourceTransferSource, sourceTransferTarget, computerRecovery };
        },
        listAdmitted() {
            return queryRecords("builders.records.listAdmitted", [collection().where("onboardingStep", "==", ADMITTED_STEP)]);
        },
        listAll() {
            return queryRecords("builders.records.listAll", [collection()]);
        },
        listByOpenClawStatus(openclawStatus) {
            return queryRecords("builders.records.listByOpenClawStatus", [collection().where(OPENCLAW_PATHS.status, "==", openclawStatus)]);
        },
        async list(page) {
            const name = "builders.records.list";
            let query = collection().orderBy("createdAt", "desc");
            if (page.after !== undefined) {
                const cursor = await session.read(name, ref(page.after));
                if (!cursor.exists)
                    throw new MissingRecordError(userKey(page.after));
                query = query.startAfter(cursor);
            }
            const docs = (await session.query(name, query.limit(page.limit + 1))).docs;
            const pageDocs = docs.slice(0, page.limit);
            return {
                items: storedUsers(pageDocs, await readSystemConfigs(session, name, pageDocs)),
                next: docs.length > page.limit ? pageDocs[pageDocs.length - 1].id : null,
            };
        },
    };
}
function userRecordWrites(access) {
    const { session, ref, readCurrent, update, updateActivationLease } = access;
    return {
        async create(record) {
            await session.merge("builders.records.create", userKey(record.uid), ref(record.uid), encodeMergeDocument({ createdAt: record.createdAt }, CREATED_AT_TIMESTAMP));
        },
        async patch(uid, patch, fence) {
            const name = "builders.records.patch";
            const key = userKey(uid);
            const fields = userPatchFields(patch);
            const hasFields = Object.keys(fields).length > 0;
            if (patch.role === undefined) {
                await update(name, uid, fields, fence);
                return;
            }
            const role = encodeMergeDocument({ role: patch.role }, STORED_AS_NUMBERS);
            await session.atomically(name, async (fenced) => {
                if (fence !== undefined || !hasFields)
                    assertUserFence(key, fence, await readCurrent(fenced, name, uid));
                if (hasFields)
                    await fenced.update(name, key, ref(uid), fields);
                await fenced.merge(name, key, systemConfigRef(ref(uid)), role);
            });
        },
        async admit(uid, input) {
            const name = "builders.records.admit";
            const key = userKey(uid);
            await session.atomically(name, async (fenced) => {
                const current = decodeUser(await fenced.readForFence(name, ref(uid)), undefined);
                if (current === null) {
                    await fenced.merge(name, key, ref(uid), encodeMergeDocument({
                        createdAt: input.createdAt,
                        onboardingStep: ADMITTED_STEP,
                        provisioning: { status: "in_progress", startedAt: input.provisioningStartedAt },
                    }, CREATED_AT_TIMESTAMP));
                    return;
                }
                if (current.provisioning.status !== undefined) {
                    throw userFenceMismatch(key, "provisioningStatus", null, current.provisioning.status);
                }
                if (current.slug !== null && current.slug !== input.slug) {
                    throw userFenceMismatch(key, "slug", input.slug, current.slug);
                }
                await fenced.update(name, key, ref(uid), encodePatch({
                    ...(current.createdAt === null ? { createdAt: input.createdAt } : {}),
                    onboardingStep: ADMITTED_STEP,
                    [PROVISIONING_PATHS.status]: "in_progress",
                    [PROVISIONING_PATHS.startedAt]: input.provisioningStartedAt,
                }, CREATED_AT_TIMESTAMP));
            });
        },
        async setGatewayMirror(uid, mirror, fence) {
            const fields = isClearField(mirror)
                ? Object.fromEntries(Object.values(USER_MIRROR_PATHS).map((path) => [path, mirror]))
                : mappedGroup(mirror, USER_MIRROR_PATHS, "gateway");
            await update("builders.records.setGatewayMirror", uid, encodePatch(fields, STORED_AS_NUMBERS), fence);
        },
        async addAgents(uid, agentIds) {
            if (agentIds.length === 0)
                return;
            await update("builders.records.addAgents", uid, { [AGENT_IDS_PATH]: FieldValue.arrayUnion(...agentIds) });
        },
        async removeAgents(uid, agentIds) {
            if (agentIds.length === 0)
                return;
            await update("builders.records.removeAgents", uid, { [AGENT_IDS_PATH]: FieldValue.arrayRemove(...agentIds) });
        },
        async setActivatedAgents(uid, activatedAgents) {
            await update("builders.records.setActivatedAgents", uid, { [ACTIVATED_AGENTS_PATH]: [...activatedAgents] });
        },
        async setActivationLease(uid, lease, fence) {
            const data = encodePatch({ [USER_ACTIVATION_LEASE_PATH]: lease }, STORED_AS_NUMBERS);
            await updateActivationLease("builders.records.setActivationLease", uid, fence, () => data);
        },
        async patchActivationLease(uid, patch, fence) {
            const name = "builders.records.patchActivationLease";
            if (Object.hasOwn(patch, "leaseId") || Object.hasOwn(patch, "generation")) {
                throw new TypeError("an activation lease patch cannot change its leaseId or generation");
            }
            const data = encodePatch(patch, STORED_AS_NUMBERS, USER_ACTIVATION_LEASE_PATH);
            await updateActivationLease(name, uid, fence, (lease) => {
                if (lease === null)
                    throw userFenceMismatch(userKey(uid), "activationLease", "present", null);
                return data;
            });
        },
        async setFence(uid, fenceName, value, expected) {
            const name = "builders.records.setFence";
            const key = userKey(uid);
            const data = encodePatch({ [USER_FENCE_PATHS[fenceName]]: value }, STORED_AS_NUMBERS);
            if (expected === undefined) {
                await session.update(name, key, ref(uid), data);
                return;
            }
            await session.atomically(name, async (fenced) => {
                const actual = (await readCurrent(fenced, name, uid)).fences[fenceName];
                const wanted = expected === "absent" ? undefined : expected;
                if (!isDeepStrictEqual(actual, wanted))
                    throw userFenceMismatch(key, fenceName, wanted ?? null, actual ?? null);
                await fenced.update(name, key, ref(uid), data);
            });
        },
        async delete(uid) {
            if (session.transactional) {
                throw new UnsupportedOperationError("firestore", "builders.records.delete", "backend-capability");
            }
            await session.db.recursiveDelete(ref(uid));
        },
    };
}
function createUserRecordsRepository(session) {
    const access = userRecordAccess(session);
    return { ...userRecordReads(access), ...userRecordWrites(access) };
}
function createPlacementReceiptsRepository(session) {
    const collection = (uid) => usersCollection(session.db).doc(uid).collection(PLACEMENT_RECEIPTS_SUBCOLLECTION);
    const decode = (snapshot) => decodeDocumentData(snapshot);
    return {
        async get(uid, leaseId, generation, kind) {
            const snapshot = await session.read("builders.placementReceipts.get", collection(uid).doc(placementReceiptDocId(leaseId, generation, kind)));
            return snapshot.exists ? decode(snapshot) : null;
        },
        async list(uid, page) {
            const name = "builders.placementReceipts.list";
            let query = collection(uid).orderBy("at", "desc");
            if (page.after !== undefined) {
                const cursor = await session.read(name, collection(uid).doc(page.after));
                if (!cursor.exists)
                    throw new MissingRecordError(receiptKey(uid, page.after));
                query = query.startAfter(cursor);
            }
            const docs = (await session.query(name, query.limit(page.limit + 1))).docs;
            const pageDocs = docs.slice(0, page.limit);
            return {
                items: pageDocs.map(decode),
                next: docs.length > page.limit ? pageDocs[pageDocs.length - 1].id : null,
            };
        },
        async create(uid, receipt) {
            const receiptId = placementReceiptDocId(receipt.leaseId, receipt.generation, receipt.kind);
            await session.create("builders.placementReceipts.create", receiptKey(uid, receiptId), collection(uid).doc(receiptId), encodeDocument(receipt, STORED_AS_NUMBERS));
        },
    };
}
function createScheduleTransfersRepository(session) {
    const ref = (uid, migrationId) => usersCollection(session.db).doc(uid).collection(SCHEDULE_TRANSFERS_SUBCOLLECTION).doc(migrationId);
    return {
        async get(uid, migrationId) {
            const snapshot = await session.read("builders.scheduleTransfers.get", ref(uid, migrationId));
            if (!snapshot.exists)
                return null;
            return { ...decodeDocumentData(snapshot), revision: revisionOf(snapshot) };
        },
        async put(uid, transfer) {
            await session.set("builders.scheduleTransfers.put", transferKey(uid, transfer.migrationId), ref(uid, transfer.migrationId), encodeDocument(transfer, STORED_AS_NUMBERS, ["revision"]));
        },
        async patch(uid, migrationId, patch) {
            await session.update("builders.scheduleTransfers.patch", transferKey(uid, migrationId), ref(uid, migrationId), encodePatch(patch, STORED_AS_NUMBERS));
        },
        async listUnrestored() {
            const snapshot = await session.query("builders.scheduleTransfers.listUnrestored", session.db.collectionGroup(SCHEDULE_TRANSFERS_SUBCOLLECTION));
            return snapshot.docs
                .map((doc) => ({
                uid: doc.ref.parent.parent.id,
                transfer: { ...decodeDocumentData(doc), revision: revisionOf(doc) },
            }))
                .filter(({ transfer }) => transfer.restoredTo === undefined)
                .sort((a, b) => a.transfer.snapshotAt - b.transfer.snapshotAt || a.uid.localeCompare(b.uid) ||
                a.transfer.migrationId.localeCompare(b.transfer.migrationId));
        },
    };
}
function decodeAgentStore(uid, snapshot) {
    return { ...agentStoreFromData(uid, snapshot.id, decodeDocumentData(snapshot)), revision: revisionOf(snapshot) };
}
function encodeAgentStore(record) {
    const common = {
        storeId: record.storeId,
        schema: record.schema,
        gatewayId: record.gatewayId ?? undefined,
        generation: record.generation ?? undefined,
        assignmentEpoch: record.assignmentEpoch ?? undefined,
        recordedAt: record.recordedAt,
    };
    if (record.kind === GATEWAY_STATE_KIND)
        return encodeDocument({ kind: GATEWAY_STATE_KIND, ...common }, STORED_AS_NUMBERS);
    if (record.kind === "auxiliary") {
        return encodeDocument({ kind: AUXILIARY_STORED_KIND, family: record.family, ...common }, STORED_AS_NUMBERS);
    }
    return encodeDocument({ agentId: record.agentId, ...common }, STORED_AS_NUMBERS);
}
function createAgentStoresRepository(session) {
    const collection = (uid) => usersCollection(session.db).doc(uid).collection(AGENT_STORES_SUBCOLLECTION);
    return {
        async list(uid) {
            const snapshot = await session.query("builders.agentStores.list", collection(uid));
            return snapshot.docs.map((doc) => decodeAgentStore(uid, doc));
        },
        async put(uid, record) {
            const storeKey = agentStoreKeyOf(record);
            await session.set("builders.agentStores.put", agentStoreKey(uid, storeKey), collection(uid).doc(storeKey), encodeAgentStore(record));
        },
        async delete(uid, storeKey) {
            await session.delete("builders.agentStores.delete", agentStoreKey(uid, storeKey), collection(uid).doc(storeKey));
        },
    };
}
function unsupportedUserAccounts() {
    const unsupported = (operation) => async () => {
        throw new UnsupportedOperationError("firestore", `users.accounts.${operation}`, "backend-capability");
    };
    return { get: unsupported("get"), getMany: unsupported("getMany"), listAll: unsupported("listAll"), create: unsupported("create") };
}
const AGENT_MODEL_SELECTIONS_SUBCOLLECTION = "agentModelSelections";
const SESSION_MODEL_AUDIT_COLLECTION = "sessionModelAudit";
function createAgentModelSelectionsRepository(session) {
    const collection = (uid) => usersCollection(session.db).doc(uid).collection(AGENT_MODEL_SELECTIONS_SUBCOLLECTION);
    const key = (uid, agentId) => ({ aggregate: "agent-model-selection", key: `${uid}/${agentId}` });
    return {
        async list(uid) {
            const snapshot = await session.query("users.agentModels.list", collection(uid));
            return snapshot.docs
                .map((doc) => ({ ...decodeDocumentData(doc), revision: revisionOf(doc) }))
                .sort((a, b) => a.agentId.localeCompare(b.agentId));
        },
        async put(selection) {
            await session.set("users.agentModels.put", key(selection.uid, selection.agentId), collection(selection.uid).doc(selection.agentId), encodeDocument(selection, STORED_AS_NUMBERS));
        },
        async delete(uid, agentId) {
            await session.delete("users.agentModels.delete", key(uid, agentId), collection(uid).doc(agentId));
        },
    };
}
function createSessionModelAuditRepository(session) {
    const ref = (auditId) => session.db.collection(SESSION_MODEL_AUDIT_COLLECTION).doc(auditId);
    const key = (auditId) => ({ aggregate: "session-model-audit", key: auditId });
    return {
        async get(auditId) {
            const snapshot = await session.read("users.sessionModelAudit.get", ref(auditId));
            return snapshot.exists
                ? ({ ...decodeDocumentData(snapshot), revision: revisionOf(snapshot) })
                : null;
        },
        async create(entry) {
            await session.create("users.sessionModelAudit.create", key(entry.auditId), ref(entry.auditId), encodeDocument({
                ...entry,
                outcome: "pending",
                commandPostId: null,
                replyPostId: null,
                resultingModel: null,
                completedAt: null,
            }, STORED_AS_NUMBERS));
        },
        async complete(auditId, completion) {
            await session.update("users.sessionModelAudit.complete", key(auditId), ref(auditId), encodePatch(completion, STORED_AS_NUMBERS));
        },
    };
}
const MODEL_CREDENTIALS_COLLECTION = "modelCredentials";
const SUBSCRIPTION_LINKS_SUBCOLLECTION = "subscriptionLinks";
const SUBSCRIPTION_FLOWS_COLLECTION = "subscriptionFlows";
function createModelCredentialsRepository(session) {
    const ref = (uid) => session.db.collection(MODEL_CREDENTIALS_COLLECTION).doc(uid);
    const key = (uid) => ({ aggregate: "model-credential", key: uid });
    return {
        async get(uid) {
            const snapshot = await session.read("users.modelCredentials.get", ref(uid));
            return snapshot.exists
                ? ({ ...decodeDocumentData(snapshot), revision: revisionOf(snapshot) })
                : null;
        },
        async put(credential) {
            await session.set("users.modelCredentials.put", key(credential.uid), ref(credential.uid), encodeDocument(credential, STORED_AS_NUMBERS));
        },
        async delete(uid) {
            await session.delete("users.modelCredentials.delete", key(uid), ref(uid));
        },
    };
}
function createSubscriptionLinksRepository(session) {
    const collection = (uid) => usersCollection(session.db).doc(uid).collection(SUBSCRIPTION_LINKS_SUBCOLLECTION);
    const key = (uid, provider) => ({ aggregate: "subscription-link", key: `${uid}/${provider}` });
    return {
        async list(uid) {
            const snapshot = await session.query("users.subscriptionLinks.list", collection(uid));
            return snapshot.docs
                .map((doc) => ({ ...decodeDocumentData(doc), revision: revisionOf(doc) }))
                .sort((a, b) => a.provider.localeCompare(b.provider));
        },
        async put(link) {
            await session.set("users.subscriptionLinks.put", key(link.uid, link.provider), collection(link.uid).doc(link.provider), encodeDocument(link, STORED_AS_NUMBERS));
        },
    };
}
function createSubscriptionFlowsRepository(session) {
    const ref = (flowId) => session.db.collection(SUBSCRIPTION_FLOWS_COLLECTION).doc(flowId);
    const key = (flowId) => ({ aggregate: "subscription-flow", key: flowId });
    return {
        async get(flowId) {
            const snapshot = await session.read("users.subscriptionFlows.get", ref(flowId));
            return snapshot.exists
                ? ({ ...decodeDocumentData(snapshot), revision: revisionOf(snapshot) })
                : null;
        },
        async create(flow) {
            await session.create("users.subscriptionFlows.create", key(flow.flowId), ref(flow.flowId), encodeDocument({
                ...flow,
                consumedAt: null,
                captureClaimId: null,
                captureClaimedAt: null,
            }, STORED_AS_NUMBERS));
        },
        async update(flowId, progress) {
            await session.update("users.subscriptionFlows.update", key(flowId), ref(flowId), encodePatch(progress, STORED_AS_NUMBERS));
        },
    };
}
export const createFirestoreUserRepositories = (session) => ({
    records: createUserRecordsRepository(session),
    accounts: unsupportedUserAccounts(),
    placementReceipts: createPlacementReceiptsRepository(session),
    scheduleTransfers: createScheduleTransfersRepository(session),
    agentStores: createAgentStoresRepository(session),
    agentModels: createAgentModelSelectionsRepository(session),
    sessionModelAudit: createSessionModelAuditRepository(session),
    modelCredentials: createModelCredentialsRepository(session),
    subscriptionLinks: createSubscriptionLinksRepository(session),
    subscriptionFlows: createSubscriptionFlowsRepository(session),
});
function storedRole(config) {
    return config?.exists === true ? config.get("role") : undefined;
}
function laterOf(a, b) {
    return a !== undefined && a.valueOf() > b.valueOf() ? a : b;
}
function withRoles(query, configs) {
    return {
        onSnapshot(onNext, onError) {
            let active = true;
            let delivery = Promise.resolve();
            let deliveredAt;
            const users = new Map();
            const roles = new Map();
            configs.clear();
            const fail = (error) => {
                if (active)
                    onError(error instanceof Error ? error : new Error(String(error)));
            };
            const enqueue = (step) => {
                delivery = delivery
                    .then(async () => {
                    if (active)
                        await step();
                })
                    .catch(fail);
            };
            const deliver = (snapshot, uids) => {
                for (const uid of uids)
                    roles.get(uid).delivered = storedRole(configs.get(uid));
                deliveredAt = snapshot.readTime;
                onNext(snapshot);
            };
            const deliverRole = (uid, readTime) => {
                const user = users.get(uid);
                const role = roles.get(uid);
                if (user === undefined || role === undefined || isDeepStrictEqual(storedRole(configs.get(uid)), role.delivered))
                    return;
                deliver({ readTime: laterOf(deliveredAt, readTime), docs: [...users.values()], docChanges: () => [{ type: "modified", doc: user }] }, [uid]);
            };
            const follow = (uid, userRef) => {
                let markReady;
                let first = true;
                const ready = new Promise((resolve) => {
                    markReady = resolve;
                });
                const role = {
                    ready,
                    delivered: undefined,
                    release: () => {
                        unsubscribe();
                        markReady();
                    },
                };
                const unsubscribe = systemConfigRef(userRef).onSnapshot((config) => {
                    if (!active || roles.get(uid) !== role)
                        return;
                    configs.set(uid, config);
                    if (!first) {
                        enqueue(() => deliverRole(uid, config.readTime));
                        return;
                    }
                    first = false;
                    markReady();
                }, fail);
                roles.set(uid, role);
                return role;
            };
            const unfollow = (uid) => {
                roles.get(uid)?.release();
                roles.delete(uid);
                configs.delete(uid);
                users.delete(uid);
            };
            const unsubscribeUsers = query.onSnapshot((snapshot) => {
                enqueue(async () => {
                    const present = [];
                    const entering = [];
                    for (const change of snapshot.docChanges()) {
                        const uid = change.doc.id;
                        if (change.type === "removed") {
                            unfollow(uid);
                            continue;
                        }
                        users.set(uid, change.doc);
                        present.push(uid);
                        if (!roles.has(uid))
                            entering.push(follow(uid, change.doc.ref).ready);
                    }
                    await Promise.all(entering);
                    if (active)
                        deliver(snapshot, present);
                });
            }, fail);
            return () => {
                active = false;
                unsubscribeUsers();
                for (const role of roles.values())
                    role.release();
                roles.clear();
            };
        },
    };
}
export const firestoreUsersWatchSource = (db, filter) => {
    let query = usersCollection(db);
    if (filter.uid !== undefined)
        query = query.where(FieldPath.documentId(), "==", filter.uid);
    if (filter.gatewayId !== undefined)
        query = query.where(USER_MIRROR_PATHS.gatewayId, "==", filter.gatewayId);
    const configs = new Map();
    const target = {
        query: withRoles(query, configs),
        key: (snapshot) => snapshot.id,
        decode: (snapshot) => decodeUser(snapshot, configs.get(snapshot.id)),
    };
    return { operation: "watch users", targets: [target] };
};
