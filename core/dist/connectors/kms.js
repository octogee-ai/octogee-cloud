import { KeyManagementServiceClient } from "@google-cloud/kms";
import { createCloudKmsEncryptor } from "../cloud-kms-encryptor.js";
import { createRootKeyEncryptor } from "../encryptor.js";
let _kmsClient = null;
export function _setKmsClientForTesting(client) {
    _kmsClient = client;
}
function getKmsClient() {
    if (_kmsClient === null) {
        _kmsClient = new KeyManagementServiceClient();
    }
    return _kmsClient;
}
function credentialEncryptor() {
    const name = process.env.OCTOGEE_KMS_KEY_NAME;
    return name
        ? createCloudKmsEncryptor(name, getKmsClient)
        : createRootKeyEncryptor(process.env.ENCRYPTION_ROOT_KEY);
}
export async function encryptSecret(plaintext) {
    return credentialEncryptor().encrypt(plaintext);
}
export async function decryptSecret(ciphertext) {
    return credentialEncryptor().decrypt(ciphertext);
}
