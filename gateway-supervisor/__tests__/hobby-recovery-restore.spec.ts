import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { sealHobbyHome } from "../lib/hobby-recovery-envelope.js";
import { homeTarDigest, readHomeTar } from "../lib/hobby-recovery-home-tar.js";
import { restoreHobbyHome } from "../lib/hobby-recovery-restore.js";

const input = {
  attemptId: "b".repeat(64),
  podUid: "8afff836-dc31-49c0-afd4-78c18ddbdba7",
  keyVersion: "projects/octogee-test/locations/us-central1/keyRings/fixture/cryptoKeys/synthetic/cryptoKeyVersions/1",
};

async function fixtureArchive(home: string) {
  const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const stream = await readHomeTar(home);
  await once(stream.child, "exit");
  await setTimeout(25);
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(chunk: Buffer, _, callback) { chunks.push(chunk); callback(); } });
  const [proof] = await Promise.all([
    sealHobbyHome({ ...input, keyPem: keys.publicKey.export({ type: "spki", format: "pem" }) }, stream.tar, sink, async () => {}),
    stream.completed,
  ]);
  const encrypted = Buffer.concat(chunks);
  const header = JSON.parse(encrypted.subarray(4, 4 + encrypted.readUInt32BE(0)).toString()) as { wrappedDataKey: string };
  const key = privateDecrypt({
    key: keys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256",
  }, Buffer.from(header.wrappedDataKey, "base64"));
  expect(proof.ownerManifestSha256).not.toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  return { encrypted, key, proof };
}

async function fixtureHome(home: string) {
  await mkdir(home);
  await mkdir(join(home, "nested"), { mode: 0o750 });
  await writeFile(join(home, "alpha"), "original owner state", { mode: 0o600 });
  await writeFile(join(home, "nested/secret"), "original private state", { mode: 0o640 });
  await link(join(home, "alpha"), join(home, "hard-link"));
  await symlink("nested/secret", join(home, "symbolic"));
}

describe.skipIf(process.platform !== "linux")("staged rollback of a retained Hobby home", () => {
  it("rejects tampered or unrelated backups and replays interrupted publication on the same mount", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "retained-rollback-spec-"));
    const home = join(scratch, "home");
    try {
      await fixtureHome(home);
      const originalRoot = await stat(home);
      const { encrypted, key, proof } = await fixtureArchive(home);
      const scope = { ...input, ...proof };
      await writeFile(join(home, "alpha"), "failed installer");
      const marker = join(home, "failed-marker");
      await writeFile(marker, "failed installer");
      const failed = await homeTarDigest(home);
      const corrupted = Buffer.from(encrypted);
      corrupted[corrupted.length - 3] ^= 1;
      const restore = (bytes: Buffer, guard = async () => {}, expected = scope) =>
        restoreHobbyHome({ home, temporaryRoot: scratch }, Readable.from([bytes]), expected, key, guard);
      await expect(restore(corrupted)).rejects.toThrow(/authenticate/);
      await expect(restore(encrypted, undefined, { ...scope, attemptId: "a".repeat(64) })).rejects.toThrow(/exact operation/);
      expect(await homeTarDigest(home)).toBe(failed);
      const interrupted = () => assert.doesNotReject(lstat(marker), "Interrupted publication after replacing active home entries");
      await expect(restore(encrypted, interrupted)).rejects.toThrow(/Interrupted publication/);
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const active = restore(encrypted, async () => { entered.resolve(); await released.promise; });
      try {
        await entered.promise;
        await expect(restore(encrypted)).rejects.toThrow(/active restoration/);
      } finally {
        released.resolve();
        await active;
      }
      expect(await restore(encrypted)).toEqual(proof);
      expect(await restore(encrypted)).toEqual(proof);
      expect(await homeTarDigest(home)).toBe(proof.ownerManifestSha256);
      expect((await stat(join(home, "alpha"))).ino).toBe((await stat(join(home, "hard-link"))).ino);
      expect((await stat(join(home, "nested/secret"))).mode & 0o777).toBe(0o640);
      expect(await readFile(join(home, "symbolic"), "utf8")).toBe("original private state");
      await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await stat(home)).toMatchObject({ ino: originalRoot.ino, mode: originalRoot.mode, uid: originalRoot.uid, gid: originalRoot.gid });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 20_000);
  it("produces a complete empty-directory tar and restores an empty home", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "retained-empty-home-spec-"));
    const home = join(scratch, "home");
    const marker = join(home, "failed-marker");
    try {
      await mkdir(home);
      const { encrypted, key, proof } = await fixtureArchive(home);
      expect(proof.ownerManifestSha256).toBe(await homeTarDigest(home));
      await writeFile(marker, "failed installer");
      expect(await restoreHobbyHome({ home, temporaryRoot: scratch }, Readable.from([encrypted]),
        { ...input, ...proof }, key, async () => {})).toEqual(proof);
      await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 20_000);
});
