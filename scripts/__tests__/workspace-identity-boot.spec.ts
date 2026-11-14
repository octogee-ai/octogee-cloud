import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const command = readFileSync(path.join(repo, "infra/gateway/entrypoint.sh"), "utf8")
  .split("\n").find(line => line.includes("beginWorkspaceIdentityBoot"))!;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace identity boot in the gateway package layout", () => {
  it.each(["shared", "isolated"])("boots %s with dependencies installed under scripts", gatewayClass => {
    const root = mkdtempSync(path.join(tmpdir(), "workspace-identity-boot-"));
    roots.push(root);
    mkdirSync(path.join(root, "core"));
    cpSync(path.join(repo, "core/package.json"), path.join(root, "core/package.json"));
    cpSync(path.join(repo, "core/dist"), path.join(root, "core/dist"), { recursive: true });
    mkdirSync(path.join(root, "scripts"));
    symlinkSync(path.join(repo, "scripts/node_modules"), path.join(root, "scripts/node_modules"));
    const result = spawnSync("bash", ["-c", command.replaceAll("/octogee", root)], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH, GATEWAY_CLASS: gatewayClass, OPENCLAW_CONTROL_IDENTITY: "per-user",
        GATEWAY_ID: "test-gateway", OPENCLAW_DIR: root },
    });
    expect(result.status, result.stderr).toBe(0);
    if (gatewayClass === "isolated") expect(readFileSync(path.join(root, "workspace-identity-boot"), "utf8")).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
