import { assertRetainedHobbySeal } from "@octogee/shared/server/hobby-checkpoint-gate";
import { sealHobbyHome, type HobbyHomeEnvelopeInput } from "../lib/hobby-recovery-envelope.js";

import { homeTarDigest, readHomeTar } from "../lib/hobby-recovery-home-tar.js";

async function readInput(): Promise<HobbyHomeEnvelopeInput> {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const part of process.stdin) {
    const bytes = Buffer.from(part);
    length += bytes.length;
    if (length > 16384) throw new Error("Hobby recovery envelope input exceeds limit");
    parts.push(bytes);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as HobbyHomeEnvelopeInput;
}

const inputs = await readInput();
if (inputs.podUid !== process.env.POD_UID) throw new Error("Hobby archive does not name this exact Pod");
const assertSeal = async () => { await assertRetainedHobbySeal(inputs.attemptId,"gateway"); };
await assertSeal();

const { child, tar, completed } = await readHomeTar("/home/node");
try {
  const [proof] = await Promise.all([sealHobbyHome(inputs, tar, process.stdout, async () => {
    await assertSeal();
    if (tar.readableEnded) await completed;
  }), completed]);
  await assertSeal();
  if (await homeTarDigest("/home/node") !== proof.ownerManifestSha256) {
    throw new Error("Hobby encrypted archive does not match the complete sealed home");
  }
  await assertSeal();
  process.stderr.write("OCTOGEE_HOBBY_HOME_ARCHIVE:" + JSON.stringify(proof) + "\n");
} catch (error) {
  child.kill();
  throw error;
}
