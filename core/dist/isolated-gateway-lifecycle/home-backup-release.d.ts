import type { PlatformStateTransaction } from "../platform-state/store.js";
import type { PlatformUserRecord, UserActivationLease } from "../platform-state/users.js";
export declare const RELEASE_RESTORED_HOME_BACKUP = "release-home-backup";
export declare function restoredHomeBackupReleaseId(archiveOperationId: string): string;
export declare function enqueueRestoredHomeBackupRelease(tx: PlatformStateTransaction, user: PlatformUserRecord, lease: UserActivationLease, now: number): Promise<void>;
