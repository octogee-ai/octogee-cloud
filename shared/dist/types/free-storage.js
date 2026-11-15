import { userEntitlements } from "./user-entitlements.js";
export function freeWorkspaceStorageLimitBytes(userData, projectStorage, config) {
    if (projectStorage ||
        userEntitlements().projectMode(userData) === "active") {
        return undefined;
    }
    return config.workspaceStorageGb * 1024 ** 3;
}
