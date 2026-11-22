import { checkpointGatewayCredentials, waitForCheckpointClaim } from "@octogee/shared/server/hobby-checkpoint-gate";

const claim = await waitForCheckpointClaim("gateway");
const { token, agentStoreDsn } = await checkpointGatewayCredentials();
process.stderr.write("[hobby-checkpoint] gateway claim and credentials ready\n");
const desktop = "/usr/local/bin/octogee-hobby-desktop";
process.execve(desktop, [desktop], {
  ...process.env,
  POD_UID: claim.podUid,
  OPENCLAW_GATEWAY_TOKEN: token,
  OPENCLAW_AGENT_STORE_DSN: agentStoreDsn,
});
