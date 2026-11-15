import type { KmsClient } from "@octogee/core/cloud-kms-encryptor";
import { createRootKeyEncryptor } from "@octogee/core/encryptor";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConnectorSecretDecryptor } from "./connector-secret-decryption.js";

describe("createConnectorSecretDecryptor", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("decrypts with the configured integration KMS key", async () => {
    vi.stubEnv(
      "OCTOGEE_KMS_KEY_NAME",
      "projects/test/locations/us/keyRings/creds/cryptoKeys/integrations",
    );
    const decrypt = vi.fn<KmsClient["decrypt"]>(async () => [{ plaintext: Buffer.from("refresh-token") }]);
    const decryptSecret = createConnectorSecretDecryptor({ decrypt });

    await expect(decryptSecret(Buffer.from("ciphertext").toString("base64"))).resolves.toBe(
      "refresh-token",
    );
    expect(decrypt).toHaveBeenCalledWith({
      name: "projects/test/locations/us/keyRings/creds/cryptoKeys/integrations",
      ciphertext: Buffer.from("ciphertext"),
    });
  });

  it("requires a root key when Cloud KMS is not configured", async () => {
    vi.stubEnv("OCTOGEE_KMS_KEY_NAME", "");
    vi.stubEnv("ENCRYPTION_ROOT_KEY", "");
    const decryptSecret = createConnectorSecretDecryptor({ decrypt: vi.fn() });

    await expect(decryptSecret("YQ==")).rejects.toThrow(/ENCRYPTION_ROOT_KEY/);
  });

  it("reads root-key credentials without a KMS client", async () => {
    const key = Buffer.alloc(32, 1).toString("base64");
    vi.stubEnv("OCTOGEE_KMS_KEY_NAME", "");
    vi.stubEnv("ENCRYPTION_ROOT_KEY", key);
    const ciphertext = await createRootKeyEncryptor(key).encrypt("connector credential");
    const decrypt = vi.fn();

    await expect(createConnectorSecretDecryptor({ decrypt })(ciphertext)).resolves.toBe("connector credential");
    expect(decrypt).not.toHaveBeenCalled();
  });
});
