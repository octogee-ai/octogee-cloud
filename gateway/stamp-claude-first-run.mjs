#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function readClaudeVersion({ claudeBin } = {}) {
  const result = spawnSync(claudeBin ?? process.env.CLAUDE_BIN ?? "claude", ["--version"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return (result.stdout || "").trim().split(/\s+/)[0] || null;
}

function credentialsPath(home, claudeConfigDir) {
  const configDir = claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR;
  return configDir
    ? path.join(configDir, ".credentials.json")
    : path.join(home, ".claude", ".credentials.json");
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, "utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    fs.renameSync(configPath, `${configPath}.broken.${new Date().toISOString().replace(/[:.]/g, "-")}`);
    return {};
  }
}

export function stampFirstRun({ home, claudeVersion, claudeConfigDir } = {}) {
  const resolvedHome = home ?? process.env.HOME ?? "/home/node";
  if (!fs.existsSync(credentialsPath(resolvedHome, claudeConfigDir))) {
    return { stamped: false, reason: "no-credentials" };
  }
  const configPath = path.join(resolvedHome, ".claude.json");
  const config = loadConfig(configPath);
  if (
    config.hasCompletedOnboarding === true &&
    config._hasCompletedAuthFlow === true &&
    (!claudeVersion || config.lastOnboardingVersion === claudeVersion)
  ) {
    return { stamped: false, reason: "already-stamped" };
  }
  config.hasCompletedOnboarding = true;
  config._hasCompletedAuthFlow = true;
  if (claudeVersion) config.lastOnboardingVersion = claudeVersion;
  const tmpPath = `${configPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
  return { stamped: true, configPath };
}

if (Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = readClaudeVersion();
  const result = stampFirstRun({ claudeVersion: version });
  console.log(result.stamped
    ? `[stamp-claude-first-run] stamped ${result.configPath} (version=${version ?? "unknown"})`
    : `[stamp-claude-first-run] skipped: ${result.reason}`);
}
