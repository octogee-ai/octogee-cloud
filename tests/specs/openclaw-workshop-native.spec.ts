import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reconcilePlatformInvariants } from "../../core/dist/system-config-invariants.js";

const binary = process.env.OCTOGEE_TEST_OPENCLAW_BIN;
const runtimePlugins = process.env.OCTOGEE_TEST_OPENCLAW_NPM;
const extensions = process.env.OCTOGEE_TEST_OPENCLAW_EXTENSIONS;
const repo = path.resolve(import.meta.dirname, "../..");
const sourceSha = JSON.parse(readFileSync(path.join(repo, "infra/gateway/openclaw-tarball/current.json"), "utf8")).sourceSha as string;

describe.skipIf(!binary || !runtimePlugins || !extensions)("pinned Native Workshop config writes", () => {
  it.each(["shared", "isolated"] as const)("validates %s config after each writer and retains Workshop policy through Doctor", (gatewayClass) => {
    const home = mkdtempSync(path.join(tmpdir(), "octogee-workshop-native-"));
    const state = path.join(home, ".openclaw");
    mkdirSync(state);
    symlinkSync(extensions!, path.join(state, "extensions"));
    symlinkSync(runtimePlugins!, path.join(state, "npm"));
    const file = path.join(state, "openclaw.json");
    const template = gatewayClass === "shared" ? "openclaw.template.json" : "openclaw.isolated.template.json";
    const config = JSON.parse(readFileSync(path.join(repo, "infra/gateway", template), "utf8"));
    config.agents.defaults.workspace = path.join(home, "workspace");
    config.database.postgres.schemaPrefix = `workshop_${path.basename(home).slice(-6).toLowerCase()}`;
    writeFileSync(file, JSON.stringify(config));
    const tokenPath = path.join(home, "broker-token");
    writeFileSync(tokenPath, "synthetic-workshop-proof", { mode: 0o600 });
    const env = { ...process.env, HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: file, OPENCLAW_DIR: state, OPENCLAW_OFFLINE: "1", OPENCLAW_NO_RESPAWN: "1",
      GATEWAY_CLASS: gatewayClass, GATEWAY_ID: "workshop-proof", CUSTOMERS_DIR: path.join(home, "customers"),
      MM_URL: "http://127.0.0.1:8065", MM_SITE_URL: "http://127.0.0.1:8065",
      MM_INTERACTIONS_CALLBACK_BASE_URL: "http://127.0.0.1:3000", MM_INTERACTIONS_ALLOWED_SOURCE_IPS: "127.0.0.1/32",
      FLEET_BROKER_URL: "http://127.0.0.1:3001/internal/fleet", OCTOGEE_API_SA_TOKEN_PATH: tokenPath,
      OPENCLAW_AGENT_STORE_DSN: process.env.OCTOGEE_TEST_POSTGRES_DSN ?? "postgresql://config-validation@127.0.0.1:9/config_validation" };
    const run = (args: string[]) => {
      const result = spawnSync(binary!, args, { env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      return result;
    };
    const validate = () => {
      const report = JSON.parse(run(["config", "validate", "--json"]).stdout);
      expect(report.valid).toBe(true);
      expect(report.warnings).not.toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("skill-workshop plugin policy") })]));
    };
    try {
      expect(run(["--version"]).stdout).toContain(`(${sourceSha.slice(0, 7)})`);
      const legacy = structuredClone(config);
      delete legacy.meta.migrations.skillWorkshopPlugin;
      writeFileSync(file, JSON.stringify(legacy));
      const refused = spawnSync(binary!, ["config", "set", "plugins.entries.skill-workshop.enabled", "true", "--strict-json"], { env, encoding: "utf8", timeout: 120_000 });
      expect(refused.status, `${refused.stdout}\n${refused.stderr}`).toBe(1);
      expect(`${refused.stdout}\n${refused.stderr}`).toContain("must be migrated first");
      writeFileSync(file, JSON.stringify(config));
      validate();
      const policy = spawnSync(process.execPath, [path.join(repo, "infra/gateway/apply-gateway-class-policy.mjs")], { env, encoding: "utf8" });
      expect(policy.status, policy.stderr).toBe(0);
      validate();
      const projected = JSON.parse(readFileSync(file, "utf8"));
      reconcilePlatformInvariants(projected, { gatewayClass, gatewayId: "workshop-proof", apiOrigin: "https://app-test.octogee.com" });
      writeFileSync(file, JSON.stringify(projected));
      validate();
      run(["config", "set", "plugins.entries.skill-workshop.enabled", "true", "--strict-json"]);
      const workshop = projected.plugins.entries["skill-workshop"];
      run(["doctor", "--fix", "--non-interactive", "--skip-recovery-backups"]);
      const repaired = JSON.parse(readFileSync(file, "utf8"));
      expect(repaired.plugins.entries["skill-workshop"]).toEqual(workshop);
      expect(repaired.meta.migrations.skillWorkshopPlugin).toBe(true);
      reconcilePlatformInvariants(repaired, { gatewayClass, gatewayId: "workshop-proof", apiOrigin: "https://app-test.octogee.com" });
      writeFileSync(file, JSON.stringify(repaired));
      validate();
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 180_000);
});
