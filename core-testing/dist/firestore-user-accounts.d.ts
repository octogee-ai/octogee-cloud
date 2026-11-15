import type { Firestore } from "firebase-admin/firestore";
import { type UserAccountReader } from "@octogee/core/user-account";
export declare function firestoreUserAccountReader(db: Pick<Firestore, "collection" | "getAll">): UserAccountReader;
