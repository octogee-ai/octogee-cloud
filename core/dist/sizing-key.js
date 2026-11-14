import { userEntitlements } from "@octogee/shared/types/user-entitlements";
export function firestoreSizingKeyReader(db) {
    return async (uid, now) => {
        const snapshot = await db.doc(`users/${uid}`).get();
        return snapshot.exists ? userEntitlements().sizingKey(snapshot.data() ?? {}, new Date(now)) : null;
    };
}
const SIZING_KEY_READ_ATTEMPTS = 3;
export class SizingKeyChangedError extends Error {
    uid;
    constructor(uid) {
        super(`User ${uid} changed while its sizing key was read`);
        this.uid = uid;
        this.name = "SizingKeyChangedError";
    }
}
export async function withCurrentSizingKey(input, run) {
    for (let attempt = 1;; attempt += 1) {
        const revision = (await input.store.users.records.get(input.uid))?.revision ?? null;
        const sizingKey = await input.readSizingKey(input.uid, input.now);
        const profile = sizingKey === null ? null : await input.store.config.orchestrator.getSizingProfile(sizingKey);
        const assertCurrent = (user) => {
            if ((user?.revision ?? null) !== revision)
                throw new SizingKeyChangedError(input.uid);
        };
        try {
            return await run({ sizingKey, profile, assertCurrent });
        }
        catch (error) {
            if (!(error instanceof SizingKeyChangedError) || attempt === SIZING_KEY_READ_ATTEMPTS)
                throw error;
        }
    }
}
