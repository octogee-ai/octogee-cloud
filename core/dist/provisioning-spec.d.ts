import type { UserProvisioningSpec } from "@octogee/shared/types/provisioning-service";
export declare function defaultAgentId(slug: string): string;
export declare function desiredUserProvisioningSpec(uid: string, userData: Record<string, unknown>, existingBotUserId?: string): UserProvisioningSpec;
export declare function sameProvisioningSpec(a: UserProvisioningSpec, b: UserProvisioningSpec): boolean;
