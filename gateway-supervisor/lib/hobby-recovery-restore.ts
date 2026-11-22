import { execFile } from "node:child_process";
import { mkdtemp, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { homeTarDigest, recoveryStageName } from "./hobby-recovery-home-tar.js";
import { verifyHobbyHomeEnvelope, type HobbyHomeEnvelopeHeader } from "./hobby-recovery-envelope.js";

const run = promisify(execFile);
const restoreBudget = 3 * 1024 * 1024 * 1024;

export async function hobbyHomeSpoolLimit(home: string): Promise<number> {
  const { stdout } = await run("/usr/bin/du", ["--one-file-system", "--block-size=1", "-s", home]);
  const occupied = Number(stdout.split("\t")[0]);
  if (!Number.isSafeInteger(occupied) || occupied < 0 || occupied >= restoreBudget) {
    throw new Error("Hobby home needs more headroom for an isolated staged rollback");
  }
  return Math.floor((restoreBudget - occupied) / 9);
}

export type ExpectedHome = Pick<HobbyHomeEnvelopeHeader, "attemptId" | "podUid" | "keyVersion"> & {
  ownerManifestSha256: string;
  cipherSha256: string;
};

function pathBytes(parent: string, filename: Buffer): Buffer {
  return Buffer.concat([Buffer.from(parent + "/"), filename]);
}

async function removeEntries(home: string, except: string, assertSeal: () => Promise<void>) {
  for (const entry of await readdir(home, { encoding: "buffer" })) {
    if (entry.equals(Buffer.from(except))) continue;
    await assertSeal();
    await rm(pathBytes(home, entry), { recursive: true, force: true });
  }
}

async function restoreStaged(
  home: string, tar: string, expected: ExpectedHome, assertSeal: () => Promise<void>,
) {
  await assertSeal();
  if (await homeTarDigest(home, true) === expected.ownerManifestSha256) {
    await rm(join(home, recoveryStageName), { recursive: true, force: true });
    return;
  }
  const stage = join(home, recoveryStageName);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { mode: 0o700 });
  await run("/usr/bin/tar", ["-xf", tar, "--same-permissions", "--same-owner", "-C", stage]);
  if (await homeTarDigest(stage) !== expected.ownerManifestSha256) {
    throw new Error("Hobby staged home differs from authenticated archive");
  }
  await assertSeal();
  await removeEntries(home, recoveryStageName, assertSeal);
  for (const entry of await readdir(stage, { encoding: "buffer" })) {
    await assertSeal();
    await rename(pathBytes(stage, entry), pathBytes(home, entry));
  }
  await rm(stage, { recursive: true, force: true });
}

export async function restoreHobbyHome(
  home: string, temporaryRoot: string, chunks: AsyncIterable<Buffer>,
  expected: ExpectedHome, dataKey: Buffer, assertSeal: () => Promise<void>,
) {
  await assertSeal();
  const mountRoot = await stat(home);
  await rm(join(home, recoveryStageName), { recursive: true, force: true });
  const spoolLimit = await hobbyHomeSpoolLimit(home);
  const temporary = await mkdtemp(join(temporaryRoot, "octogee-rollback-"));
  const tar = join(temporary, "sealed.tar");
  try {
    const file = await open(tar, "wx", 0o600);
    try {
      let length = 0;
      const proof = await verifyHobbyHomeEnvelope(chunks, expected, dataKey, assertSeal, async chunk => {
        length += chunk.length;
        if (length > spoolLimit) throw new Error("Hobby rollback staging would exceed its safe volume headroom");
        await file.writeFile(chunk);
      });
      if (proof.ownerManifestSha256 !== expected.ownerManifestSha256 || proof.cipherSha256 !== expected.cipherSha256) {
        throw new Error("Hobby rollback archive differs from the immutable sealed receipt");
      }
    } finally {
      await file.close();
    }
    await restoreStaged(home, tar, expected, assertSeal);
    await run("/usr/bin/sync", ["-f", home]);
    await assertSeal();
    const resultingRoot = await stat(home);
    if (resultingRoot.ino !== mountRoot.ino || resultingRoot.mode !== mountRoot.mode ||
        resultingRoot.uid !== mountRoot.uid || resultingRoot.gid !== mountRoot.gid) {
      throw new Error("Hobby restore changed the original mounted home root");
    }
    if (await homeTarDigest(home) !== expected.ownerManifestSha256) {
      throw new Error("Hobby restored live home differs from the sealed source");
    }
    return { ownerManifestSha256: expected.ownerManifestSha256, cipherSha256: expected.cipherSha256 };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
