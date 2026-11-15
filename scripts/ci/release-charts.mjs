import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { PLATFORM_IMAGES } from "./cloud-build.mjs";
import { releaseVersion } from "./release-packages.mjs";

export const CHART_REGISTRY = "ghcr.io/octogee-ai/octogee-cloud/charts";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OPENCLAW_PIN = "infra/gateway/openclaw-tarball/current.json";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HELM = "helm";
const GATEWAY_EDGE = "gateway-edge";

function releaseImages({ tag, manifest }) {
  if (!/^[a-f0-9]{40}$/.test(manifest?.sha ?? "")) throw new Error("The image manifest names no full commit SHA");
  const digest = name => {
    const value = manifest.images?.[name]?.digest;
    if (!DIGEST.test(value ?? "")) throw new Error(`The image manifest has no index digest for ${name}`);
    return value;
  };
  const repository = name => `${manifest.registry}/${name}`;
  return {
    repository,
    image: name => ({ repository: repository(name), tag, digest: digest(name) }),
    pinned: name => `${manifest.sha.slice(0, 7)}@${digest(name)}`,
  };
}

export function platformReleaseValues({ tag, manifest, openclawSourceSha }) {
  const { repository, image, pinned } = releaseImages({ tag, manifest });
  return {
    global: { computer: { bridge: { image: image("vm-bridge") } } },
    "octogee-api": { image: image("octogee-api") },
    llmBroker: { image: image("octogee-api") },
    [GATEWAY_EDGE]: { image: image(GATEWAY_EDGE) },
    "glm-controller": {
      image: image("glm-controller"),
      platformRelease: {
        sourceSha: manifest.sha,
        gatewayImageRepository: repository("octogee-gateway"),
        gatewayImageTag: pinned("octogee-gateway"),
        builderImageTag: pinned("octogee-gateway-builder"),
        gatewayEdgeImageRepository: repository(GATEWAY_EDGE),
        gatewayEdgeImageTag: pinned(GATEWAY_EDGE),
        openclawSourceSha,
      },
    },
  };
}

export function gatewayReleaseValues({ tag, manifest }) {
  const { repository, pinned } = releaseImages({ tag, manifest });
  return {
    image: { repository: repository("octogee-gateway") },
    imageTag: pinned("octogee-gateway"),
    gatewayEdge: { image: { repository: repository(GATEWAY_EDGE), tag: pinned(GATEWAY_EDGE) } },
  };
}

export const PUBLISHED_CHARTS = [
  {
    directory: "helm/octogee",
    releaseValues: platformReleaseValues,
    templateArgs: [
      "-f", "scripts/ops/kind/values.yaml", "-n", "octogee-local", "--set", "global.computer.enabled=true", "--set", "global.computer.cidr=10.8.0.0/16",
      "--set", "global.computer.projectId=example", "--set", "global.computer.serviceAccountEmail=vm@example.iam.gserviceaccount.com",
      "--set", "global.computer.kubernetesApiHost=10.0.0.1", "--set", "global.computer.vmSpec.machineType=n2-standard-2",
    ],
  },
  {
    directory: "helm/octogee-gateway",
    releaseValues: gatewayReleaseValues,
    templateArgs: ["--set", "gatewayId=release-check", "--set", "env.mmSiteUrl=https://chat.example.com", "--set", "env.mmInternalUrl=http://mattermost:8065", "--set", "gatewayEdge.publicAppOrigins[0]=https://app.example.com"],
  },
  { directory: "helm/monitoring", templateArgs: [] },
];

function leaves(values, path = []) {
  return Object.entries(values).flatMap(([key, value]) => (value && typeof value === "object" && !Array.isArray(value)
    ? leaves(value, [...path, key])
    : [[[...path, key], value]]));
}

export function stampValues(source, values) {
  const document = parseDocument(source);
  if (document.errors.length) throw new Error(`values.yaml does not parse: ${document.errors[0].message}`);
  for (const [path, value] of leaves(values)) document.setIn(path, value);
  return document.toString({ lineWidth: 0 });
}

export function expectedReferences(values) {
  const references = [];
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (typeof node.repository === "string" && typeof node.tag === "string" && typeof node.digest === "string") {
      references.push(`${node.repository}:${node.tag}@${node.digest}`);
    }
    Object.values(node).forEach(visit);
  };
  visit(values);
  return [...references, ...leaves(values).map(([, value]) => value).filter(value => typeof value === "string" && /@sha256:/.test(value))];
}

