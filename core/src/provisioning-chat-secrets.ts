import type {
  ChatOutputs,
  ProvisioningCredential,
  ProvisioningCredentialName,
  UserProvisioning,
} from "@octogee/shared/types/provisioning-service";
import type { MattermostTokenSecret, UserSecretInput } from "./platform-state/secrets.js";
import { MissingRecordError } from "./platform-state/errors.js";
import type { PlatformStateStore } from "./platform-state/store.js";
import { ProvisioningServiceError, type ProvisioningServiceClient } from "./provisioning-service-client.js";

export const USER_CHAT_SECRET_ID = "mattermost";
export const AGENT_CHAT_SECRET_ID = "coachMattermost";

export interface ChatSecretDeps {
  readonly store: Pick<PlatformStateStore, "secrets" | "transaction">;
  readonly client: Pick<ProvisioningServiceClient, "getCredential">;
}

export type ChatSecretsOutcome = "present" | "credentials-not-issued" | "agent-not-ready";

interface ChatSecretTarget {
  readonly secretId: string;
  readonly kind: MattermostTokenSecret["kind"];
  readonly credential: ProvisioningCredentialName;
  readonly mattermostUserId: string;
}

export class ProvisioningChatSecretError extends Error {
  constructor(readonly uid: string, message: string) {
    super(message);
    this.name = "ProvisioningChatSecretError";
  }
}

export function chatSecretRow(target: ChatSecretTarget, token: string): UserSecretInput {
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

function targetsOf(chat: ChatOutputs): ChatSecretTarget[] {
  const user: ChatSecretTarget = {
    secretId: USER_CHAT_SECRET_ID,
    kind: "builder-mattermost",
    credential: "user-chat-token",
    mattermostUserId: chat.userId,
  };
  if (!chat.agentBotUserId) return [user];
  return [user, {
    secretId: AGENT_CHAT_SECRET_ID,
    kind: "coach-mattermost",
    credential: "agent-chat-token",
    mattermostUserId: chat.agentBotUserId,
  }];
}

function credentialsIssued(resource: UserProvisioning): boolean {
  return resource.status.conditions.some((condition) => condition.type === "CredentialsIssued" && condition.status === "True");
}

function redacted(error: unknown, token: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(token, "[redacted]");
}

async function readCredential(deps: ChatSecretDeps, uid: string, name: ProvisioningCredentialName): Promise<ProvisioningCredential | null> {
  try {
    return await deps.client.getCredential(uid, name);
  } catch (error) {
    if (error instanceof ProvisioningServiceError && error.status === 403) {
      throw new ProvisioningChatSecretError(uid, `the provisioning service refused to read ${name} for ${uid} (403 ${error.code}): the fleet controller needs the credential-reader role`);
    }
    throw error;
  }
}

async function writeWhenAbsent(deps: ChatSecretDeps, uid: string, row: UserSecretInput, token: string): Promise<void> {
  try {
    await deps.store.transaction({ label: "provisioning-mirror-chat-secret" }, async (transaction) => {
      if ((await transaction.users.records.get(uid)) === null) throw new MissingRecordError({ aggregate: "builder", key: uid });
      if ((await transaction.secrets.get(uid, row.secretId)) !== null) return;
      await transaction.secrets.put(uid, row);
    });
  } catch (error) {
    if (error instanceof MissingRecordError) throw error;
    throw new ProvisioningChatSecretError(uid, `could not write the ${row.secretId} platform secret of ${uid}: ${redacted(error, token)}`);
  }
}

export async function ensureChatSecrets(deps: ChatSecretDeps, resource: UserProvisioning, chat: ChatOutputs): Promise<ChatSecretsOutcome> {
  const uid = resource.uid;
  if (!credentialsIssued(resource)) return "credentials-not-issued";
  if (resource.spec.chat.defaultAgent.enabled && !chat.agentBotUserId) return "agent-not-ready";
  const missing: ChatSecretTarget[] = [];
  for (const target of targetsOf(chat)) {
    if ((await deps.store.secrets.get(uid, target.secretId)) === null) missing.push(target);
  }
  if (missing.length === 0) return "present";
  for (const target of missing) {
    const credential = await readCredential(deps, uid, target.credential);
    if (credential === null) return "credentials-not-issued";
    await writeWhenAbsent(deps, uid, chatSecretRow(target, credential.value), credential.value);
  }
  return "present";
}
