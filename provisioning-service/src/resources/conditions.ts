import type {
  ConditionStatus,
  ProvisioningCondition,
  ProvisioningConditionReason,
} from "@octogee/shared/types/provisioning-service";

export interface ConditionUpdate<Type extends string> {
  type: Type;
  status: ConditionStatus;
  reason: ProvisioningConditionReason;
  message?: string;
}

export function pendingConditions<Type extends string>(types: readonly Type[], now: Date): ProvisioningCondition<Type>[] {
  return types.map((type) => ({
    type,
    status: "Unknown",
    reason: "Pending",
    message: "",
    lastTransitionTime: now.toISOString(),
    observedGeneration: 0,
  }));
}

export function applyConditions<Type extends string>(
  current: readonly ProvisioningCondition<Type>[],
  updates: readonly ConditionUpdate<Type>[],
  generation: number,
  now: Date,
): ProvisioningCondition<Type>[] {
  const next = [...current];
  for (const update of updates) {
    const index = next.findIndex((condition) => condition.type === update.type);
    const previous = index >= 0 ? next[index] : undefined;
    const condition: ProvisioningCondition<Type> = {
      type: update.type,
      status: update.status,
      reason: update.reason,
      message: update.message ?? "",
      lastTransitionTime: previous && previous.status === update.status ? previous.lastTransitionTime : now.toISOString(),
      observedGeneration: generation,
    };
    if (index >= 0) next[index] = condition;
    else next.push(condition);
  }
  return next;
}
