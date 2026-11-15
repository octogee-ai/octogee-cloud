import { onTestFinished } from "vitest";
import {
  installUserEntitlements,
  staticUserEntitlements,
  userEntitlements,
  type UserEntitlementInputs,
  type UserEntitlementResolver,
} from "@octogee/shared/types/user-entitlements";

export const houseOnlyUserEntitlements: UserEntitlementResolver = {
  ...staticUserEntitlements,
  policy: (user, now) => ({
    ...staticUserEntitlements.policy(user, now),
    modelAccess: "house_only",
    toolAccess: false,
  }),
};

const HOUSE_PLAN = "house";
const PLAN_INPUT_KEYS = new Set(["plan", "planEndsAt"]);

function resolvedPlan(user: UserEntitlementInputs, now = new Date()): string {
  const { plan, planEndsAt } = user as { plan?: string; planEndsAt?: number };
  if (plan === undefined) return HOUSE_PLAN;
  if (planEndsAt !== undefined && now.getTime() >= planEndsAt) return HOUSE_PLAN;
  return plan;
}

const noProductFields = () => ({});

export const planUserEntitlements: UserEntitlementResolver = {
  ...staticUserEntitlements,
  policy: (user, now) => resolvedPlan(user, now) === HOUSE_PLAN
    ? houseOnlyUserEntitlements.policy(user, now)
    : staticUserEntitlements.policy(user, now),
  pickInputs: (source) => Object.fromEntries(Object.entries(source).filter(([key]) => PLAN_INPUT_KEYS.has(key))),
  contextFilePolicy: (user, now) => ({ templateKey: resolvedPlan(user, now), removedFiles: [] }),
  seedContextTemplateKey: (user) => resolvedPlan(user),
  productProjection: {
    agentUsageStatus: noProductFields,
    agentSupportUser: noProductFields,
    agentModels: noProductFields,
    adminUserSummary: noProductFields,
    adminUserDetail: noProductFields,
    adminUserStats: noProductFields,
    adminUserArchive: noProductFields,
    provisionedUser: (user) => ({ plan: resolvedPlan(user) }),
  },
};

export function installUserEntitlementsForTest(resolver: UserEntitlementResolver): void {
  const installed = userEntitlements();
  installUserEntitlements(resolver);
  onTestFinished(() => installUserEntitlements(installed));
}
