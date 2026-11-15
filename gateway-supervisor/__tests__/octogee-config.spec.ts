import { describe, expect, it, vi } from "vitest";

import {
  parseOctogeeConfigArgs,
  runOctogeeConfig,
} from "../entrypoints/octogee-config.js";
import { withUserClaim } from "./helpers/user-claim.js";

describe("octogee config CLI", () => {
  it("prints only redacted durable status fields", async () => {
    const lines: string[] = [];

    await runOctogeeConfig(["config", "status"], {
      env: { OPENCLAW_DIR: "/durable" },
      readStatus: () => ({
        state: "error",
        acceptedCommit: "abc1234",
        lastSyncedAt: "2026-07-14T20:00:00.000Z",
        lastErrorCode: "validation-failed",
      }),
      write: (line) => lines.push(line),
      adopt: vi.fn(),
    });

    expect(lines.join("\n")).toBe([
      "state: error",
      "accepted head: abc1234",
      "last sync: 2026-07-14T20:00:00.000Z",
      "last error: validation-failed",
    ].join("\n"));
  });

  it("parses dry-run-first adoption and exact hash approval", () => {
    expect(parseOctogeeConfigArgs(["config", "adopt", "--from", "/tmp/walter.json"])).toEqual({
      command: "adopt",
      sourcePath: "/tmp/walter.json",
    });
    expect(parseOctogeeConfigArgs([
      "config",
      "adopt",
      "--from=/tmp/walter.json",
      `--approve-hash=sha256:${"a".repeat(64)}`,
    ])).toEqual({
      command: "adopt",
      sourcePath: "/tmp/walter.json",
      approveHash: `sha256:${"a".repeat(64)}`,
    });
  });

  it("renders a path-only adoption preview and never candidate values", async () => {
    const lines: string[] = [];
    const adopt = vi.fn(async () => ({
      applied: false,
      approvalHash: `sha256:${"b".repeat(64)}`,
      changedPaths: ["channels.mattermost.accounts.ceckert-coach.botToken"],
    }));

    const env = withUserClaim({}, "ceckert");
    await runOctogeeConfig(["config", "adopt", "--from=/tmp/walter.json"], {
      env,
      readStatus: vi.fn(),
      write: (line) => lines.push(line),
      adopt,
    });

    expect(lines.join("\n")).toContain("adoption: preview");
    expect(lines.join("\n")).toContain("channels.mattermost.accounts.ceckert-coach.botToken");
    expect(lines.join("\n")).not.toContain("walter-live-pat");
    expect(adopt).toHaveBeenCalledWith(expect.objectContaining({
      slug: "ceckert",
      sourcePath: "/tmp/walter.json",
      openclawDir: env.OPENCLAW_DIR,
    }));
  });

  it("rejects adoption without an isolated user slug", async () => {
    await expect(runOctogeeConfig(["config", "adopt", "--from=/tmp/walter.json"], {
      env: { OPENCLAW_DIR: "/durable" },
      readStatus: vi.fn(),
      write: vi.fn(),
      adopt: vi.fn(),
    })).rejects.toThrow("user claim");
  });
});
