import type { DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";

export interface UserAccount {
  readonly uid: string;
  readonly username: string | null;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly lastActive: number | null;
  readonly planInputs: Readonly<Record<string, unknown>>;
  readonly usage: Readonly<Record<string, unknown>>;
  readonly mattermostUsername: string | null;
}

export interface UserAccountReader {
  get(uid: string): Promise<UserAccount | null>;
  getMany(uids: readonly string[]): Promise<ReadonlyMap<string, UserAccount>>;
  list(): Promise<ReadonlyMap<string, UserAccount>>;
}

type Data = Record<string, unknown>;

function map(value: unknown): Data {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function millis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  const timestamp = value as { toMillis?: () => number } | null | undefined;
  return typeof timestamp?.toMillis === "function" ? timestamp.toMillis() : null;
}

export function userAccountFromData(uid: string, data: Data): UserAccount {
  const mattermostUsername = map(data.mattermost).username;
  return {
    uid,
    username: nonEmptyString(data.username),
    email: nonEmptyString(data.email),
    displayName: nonEmptyString(data.displayName),
    lastActive: millis(data.lastActive),
    planInputs: userEntitlements().pickInputs(data),
    usage: map(data.usage),
    mattermostUsername: typeof mattermostUsername === "string" ? mattermostUsername : null,
  };
}

function accountOf(snapshot: DocumentSnapshot): UserAccount | null {
  return snapshot.exists ? userAccountFromData(snapshot.id, snapshot.data() ?? {}) : null;
}

export function firestoreUserAccountReader(db: Pick<Firestore, "collection" | "getAll">): UserAccountReader {
  const users = () => db.collection("users");
  return {
    get: async (uid) => accountOf(await users().doc(uid).get()),
    getMany: async (uids) => {
      const unique = [...new Set(uids)];
      if (unique.length === 0) return new Map();
      const snapshots = await db.getAll(...unique.map((uid) => users().doc(uid)));
      return new Map(snapshots.flatMap((snapshot) => {
        const account = accountOf(snapshot);
        return account === null ? [] : [[snapshot.id, account] as const];
      }));
    },
    list: async () => {
      const snapshot = await users().get();
      return new Map(snapshot.docs.map((doc) => [doc.id, userAccountFromData(doc.id, doc.data())]));
    },
  };
}

export const noUserAccounts: UserAccountReader = {
  get: async () => null,
  getMany: async () => new Map(),
  list: async () => new Map(),
};
