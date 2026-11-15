import { generateKeyPairSync } from "node:crypto";

export const { privateKey: signingKey, publicKey: verificationKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
