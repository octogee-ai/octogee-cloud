import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.resolve(__dirname, "../..");
const LEGACY_RUNTIME_COLLECTION = /(?:collection\(["']glmGateways["']\)|GLM_GATEWAYS_COLLECTION)/u;

const POLICY_AND_CREDENTIAL_SOURCES = [
  "gateway-edge/src/routes/byosub-health.ts",
  "gateway-edge/src/routes/byosub.ts",
  "octogee-api/src/lib/model-broker-limits.ts",
  "octogee-api/src/lib/sa-to-tenant.ts",
  "octogee-api/src/routes/fleet-broker.ts",
  "octogee-api/src/routes/byok-broker.ts",
  "scripts/entrypoints/byosub-syncback-runner.ts",
  "scripts/entrypoints/pre-boot-config.ts",
] as const;

describe("durable gateway authority boundary", () => {
  it("keeps non-telemetry policy and credential paths out of the runtime revision collection", () => {
    const violations = POLICY_AND_CREDENTIAL_SOURCES.filter((relativePath) =>
      LEGACY_RUNTIME_COLLECTION.test(
        readFileSync(path.join(REPOSITORY_ROOT, relativePath), "utf8"),
      ),
    );

    expect(violations).toEqual([]);
  });
});
