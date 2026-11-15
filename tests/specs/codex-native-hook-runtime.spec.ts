import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const verifier = path.resolve(import.meta.dirname, "../../gateway/verify-codex-native-hook-runtime.mjs");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function verify(symbol: string | null) {
  const root = mkdtempSync(path.join(tmpdir(), "codex-native-hook-"));
  roots.push(root);
  mkdirSync(path.join(root, "dist"));
  mkdirSync(path.join(root, "node_modules/openclaw"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@openclaw/codex", type: "module" }));
  writeFileSync(path.join(root, "node_modules/openclaw/package.json"), JSON.stringify({
    name: "openclaw", type: "module", exports: { "./plugin-sdk/native-hook-relay-runtime": "./relay.js" },
  }));
  writeFileSync(path.join(root, "node_modules/openclaw/relay.js"), "export function registerNativeHookRelayForBundledRuntime() {}\n");
  writeFileSync(path.join(root, "dist/index.js"), "export default {};\n");
  if (symbol) writeFileSync(path.join(root, "dist/run-attempt.js"),
    `import { ${symbol} } from 'openclaw/plugin-sdk/native-hook-relay-runtime';\nexport { ${symbol} };\n`);
  return spawnSync(process.execPath, [verifier, path.join(root, "package.json")], { encoding: "utf8" });
}

describe("Codex lazy native-hook runtime linkage", () => {
  it("rejects the retired SDK export even when the plugin entry imports successfully", () => {
    const result = verify("registerRetainedNativeHookRelayForBundledRuntime");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not provide an export named 'registerRetainedNativeHookRelayForBundledRuntime'");
  });

  it("imports the source-matched native-hook consumer", () => {
    const result = verify("registerNativeHookRelayForBundledRuntime");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS (1 modules)");
  });

  it("fails when no native-hook consumer was packaged", () => {
    const result = verify(null);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("consumer is absent");
  });
});
