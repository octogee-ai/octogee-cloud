import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

describe("native Mattermost base image", () => {
  it("has no legacy verifier for patched Activity gateway methods", () => {
    expect(existsSync(path.join(repoRoot, "gateway/Dockerfile.base-candidate"))).toBe(false);
    expect(
      existsSync(
        path.join(
          repoRoot,
          "gateway/openclaw-candidates/verify-mattermost-install.mjs",
        ),
      ),
    ).toBe(false);
  });
});
