import { constants, createCipheriv, createDecipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import type { DecipherGCM } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface HobbyHomeEnvelopeInput {
  attemptId: string;
  podUid: string;
  keyVersion: string;
  keyPem: string;
}

export interface HobbyHomeEnvelopeHeader {
  version: 1;
  attemptId: string;
  podUid: string;
  keyVersion: string;
  wrappedDataKey: string;
  nonce: string;
}

function requiredIdentity(input: HobbyHomeEnvelopeInput): void {
  if (!/^[0-9a-f]{64}$/.test(input.attemptId) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.podUid) ||
    !/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/keyRings\/[a-zA-Z0-9_-]+\/cryptoKeys\/[a-zA-Z0-9_-]+\/cryptoKeyVersions\/[1-9]\d*$/.test(input.keyVersion) ||
    typeof input.keyPem !== "string" || input.keyPem.length > 8192) {
    throw new Error("Hobby home envelope requires exact Pod and KMS identities");
  }
}

export async function sealHobbyHome(
  input: HobbyHomeEnvelopeInput, tar: Readable, destination: Writable, assertSeal: () => Promise<void>,
): Promise<{ ownerManifestSha256: string; cipherSha256: string }> {
  requiredIdentity(input);
  const publicKey = createPublicKey(input.keyPem);
  if (publicKey.asymmetricKeyType !== "rsa" || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) {
    throw new Error("Hobby home envelope requires an RSA OAEP 3072-bit or stronger wrapping key");
  }
  const dataKey = randomBytes(32);
  const nonce = randomBytes(12);
  const wrappedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, dataKey);
  const header: HobbyHomeEnvelopeHeader = {version:1,attemptId:input.attemptId,podUid:input.podUid,keyVersion:input.keyVersion,
    wrappedDataKey:wrappedKey.toString("base64"),nonce:nonce.toString("base64")};
  const encoded = Buffer.from(JSON.stringify(header));
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(encoded.length);
  const authenticatedHeader = Buffer.concat([headerLength,encoded]);
  const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
  dataKey.fill(0);
  cipher.setAAD(authenticatedHeader);
  const plaintextDigest = createHash("sha256");
  const ciphertextDigest = createHash("sha256");
  await assertSeal();

  async function* encode(source: AsyncIterable<Buffer>) {
    ciphertextDigest.update(authenticatedHeader);
    yield authenticatedHeader;
    for await (const data of source) {
      plaintextDigest.update(data);
      const bytes = cipher.update(data);
      ciphertextDigest.update(bytes);
      yield bytes;
    }
    await assertSeal();
    const last = Buffer.concat([cipher.final(),cipher.getAuthTag()]);
    ciphertextDigest.update(last);
    yield last;
  }

  const limit = 5 * 1024 * 1024 * 1024;
  let count = 0;
  const maximum = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    count += chunk.length;
    if (count > limit) callback(new Error("Hobby home archive exceeds its four-GiB volume envelope"));
    else callback(null,chunk);
  } });
  await pipeline(tar,maximum,encode,destination);
  return { ownerManifestSha256: plaintextDigest.digest("hex"), cipherSha256: ciphertextDigest.digest("hex") };
}

function openEnvelope(
  aad: Buffer, expected: Pick<HobbyHomeEnvelopeHeader,"attemptId"|"podUid"|"keyVersion">, dataKey: Buffer,
): DecipherGCM {
  const header=JSON.parse(aad.subarray(4).toString("utf8")) as HobbyHomeEnvelopeHeader;
  if (header.version!==1 || header.attemptId!==expected.attemptId || header.podUid!==expected.podUid ||
    header.keyVersion!==expected.keyVersion || Buffer.from(header.nonce,"base64").length!==12) {
    throw new Error("Hobby home envelope does not match its exact operation");
  }
  const decipher=createDecipheriv("aes-256-gcm",dataKey,Buffer.from(header.nonce,"base64"));
  decipher.setAAD(aad);
  return decipher;
}

export async function verifyHobbyHomeEnvelope(
  chunks: AsyncIterable<Buffer>, expected: Pick<HobbyHomeEnvelopeHeader,"attemptId"|"podUid"|"keyVersion">,
  dataKey: Buffer, assertSeal: () => Promise<void>,
): Promise<{ ownerManifestSha256: string; cipherSha256: string }> {
  if (dataKey.length!==32) throw new Error("Invalid Hobby home envelope data key");
  await assertSeal();
  let decipher: DecipherGCM | undefined;
  let pending=Buffer.alloc(0);
  const clearDigest=createHash("sha256"), cipherDigest=createHash("sha256");
  for await (const bytes of chunks) {
    cipherDigest.update(bytes);
    pending=Buffer.concat([pending,bytes]);
    if (!decipher) {
      if (pending.length<4) continue;
      const headerLength=pending.readUInt32BE();
      if (headerLength<64 || headerLength>8192) throw new Error("Invalid Hobby home envelope header length");
      if (pending.length<4+headerLength) continue;
      const aad=pending.subarray(0,4+headerLength);
      decipher = openEnvelope(aad, expected, dataKey);
      pending=pending.subarray(4+headerLength);
    }
    if (pending.length>16) {
      clearDigest.update(decipher.update(pending.subarray(0,-16)));
      pending=pending.subarray(-16);
    }
  }
  if (!decipher || pending.length!==16) throw new Error("Incomplete Hobby home envelope");
  decipher.setAuthTag(pending);
  clearDigest.update(decipher.final());
  await assertSeal();
  return {ownerManifestSha256:clearDigest.digest("hex"),cipherSha256:cipherDigest.digest("hex")};
}
