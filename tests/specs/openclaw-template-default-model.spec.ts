import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  catalogEntryForModelRef,
  modelRefForCatalogEntry,
} from "@octogee/shared/types/agent-models";

const repoRoot = path.resolve(__dirname, "../..");
const DEFAULT_MODEL_REF = "platform-openrouter/z-ai/glm-5.2";

function readTemplate() {
  return JSON.parse(
    readFileSync(path.join(repoRoot, "gateway/openclaw.template.json"), "utf8"),
  );
}

describe("gateway/openclaw.template.json — platform default model", () => {
  it("does not assign the unauthenticated bootstrap agent a platform-funded model", () => {
    const template = readTemplate();

    expect(template.agents.defaults).not.toHaveProperty("model");
    expect(template.agents.defaults.subagents).not.toHaveProperty("model");
  });

  it("keys the default off the shared model catalog", () => {
    const entry = catalogEntryForModelRef(DEFAULT_MODEL_REF);

    expect(entry).not.toBeNull();
    expect(modelRefForCatalogEntry(entry!)).toBe(DEFAULT_MODEL_REF);
  });

  it("keeps the platform model allowlist metadata for mounted user agents", () => {
    const template = readTemplate();
    const entry = catalogEntryForModelRef(DEFAULT_MODEL_REF)!;

    expect(template.agents.defaults.models[DEFAULT_MODEL_REF]).toEqual({
      alias: "glm",
      params: { thinking: entry.defaultReasoningEffort },
    });
    expect(entry.reasoningEfforts).toContain(entry.defaultReasoningEffort);
  });

  it("keeps the haiku fallback pin", () => {
    const template = readTemplate();

    expect(template.agents.defaults.models["anthropic/claude-haiku-4-5"]).toEqual({
      alias: "haiku",
      params: { cacheRetention: "short" },
    });
  });
});
