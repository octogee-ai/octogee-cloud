import { waitForCheckpointClaim } from "@octogee/shared/server/hobby-checkpoint-gate";

const claim = await waitForCheckpointClaim("gateway");
process.stderr.write("[hobby-checkpoint] gateway claim and credentials ready\n");
process.stdout.write(`${claim.podUid}\n`);
