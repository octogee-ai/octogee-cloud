import { KeyManagementServiceClient } from "@google-cloud/kms";
import { createCloudKmsEncryptor, type KmsClient } from "../cloud-kms-encryptor.js";
import { createRootKeyEncryptor, type Encryptor } from "../encryptor.js";

export type { KmsClient } from "../cloud-kms-encryptor.js";

let _kmsClient: KmsClient | null = null;

export function _setKmsClientForTesting(client: KmsClient | null): void {
  _kmsClient = client;
}

function getKmsClient(): KmsClient {
  if (_kmsClient === null) {
    _kmsClient = new KeyManagementServiceClient() as unknown as KmsClient;
  }
  return _kmsClient;
}

function credentialEncryptor(): Encryptor {
  const name = process.env.OCTOGEE_KMS_KEY_NAME;
  return name
    ? createCloudKmsEncryptor(name, getKmsClient)
    : createRootKeyEncryptor(process.env.ENCRYPTION_ROOT_KEY);
}

export async function encryptSecret(plaintext: string): Promise<string> {
  return credentialEncryptor().encrypt(plaintext);
}

export async function decryptSecret(ciphertext: string): Promise<string> {
  return credentialEncryptor().decrypt(ciphertext);
}
