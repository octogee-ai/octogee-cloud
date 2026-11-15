

import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stampFirstRun, readClaudeVersion } from "../../gateway/stamp-claude-first-run.mjs";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "stamp-claude-first-run-"));
}

function writeCreds(home: string): void {
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(
    path.join(home, ".claude", ".credentials.json"),
    JSON.stringify({ oauth: { access_token: "fake" } }),
  );
}

describe("stamp-claude-first-run — idempotent operator-profile onboarding stamp", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });

  it("no-ops when ~/.claude/.credentials.json is absent (must not fake completion without underlying OAuth)", () => {
    const result = stampFirstRun({ home, claudeVersion: "2.1.145" });
    expect(result).toEqual({ stamped: false, reason: "no-credentials" });
    expect(existsSync(path.join(home, ".claude.json"))).toBe(false);
  });

  it("creates ~/.claude.json with the three first-run flags when creds exist + no config yet", () => {
    writeCreds(home);
    const result = stampFirstRun({ home, claudeVersion: "2.1.145" });
    expect(result.stamped).toBe(true);
    const config = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(config.hasCompletedOnboarding).toBe(true);
    expect(config._hasCompletedAuthFlow).toBe(true);
    expect(config.lastOnboardingVersion).toBe("2.1.145");
  });

  it("preserves existing keys in ~/.claude.json (operator customizations survive)", () => {
    writeCreds(home);
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        theme: "light",
        userID: "user-123",
        projects: { "/some/path": { allowedTools: [] } },
      }),
    );
    stampFirstRun({ home, claudeVersion: "2.1.145" });
    const config = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(config.theme).toBe("light");
    expect(config.userID).toBe("user-123");
    expect(config.projects["/some/path"]).toEqual({ allowedTools: [] });
    expect(config.hasCompletedOnboarding).toBe(true);
    expect(config._hasCompletedAuthFlow).toBe(true);
    expect(config.lastOnboardingVersion).toBe("2.1.145");
  });

  it("is idempotent: a second run on an already-stamped home produces byte-identical output", () => {
    writeCreds(home);
    stampFirstRun({ home, claudeVersion: "2.1.145" });
    const first = readFileSync(path.join(home, ".claude.json"), "utf8");
    stampFirstRun({ home, claudeVersion: "2.1.145" });
    const second = readFileSync(path.join(home, ".claude.json"), "utf8");
    expect(second).toBe(first);
  });

  it("omits lastOnboardingVersion when claudeVersion is null (claude --version unreachable — don't write a bogus marker)", () => {
    writeCreds(home);
    stampFirstRun({ home, claudeVersion: null });
    const config = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(config.hasCompletedOnboarding).toBe(true);
    expect(config._hasCompletedAuthFlow).toBe(true);
    expect("lastOnboardingVersion" in config).toBe(false);
  });

  it("writes the config 0600 (it sits next to .credentials.json — same blast radius)", () => {
    writeCreds(home);
    stampFirstRun({ home, claudeVersion: "2.1.145" });
    const mode = statSync(path.join(home, ".claude.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("stamp-claude-first-run — Copilot review hardening", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });

  it("does not leak ~/.claude.json.tmp on a successful run (atomic temp+rename, not a direct write)", () => {
    writeCreds(home);
    stampFirstRun({ home, claudeVersion: "2.1.145" });
    expect(existsSync(path.join(home, ".claude.json"))).toBe(true);
    expect(existsSync(path.join(home, ".claude.json.tmp"))).toBe(false);
  });

  it("creates the temp file with mode 0600 from the start (no umask window before chmod)", () => {
    writeCreds(home);

const fs = require("node:fs") as typeof import("node:fs");
    const realRename = fs.renameSync;
    let tmpMode: number | null = null;
    fs.renameSync = ((from: string, to: string) => {
      tmpMode = fs.statSync(from).mode & 0o777;
      return realRename(from, to);
    }) as typeof fs.renameSync;
    try {
      stampFirstRun({ home, claudeVersion: "2.1.145" });
    } finally {
      fs.renameSync = realRename;
    }
    expect(tmpMode).toBe(0o600);
  });

  it("on malformed existing ~/.claude.json: backs up the bad file and proceeds (does not wedge boot)", () => {
    writeCreds(home);
    const configPath = path.join(home, ".claude.json");
    writeFileSync(configPath, "{not json at all");
    stampFirstRun({ home, claudeVersion: "2.1.145" });

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.hasCompletedOnboarding).toBe(true);

    const fsLib = require("node:fs") as typeof import("node:fs");
    const broken = fsLib
      .readdirSync(home)
      .filter((f: string) => /^\.claude\.json\.broken\./.test(f));
    expect(broken.length).toBe(1);
    expect(fsLib.readFileSync(path.join(home, broken[0]), "utf8")).toBe(
      "{not json at all",
    );
  });

  it("honors CLAUDE_CONFIG_DIR for the credentials lookup (operator-relocated .credentials.json still triggers the stamp)", () => {

    const relocated = mkdtempSync(path.join(tmpdir(), "claude-config-dir-"));
    writeFileSync(path.join(relocated, ".credentials.json"), JSON.stringify({ oauth: { access_token: "fake" } }));

    const result = stampFirstRun({
      home,
      claudeVersion: "2.1.145",
      claudeConfigDir: relocated,
    });
    expect(result.stamped).toBe(true);

    const config = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(config.hasCompletedOnboarding).toBe(true);
  });

  it("CLAUDE_CONFIG_DIR set but no credentials inside it → no-op (refuses to fake completion)", () => {
    const relocated = mkdtempSync(path.join(tmpdir(), "claude-config-dir-empty-"));
    const result = stampFirstRun({
      home,
      claudeVersion: "2.1.145",
      claudeConfigDir: relocated,
    });
    expect(result).toEqual({ stamped: false, reason: "no-credentials" });
  });

  it("already-stamped fast-path: a second run on identical inputs returns reason='already-stamped' and does NOT rewrite the file", () => {

writeCreds(home);
    stampFirstRun({ home, claudeVersion: "2.1.145" });
    const configPath = path.join(home, ".claude.json");
    const mtimeBefore = statSync(configPath).mtimeMs;

    const result = stampFirstRun({ home, claudeVersion: "2.1.145" });
    expect(result).toEqual({ stamped: false, reason: "already-stamped" });
    const mtimeAfter = statSync(configPath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("re-stamps when the claudeVersion has changed (operator upgraded claude — refresh lastOnboardingVersion)", () => {
    writeCreds(home);
    stampFirstRun({ home, claudeVersion: "2.1.145" });
    const result = stampFirstRun({ home, claudeVersion: "2.2.0" });
    expect(result.stamped).toBe(true);
    const config = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(config.lastOnboardingVersion).toBe("2.2.0");
  });

  it("re-stamps when a previous run wrote the flags but lastOnboardingVersion is missing (older stamper / corrupt half-write)", () => {
    writeCreds(home);
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true, _hasCompletedAuthFlow: true }),
    );
    const result = stampFirstRun({ home, claudeVersion: "2.1.145" });
    expect(result.stamped).toBe(true);
  });
});

describe("readClaudeVersion — parses `claude --version` stdout, returns null on failure", () => {
  it("returns the first whitespace-delimited token of stdout (e.g. '2.1.145' from '2.1.145 (Claude Code)')", () => {

const fakeBin = path.join(makeHome(), "fake-claude");
    writeFileSync(fakeBin, "#!/bin/sh\necho '2.1.145 (Claude Code)'\n");
    chmodSync(fakeBin, 0o755);
    expect(readClaudeVersion({ claudeBin: fakeBin })).toBe("2.1.145");
  });

  it("returns null when the binary is not executable / missing (cattle image with no `claude` on PATH)", () => {

    expect(readClaudeVersion({ claudeBin: "/bin/false" })).toBeNull();
  });

  it("returns null when the binary cannot be spawned at all (path doesn't exist)", () => {
    expect(readClaudeVersion({ claudeBin: "/nonexistent-binary-zzz" })).toBeNull();
  });

  it("defaults claudeBin to process.env.CLAUDE_BIN when set — prevents the operator-image wrapper recursion", () => {

const fakeBin = path.join(makeHome(), "fake-claude-real");
    writeFileSync(fakeBin, "#!/bin/sh\necho '2.1.999 (Claude Code)'\n");
    chmodSync(fakeBin, 0o755);
    const prior = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = fakeBin;
    try {

      expect(readClaudeVersion()).toBe("2.1.999");
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = prior;
    }
  });

  it("explicit claudeBin arg still wins over process.env.CLAUDE_BIN (test ergonomics: env is a default, not a clamp)", () => {
    const envBin = path.join(makeHome(), "env-fake-claude");
    writeFileSync(envBin, "#!/bin/sh\necho 'env-version (Claude Code)'\n");
    chmodSync(envBin, 0o755);
    const argBin = path.join(makeHome(), "arg-fake-claude");
    writeFileSync(argBin, "#!/bin/sh\necho 'arg-version (Claude Code)'\n");
    chmodSync(argBin, 0o755);
    const prior = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = envBin;
    try {
      expect(readClaudeVersion({ claudeBin: argBin })).toBe("arg-version");
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = prior;
    }
  });
});
