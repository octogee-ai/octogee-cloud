import { describe, expect, it } from "vitest";
import { containsAsciiControlCharacter } from "./text-validation.js";

describe("containsAsciiControlCharacter", () => {
  it("recognizes every ASCII control code without rejecting printable text", () => {
    expect(containsAsciiControlCharacter("safe-text_123")).toBe(false);
    expect(containsAsciiControlCharacter("safe\u0000text")).toBe(true);
    expect(containsAsciiControlCharacter("safe\u001ftext")).toBe(true);
    expect(containsAsciiControlCharacter("safe\u007ftext")).toBe(true);
  });
});
