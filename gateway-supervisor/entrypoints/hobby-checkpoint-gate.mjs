import { checkpointDesktop, checkpointGatewayCredentials, waitForCheckpointClaim } from "@octogee/shared/server/hobby-checkpoint-gate";

const claim = await waitForCheckpointClaim("gateway");
const live = claim.version === 2;
const desktop = checkpointDesktop(claim, process.env);
const { token, agentStoreDsn } = await checkpointGatewayCredentials();
process.stderr.write("[hobby-checkpoint] gateway claim and credentials ready\n");
const entrypoint = live ? "/usr/local/bin/entrypoint.sh" : "/usr/local/bin/octogee-hobby-desktop";
process.execve(entrypoint, [entrypoint], {
  ...process.env,
  POD_UID: claim.podUid,
  ...(desktop === undefined ? {} : { GATEWAY_COMPUTER_DESKTOP: desktop }),
  ...(live && claim.recovery ? { GATEWAY_IMAGE_TAG: claim.recovery.gatewayImageTag } : {}),
  OPENCLAW_GATEWAY_TOKEN: token,
  OPENCLAW_AGENT_STORE_DSN: agentStoreDsn,
});
