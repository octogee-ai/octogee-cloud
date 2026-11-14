#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [templatesArg, extensionsArg, runtimeArg, cliArg] = process.argv.slice(2);
if (!templatesArg || !extensionsArg || !runtimeArg) {
  throw new Error("Usage: verify-config-templates.mjs <templates-dir> <extensions-dir> <runtime-npm-dir> [openclaw-cli]");
}
const templates = realpathSync(templatesArg), extensions = realpathSync(extensionsArg), runtime = realpathSync(runtimeArg);
const cli = realpathSync(cliArg ?? "/usr/local/bin/openclaw");
const root = mkdtempSync(path.join(tmpdir(), "octogee-config-template-"));
try {
  for (const [template, gatewayClass] of [["openclaw.template.json", "shared"], ["openclaw.isolated.template.json", "isolated"]]) {
    const home = path.join(root, gatewayClass), stateDir = path.join(home, ".openclaw");
    mkdirSync(stateDir, { recursive: true });
    symlinkSync(extensions, path.join(stateDir, "extensions"), "dir");
    symlinkSync(runtime, path.join(stateDir, "npm"), "dir");
    const configPath = path.join(stateDir, "openclaw.json"), tokenPath = path.join(home, "broker-token");
    copyFileSync(path.join(templates, template), configPath);
    writeFileSync(tokenPath, "config-validation-token", { mode: 0o600 });
    const result = spawnSync(process.execPath, [cli, "config", "validate", "--json"], {
      encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, HOME: home, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_OFFLINE: "1",
        OPENCLAW_AGENT_STORE_DSN: "postgresql://config-validation@127.0.0.1:5432/config_validation",
        MM_URL: "http://127.0.0.1:8065", MM_SITE_URL: "http://127.0.0.1:8065",
        MM_INTERACTIONS_CALLBACK_BASE_URL: "http://127.0.0.1:3000", MM_INTERACTIONS_ALLOWED_SOURCE_IPS: "127.0.0.1/32",
        FLEET_BROKER_URL: "http://127.0.0.1:3001/internal/fleet", OCTOGEE_API_SA_TOKEN_PATH: tokenPath,
        CUSTOMERS_DIR: path.join(home, "customers"), GATEWAY_CLASS: gatewayClass, GATEWAY_ID: "config-validation" },
    });
    if (result.error || result.status !== 0) {
      throw new Error(`${template}: Native config validation failed (${result.error?.message ?? result.status ?? result.signal})\n${result.stdout ?? ""}${result.stderr ?? ""}`);
    }
    let report;
    try { report = JSON.parse(result.stdout); }
    catch { throw new Error(`${template}: Native config validation returned invalid JSON\n${result.stdout}${result.stderr}`); }
    if (report?.valid !== true) throw new Error(`${template}: Native rejected the shipped config\n${result.stdout}${result.stderr}`);
    if (report.warnings?.some(warning => warning.message?.includes("skill-workshop plugin policy"))) {
      throw new Error(`${template}: Native ignores the shipped Workshop policy\n${result.stdout}${result.stderr}`);
    }
    console.log(`[config-templates] PASS ${template}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
