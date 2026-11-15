import { type KmsClient } from "../cloud-kms-encryptor.js";
export type { KmsClient } from "../cloud-kms-encryptor.js";
export declare function _setKmsClientForTesting(client: KmsClient | null): void;
export declare function encryptSecret(plaintext: string): Promise<string>;
export declare function decryptSecret(ciphertext: string): Promise<string>;
