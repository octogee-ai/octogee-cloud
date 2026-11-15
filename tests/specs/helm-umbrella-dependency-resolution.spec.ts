import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSTALLATION_SETS, INSTALLATION_VALUES } from "./helpers/umbrella-chart";

const REPO_ROOT = path.resolve(__dirname, "../..");
const UMBRELLA_PATH = path.join(REPO_ROOT, "charts/octogee");
const PACKAGE_SCRIPT = path.join(REPO_ROOT, "scripts/package-umbrella-chart.sh");
const INTERNAL_CHARTS = [
  "cloud-sql-proxy",
  "gateway-edge",
  "glm-controller",
  "mattermost",
  "octogee-api",
] as const;

describe("umbrella dependency resolution", () => {
  let tempRoot = "";
  let chartPath = "";

  beforeAll(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-helm-dependencies-"));
    chartPath = path.join(tempRoot, "octogee");
    fs.cpSync(UMBRELLA_PATH, chartPath, { recursive: true });

    for (const chart of INTERNAL_CHARTS) {
      for (const entry of fs.readdirSync(path.join(chartPath, "charts"))) {
        if (entry.startsWith(`${chart}-`) && entry.endsWith(".tgz")) {
          fs.rmSync(path.join(chartPath, "charts", entry));
        }
      }
    }

    const staleChart = path.join(tempRoot, "cloud-sql-proxy");
    fs.cpSync(path.join(chartPath, "charts/cloud-sql-proxy"), staleChart, { recursive: true });
    const deploymentPath = path.join(staleChart, "templates/deployment.yaml");
    const deployment = fs.readFileSync(deploymentPath, "utf8");
    fs.writeFileSync(
      deploymentPath,
      deployment.replace(
        "{{ .Values.image.repository }}:{{ .Values.image.tag }}@{{ .Values.image.digest }}",
        "{{ .Values.image.repository }}:{{ .Values.image.tag }}",
      ),
    );
    execFileSync("helm", ["package", staleChart, "--destination", path.join(chartPath, "charts")]);
  });

  afterAll(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("ignores packaged copies of every source-controlled internal subchart", () => {
    const helmIgnore = fs.readFileSync(path.join(UMBRELLA_PATH, ".helmignore"), "utf8");
    for (const chart of INTERNAL_CHARTS) {
      expect(helmIgnore).toContain(`charts/${chart}-*.tgz`);
    }
  });

  it("packages the source chart when a stale packaged copy is present", () => {
    execFileSync("helm", ["package", chartPath, "--destination", tempRoot]);
    const packagedChart = path.join(tempRoot, "octogee-0.1.0.tgz");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const output = execFileSync(
        "helm",
        [
          "template",
          "octogee",
          packagedChart,
          "-f",
          INSTALLATION_VALUES,
          "-n",
          "octogee-local",
          ...Object.entries({
            ...INSTALLATION_SETS,
            "cloud-sql-proxy.enabled": "true",
            "cloud-sql-proxy.connectionName": "example-project:us-central1:example-instance",
          }).flatMap(([key, value]) => ["--set", `${key}=${value}`]),
        ],
        { encoding: "utf8" },
      );
      expect(output).toContain(
        "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.27.0@sha256:7d156a5c466e31596afd6c8ed134f19c207a297418392fdad2686524ca4e7a3c",
      );
      expect(output).not.toMatch(/cloud-sql-proxy:2\.23\.0(?:\s|$)/);
    }
  });

  it("provides a packaging command for the deployment path", () => {
    const outputDir = path.join(tempRoot, "script-output");
    const packagedChart = execFileSync(
      PACKAGE_SCRIPT,
      ["--output-dir", outputDir],
      { encoding: "utf8" },
    ).trim();
    expect(packagedChart).toBe(
      path.join(fs.realpathSync(outputDir), "octogee-0.1.0.tgz"),
    );
    expect(fs.statSync(packagedChart).isFile()).toBe(true);
  });

  it("does not direct operators to deploy the ambiguous source directory", () => {
    const paths = [
      path.join(REPO_ROOT, "scripts"),
      path.join(REPO_ROOT, "docs/handbook"),
    ];
    const offenders: string[] = [];
    const inspect = (candidate: string): void => {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(candidate)) inspect(path.join(candidate, entry));
        return;
      }
      if (!/\.(?:md|sh|ya?ml)$/.test(candidate)) return;
      const source = fs.readFileSync(candidate, "utf8");
      if (/helm upgrade(?: --install)? octogee (?:\.\/)?(?:platform\/)?charts\/octogee/.test(source)) {
        offenders.push(path.relative(REPO_ROOT, candidate));
      }
    };
    for (const candidate of paths) inspect(candidate);
    expect(offenders).toEqual([]);
  });
});
