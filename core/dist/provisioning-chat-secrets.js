import { MissingRecordError } from "./platform-state/errors.js";
import { ProvisioningServiceError } from "./provisioning-service-client.js";
export const USER_CHAT_SECRET_ID = "mattermost";
export const AGENT_CHAT_SECRET_ID = "coachMattermost";
export class ProvisioningChatSecretError extends Error {
    uid;
    constructor(uid, message) {
        super(message);
        this.uid = uid;
        this.name = "ProvisioningChatSecretError";
    }
}
export function chatSecretRow(target, token) {
    return {
        kind: target.kind,
        secretId: target.secretId,
        projectId: null,
        personalToken: token,
        mattermostUserId: target.mattermostUserId,
        createdAt: { serverNow: true },
        rotatedAt: null,
    };
}
function targetsOf(chat) {
    const user = {
        secretId: USER_CHAT_SECRET_ID,
        kind: "builder-mattermost",
        credential: "user-chat-token",
        mattermostUserId: chat.userId,
    };
    if (!chat.agentBotUserId)
        return [user];
    return [user, {
            secretId: AGENT_CHAT_SECRET_ID,
            kind: "coach-mattermost",
            credential: "agent-chat-token",
            mattermostUserId: chat.agentBotUserId,
        }];
}
function credentialsIssued(resource) {
    return resource.status.conditions.some((condition) => condition.type === "CredentialsIssued" && condition.status === "True");
}
function redacted(error, token) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replaceAll(token, "[redacted]");
}
async function readCredential(deps, uid, name) {
    try {
        return await deps.client.getCredential(uid, name);
    }
    catch (error) {
        if (error instanceof ProvisioningServiceError && error.status === 403) {
            throw new ProvisioningChatSecretError(uid, `the provisioning service refused to read ${name} for ${uid} (403 ${error.code}): the fleet controller needs the credential-reader role`);
        }
        throw error;
    }
}
async function writeWhenAbsent(deps, uid, row, token) {
    try {
        await deps.store.transaction({ label: "provisioning-mirror-chat-secret" }, async (transaction) => {
            if ((await transaction.users.records.get(uid)) === null)
                throw new MissingRecordError({ aggregate: "builder", key: uid });
            if ((await transaction.secrets.get(uid, row.secretId)) !== null)
                return;
            await transaction.secrets.put(uid, row);
        });
    }
    catch (error) {
        if (error instanceof MissingRecordError)
            throw error;
        throw new ProvisioningChatSecretError(uid, `could not write the ${row.secretId} platform secret of ${uid}: ${redacted(error, token)}`);
    }
}
export async function ensureChatSecrets(deps, resource, chat) {
    const uid = resource.uid;
    const missing = [];
    for (const target of targetsOf(chat)) {
        if ((await deps.store.secrets.get(uid, target.secretId)) === null)
            missing.push(target);
    }
    if (missing.length === 0)
        return "present";
    if (!credentialsIssued(resource))
        return "credentials-not-issued";
    for (const target of missing) {
        const credential = await readCredential(deps, uid, target.credential);
        if (credential === null)
            return "credentials-not-issued";
        await writeWhenAbsent(deps, uid, chatSecretRow(target, credential.value), credential.value);
    }
    return "present";
}
