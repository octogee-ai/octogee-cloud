import { log } from "../config.js";
import { platformStateStore } from "../provisioner-platform-state.js";
import { mmApiCall, getMmAdminToken } from "./client.js";
export async function ensureAdminCredentials() {
    const MM_URL = process.env.MM_URL;
    if (!MM_URL) {
        log("[admin-creds] skipping — MM_URL not set");
        return;
    }
    const token = await getMmAdminToken();
    if (!token) {
        log("[admin-creds] skipping — no admin token");
        return;
    }
    let adminUserId = process.env.MM_ADMIN_USER_ID;
    if (!adminUserId) {
        const adminUser = process.env.MM_ADMIN_USER;
        if (adminUser) {
            const user = await mmApiCall("GET", `/users/username/${adminUser}`);
            if (user?.id) {
                adminUserId = user.id;
                log(`[admin-creds] looked up admin user ID: ${adminUserId}`);
            }
        }
    }
    if (!adminUserId) {
        log("[admin-creds] skipping — could not determine admin user ID (set MM_ADMIN_USER_ID or MM_ADMIN_USER)");
        return;
    }
    const proxyUrl = process.env.API_PUBLIC_URL || "";
    await platformStateStore.config.mattermostAdmin.put({
        userId: adminUserId,
        proxyUrl: proxyUrl || null,
        updatedAt: { serverNow: true },
    });
    log(`[admin-creds] stored admin credentials for user ${adminUserId}`);
}
