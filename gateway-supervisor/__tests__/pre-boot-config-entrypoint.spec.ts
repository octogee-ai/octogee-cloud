import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import { assertUserPostgresSelection } from "../lib/user-store-migration.js";

const temporaryDirectories: string[] = [];
const scriptsDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const tsx = path.join(scriptsDir, "node_modules/.bin/tsx");
const entrypoint = path.join(scriptsDir, "entrypoints/pre-boot-config.ts");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("pre-boot config entrypoint", () => {
  it.each([undefined, { engine: "postgres" }])("starts a fresh PostgreSQL user whose anchor precedes pre-boot config (database=%j)", async database => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "user-pg-preboot-"));
    temporaryDirectories.push(root);
    const configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({ database }));
    fs.mkdirSync(path.join(root, "state"));
    const anchorPath = path.join(root, "state", "openclaw.sqlite");
    const anchor = new DatabaseSync(anchorPath);
    try {
      anchor.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)");
      anchor.exec("INSERT INTO openclaw_engine_anchor VALUES ('92c817cc-770f-466d-b4a6-4e9b02998363', 'postgres', 'octogee_state_92c817cc770f466d')");
    } finally { anchor.close(); }
    const before = fs.readFileSync(anchorPath);
    const env = {
      ...process.env, HOME: root, GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: "cluster",
      OPENCLAW_DIR: root, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath,
    };
    const result = spawnSync(tsx, [entrypoint, "--defer-builder-store-migration"], { encoding: "utf8", env });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("User stores require migration");
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).database).toEqual({
      engine: "postgres", postgres: {
        connection: { source: "env", provider: "default", id: "OPENCLAW_AGENT_STORE_DSN" }, schemaPrefix: "octogee",
      },
    });
    await expect(assertUserPostgresSelection(env)).resolves.toBeUndefined();
    expect(fs.readFileSync(anchorPath)).toEqual(before);
  });

  it("exits nonzero when the durable OpenClaw config is malformed", () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-preboot-fatal-"));
    temporaryDirectories.push(openclawDir);
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(configPath, "{ malformed", "utf8");

    const result = spawnSync(tsx, [entrypoint], {
      encoding: "utf8",
      env: {
        ...process.env,
        GATEWAY_CLASS: "shared",
        HOME: openclawDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DIR: openclawDir,
      },
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      service: "pre-boot-config", severity: "ERROR",
      timestamp: expect.stringMatching(/^\d{4}-.*Z$/),
      message: expect.stringContaining("[pre-boot] Fatal:"),
    });
  });

  it("patches the config without initializing Firebase, whatever credentials the pod carries", () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-preboot-dbless-"));
    temporaryDirectories.push(openclawDir);
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(configPath, "{}", "utf8");
    const credentialPath = path.join(openclawDir, "service-account.json");
    fs.writeFileSync(credentialPath, "{}", "utf8");

    const result = spawnSync(tsx, [entrypoint], {
      encoding: "utf8",
      env: {
        ...process.env,
        GOOGLE_APPLICATION_CREDENTIALS: credentialPath,
        HOME: openclawDir,
        OCTOGEE_PREBOOT_FIRESTORE: "true",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DIR: openclawDir,
        SA_KEY_PATH: credentialPath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Firebase");
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).agents.defaults.typingMode).toBe("instant");
  });
});


it.each(["isolated", "shared"])("defers only a Builder's full migration to the held supervisor: %s", gatewayClass => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "user-selector-boot-")); temporaryDirectories.push(root);
  const configPath = path.join(root, "openclaw.json");
  const raw = JSON.stringify({ database: { engine: "sqlite" } });
  fs.writeFileSync(configPath, raw);
  const result = spawnSync(tsx, [entrypoint, "--defer-builder-store-migration"], { encoding: "utf8", env: {
    ...process.env, HOME: root, OPENCLAW_DIR: root, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath, GATEWAY_CLASS: gatewayClass,
  } });
  expect(result.status).toBe(gatewayClass === "isolated" ? 0 : 1);
  expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
  if (gatewayClass === "isolated") expect(result.stdout).toContain("supervisor");
});
