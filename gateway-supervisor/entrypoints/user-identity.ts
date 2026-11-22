import { pathToFileURL } from "node:url";
import {
  UserClaimError,
  DEFAULT_OPENCLAW_DIR,
  userClaimFromIdentity,
  writeUserClaim,
} from "@octogee/shared/server/user-claim";
import type { UserIdentity } from "@octogee/shared/types/user-identity";
import { readMountedCheckpointClaim } from "@octogee/shared/server/hobby-checkpoint-gate";
import type { FleetBrokerAssignmentRosterEntry } from "@octogee/shared/types/fleet-broker";
import { GATEWAY_BINDING_MISMATCH_REASON } from "@octogee/shared/types/fleet-broker";
import { createFleetBrokerClient, FleetBrokerHttpError } from "../lib/fleet-broker-client.js";

export const USER_IDENTITY_FATAL_EXIT = 2;
export const USER_IDENTITY_REBOUND_EXIT = 72;

export type UserIdentityBootResult =
  | { exitCode: 0; builderSlug: string }
  | { exitCode: 1 | typeof USER_IDENTITY_FATAL_EXIT | typeof USER_IDENTITY_REBOUND_EXIT };

export function checkCheckpointIdentity(
  claim: NonNullable<Awaited<ReturnType<typeof readMountedCheckpointClaim>>>,
  identity: UserIdentity,
  roster: readonly FleetBrokerAssignmentRosterEntry[],
): boolean {
  return identity.state === "claimed" && identity.gatewayId === claim.gatewayId &&
    identity.ownerUid === claim.uid && identity.builderSlug === claim.slug &&
    roster.length === 1 && roster[0]?.uid === claim.uid &&
    roster[0].epoch === claim.assignmentEpoch && roster[0].state === "serving";
}

export async function resolveUserIdentityBoot(input: {
  env: NodeJS.ProcessEnv;
  fetchIdentity: () => Promise<UserIdentity>;
  now: () => number;
  log: (message: string) => void;
}): Promise<UserIdentityBootResult> {
  const gatewayId = input.env.GATEWAY_ID?.trim();
  if (!gatewayId) {
    input.log("[builder-identity] FATAL: GATEWAY_ID is required");
    return { exitCode: USER_IDENTITY_FATAL_EXIT };
  }
  let identity: UserIdentity;
  try {
    identity = await input.fetchIdentity();
  } catch (error) {
    if (error instanceof FleetBrokerHttpError && error.status === 403 &&
      error.denialReason === GATEWAY_BINDING_MISMATCH_REASON) {
      input.log(`[builder-identity] FATAL: gateway ${gatewayId} does not match the bound gateway`);
      return { exitCode: USER_IDENTITY_REBOUND_EXIT };
    }
    input.log(`[builder-identity] broker read failed: ${error instanceof Error ? error.message : String(error)}`);
    return { exitCode: 1 };
  }
  const openclawDir = input.env.OPENCLAW_DIR?.trim() || DEFAULT_OPENCLAW_DIR;
  if (identity.state === "unavailable") {
    input.log(`[builder-identity] FATAL: gateway ${gatewayId} has no claimed user: unavailable (${identity.reason})`);
    return { exitCode: USER_IDENTITY_FATAL_EXIT };
  }
  try {
    const claim = writeUserClaim(openclawDir, userClaimFromIdentity(identity, input.now()));
    return { exitCode: 0, builderSlug: claim.builderSlug };
  } catch (error) {
    if (!(error instanceof UserClaimError)) throw error;
    input.log(`[builder-identity] FATAL: ${error.message}`);
    return { exitCode: USER_IDENTITY_FATAL_EXIT };
  }
}

interface SlugOutput {
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
}

export async function runUserIdentityEntrypoint(input: Parameters<typeof resolveUserIdentityBoot>[0] & {
  stdout: SlugOutput;
}): Promise<number> {
  const result = await resolveUserIdentityBoot(input);
  if (result.exitCode !== 0) return result.exitCode;
  await new Promise<void>((resolve, reject) => {
    input.stdout.write(`${result.builderSlug}\n`, (error) => (error ? reject(error) : resolve()));
  });
  return 0;
}

export async function main(): Promise<void> {
  const gatewayId = process.env.GATEWAY_ID?.trim() ?? "";
  const checkpointClaim = process.env.OCTOGEE_CHECKPOINT_SLOT_ID ? await readMountedCheckpointClaim() : undefined;
  if (checkpointClaim === null || (checkpointClaim &&
    (checkpointClaim.gatewayId !== gatewayId || checkpointClaim.podUid !== process.env.POD_UID))) {
    throw new Error("Expected the restored pod's exact gateway checkpoint claim");
  }
  const client = createFleetBrokerClient(gatewayId);
  const exitCode = await runUserIdentityEntrypoint({
    env: process.env,
    fetchIdentity: async () => {
      const identity = await client.builderIdentity();
      if (checkpointClaim && !checkCheckpointIdentity(checkpointClaim, identity, await client.assignmentRoster())) {
        throw new FleetBrokerHttpError("checkpoint claim differs from the gateway assignment", 403, GATEWAY_BINDING_MISMATCH_REASON);
      }
      return identity;
    },
    now: Date.now,
    log: (message) => process.stderr.write(`${message}\n`),
    stdout: process.stdout,
  });
  if (exitCode !== 0) process.exit(exitCode);
  process.exitCode = 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[builder-identity] FATAL: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(USER_IDENTITY_FATAL_EXIT);
  });
}
