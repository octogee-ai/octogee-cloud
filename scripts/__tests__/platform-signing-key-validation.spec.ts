import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const pair = () => generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const valid = pair();
const other = pair();
const wrongAlgorithm = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
function platformScriptsWithoutExtensions(dir: string): string {
  const root = path.join(dir, "platform");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  symlinkSync(path.join(repoRoot, "core"), path.join(root, "core"));
  symlinkSync(path.join(repoRoot, "scripts/lib"), path.join(root, "scripts/lib"));
  symlinkSync(path.join(repoRoot, "scripts/verify-secrets.sh"), path.join(root, "scripts/verify-secrets.sh"));
  return root;
}

function verifySecrets(privateKey: string, publicKey: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "octogee-signing-preflight-"));
  try {
    const fixture = path.join(dir, "keys.json");
    writeFileSync(fixture, JSON.stringify({ privateKey, publicKey }), { mode: 0o600 });
    writeFileSync(path.join(dir, "kubectl"), `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "get" || args[1] !== "secret") process.exit(2);
const query = args.find((arg) => arg.startsWith("jsonpath="));
if (!query) process.exit(0);
const fixture = JSON.parse(readFileSync(process.env.OCTOGEE_SIGNING_FIXTURE, "utf8"));
const key = /^jsonpath=\\{\\.data\\.(.+)\\}$/.exec(query)?.[1];
if (!key) process.exit(2);
let value = "fixture-configured-value";
if (["agent-control-router", "byot-sync-internal"].includes(args[2])) {
  value = key === "secret" ? fixture.privateKey : fixture.publicKey;
} else if (args[2] === "mattermost-cloud-sql") value = "fixture-db-password";
process.stdout.write(Buffer.from(value).toString("base64"));
`, { mode: 0o700 });
    writeFileSync(path.join(dir, "gcloud"), `#!/usr/bin/env bash
[[ "$1 $2 $3" == "secrets versions access" ]] || exit 2
printf 'fixture-db-password'
`, { mode: 0o700 });
    return spawnSync("bash", ["scripts/verify-secrets.sh", "--env=custom", "--namespace=signing-test"], {
      cwd: platformScriptsWithoutExtensions(dir),
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, OCTOGEE_SIGNING_FIXTURE: fixture },
      encoding: "utf8",
      timeout: 30_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("platform signing key deployment verification", () => {
  it("accepts matching Ed25519 signing and verification keys without printing them", () => {
    const result = verifySecrets(valid.privateKey, valid.publicKey);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("No secret extensions loaded");
    expect(result.stdout + result.stderr).not.toContain(valid.privateKey.trim());
    expect(result.stdout + result.stderr).not.toContain(valid.publicKey.trim());
  });

  it.each([
    ["retired HMAC signing material", "f".repeat(64), valid.publicKey],
    ["mismatched Ed25519 keys", valid.privateKey, other.publicKey],
    ["a different signing algorithm", wrongAlgorithm.privateKey, wrongAlgorithm.publicKey],
    ["a private key in the runtime public field", valid.privateKey, valid.privateKey],
  ])("refuses deployment with %s", (_reason, privateKey, publicKey) => {
    const result = verifySecrets(privateKey, publicKey);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("agent-control-router — INVALID Ed25519 keypair");
    expect(result.stdout).toContain("byot-sync-internal — INVALID Ed25519 keypair");
    expect(result.stdout + result.stderr).not.toContain(privateKey.trim());
    expect(result.stdout + result.stderr).not.toContain(publicKey.trim());
  });
});
