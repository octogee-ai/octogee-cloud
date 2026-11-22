import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readdir } from "node:fs/promises";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const recoveryStageName = ".octogee-retained-home-restore";

export async function readHomeTar(home: string, excludeStage = false) {
  const entries = (await readdir(home, { encoding: "buffer" })).sort(Buffer.compare);
  const stage = Buffer.from(recoveryStageName);
  if (!excludeStage && entries.some(entry => entry.equals(stage))) {
    throw new Error("Hobby home archive contains the reserved restore path");
  }
  const child = spawn("/usr/bin/tar", [
    "--one-file-system", "--sort=name", "--numeric-owner", "-C", home, "-cf", "-", "--null", "-T", "-",
  ], { stdio: ["pipe", "pipe", "ignore"] });
  const tar = new PassThrough();
  let received = 0;
  const verifiedTar = new Transform({
    transform(chunk: Buffer, _, done) {
      received += chunk.length;
      done(null, chunk);
    },
    flush(done) {
      if (received >= 1024 && received % 512 === 0) done();
      else done(new Error("Hobby home tar did not produce a complete archive"));
    },
  });
  const completed = Promise.all([
    once(child, "close"),
    pipeline(child.stdout, verifiedTar, tar),
    pipeline(Readable.from(entries.filter(entry => !entry.equals(stage)).flatMap(entry => [entry, Buffer.from([0])])), child.stdin),
  ]).then(([[code]]) => {
    if (code !== 0) throw new Error("Hobby home tar did not finish successfully");
  });
  return { child, tar, completed };
}

export async function homeTarDigest(home: string, excludeStage = false): Promise<string> {
  const hash = createHash("sha256");
  const { tar, completed } = await readHomeTar(home, excludeStage);
  await Promise.all([
    (async () => { for await (const chunk of tar) hash.update(chunk); })(),
    completed,
  ]);
  return hash.digest("hex");
}
