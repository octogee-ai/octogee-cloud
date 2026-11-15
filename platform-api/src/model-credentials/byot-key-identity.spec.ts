import { expect, it } from "vitest";
import { credentialVersionFingerprint } from "./byot-key-identity.js";

it("gives each stored credential version a stable diagnostic identifier", () => {
  const first = credentialVersionFingerprint("secrets/byok-alice-openai/versions/1");
  expect(first).toMatch(/^[a-f0-9]{12}$/u);
  expect(credentialVersionFingerprint("secrets/byok-alice-openai/versions/1")).toBe(first);
  expect(credentialVersionFingerprint("secrets/byok-alice-openai/versions/2")).not.toBe(first);
});
