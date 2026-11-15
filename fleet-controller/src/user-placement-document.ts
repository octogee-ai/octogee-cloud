import type { PlatformUserRecord } from "@octogee/core/platform-state";

export type UserPolicyInputs = Readonly<Record<string, unknown>>;

export interface UserPolicyInputsSource {
  current(): ReadonlyMap<string, UserPolicyInputs> | null;
  list(): Promise<ReadonlyMap<string, UserPolicyInputs>>;
  stop(): void;
}

export const noUserPolicyInputs: UserPolicyInputsSource = {
  current: () => new Map(),
  list: async () => new Map(),
  stop: () => {},
};

function defined(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== null));
}

export function userPlacementDocument(
  user: PlatformUserRecord,
  policyInputs: UserPolicyInputs,
): Record<string, unknown> {
  return {
    ...policyInputs,
    ...defined({
      admitted: user.admitted,
      accountLifecycle: user.accountLifecycle,
      username: user.slug,
      workspaceId: user.workspaceId,
    }),
    provisioning: defined({
      status: user.provisioning.status,
      startedAt: user.provisioning.startedAt,
      openclaw: defined({
        slug: user.slug,
        status: user.openclaw.status,
        managedBy: user.openclaw.managedBy,
        gatewayId: user.gateway?.gatewayId,
        activationLease: user.activationLease,
        runtimeReset: user.fences.runtimeReset,
      }),
    }),
  };
}
