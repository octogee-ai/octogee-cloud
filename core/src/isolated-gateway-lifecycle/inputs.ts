import type { SizingTier } from "@octogee/shared/types/sizing";
import { runNormalFleetMutation, type NormalFleetMutationInput } from "../normal-fleet-mutation.js";
import type { SizingKeyReader } from "../sizing-key.js";
import type { PlacementOwnerFence } from "../placement-automation-owner.js";
import type { PlatformStateStore } from "../platform-state/store.js";

export const ISOLATED_GATEWAY_LIFECYCLE_ACTOR = "glm-controller-disposable-gateway";
export const PLACEMENT_AUTOMATION_ACTOR = "glm-controller-placement-policy";
export const ISOLATED_GATEWAY_ALLOCATION_KIND = "disposable-builder";
export const ROLLED_BACK_STATUS = "rolled-back";

export class IsolatedGatewayFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolatedGatewayFenceError";
  }
}

export type { PlacementOwnerFence } from "../placement-automation-owner.js";

export type LifecycleMutation<T> = Omit<NormalFleetMutationInput<T>, "action"> & { action: () => Promise<T> };
export type LifecycleMutationRunner = <T>(mutation: LifecycleMutation<T>) => Promise<T>;

export function auditedLifecycleMutations(store: PlatformStateStore): LifecycleMutationRunner {
  return (mutation) => runNormalFleetMutation(store, { ...mutation, action: () => mutation.action() });
}

export const unauditedLifecycleMutations: LifecycleMutationRunner = (mutation) => mutation.action();

export type LifecycleMode = "apply" | "plan";

export interface IsolatedLifecycleDeps {
  store: PlatformStateStore;
  readSizingKey: SizingKeyReader;
  requireOwner: PlacementOwnerFence;
  mutations: LifecycleMutationRunner;
  now(): number;
  log(message: string): void;
}

export async function checkPlacementOwner(input: Pick<IsolatedLifecycleDeps, "store" | "requireOwner">): Promise<void> {
  await input.store.transaction({ label: "isolated-gateway.owner-check", readOnly: true }, input.requireOwner);
}

export interface AllocateIsolatedGatewayInput {
  uid: string;
  builderSlug: string;
  leaseId: string;
  generation: number;
  sourceGatewayId: string;
  sourceAssignmentEpoch: number;
  sizingKey: string;
  sizingTier: SizingTier;
  parkedGateway?: { gatewayId: string; generation: number };
}

export interface SizingKeyTransitionInput {
  uid: string;
  leaseId: string;
  generation: number;
  targetGatewayId: string;
  sizingKey: string;
}

export interface AdvanceActivationLeaseInput {
  uid: string;
  leaseId: string;
  generation: number;
  fromStatus: "provisioning" | "activating" | "active";
  toStatus: "activating" | "active" | "returning";
  operationId?: string;
}

export interface CompleteActivationLeaseInput {
  uid: string;
  leaseId: string;
  generation: number;
  targetGatewayId: string;
  parked?: true;
}

export interface FailActivationLeaseInput {
  uid: string;
  leaseId: string;
  generation: number;
  targetGatewayId: string;
  operationId: string;
  message: string;
}

export interface RecoverUnreachableIsolatedGatewayInput {
  uid: string;
  builderSlug: string;
  gatewayId: string;
  leaseId: string;
  generation: number;
  authoritativeGatewayId: string;
  sourceUnavailable?: boolean;
}

export type AuthoritativeLeaseStatus = "provisioning" | "activating" | "returning";

export const PLACEMENT_RETIREMENT_REASONS = [
  "provisioning-timeout",
  "provisioning-target-paused",
  "builder-authorization-ended",
  "activation-failed",
  "builder-returned",
  "operator-terminated",
  "parked-computer-replaced",
  "owned-gateway-not-kept",
] as const;

export type PlacementRetirementReason = typeof PLACEMENT_RETIREMENT_REASONS[number];

export interface RetireOwnedIsolatedGatewayInput {
  uid: string;
  builderSlug: string;
  gatewayId: string;
  reason: PlacementRetirementReason;
  leaseId?: string;
  generation: number;
  telemetryFenceOperationId?: string;
  telemetryFenceStatus?: "succeeded" | "terminal-failure";
  authoritativeGatewayId?: string;
  authoritativeLeaseStatus?: AuthoritativeLeaseStatus;
  zeroWorkloadRecoveryOperationId?: string;
}

export function fieldMap(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { toMillis?: unknown }).toMillis === "function"
  ) {
    const result = (value as { toMillis: () => unknown }).toMillis();
    return typeof result === "number" && Number.isFinite(result) ? result : null;
  }
  return null;
}
