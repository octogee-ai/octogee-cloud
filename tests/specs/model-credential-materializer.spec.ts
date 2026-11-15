import { existsSync, readFileSync } from "fs";
import path from "path";
import { describe, expect, test } from "vitest";

import {
  buildModelCredentialConfigForProvider,
  type ModelCredentialConfigInput,
} from "../../gateway-supervisor/lib/model-credential-materializer";

const repoRoot = path.resolve(__dirname, "../..");

// Source-inspection guards: a module/spec that moved into @octogee/core is read
// from core/src; gateway-supervisor/lib + gateway-supervisor/__tests__ paths fall back to their origin.
const readSrc = (rel: string) => {
  const moved = rel.replace(/^gateway-supervisor\/(lib|__tests__)\//, "core/src/");
  const target = existsSync(path.join(repoRoot, moved)) ? moved : rel;
  return readFileSync(path.join(repoRoot, target), "utf8");
};

describe("buildModelCredentialConfigForProvider", () => {
  test("materializes Anthropic API keys as auth-profile SecretRefs", () => {
    const out = buildModelCredentialConfigForProvider({
      slug: "smile-wring-011b",
      provider: "anthropic",
    });

    expect(out.authProfiles).toEqual({
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          keyRef: {
            source: "exec",
            provider: "gcp-secret-manager",
            id: "byok-smile-wring-011b-anthropic/latest",
          },
        },
      },
    });
    expect(out.models).toBeNull();
    expect(JSON.stringify(out)).not.toContain("sk-ant-api");
  });

  test("materializes canonical OpenAI-compatible providers without asking for a base URL", () => {
    const out = buildModelCredentialConfigForProvider({
      slug: "smile-wring-011b",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4-6",
    });

    expect(out.models).toEqual({
      providers: {
        "custom-smile-wring-011b": {
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: {
            source: "exec",
            provider: "gcp-secret-manager",
            id: "byok-smile-wring-011b-openrouter/latest",
          },
          models: [
            {
              id: "anthropic/claude-sonnet-4-6",
              name: "anthropic/claude-sonnet-4-6",
            },
          ],
        },
      },
    });
    expect(out.authProfiles).toBeNull();
    expect(out.agentModelOverride).toBe(
      "custom-smile-wring-011b/anthropic/claude-sonnet-4-6",
    );
  });

  test.each<ModelCredentialConfigInput>([
    { slug: "smile-wring-011b", provider: "openai-codex" },
    { slug: "smile-wring-011b", provider: "claude-cli" },
  ])("materializes OAuth provider $provider without SecretRefs", (input) => {
    const out = buildModelCredentialConfigForProvider(input);
    const json = JSON.stringify(out);

    expect(out.authProfiles).toBeTruthy();
    expect(out.models).toBeNull();
    expect(json).toContain('"type":"oauth"');
    expect(json).not.toContain("keyRef");
    expect(json).not.toContain("tokenRef");
    expect(json).not.toContain("byok-");
  });
});

describe("model credential materializer consumers", () => {
  test("model credential materializer owns the catalog-derived implementation", () => {
    const src = readSrc("gateway-supervisor/lib/model-credential-materializer.ts");

    expect(src).toContain("MODEL_CREDENTIAL_CATALOG");
    expect(src).not.toContain('from "./byot-multi-provider-config.js"');
  });

  test("legacy BYOT materializer alias module is gone", () => {
    expect(
      existsSync(path.join(repoRoot, "gateway-supervisor/lib/byot-multi-provider-config.ts")),
    ).toBe(false);
  });

  test.each([
    "gateway-supervisor/lib/byot-sync.ts",
    "gateway-supervisor/lib/byot-sync-runtime.ts",
  ])("%s consumes the model credential materializer facade", (relativePath) => {
    const src = readSrc(relativePath);
    expect(src).toContain("./model-credential-materializer.js");
    expect(src).not.toContain("./byot-multi-provider-config.js");
  });

  test.each([
    "gateway-supervisor/lib/byosub-restore.ts",
  ])("%s consumes the model credential materializer facade", (relativePath) => {
    const src = readSrc(relativePath);

    expect(src).toContain("./model-credential-materializer.js");
    expect(src).not.toContain("./byot-multi-provider-config.js");
  });

  test("byosub health route consumes the model credential materializer facade", () => {
    const src = readSrc("gateway-edge/src/routes/byosub-health.ts");

    expect(src).toContain("@octogee/core/model-credential-materializer");
    expect(src).not.toContain("@octogee/core/byot-multi-provider-config");
  });

  test.each([
    "tests/specs/byok-provider-registry-parity.spec.ts",
    "gateway-supervisor/__tests__/model-credential-golden-path.spec.ts",
    "gateway-supervisor/__tests__/byosub-restore.spec.ts",
    "gateway-supervisor/__tests__/codex-auth-health.spec.ts",
    "gateway-supervisor/__tests__/model-credential-materializer-parity.spec.ts",
    "tests/specs/model-credential-materializer-shape.spec.ts",
  ])("%s tests through the model credential materializer facade", (relativePath) => {
    const src = readSrc(relativePath);

    expect(src).toContain("model-credential-materializer");
    expect(src).not.toContain("byot-multi-provider-config");
  });
});
