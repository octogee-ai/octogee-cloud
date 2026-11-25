import { PLATFORM_MODEL_POLICY_ALLOW_PATH, applyDefaultAgentModelPatch, userMountConfigPatch, userSecurityProjectionReplacePaths, platformModelAllowlistPatch, brokerFetchByosubCreds, restoreOauthStoreForSlug, syncByotForUser, triggerSecretsReload, } from "./byot-sync-runtime.js";
import { legacyByotSyncUserDataFromModelCredentialState, } from "./model-credential-sync.js";
function legacyDepsFromModelCredentialDeps(deps) {
    if (!deps)
        return undefined;
    const { applyModelCredentialState: modelCredentialApply, ...legacyDeps } = deps;
    return {
        ...legacyDeps,
        ...(modelCredentialApply ? { applyByotState: modelCredentialApply } : {}),
    };
}
export async function syncModelCredentialsForUser(userData, deps) {
    await syncByotForUser(legacyByotSyncUserDataFromModelCredentialState(userData), legacyDepsFromModelCredentialDeps(deps));
}
export { PLATFORM_MODEL_POLICY_ALLOW_PATH, userMountConfigPatch, userSecurityProjectionReplacePaths, platformModelAllowlistPatch, applyDefaultAgentModelPatch as applyModelCredentialDefaultAgentPatch, brokerFetchByosubCreds as brokerFetchModelCredentialOauthCreds, restoreOauthStoreForSlug as restoreModelCredentialOauthStoreForSlug, triggerSecretsReload as triggerModelCredentialSecretsReload, };
