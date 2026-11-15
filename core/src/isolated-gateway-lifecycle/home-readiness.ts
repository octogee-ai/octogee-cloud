import type { GatewaySizingProfile } from "@octogee/shared/types/sizing-profile";
import type { PlatformUserRecord } from "../platform-state/users.js";
import { IsolatedGatewayFenceError, type AllocateIsolatedGatewayInput } from "./inputs.js";

export interface HomeReadinessInput {
  user: PlatformUserRecord;
  request: AllocateIsolatedGatewayInput;
  sizingProfile: GatewaySizingProfile | null;
}

export type HomeReadinessFence = (input: HomeReadinessInput) => void;

export interface HomePreparedFor {
  leaseId: string;
  generation: number;
  sizingKey: string;
}

export function sizingProfileNeedsVmHome(profile: GatewaySizingProfile | null): boolean {
  return profile?.isolation === "isolated" && profile.computer.runtime === "gce-vm";
}

function storedPreparation(user: PlatformUserRecord): Partial<HomePreparedFor> | null {
  const migration = user.home.homeMigration;
  if (migration?.phase !== "complete") return null;
  const preparedFor = migration.preparedFor;
  return preparedFor !== null && typeof preparedFor === "object" ? preparedFor as Partial<HomePreparedFor> : null;
}

export function homePreparedForAllocation(input: HomeReadinessInput): boolean {
  if (!sizingProfileNeedsVmHome(input.sizingProfile)) return true;
  const prepared = storedPreparation(input.user);
  return prepared?.leaseId === input.request.leaseId &&
    prepared.generation === input.request.generation &&
    prepared.sizingKey === input.request.sizingKey;
}

export const requireStoredHomeReadiness: HomeReadinessFence = (input) => {
  if (homePreparedForAllocation(input)) return;
  const { uid, leaseId, generation, sizingKey } = input.request;
  throw new IsolatedGatewayFenceError(
    `home for ${uid} is not prepared for lease ${leaseId} generation ${generation} sizing key ${sizingKey}`,
  );
};

export const homePreparedBeforeAllocation: HomeReadinessFence = () => undefined;
