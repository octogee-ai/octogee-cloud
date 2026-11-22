import { spawn } from "node:child_process";
import { once } from "node:events";
import { assertRetainedHobbySeal } from "@octogee/shared/server/hobby-checkpoint-gate";
import { sealHobbyHome, type HobbyHomeEnvelopeInput } from "../lib/hobby-recovery-envelope.js";

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

const child=spawn("/usr/bin/tar",["--one-file-system","--sort=name","--numeric-owner","-C","/home/node","-cf","-","."],{
  stdio:["ignore","pipe","ignore"],
});
const completion=once(child,"exit");
try {
  const proof=await sealHobbyHome(inputs,child.stdout,process.stdout,async()=>{
    await assertSeal();
    if (child.stdout.readableEnded) {
      const [code]=await completion;
      if (code!==0) throw new Error("Hobby home tar did not finish successfully");
    }
  });
  const [code]=await completion;
  if (code!==0) throw new Error("Hobby home tar did not finish successfully");
  process.stderr.write("OCTOGEE_HOBBY_HOME_ARCHIVE:"+JSON.stringify(proof)+"\n");
} catch (error) {
  child.kill();
  throw error;
}
