import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");

// Source-inspection guards: a module/spec that moved into @octogee/core is read
// from core/src; gateway-supervisor/lib + gateway-supervisor/__tests__ paths fall back to their origin.
const readSrc = (rel: string) => {
  const moved = rel.replace(/^gateway-supervisor\/(lib|__tests__)\//, "core/src/");
  const target = existsSync(path.join(repoRoot, moved)) ? moved : rel;
  return readFileSync(path.join(repoRoot, target), "utf8");
};

function source(rel: string): string {
  return readSrc(rel);
}

function expectLocalGatewayRpcException(rel: string): void {
  expect(source(rel), `${rel} must explicitly opt into the temporary local gateway-token bridge`)
    .toMatch(/createGatewayRpc\(\s*\{[\s\S]*?allowLegacyGatewayTokenFallback:\s*true/);
}

describe("gateway-rpc local credential exceptions", () => {
  it("keeps the db-less fleet controller on the explicit local token bridge", () => {
    expectLocalGatewayRpcException("gateway-supervisor/entrypoints/provisioner.ts");
  });

  it("keeps config.patch helper on the explicit local token bridge", () => {
    expectLocalGatewayRpcException("gateway-supervisor/lib/apply-config-patch.ts");
  });
});
