import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helper = resolve(import.meta.dirname, "../../infra/gateway/verify-config-templates.mjs");
const roots: string[] = [];

function fixture(user: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gateway-template-test-"))); roots.push(root);
  for (const name of ["templates", "extensions", "npm", "bin"]) mkdirSync(join(root, name));
  writeFileSync(join(root, "templates/openclaw.template.json"), JSON.stringify({ kind: "shared" }));
  writeFileSync(join(root, "templates/openclaw.isolated.template.json"), JSON.stringify({ kind: "builder", ...user }));
  const cli = join(root, "bin/openclaw"), log = join(root, "calls.jsonl");
  writeFileSync(cli, `#!${process.execPath}
const fs=require('fs');const path=require('path');const config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,'utf8'));
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),config,configPath:process.env.OPENCLAW_CONFIG_PATH,gatewayClass:process.env.GATEWAY_CLASS,databaseDsn:process.env.OPENCLAW_AGENT_STORE_DSN,
 projected:fs.realpathSync(path.join(process.env.OPENCLAW_STATE_DIR,'extensions')),npm:fs.realpathSync(path.join(process.env.OPENCLAW_STATE_DIR,'npm'))})+'\\n');
if(config.reject){process.stderr.write('unsupported config key');process.exit(2);}
process.stdout.write(JSON.stringify({valid:config.invalidReport!==true,warnings:config.warnings??[]}));
`);
  chmodSync(cli, 0o755);
  const run = () => spawnSync(process.execPath, [helper, join(root, "templates"), join(root, "extensions"), join(root, "npm"), cli], {
    encoding: "utf8", env: { ...process.env, OPENCLAW_AGENT_STORE_DSN: "postgresql://inherited.invalid/runtime", PATH: `${join(root, "bin")}:${process.env.PATH}` },
  });
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { root, run, calls };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Native config template image gate", () => {
  it("resolves PostgreSQL templates against a build-only DSN instead of inherited runtime credentials", () => {
    const f = fixture({ database: { engine: "postgres", postgres: {
      connection: { source: "env", provider: "default", id: "OPENCLAW_AGENT_STORE_DSN" },
    } } });
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(f.calls().map(call => call.databaseDsn)).toEqual([
      "postgresql://config-validation@127.0.0.1:5432/config_validation",
      "postgresql://config-validation@127.0.0.1:5432/config_validation",
    ]);
  });
  it("validates both raw templates with projected image plugins and isolated runtime state", () => {
    const f = fixture(), result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const calls = f.calls();
    expect(calls.map(call => ({ args: call.args, config: call.config, gatewayClass: call.gatewayClass }))).toEqual([
      { args: ["config", "validate", "--json"], config: { kind: "shared" }, gatewayClass: "shared" },
      { args: ["config", "validate", "--json"], config: { kind: "builder" }, gatewayClass: "isolated" },
    ]);
    for (const call of calls) {
      expect(call.projected).toBe(join(f.root, "extensions")); expect(call.npm).toBe(join(f.root, "npm"));
      expect(existsSync(call.configPath)).toBe(false);
    }
  });
  it.each([{ reject: true }, { invalidReport: true }, { warnings: [{ path: "plugins", message: "skill-workshop plugin policy written while Skill Workshop was built in is ignored." }] }])("fails the image when the user template is rejected: %o", rejection => {
    const f = fixture(rejection), result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("openclaw.isolated.template.json");
    expect(f.calls()).toHaveLength(2);
    for (const call of f.calls()) expect(existsSync(call.configPath)).toBe(false);
  });
});
