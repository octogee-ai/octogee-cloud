import { constants, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { sealHobbyHome, verifyHobbyHomeEnvelope, type HobbyHomeEnvelopeHeader } from "../lib/hobby-recovery-envelope.js";

const { publicKey, privateKey }=generateKeyPairSync("rsa",{modulusLength:3072});
const input = {
  attemptId:"c".repeat(64),podUid:"040cb6a0-870b-4b97-85f2-f54cebcf6e27",
  keyVersion:"projects/fixture/locations/us-central1/keyRings/private/cryptoKeys/recovery/cryptoKeyVersions/1",
  keyPem:publicKey.export({type:"spki",format:"pem"}).toString(),
};

function receiver() {
  const chunks: Buffer[]=[];
  const output=new Writable({write(value,_encoding,done){chunks.push(Buffer.from(value));done();}});
  return { output, bytes:()=>Buffer.concat(chunks) };
}

function unseal(bytes: Buffer) {
  const length=bytes.readUInt32BE(), header=bytes.subarray(0,4+length);
  const metadata=JSON.parse(header.subarray(4).toString("utf8")) as HobbyHomeEnvelopeHeader;
  const key=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},Buffer.from(metadata.wrappedDataKey,"base64"));
  const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(metadata.nonce,"base64"));
  decipher.setAAD(header);
  decipher.setAuthTag(bytes.subarray(-16));
  return {metadata,contents:Buffer.concat([decipher.update(bytes.subarray(4+length,-16)),decipher.final()])};
}

it("protects a streamed archive with one authenticated generated data key and binds its exact authority",async()=>{
  const {output,bytes}=receiver();
  const plaintext=Buffer.from("real synthetic data from the retained home\n");
  const assertSeal=vi.fn(async()=>undefined);
  const proof=await sealHobbyHome(input,Readable.from([plaintext.subarray(0,20),plaintext.subarray(20)]),output,assertSeal);
  expect(assertSeal).toHaveBeenCalledTimes(2);
  expect(bytes().includes(plaintext)).toBe(false);
  expect(unseal(bytes())).toMatchObject({metadata:{attemptId:input.attemptId,podUid:input.podUid,keyVersion:input.keyVersion},contents:plaintext});
  expect(proof).toEqual({ownerManifestSha256:createHash("sha256").update(plaintext).digest("hex"),
    cipherSha256:createHash("sha256").update(bytes()).digest("hex")});
  const altered=bytes(); altered[altered.length-20]!^=1;
  expect(()=>unseal(altered)).toThrow();
});

it("does not publish a usable envelope after a late custody loss",async()=>{
  const {output,bytes}=receiver();
  const assertSeal=vi.fn(async()=>undefined).mockRejectedValueOnce(new Error("lost initial seal"));
  await expect(sealHobbyHome(input,Readable.from([Buffer.from("private")]),output,assertSeal)).rejects.toThrow("lost initial seal");
  expect(bytes()).toHaveLength(0);
  const retry=receiver();
  const confirm=vi.fn(async()=>undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("lost seal during transfer"));
  await expect(sealHobbyHome(input,Readable.from([Buffer.from("private")]),retry.output,confirm)).rejects.toThrow("lost seal during transfer");
  expect(()=>unseal(retry.bytes())).toThrow();
});

it("rejects invalid operation, Pod, key version and key algorithm before output",async()=>{
  for (const invalid of [{podUid:"foreign"},{attemptId:"foreign"},{keyVersion:"mutable"},
    {keyPem:generateKeyPairSync("ed25519").publicKey.export({type:"spki",format:"pem"}).toString()}]) {
    const {output,bytes}=receiver();
    await expect(sealHobbyHome({...input,...invalid},Readable.from([]),output,async()=>undefined)).rejects.toThrow();
    expect(bytes()).toHaveLength(0);
  }
});


it("authenticates generation bytes inside the sealed reader without exposing plaintext", async () => {
  const {output,bytes}=receiver();
  const expected=await sealHobbyHome(input,Readable.from([Buffer.from("private fixture")]),output,async()=>undefined);
  const received=bytes();
  const length=received.readUInt32BE();
  const header=JSON.parse(received.subarray(4,4+length).toString("utf8")) as HobbyHomeEnvelopeHeader;
  const key=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},Buffer.from(header.wrappedDataKey,"base64"));
  const payload=()=>Readable.from([received.subarray(0,2),received.subarray(2,13),received.subarray(13,received.length-3),received.subarray(-3)]);
  await expect(verifyHobbyHomeEnvelope(payload(),input,key,async()=>undefined)).resolves.toEqual(expected);
  await expect(verifyHobbyHomeEnvelope(payload(),{...input,attemptId:"a".repeat(64)},key,async()=>undefined)).rejects.toThrow("exact operation");
  const corrupt=Buffer.from(received);corrupt[corrupt.length-1]!^=1;
  await expect(verifyHobbyHomeEnvelope(Readable.from([corrupt]),input,key,async()=>undefined)).rejects.toThrow();
});
