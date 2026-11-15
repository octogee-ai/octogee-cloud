import { revokeAllConnectorGrantsForUser } from "@octogee/core/connector-revocation";
import { CONNECTOR_OAUTH_REVOCATION_TARGETS } from "@octogee/shared/types/connectors";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { decryptSecret } from "@octogee/core/connectors/kms";
import { logger } from "@octogee/core/http/logging";

export type AuthUserSuspension = (uid: string) => Promise<void>;

export const ACCOUNT_LIFECYCLE_SUSPENSION: AuthUserSuspension = async (uid) => {
  logger.info("No external identity to suspend; the account lifecycle refuses the deleted user's sessions", { uid });
};

export const userDeletionDeps = {
  suspendAuthUser: ACCOUNT_LIFECYCLE_SUSPENSION,
  revokeConnectorGrantsForUser: (uid: string): Promise<void> =>
    revokeAllConnectorGrantsForUser(uid, CONNECTOR_OAUTH_REVOCATION_TARGETS, {
      secrets: platformStateStore.secrets,
      decryptSecret,
      logger,
    }),
};
