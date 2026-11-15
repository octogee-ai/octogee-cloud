import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("model credential sync middleware", () => {
  it("middleware log messages use model credential wording", () => {
    const src = readFileSync(
      join(import.meta.dirname, "byot-sync-auth.ts"),
      "utf8",
    );
    expect(src).toContain("model credential sync public key or gateway identity is not configured");
    expect(src).toContain("model credential sync internal auth rejected");
    expect(src).not.toContain("BYOT sync internal");
  });
});
