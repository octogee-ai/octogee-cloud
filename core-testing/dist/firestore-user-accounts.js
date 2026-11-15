import { userAccountFromData } from "@octogee/core/user-account";
function accountOf(snapshot) {
    return snapshot.exists ? userAccountFromData(snapshot.id, snapshot.data() ?? {}) : null;
}
export function firestoreUserAccountReader(db) {
    const users = () => db.collection("users");
    return {
        get: async (uid) => accountOf(await users().doc(uid).get()),
        getMany: async (uids) => {
            const unique = [...new Set(uids)];
            if (unique.length === 0)
                return new Map();
            const snapshots = await db.getAll(...unique.map((uid) => users().doc(uid)));
            return new Map(snapshots.flatMap((snapshot) => {
                const account = accountOf(snapshot);
                return account === null ? [] : [[snapshot.id, account]];
            }));
        },
        list: async () => {
            const snapshot = await users().get();
            return new Map(snapshot.docs.map((doc) => [doc.id, userAccountFromData(doc.id, doc.data())]));
        },
    };
}
