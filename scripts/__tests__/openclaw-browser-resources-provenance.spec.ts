import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const readJson = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const provenance = readJson("gateway-edge/src/vendor/openclaw-browser-resources/provenance.json") as {
  source: string;
  inputs: { sha256: string; files: string[] };
};
const generator = async () =>
  (await import(pathToFileURL(path.join(root, "gateway-edge/openclaw-browser-resources/provenance.mjs")).href)) as {
    inputsDigest: (root: string, files: string[]) => Promise<string>;
  };

describe("gateway-edge's vendored OpenClaw Browser resource projection", () => {
  it("was generated from the pinned OpenClaw source", () => {
    expect(provenance.source).toBe(readJson("gateway/openclaw-tarball/current.json").sourceSha);
  });

  it("was generated from the generator and adapter files as committed", async () => {
    const { inputsDigest } = await generator();
    expect(provenance.inputs.files).toContain("gateway-edge/openclaw-browser-resources/build.mjs");
    expect(provenance.inputs.files).toContain("gateway-edge/openclaw-browser-resources/entry.ts");
    await expect(inputsDigest(root, provenance.inputs.files)).resolves.toBe(provenance.inputs.sha256);
  });

  it.each([
    "openclaw/ui/src/lib/chat/browser-tab-preview.ts",
    "/etc/hosts",
    "../outside/package-lock.json",
    "gateway-edge/../../outside/package-lock.json",
  ])("refuses %s as a generator input", async (file) => {
    const { inputsDigest } = await generator();
    await expect(inputsDigest(root, [file])).rejects.toThrow("Not a generator input in this repository");
  });
});
