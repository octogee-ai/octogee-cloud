import { describe, expect, it, vi } from "vitest";
import {
  resolveScopeCli,
  scopeSummary,
} from "../ops/scope.js";

describe("scope CLI glue", () => {
  it("fails open when no usable diff base is supplied", () => {
    const result = resolveScopeCli([]);

    expect(result.everything).toBe(true);
    expect(scopeSummary(result)).toContain("no usable diff base");
  });

  it("converts git failures into full-scope runs", () => {
    const execFile = vi.fn(() => {
      throw new Error("merge-base failed");
    });

    const result = resolveScopeCli(["--base", "abc123"], execFile);

    expect(result.everything).toBe(true);
    expect(scopeSummary(result)).toContain("git diff failed");
  });
});
