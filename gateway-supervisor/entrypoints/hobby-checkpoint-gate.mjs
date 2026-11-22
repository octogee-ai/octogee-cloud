import { checkpointGatewayCredentials, waitForCheckpointClaim } from "@octogee/shared/server/hobby-checkpoint-gate";

const claim = await waitForCheckpointClaim("gateway");
const live = claim.version === 2;
if (live && process.env.GATEWAY_COMPUTER_DESKTOP !== "none") {
  throw new Error("Hobby live standby must be headless");
}
const { token, agentStoreDsn } = await checkpointGatewayCredentials();
process.stderr.write("[hobby-checkpoint] gateway claim and credentials ready\n");
const entrypoint = live ? "/usr/local/bin/entrypoint.sh" : "/usr/local/bin/octogee-hobby-desktop";
process.execve(entrypoint, [entrypoint], {
  ...process.env,
  POD_UID: claim.podUid,
  OPENCLAW_GATEWAY_TOKEN: token,
  OPENCLAW_AGENT_STORE_DSN: agentStoreDsn,
});
