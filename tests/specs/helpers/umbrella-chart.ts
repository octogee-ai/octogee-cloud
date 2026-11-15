import { beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const UMBRELLA_PATH = path.join(REPO_ROOT, "charts/octogee");
export const INSTALLATION_VALUES = path.join(REPO_ROOT, "scripts/ops/kind/values.yaml");
const DIGEST = `sha256:${"0".repeat(64)}`;
export const INSTALLATION_SETS: Record<string, string> = {
  ...Object.fromEntries(
    ["octogee-api", "gateway-edge", "glm-controller"].flatMap((chart) => [
      [`${chart}.image.repository`, `registry.example/${chart}`],
      [`${chart}.image.tag`, "aaaaaaa"],
      [`${chart}.image.digest`, DIGEST],
    ]),
  ),
  "llmBroker.image.repository": "registry.example/llm-broker",
  "llmBroker.image.tag": "aaaaaaa",
  "llmBroker.image.digest": DIGEST,
  "glm-controller.platformRelease.sourceSha": "a".repeat(40),
  "glm-controller.platformRelease.gatewayImageRepository": "registry.example/octogee-gateway",
  "glm-controller.platformRelease.gatewayImageTag": `aaaaaaa@${DIGEST}`,
  "glm-controller.platformRelease.gatewayEdgeImageRepository": "registry.example/gateway-edge",
  "glm-controller.platformRelease.gatewayEdgeImageTag": `aaaaaaa@${DIGEST}`,
  "glm-controller.platformRelease.builderImageTag": `${"a".repeat(7)}-oc2026.7.2@sha256:${"b".repeat(64)}`,
};

export interface HelmTemplateOptions {
  extraValues?: string;
  namespace?: string;
  sets?: Record<string, string>;
  isUpgrade?: boolean;
}

export interface UmbrellaChartHarness {
  helmTemplate: (opts?: HelmTemplateOptions) => string;
}

export function useUmbrellaChart(tempPrefix = "octogee-umbrella-chart-"): UmbrellaChartHarness {
  let tempChartRoot: string | null = null;
  let chartUnderTest = UMBRELLA_PATH;
  let extraValuesSequence = 0;

  beforeAll(() => {
    if (!fs.existsSync(UMBRELLA_PATH)) {
      throw new Error(`umbrella chart not found at ${UMBRELLA_PATH}`);
    }
    tempChartRoot = fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix));
    const sourceChart = path.join(tempChartRoot, "octogee");
    fs.cpSync(UMBRELLA_PATH, sourceChart, { recursive: true });
    const packaged = spawnSync(
      "helm",
      ["package", sourceChart, "--destination", tempChartRoot],
      { encoding: "utf-8" },
    );
    if (packaged.status !== 0) {
      throw new Error(
        `helm package failed (status=${packaged.status}):\n--- stderr ---\n${packaged.stderr.slice(0, 2000)}`,
      );
    }
    chartUnderTest = path.join(tempChartRoot, "octogee-0.1.0.tgz");
  });

  afterAll(() => {
    if (tempChartRoot) fs.rmSync(tempChartRoot, { recursive: true, force: true });
  });

  return {
    helmTemplate: (opts: HelmTemplateOptions = {}) => {
      const args = [
        "template",
        "octogee",
        chartUnderTest,
        "-f",
        INSTALLATION_VALUES,
        "-n",
        opts.namespace ?? "octogee-local",
      ];
      if (opts.extraValues) {
        if (!tempChartRoot) throw new Error("umbrella chart is not initialized");
        const extraValuesFile = path.join(
          tempChartRoot,
          `extra-values-${extraValuesSequence++}.yaml`,
        );
        fs.writeFileSync(extraValuesFile, opts.extraValues);
        args.push("-f", extraValuesFile);
      }
      for (const [k, v] of Object.entries({ ...INSTALLATION_SETS, ...opts.sets })) {
        args.push("--set", `${k}=${v}`);
      }
      if (opts.isUpgrade) args.push("--is-upgrade");
      const result = spawnSync("helm", args, { encoding: "utf-8" });
      if (result.status !== 0) {
        throw new Error(
          `helm template failed (status=${result.status}):\n--- stderr ---\n${result.stderr.slice(0, 2000)}`,
        );
      }
      return result.stdout;
    },
  };
}

export function findDoc(out: string, kind: string, name: string): string | null {
  const docs = out.split(/^---\s*$/m);
  return (
    docs.find((d) => {
      if (!new RegExp(`^kind:\\s*${kind}\\s*$`, "m").test(d)) return false;
      return new RegExp(`^  name:\\s*${name}\\s*$`, "m").test(d);
    }) ?? null
  );
}
