import {
  PLATFORM_MODEL_POLICY_ALLOW_PATH,
  applyDefaultAgentModelPatch,
  userMountConfigPatch,
  userSecurityProjectionReplacePaths,
  platformModelAllowlistPatch,
  brokerFetchByosubCreds,
  restoreOauthStoreForSlug,
  syncByotForUser,
  triggerSecretsReload,
  type SyncByotForUserDeps,
} from "./byot-sync-runtime.js";
import {
  applyModelCredentialState,
  legacyByotSyncUserDataFromModelCredentialState,
  type ModelCredentialSyncUserData,
} from "./model-credential-sync.js";

export type SyncModelCredentialsForUserDeps = SyncByotForUserDeps & {
  applyModelCredentialState?: typeof applyModelCredentialState;
};

function legacyDepsFromModelCredentialDeps(
  deps: SyncModelCredentialsForUserDeps | undefined,
): SyncByotForUserDeps | undefined {
  if (!deps) return undefined;
  const { applyModelCredentialState: modelCredentialApply, ...legacyDeps } = deps;
  return {
    ...legacyDeps,
    ...(modelCredentialApply ? { applyByotState: modelCredentialApply } : {}),
  };
}

export async function syncModelCredentialsForUser(
  userData: ModelCredentialSyncUserData,
  deps?: SyncModelCredentialsForUserDeps,
): Promise<void> {
  await syncByotForUser(
    legacyByotSyncUserDataFromModelCredentialState(userData),
    legacyDepsFromModelCredentialDeps(deps),
  );
}

export {
  PLATFORM_MODEL_POLICY_ALLOW_PATH,
  userMountConfigPatch,
  userSecurityProjectionReplacePaths,
  platformModelAllowlistPatch,
  applyDefaultAgentModelPatch as applyModelCredentialDefaultAgentPatch,
  brokerFetchByosubCreds as brokerFetchModelCredentialOauthCreds,
  restoreOauthStoreForSlug as restoreModelCredentialOauthStoreForSlug,
  triggerSecretsReload as triggerModelCredentialSecretsReload,
};
