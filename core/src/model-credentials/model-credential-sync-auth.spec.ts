import { signingKey, verificationKey } from "../fixtures/signature-keys.js";
import { describe, expect, it } from "vitest";
import * as modelCredentialSyncAuth from "./byot-sync-internal-auth.js";
import {
  MODEL_CREDENTIAL_SYNC_SIGNATURE_HEADER,
  MODEL_CREDENTIAL_SYNC_TIMESTAMP_HEADER,
  createModelCredentialSyncAuthHeaders,
  isValidModelCredentialSyncSignature,
} from "./byot-sync-internal-auth.js";

describe("model credential sync internal auth", () => {
  it("keeps the existing wire header names under model credential exports", () => {
    expect(MODEL_CREDENTIAL_SYNC_TIMESTAMP_HEADER).toBe("x-byot-sync-timestamp");
    expect(MODEL_CREDENTIAL_SYNC_SIGNATURE_HEADER).toBe("x-byot-sync-signature");
  });

  it("does not export legacy BYOT helper aliases", () => {
    expect("BYOT_SYNC_TIMESTAMP_HEADER" in modelCredentialSyncAuth).toBe(false);
    expect("BYOT_SYNC_SIGNATURE_HEADER" in modelCredentialSyncAuth).toBe(false);
    expect("createByotSyncAuthHeaders" in modelCredentialSyncAuth).toBe(false);
    expect("isValidByotSyncSignature" in modelCredentialSyncAuth).toBe(false);
  });

  it("signs and validates a canonical model credential sync body", () => {
    const body = {
      username: "tester-70",
      provisioning: { openclaw: { status: "complete" } },
      systemConfig: {
        modelCredential: { active: true, provider: "claude-cli", mode: "oauth" },
      },
    };
    const headers = createModelCredentialSyncAuthHeaders({
      body,
      secret: signingKey,
      gatewayId: "walter",
      nowMs: 42,
    });

    expect(
      isValidModelCredentialSyncSignature({
        body,
        publicKey: verificationKey,
        gatewayId: "walter",
        timestamp: headers[MODEL_CREDENTIAL_SYNC_TIMESTAMP_HEADER],
        signature: headers[MODEL_CREDENTIAL_SYNC_SIGNATURE_HEADER],
        nowMs: 42,
      }),
    ).toBe(true);
  });

  it("uses model credential wording for missing signing secret errors", () => {
    expect(() =>
      createModelCredentialSyncAuthHeaders({ body: {}, gatewayId: "walter", secret: " " }),
    ).toThrow(/model credential sync/);
  });

});
