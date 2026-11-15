import { describe, expect, it } from "vitest";
import { validateFilePath } from "./path-validation.js";

describe("validateFilePath", () => {
  it("accepts relative workspace paths with safe characters", () => {
    expect(validateFilePath("docs/Project Plan-1.md")).toBeNull();
    expect(validateFilePath("assets/icons/logo_2.png")).toBeNull();
  });

  it("rejects empty, absolute, traversal, null-byte, duplicate-slash, and backslash paths", () => {
    expect(validateFilePath("")).toBe("Path is required");
    expect(validateFilePath("   ")).toBe("Path is empty");
    expect(validateFilePath("/etc/passwd")).toBe("Absolute paths not allowed");
    expect(validateFilePath("docs/../secrets")).toBe("Path traversal (..) not allowed");
    expect(validateFilePath("docs/\0secret")).toBe("Null bytes not allowed");
    expect(validateFilePath("docs//readme.md")).toBe("Double slashes not allowed");
    expect(validateFilePath("docs\\readme.md")).toBe("Backslashes not allowed");
  });

  it("rejects long paths and characters outside the workspace path allowlist", () => {
    expect(validateFilePath(`${"a".repeat(501)}.md`)).toBe("Path too long (max 500 chars)");
    expect(validateFilePath("docs/<script>.md")).toBe("Path contains invalid characters");
  });
});
