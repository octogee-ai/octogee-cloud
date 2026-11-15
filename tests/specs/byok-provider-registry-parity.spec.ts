import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS } from "../../scripts/lib/model-credential-materializer.js";
import {
  MODEL_CREDENTIAL_CATALOG,
  MODEL_CREDENTIAL_STATIC_PROVIDER_IDS,
} from "../../shared/types/model-credentials.js";
import {
  SUPPORTED,
  CANONICAL_BASE_URL,
} from "../../gateway-edge/src/model-credentials/provider-key-format.js";

// The BYOK provider list lives in three places that MUST agree, or a new
// provider "works" in one layer and fails at runtime in another (exactly the
// #1726 review finding). This pins them together so adding a provider to one
// without the others fails CI:
//   1. scripts/lib model-credential-materializer providers (api_key entries) — what byot-sync materializes
//   2. gateway-edge provider-key-format SUPPORTED — what the static key route accepts + probes
//   3. scripts/secret-resolver.mjs BYOK_ID_RE — what the gateway resolver will resolve

const repoRoot = path.resolve(__dirname, "../..");

// Source-inspection guards: a module/spec that moved into @octogee/core is read
// from core/src; scripts/lib + scripts/__tests__ paths fall back to their origin.
const readSrc = (rel: string) => {
  const moved = rel.replace(/^scripts\/(lib|__tests__)\//, "core/src/");
  const target = existsSync(path.join(repoRoot, moved)) ? moved : rel;
  return readFileSync(path.join(repoRoot, target), "utf8");
};

const apiKeyProviders = Object.entries(MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS)
  .filter(([, spec]) => spec.mode === "api_key")
  .map(([id]) => id)
  .sort();
const catalogStaticProviders = [...MODEL_CREDENTIAL_STATIC_PROVIDER_IDS].sort();
const catalogCanonicalBaseUrl = Object.fromEntries(
  MODEL_CREDENTIAL_CATALOG
    .flatMap((entry) =>
      entry.activeSlotEligible && entry.baseUrl.kind === "canonical"
        ? [[entry.id, entry.baseUrl.value] as const]
        : [],
    ),
);

async function resolverGrammarProviders(): Promise<string[]> {
  const resolver = await import(
    pathToFileURL(path.join(repoRoot, "scripts/secret-resolver.mjs")).href
  ) as {
    BYOK_API_KEY_PROVIDER_IDS: readonly string[];
  };
  return [...resolver.BYOK_API_KEY_PROVIDER_IDS].sort();
}

function brokerRouteProviders(): string[] {
  const src = readSrc("platform-api/src/routes/byok-broker.ts");
  if (src.includes("MODEL_CREDENTIAL_STATIC_PROVIDER_IDS")) {
    return catalogStaticProviders;
  }
  const m = src.match(/\(\?<provider>([^)]+)\)/);
  if (!m) throw new Error("could not find the BYOK_API_KEY_RE provider group in byok-broker.ts");
  return m[1].split("|").sort();
}

describe("BYOK provider registry parity (scripts PROVIDERS ↔ route ↔ resolver)", () => {
  it("static provider projections are backed by the shared model credential catalog", async () => {
    expect(
      readSrc("gateway-edge/src/model-credentials/provider-key-format.ts"),
    ).toContain("MODEL_CREDENTIAL_STATIC_PROVIDER_IDS");
    expect(
      readSrc("scripts/lib/model-credential-materializer.ts"),
    ).toContain("MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS");
    expect(
      readSrc("platform-api/src/routes/byok-broker.ts"),
    ).toContain("MODEL_CREDENTIAL_STATIC_PROVIDER_IDS");

    const resolver = await import(
      pathToFileURL(path.join(repoRoot, "scripts/secret-resolver.mjs")).href
    ) as {
      BYOK_API_KEY_PROVIDER_IDS?: readonly string[];
    };
    expect([...(resolver.BYOK_API_KEY_PROVIDER_IDS ?? [])].sort()).toEqual(catalogStaticProviders);
  });

  it("scripts model credential materializer api_key providers == catalog active static providers", () => {
    expect(apiKeyProviders).toEqual(catalogStaticProviders);
  });

  it("gateway-edge SUPPORTED == catalog active static providers", () => {
    expect([...SUPPORTED].sort()).toEqual(catalogStaticProviders);
  });

  it("the secret-resolver grammar accepts exactly the catalog active static providers", async () => {
    expect(await resolverGrammarProviders()).toEqual(catalogStaticProviders);
  });

  it("the byok-broker api-key route grammar accepts exactly the catalog active static providers", () => {
    expect(brokerRouteProviders()).toEqual(catalogStaticProviders);
  });

  it("CANONICAL_BASE_URL matches catalog canonical base URLs", () => {
    expect(CANONICAL_BASE_URL).toEqual(catalogCanonicalBaseUrl);
  });
});
