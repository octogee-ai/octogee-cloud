import { generateKeyPairSync } from "node:crypto";

function makeEd25519PemPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

export const FLEET_KEY_PAIR = makeEd25519PemPair();
export const OTHER_FLEET_KEY_PAIR = makeEd25519PemPair();
