import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _setKmsClientForTesting,
  decryptSecret,
  encryptSecret,
  type KmsClient,
} from "./kms.js";

const KEY =
  "projects/octogee/locations/us-central1/keyRings/octogee-creds/cryptoKeys/integrations-at-rest";

function mockKms(overrides: Partial<KmsClient> = {}): KmsClient {
  return {
    encrypt: vi.fn() as unknown as KmsClient["encrypt"],
    decrypt: vi.fn() as unknown as KmsClient["decrypt"],
    ...overrides,
  };
}

beforeEach(() => {
  process.env.OCTOGEE_KMS_KEY_NAME = KEY;
});

afterEach(() => {
  _setKmsClientForTesting(null);
  delete process.env.OCTOGEE_KMS_KEY_NAME;
  delete process.env.ENCRYPTION_ROOT_KEY;
});

describe("encryptSecret", () => {
  it("base64-encodes KMS ciphertext bytes for Firestore string storage", async () => {
    const ciphertextBytes = Buffer.from("opaque-ciphertext-bytes");
    const encrypt = vi.fn(async (_request: { name: string; plaintext: Buffer }) => [{ ciphertext: ciphertextBytes }] as [
      { ciphertext: Buffer },
    ]);
    _setKmsClientForTesting(mockKms({ encrypt: encrypt as unknown as KmsClient["encrypt"] }));

    const result = await encryptSecret("my-secret-token");

    expect(result).toBe(ciphertextBytes.toString("base64"));
    expect(encrypt).toHaveBeenCalledOnce();
    const call = encrypt.mock.calls[0][0];
    expect(call.name).toBe(KEY);
    expect(call.plaintext.toString("utf-8")).toBe("my-secret-token");
  });

  it("throws on empty plaintext (defensive: never store empty creds)", async () => {
    _setKmsClientForTesting(mockKms());
    await expect(encryptSecret("")).rejects.toThrow(/non-empty/);
  });

  it("throws on non-string plaintext (typescript guard reinforcement)", async () => {
    _setKmsClientForTesting(mockKms());
    await expect(encryptSecret(null as unknown as string)).rejects.toThrow(
      /non-empty/,
    );
  });

  it("requires a root key when Cloud KMS is not configured", async () => {
    delete process.env.OCTOGEE_KMS_KEY_NAME;
    delete process.env.ENCRYPTION_ROOT_KEY;
    _setKmsClientForTesting(mockKms());
    await expect(encryptSecret("x")).rejects.toThrow(/ENCRYPTION_ROOT_KEY/);
  });

  it("propagates KMS API errors (transient + permanent must reach the caller)", async () => {
    const encrypt = vi.fn(async () => {
      throw new Error("KMS API: PERMISSION_DENIED");
    });
    _setKmsClientForTesting(mockKms({ encrypt: encrypt as unknown as KmsClient["encrypt"] }));
    await expect(encryptSecret("x")).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it("throws if KMS returns a response without ciphertext (defensive)", async () => {
    const encrypt = vi.fn(async () => [{}] as [Record<string, never>]);
    _setKmsClientForTesting(mockKms({ encrypt: encrypt as unknown as KmsClient["encrypt"] }));
    await expect(encryptSecret("x")).rejects.toThrow(/no ciphertext/);
  });

it("handles a string-typed ciphertext return as base64-encoded bytes (not utf-8)", async () => {
    const ciphertextBytes = Buffer.from("opaque-ciphertext-bytes");
    const ciphertextAsBase64String = ciphertextBytes.toString("base64");
    const encrypt = vi.fn(async () => [{ ciphertext: ciphertextAsBase64String }] as [
      { ciphertext: string },
    ]);
    _setKmsClientForTesting(mockKms({ encrypt: encrypt as unknown as KmsClient["encrypt"] }));

    const result = await encryptSecret("my-secret-token");

expect(result).toBe(ciphertextAsBase64String);
  });

  it("handles a Uint8Array-typed ciphertext return", async () => {
    const ciphertextBytes = new Uint8Array(Buffer.from("opaque-ciphertext-bytes"));
    const encrypt = vi.fn(async () => [{ ciphertext: ciphertextBytes }] as [
      { ciphertext: Uint8Array },
    ]);
    _setKmsClientForTesting(mockKms({ encrypt: encrypt as unknown as KmsClient["encrypt"] }));

    const result = await encryptSecret("my-secret-token");
    expect(result).toBe(Buffer.from(ciphertextBytes).toString("base64"));
  });
});

describe("decryptSecret", () => {
  it("base64-decodes stored ciphertext, calls KMS, returns utf-8 plaintext", async () => {
    const plaintextBytes = Buffer.from("the-original-token", "utf-8");
    const decrypt = vi.fn(async (_request: { name: string; ciphertext: Uint8Array }) => [{ plaintext: plaintextBytes }] as [
      { plaintext: Buffer },
    ]);
    _setKmsClientForTesting(mockKms({ decrypt: decrypt as unknown as KmsClient["decrypt"] }));

    const ciphertextBase64 = Buffer.from("opaque-bytes").toString("base64");
    const result = await decryptSecret(ciphertextBase64);

    expect(result).toBe("the-original-token");
    const call = decrypt.mock.calls[0][0];
    expect(call.name).toBe(KEY);
    expect(Buffer.from(call.ciphertext).toString("utf-8")).toBe("opaque-bytes");
  });

  it("throws on empty ciphertext", async () => {
    _setKmsClientForTesting(mockKms());
    await expect(decryptSecret("")).rejects.toThrow(/non-empty/);
  });

  it("requires a root key when Cloud KMS is not configured", async () => {
    delete process.env.OCTOGEE_KMS_KEY_NAME;
    delete process.env.ENCRYPTION_ROOT_KEY;
    _setKmsClientForTesting(mockKms());
    await expect(decryptSecret("YWJj")).rejects.toThrow(/ENCRYPTION_ROOT_KEY/);
  });

  it("propagates KMS API errors (key rotation, IAM denial, etc.)", async () => {
    const decrypt = vi.fn(async () => {
      throw new Error("KMS API: PERMISSION_DENIED");
    });
    _setKmsClientForTesting(mockKms({ decrypt: decrypt as unknown as KmsClient["decrypt"] }));
    await expect(decryptSecret("YWJj")).rejects.toThrow(/PERMISSION_DENIED/);
  });

it("handles a string-typed plaintext return as base64-encoded bytes (not utf-8)", async () => {
    const realPlaintext = "Bearer ya29.a0AfB-original-refresh-token";
    const plaintextAsBase64String = Buffer.from(realPlaintext, "utf-8").toString("base64");
    const decrypt = vi.fn(async () => [{ plaintext: plaintextAsBase64String }] as [
      { plaintext: string },
    ]);
    _setKmsClientForTesting(mockKms({ decrypt: decrypt as unknown as KmsClient["decrypt"] }));

    const result = await decryptSecret("YWJj");
    expect(result).toBe(realPlaintext);
  });

  it("handles a Uint8Array-typed plaintext return", async () => {
    const realPlaintext = "Bearer ya29.a0AfB-original-refresh-token";
    const plaintextBytes = new Uint8Array(Buffer.from(realPlaintext, "utf-8"));
    const decrypt = vi.fn(async () => [{ plaintext: plaintextBytes }] as [
      { plaintext: Uint8Array },
    ]);
    _setKmsClientForTesting(mockKms({ decrypt: decrypt as unknown as KmsClient["decrypt"] }));

    const result = await decryptSecret("YWJj");
    expect(result).toBe(realPlaintext);
  });
});

describe("encryptSecret + decryptSecret — round-trip", () => {
  it("a string encrypts then decrypts back to the same value (the contract callers depend on)", async () => {

_setKmsClientForTesting({
      encrypt: vi.fn(async ({ plaintext }) => [
        {
          ciphertext: Buffer.concat([
            Buffer.from("ENC:"),
            Buffer.from(plaintext),
          ]),
        },
      ] as [{ ciphertext: Buffer }]) as unknown as KmsClient["encrypt"],
      decrypt: vi.fn(async ({ ciphertext }) => [
        { plaintext: Buffer.from(ciphertext).slice(4) },
      ] as [{ plaintext: Buffer }]) as unknown as KmsClient["decrypt"],
    });
    const original = "Bearer ya29.a0AfBxxxxx-refreshTokenLike";
    const enc = await encryptSecret(original);
    expect(enc).not.toBe(original);
    expect(enc).not.toContain(original); 
    const dec = await decryptSecret(enc);
    expect(dec).toBe(original);
  });

  it("multi-byte unicode round-trips intact (boundary check on utf-8 encoding)", async () => {
    _setKmsClientForTesting({
      encrypt: vi.fn(async ({ plaintext }) => [
        { ciphertext: Buffer.from(plaintext) },
      ] as [{ ciphertext: Buffer }]) as unknown as KmsClient["encrypt"],
      decrypt: vi.fn(async ({ ciphertext }) => [
        { plaintext: Buffer.from(ciphertext) },
      ] as [{ plaintext: Buffer }]) as unknown as KmsClient["decrypt"],
    });
    const original = "🐙 octogee — accents, émojis, 多字節";
    const enc = await encryptSecret(original);
    const dec = await decryptSecret(enc);
    expect(dec).toBe(original);
  });
});

it("encrypts and decrypts with the root key when Cloud KMS is not configured", async () => {
  delete process.env.OCTOGEE_KMS_KEY_NAME;
  process.env.ENCRYPTION_ROOT_KEY = Buffer.alloc(32, 1).toString("base64");
  const encrypt = vi.fn();
  const decrypt = vi.fn();
  _setKmsClientForTesting({ encrypt, decrypt });

  const ciphertext = await encryptSecret("default backend credential");

  await expect(decryptSecret(ciphertext)).resolves.toBe("default backend credential");
  expect(encrypt).not.toHaveBeenCalled();
  expect(decrypt).not.toHaveBeenCalled();
});
