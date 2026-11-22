import { tmpdir } from "node:os";
import { hobbyHomeSpoolLimit, restoreHobbyHome, type ExpectedHome } from "../lib/hobby-recovery-restore.js";
import { assertRetainedHobbySeal } from "@octogee/shared/server/hobby-checkpoint-gate";
import { verifyHobbyHomeEnvelope, type HobbyHomeEnvelopeHeader } from "../lib/hobby-recovery-envelope.js";

type Restore = { restore: true; ownerManifestSha256: string; cipherSha256: string };
type Verification = Pick<HobbyHomeEnvelopeHeader,"attemptId"|"podUid"|"keyVersion"> & { dataKey: string } & (Restore | { restore?: false });

async function* archiveInput(
  source: AsyncIterable<Buffer>, authorize:(proof:Verification)=>void,
): AsyncGenerator<Buffer> {
  let control=Buffer.alloc(0), admitted=false;
  for await (const chunk of source) {
    if (admitted) { yield chunk; continue; }
    const newline=chunk.indexOf(10);
    const prefix=newline<0?chunk:chunk.subarray(0,newline);
    if (control.length+prefix.length>4096) throw new Error("Invalid Hobby archive verification input");
    control=Buffer.concat([control,prefix]);
    if (newline<0) continue;
    authorize(JSON.parse(control.toString("utf8")) as Verification);
    control.fill(0);
    admitted=true;
    yield chunk.subarray(newline+1);
  }
  if (!admitted) throw new Error("Missing Hobby archive verification control");
}

async function preflightRollback(chunks: AsyncIterable<Buffer>, input: Verification, key: Buffer, assertSeal: () => Promise<void>) {
  const limit = await hobbyHomeSpoolLimit("/home/node");
  let decoded = 0;
  return verifyHobbyHomeEnvelope(chunks, input, key, assertSeal, async chunk => {
    decoded += chunk.length;
    if (decoded > limit) throw new Error("Hobby backup cannot be safely staged within the original home volume");
  });
}

const control: { received?: Verification } = {};
const stream=archiveInput(process.stdin,input=>{control.received=input;});
const first=await stream.next();
const input=control.received;
if (!input || first.done || input.podUid!==process.env.POD_UID) throw new Error("Hobby verification does not name this exact Pod");
const key=Buffer.from(input.dataKey,"base64");
async function* withFirst(value: Buffer) { yield value; yield* stream; }

try {
  const assertSeal = async () => { await assertRetainedHobbySeal(input.attemptId,"gateway"); };
  const archive = withFirst(first.value);
  const proof = input.restore
    ? await restoreHobbyHome("/home/node", tmpdir(), archive, input satisfies ExpectedHome, key, assertSeal)
    : await preflightRollback(archive, input, key, assertSeal);
  process.stdout.write(JSON.stringify(proof)+"\n");
} finally {
  key.fill(0);
}
