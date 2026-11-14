import type { Firestore } from "firebase-admin/firestore";
import { type UserAccountReader } from "../user-account.js";
export declare function firestoreUserAccountReader(db: Pick<Firestore, "collection" | "getAll">): UserAccountReader;
