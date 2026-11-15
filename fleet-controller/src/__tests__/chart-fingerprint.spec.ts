import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeChartFingerprint } from "../chart-fingerprint.js";

function makeChart(layout: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "chart-fp-"));
  for (const [rel, contents] of Object.entries(layout)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop()!, { recursive: true, force: true });
  }
});

function chart(layout: Record<string, string>): string {
  const path = makeChart(layout);
  created.push(path);
  return path;
}

describe("computeChartFingerprint", () => {
  it("returns a stable hex SHA-256 for the same chart bytes", () => {
    const a = chart({
      "Chart.yaml": "name: test\nversion: 1.0.0",
      "values.yaml": "key: value",
      "templates/deployment.yaml": "kind: Deployment",
    });
    const b = chart({
      "Chart.yaml": "name: test\nversion: 1.0.0",
      "values.yaml": "key: value",
      "templates/deployment.yaml": "kind: Deployment",
    });
    const fpA = computeChartFingerprint(a);
    const fpB = computeChartFingerprint(b);
    expect(fpA).toMatch(/^[0-9a-f]{64}$/);
    expect(fpA).toBe(fpB);
  });

  it("differs when any file contents change", () => {
    const a = chart({
      "Chart.yaml": "name: test",
      "templates/deployment.yaml": "kind: Deployment\nspec: {}",
    });
    const b = chart({
      "Chart.yaml": "name: test",
      "templates/deployment.yaml": "kind: Deployment\nspec: { replicas: 2 }",
    });
    expect(computeChartFingerprint(a)).not.toBe(computeChartFingerprint(b));
  });

  it("differs when a file is added", () => {
    const a = chart({
      "Chart.yaml": "name: test",
      "templates/deployment.yaml": "kind: Deployment",
    });
    const b = chart({
      "Chart.yaml": "name: test",
      "templates/deployment.yaml": "kind: Deployment",
      "templates/service.yaml": "kind: Service",
    });
    expect(computeChartFingerprint(a)).not.toBe(computeChartFingerprint(b));
  });

  it("differs when only a file path changes (same contents)", () => {
    const a = chart({
      "templates/deployment.yaml": "shared",
    });
    const b = chart({
      "templates/other.yaml": "shared",
    });
    expect(computeChartFingerprint(a)).not.toBe(computeChartFingerprint(b));
  });

  it("skips symlinks (hermetic — no out-of-tree fingerprint contributions)", () => {
    const target = chart({ "outside.txt": "external" });
    const root = chart({ "Chart.yaml": "name: test" });
    symlinkSync(join(target, "outside.txt"), join(root, "linked.txt"));
    const fpWithSymlink = computeChartFingerprint(root);
    const plain = chart({ "Chart.yaml": "name: test" });
    expect(fpWithSymlink).toBe(computeChartFingerprint(plain));
  });
});
