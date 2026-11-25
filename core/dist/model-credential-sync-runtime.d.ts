import { PLATFORM_MODEL_POLICY_ALLOW_PATH, applyDefaultAgentModelPatch, userMountConfigPatch, userSecurityProjectionReplacePaths, platformModelAllowlistPatch, brokerFetchByosubCreds, restoreOauthStoreForSlug, triggerSecretsReload, type SyncByotForUserDeps } from "./byot-sync-runtime.js";
import { applyModelCredentialState, type ModelCredentialSyncUserData } from "./model-credential-sync.js";
export type SyncModelCredentialsForUserDeps = SyncByotForUserDeps & {
    applyModelCredentialState?: typeof applyModelCredentialState;
};
export declare function syncModelCredentialsForUser(userData: ModelCredentialSyncUserData, deps?: SyncModelCredentialsForUserDeps): Promise<void>;
export { PLATFORM_MODEL_POLICY_ALLOW_PATH, userMountConfigPatch, userSecurityProjectionReplacePaths, platformModelAllowlistPatch, applyDefaultAgentModelPatch as applyModelCredentialDefaultAgentPatch, brokerFetchByosubCreds as brokerFetchModelCredentialOauthCreds, restoreOauthStoreForSlug as restoreModelCredentialOauthStoreForSlug, triggerSecretsReload as triggerModelCredentialSecretsReload, };
