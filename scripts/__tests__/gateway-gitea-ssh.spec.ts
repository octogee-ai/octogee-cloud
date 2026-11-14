import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const entrypoint = readFileSync(path.resolve(import.meta.dirname, "../../infra/gateway/entrypoint.sh"), "utf8");
const sshSetup = entrypoint.slice(entrypoint.indexOf('GIT_SSH_HOST="'), entrypoint.indexOf("# ── OpenClaw environment inputs"));
const homes: string[] = [];

function configure(gatewayClass: string, slug = "sep091"): string {
  const home = mkdtempSync(path.join(tmpdir(), "octogee-gitea-ssh-"));
  homes.push(home);
  execFileSync("sh", ["-ec", `log() { :; }\n${sshSetup}`], {
    env: { ...process.env, HOME: home, OPENCLAW_DIR: "/home/node/.openclaw", GIT_SSH_HOST: "gitea.test.internal", GATEWAY_CLASS_EFFECTIVE: gatewayClass, BUILDER_SLUG: slug },
    stdio: "pipe",
  });
  return path.join(home, ".ssh/config");
}

function resolved(config: string, host: string): string {
  return execFileSync("ssh", ["-G", "-F", config, host], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })));

describe("gateway Gitea SSH identity", () => {
  it("selects the user's key for an ordinary Git SSH connection", () => {
    const config = configure("isolated");
    const effective = resolved(config, "gitea");
    expect(effective).toContain("hostname gitea.test.internal\n");
    expect(effective).toContain("port 2222\n");
    expect(effective).toContain("identityfile /home/node/.openclaw/customer-keys/sep091/id_ed25519\n");
    expect(effective).toContain("identitiesonly yes\n");
    expect(statSync(config).mode & 0o777).toBe(0o600);
  });

  it("does not offer the user key to other SSH hosts", () => {
    expect(resolved(configure("isolated"), "github.com")).not.toContain("customer-keys");
  });

  it("keeps shared gateways without a default user identity even when a slug is present", () => {
    expect(readFileSync(configure("shared"), "utf8")).not.toContain("IdentityFile");
  });

  it.each(["", "../another-user", "sep091\nHost *"])("rejects an invalid user slug: %j", (slug) => {
    expect(() => configure("isolated", slug)).toThrow();
  });
});
