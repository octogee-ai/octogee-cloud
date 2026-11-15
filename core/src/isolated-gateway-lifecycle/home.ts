import type { PlatformUserRecord } from "../platform-state/users.js";

export interface CopyHomeDisk {
  projectId: string; zone: string; name: string; id: string; sizeGb: number;
  source: string; diskType: "pd-balanced" | "pd-ssd";
}

export interface HomeCopyInput {
  operationId: string;
  ownerUid: string;
  source: CopyHomeDisk;
  sourceLayout: "flat" | "portable";
  targetZone: string;
  desiredGiB: number;
  subnetwork: string;
}

export type HomeCopyProgress = { status: "pending" } | { status: "copying"; usedBytes: number } |
  { status: "ready"; usedBytes: number; filesystem: "btrfs"; proof: Record<string, string> };

export class HomeCopyFailure extends Error {}

export function homeCopyCapacity(input: { desiredGiB: number; sourceGiB: number; usedBytes: number }): number {
  if (![10, 50, 100].includes(input.desiredGiB) || !Number.isSafeInteger(input.sourceGiB) || input.sourceGiB < 10 || !Number.isSafeInteger(input.usedBytes) || input.usedBytes < 0) throw new Error("invalid home copy capacity");
  const needed = Math.ceil((input.usedBytes * 1.1 + 2 * 1024 ** 3) / 1024 ** 3);
  const allocation = needed <= input.desiredGiB ? input.desiredGiB : Math.max(input.sourceGiB, input.desiredGiB);
  if (needed > allocation) throw new Error("home copy needs more space than the retained allocation; source retained");
  return allocation;
}

export interface UserHomeLocation {
  runtime: "gce-vm";
  disk: CopyHomeDisk;
  layout: "flat" | "portable";
  computer?: { name: string; id: string; zone: string };
}

export interface HomePreparedFor {
  leaseId: string;
  generation: number;
  sizingKey: string;
}

export type UserHomeMigrationPhase = "copying" | "retaining" | "releasing" | "adopting" | "complete" | "failed" | "retrying" | "blocked";

export interface UserHomeMigration {
  id: string;
  tier: string;
  source: UserHomeLocation;
  copy: HomeCopyInput;
  phase: UserHomeMigrationPhase;
  attempt?: number;
  retryAt?: number;
  error?: string;
  target?: CopyHomeDisk;
  proof?: Extract<HomeCopyProgress, { status: "ready" }>;
  startedAt: number;
  completedAt?: number;
  preparedFor?: HomePreparedFor;
}

export interface PreparedWithoutMigration {
  phase: "complete";
  preparedFor: HomePreparedFor;
}

export interface UserHomeStorage extends UserHomeLocation {
  retained: UserHomeLocation[];
  admittedAt?: number;
}

export interface UserHomeOwner {
  computer?: { instanceName: string; instanceId: string; zone: string };
  homeStorage?: UserHomeStorage;
  homeMigration?: UserHomeMigration | PreparedWithoutMigration;
  homeDisk?: CopyHomeDisk;
}

export function userHomeOwner(user: PlatformUserRecord): UserHomeOwner {
  return user.home as UserHomeOwner;
}

export function isActiveHomeMigration(state: UserHomeOwner["homeMigration"]): state is UserHomeMigration {
  return state !== undefined && "id" in state;
}
