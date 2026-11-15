import { userEntitlements, type UserEntitlementInputs } from "./user-entitlements.js";
import type { PlatformFreeConfig } from "./platform-config.js";

export function freeWorkspaceStorageLimitBytes(
  userData: UserEntitlementInputs,
  projectStorage: boolean,
  config: PlatformFreeConfig,
): number | undefined {
  if (
    projectStorage ||
    userEntitlements().projectMode(userData) === "active"
  ) {
    return undefined;
  }
  return config.workspaceStorageGb * 1024 ** 3;
}