export function placeholderManifest(sha = "0".repeat(40)) {
  return {
    sha, registry: "ghcr.io/octogee-ai/octogee-cloud", source: "https://github.com/octogee-ai/octogee-cloud",
    images: Object.fromEntries(PLATFORM_IMAGES.map(name => [name, { digest: `sha256:${createHash("sha256").update(name).digest("hex")}` }])),
  };
}

const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...options });
const chartName = directory => parseDocument(readFileSync(join(directory, "Chart.yaml"), "utf8")).get("name");

function chartValues(chart, { root, tag, manifest }) {
  if (!chart.releaseValues) return undefined;
  return chart.releaseValues({ tag, manifest, openclawSourceSha: readJson(join(root, OPENCLAW_PIN)).sourceSha });
}

export function packageCharts({ root = ROOT, tag, manifest, out }) {
  const version = releaseVersion(tag);
  const directory = resolve(out);
  mkdirSync(directory, { recursive: true });
  const charts = PUBLISHED_CHARTS.map(chart => {
    const stage = join(directory, "stage", chart.directory);
    rmSync(stage, { recursive: true, force: true });
    cpSync(join(root, chart.directory), stage, { recursive: true });
    const values = chartValues(chart, { root, tag, manifest });
    if (values) writeFileSync(join(stage, "values.yaml"), stampValues(readFileSync(join(stage, "values.yaml"), "utf8"), values));
    run(HELM, ["package", stage, "--version", version, "--app-version", tag, "--destination", directory], { stdio: ["ignore", "inherit", "inherit"] });
    const name = chartName(stage);
    return { name, version, directory: chart.directory, archive: join(directory, `${name}-${version}.tgz`) };
  });
  writeFileSync(join(directory, "charts.json"), `${JSON.stringify(charts, null, 2)}\n`);
  return charts;
}

export function verifyCharts({ root = ROOT, tag, manifest, out }) {
  const entries = readJson(join(resolve(out), "charts.json"));
  for (const entry of entries) {
    const chart = PUBLISHED_CHARTS.find(candidate => candidate.directory === entry.directory);
    if (!chart) throw new Error(`${entry.directory} is not in the published chart set`);
    run(HELM, ["lint", entry.archive, ...chart.templateArgs], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
    const rendered = run(HELM, ["template", entry.name, entry.archive, ...chart.templateArgs], { cwd: root });
    const missing = expectedReferences(chartValues(chart, { root, tag, manifest }) ?? {}).filter(reference => !rendered.includes(reference));
    if (missing.length) throw new Error(`${entry.name} ${entry.version} does not render the release images:\n  ${missing.join("\n  ")}`);
    console.log(`${entry.name} ${entry.version} lints and renders the release images`);
  }
  return entries;
}

// eslint-disable-next-line sonarjs/no-os-command-from-path -- helm is the release runner's own tool.
const helmShow = args => spawnSync(HELM, args, { encoding: "utf8" });

export function chartVersionExists(name, version, show = helmShow) {
  const result = show(["show", "chart", `oci://${CHART_REGISTRY}/${name}`, "--version", version]);
  if (result.status === 0) return true;
  if (/not found|manifest unknown|denied: requested access to the resource is denied/i.test(result.stderr ?? "")) return false;
  throw new Error(`helm show chart ${name} ${version} failed:\n${result.stderr}`);
}

export function publishCharts({ out, exists = chartVersionExists, helm = args => run(HELM, args, { stdio: "inherit" }) }) {
  const entries = readJson(join(resolve(out), "charts.json"));
  return entries.map(entry => {
    if (exists(entry.name, entry.version)) {
      console.log(`${entry.name} ${entry.version} is already in ${CHART_REGISTRY}; skipping it`);
      return { name: entry.name, published: false };
    }
    helm(["push", entry.archive, `oci://${CHART_REGISTRY}`]);
    return { name: entry.name, published: true };
  });
}

const option = (argv, name) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const required = (argv, name) => option(argv, name) ?? (() => { throw new Error(`--${name} is required`); })();
const releaseInputs = argv => ({ tag: required(argv, "tag"), manifest: readJson(required(argv, "manifest")), out: required(argv, "out") });

const COMMANDS = {
  "placeholder-manifest": () => process.stdout.write(`${JSON.stringify(placeholderManifest(), null, 2)}\n`),
  package: argv => packageCharts(releaseInputs(argv)),
  verify: argv => verifyCharts(releaseInputs(argv)),
  publish: argv => publishCharts({ out: required(argv, "out") }),
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const [command, ...argv] = process.argv.slice(2);
    if (!Object.hasOwn(COMMANDS, command ?? "")) throw new Error("Usage: release-charts.mjs placeholder-manifest|package|verify|publish [--tag=vX.Y.Z] [--manifest=FILE] --out=DIR");
    COMMANDS[command](argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
