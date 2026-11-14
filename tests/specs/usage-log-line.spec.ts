import { test, expect, describe } from "vitest";
import { formatUsageLogLine } from "../../core/src/usage-log-line";

describe("formatUsageLogLine", () => {
  const base = {
    totalTokens: 1800,
    costUsd: 0.0168,
    role: "coach",
    model: "anthropic/claude-sonnet-4-6",
    uid: "abc12345defg",
    workspaceId: "smile-wring-011b",
  };

  test("canonical turn line: tokens, cost, role/model, uid, workspace slug", () => {
    expect(formatUsageLogLine(base)).toBe(
      "✓ usage: 1800 tokens ($0.0168) [coach/anthropic/claude-sonnet-4-6] uid:abc12345 slug:smile-wring-011b",
    );
  });

  test("workspaceId omitted: no slug: segment", () => {
    expect(formatUsageLogLine({ ...base, workspaceId: null })).toBe(
      "✓ usage: 1800 tokens ($0.0168) [coach/anthropic/claude-sonnet-4-6] uid:abc12345",
    );
  });

  test("uid truncated to first 8 chars", () => {
    const line = formatUsageLogLine({ ...base, uid: "0123456789abcdef" });
    expect(line).toContain("uid:01234567 ");
    expect(line).not.toContain("89abcdef");
  });

  test("cost formatted to four decimals, always", () => {
    expect(formatUsageLogLine({ ...base, costUsd: 0 })).toContain("($0.0000)");
    expect(formatUsageLogLine({ ...base, costUsd: 1 })).toContain("($1.0000)");
    expect(formatUsageLogLine({ ...base, costUsd: 0.123456 })).toContain("($0.1235)");
  });

  test("line never contains raw secret material — the format does not include keys", () => {
    const line = formatUsageLogLine(base);
    expect(line).not.toContain("key=");
    expect(line).not.toMatch(/sk-ant-api\d+/);
  });

  test("alternative role (e.g. alex) renders inline", () => {
    expect(formatUsageLogLine({ ...base, role: "alex" })).toContain(
      "[alex/anthropic/claude-sonnet-4-6]",
    );
  });
});
