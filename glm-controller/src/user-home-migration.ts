import type { SizingKeyReader } from "@octogee/core/sizing-key";
import type { PlatformUserRecord, PlatformStateStore } from "@octogee/core/platform-state";
import type { CopyHomeDisk, HomeCopyInput, HomeCopyProgress } from "./lib/compute-home-copy.js";

export interface UserHomeLocation {
  runtime: "gce-vm";
  disk: CopyHomeDisk;
  layout: "flat" | "portable";
  computer?: { name: string; id: string; zone: string };
}
export interface UserHomeMigration {
  id: string;
  tier: string;
  source: UserHomeLocation;
  copy: HomeCopyInput;
  phase: "copying" | "retaining" | "releasing" | "adopting" | "complete" | "failed" | "retrying" | "blocked";
  attempt?: number;
  retryAt?: number;
  error?: string;
  target?: CopyHomeDisk;
  proof?: Extract<HomeCopyProgress, { status: "ready" }>;
  startedAt: number;
  completedAt?: number;
}
export interface UserHomeStorage extends UserHomeLocation {
  retained: UserHomeLocation[];
  admittedAt?: number;
}
export interface UserHomeOwner {
  computer?: { instanceName: string; instanceId: string; zone: string };
  homeStorage?: UserHomeStorage;
  homeMigration?: UserHomeMigration;
  homeDisk?: CopyHomeDisk;
}
export function userHomeOwner(user: PlatformUserRecord): UserHomeOwner {
  return user.home as UserHomeOwner;
}
export interface UserHomeMigrationDeps {
  store: PlatformStateStore;
  readSizingKey: SizingKeyReader;
  environment: "test" | "prod";
  now: () => number;
  subnetwork: string;
  nativeZones: readonly string[];
  nativeZone: (uid: string) => Promise<string | null>;
  inventory: (uid: string, owner: UserHomeOwner) => Promise<UserHomeLocation | null>;
  verifyStopped: (uid: string, source: UserHomeLocation) => Promise<void>;
  copy: {
    advance(input: HomeCopyInput): Promise<{ progress: HomeCopyProgress; target?: CopyHomeDisk }>;
    release(input: HomeCopyInput): Promise<boolean>;
    abort(input: HomeCopyInput): Promise<boolean>;
  };
  adopt: (input: { uid: string; target: CopyHomeDisk }) => Promise<boolean>;
  removeStoppedHome: (uid: string, source: UserHomeLocation) => Promise<boolean>;
  log: (message: string) => void;
}
