import { KeyManagementServiceClient } from "@google-cloud/kms";
import { createCloudKmsDecryptor, type KmsClient } from "@octogee/core/cloud-kms-encryptor";
import { createRootKeyEncryptor, type Encryptor } from "@octogee/core/encryptor";

export function createConnectorSecretDecryptor(client?: Pick<KmsClient, "decrypt">): Encryptor["decrypt"] {
  return async (ciphertext) => {
    const name = process.env.OCTOGEE_KMS_KEY_NAME;
    if (!name) return createRootKeyEncryptor(process.env.ENCRYPTION_ROOT_KEY).decrypt(ciphertext);
    const decrypt = createCloudKmsDecryptor(name, () => {
      client ??= new KeyManagementServiceClient() as unknown as Pick<KmsClient, "decrypt">;
      return client;
    });
    return decrypt(ciphertext);
  };
}
