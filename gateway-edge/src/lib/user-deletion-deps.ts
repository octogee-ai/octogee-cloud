import { revokeAllConnectorGrantsForUser } from "@octogee/core/connector-revocation";
import { CONNECTOR_OAUTH_REVOCATION_TARGETS } from "@octogee/shared/types/connectors";
import { platformStateStore } from "./platform-state.js";
import { decryptSecret } from "./kms.js";
import { logger } from "../middleware/logging.js";

export type AuthUserSuspension = (uid: string) => Promise<void>;

export const ACCOUNT_LIFECYCLE_SUSPENSION: AuthUserSuspension = async () => {};

export const userDeletionDeps = {
  suspendAuthUser: ACCOUNT_LIFECYCLE_SUSPENSION,
  revokeConnectorGrantsForUser: (uid: string): Promise<void> =>
    revokeAllConnectorGrantsForUser(uid, CONNECTOR_OAUTH_REVOCATION_TARGETS, {
      secrets: platformStateStore.secrets,
      decryptSecret,
      logger,
    }),
};
