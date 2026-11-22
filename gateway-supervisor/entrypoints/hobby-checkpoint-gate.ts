import { waitForCheckpointClaim } from "@octogee/shared/server/hobby-checkpoint-gate";

const claim = await waitForCheckpointClaim("gateway");
process.stdout.write(`${claim.podUid}\n`);
