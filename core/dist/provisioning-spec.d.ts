import type { UserProvisioningSpec } from "@octogee/shared/types/provisioning-service";
export declare function defaultAgentId(slug: string): string;
export declare function desiredUserProvisioningSpec(uid: string, userData: Record<string, unknown>): UserProvisioningSpec;
export declare function sameProvisioningSpec(a: UserProvisioningSpec, b: UserProvisioningSpec): boolean;
