import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cloudBakePlan, PLATFORMS } from "../ci/cloud-build.mjs";
import { dockerfileLocalFileDeps } from "../lib/dockerfile-local-file-deps.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const dockerfiles = [...new Set(PLATFORMS.flatMap((platform: string) =>
  Object.values(cloudBakePlan({ registry: "registry.example/octogee/images", sha: "a".repeat(40), platform, root }).target)
    .map((target) => (target as { dockerfile: string }).dockerfile)))].sort();

const dockerfileDeps = dockerfiles.map((file) => dockerfileLocalFileDeps(path.join(root, file), root));

describe("platform image Dockerfiles", () => {
  it("covers every Dockerfile the platform image build uses", () => {
    expect(dockerfiles).toEqual(expect.arrayContaining([
      "fleet-controller/Dockerfile",
      "gateway-edge/Dockerfile",
      "gateway/Dockerfile",
      "gateway/Dockerfile.base",
      "llm-broker/Dockerfile",
      "platform-api/Dockerfile",
    ]));
  });

  it.each(dockerfiles.map((file, index) => [file, dockerfileDeps[index]] as const))(
    "%s provides every local file dependency before its npm installs",
    (_file, deps) => {
      expect(deps.missing).toEqual([]);
    },
  );

  it("checks the npm installs of every service image", () => {
    const installs = dockerfileDeps.flatMap((deps) => deps.installs.map((install) => install.replace(/^.*\((.*)\)$/u, "$1")));
    expect(installs.filter((dir) => dir === "platform-api")).toHaveLength(2);
    expect(installs.filter((dir) => dir === "gateway-edge")).toHaveLength(2);
    expect(installs.filter((dir) => dir === "llm-broker")).toHaveLength(2);
    expect(installs).toEqual(expect.arrayContaining(["fleet-controller", "scripts", "shared"]));
  });

  it("re-includes every packed interface in the Docker build context", () => {
    const lines = fs.readFileSync(path.join(root, ".dockerignore"), "utf8").split("\n").map((line) => line.trim());
    const distDirs = [...new Set(dockerfileDeps.flatMap((deps) => deps.distDirs))];
    expect(distDirs).toEqual(expect.arrayContaining(["core/dist", "core-testing/dist", "shared/dist"]));
    for (const distDir of distDirs) {
      expect(lines).toContain(`!${distDir}/`);
      expect(lines).toContain(`!${distDir}/**`);
    }
  });
});

const BUILDER = [
  "FROM node:26 AS builder",
  "WORKDIR /lib/widget",
  "COPY lib/widget/package.json lib/widget/package-lock.json ./",
  "RUN npm ci",
  "COPY lib/widget/src/ ./src/",
  "RUN npm run build",
];

function consumer(...copies: string[]): string[] {
  return [
    "FROM node:26 AS app",
    ...copies,
    "WORKDIR /app/service",
    "COPY app/service/package.json app/service/package-lock.json ./",
    "RUN npm ci",
  ];
}

function scan(lines: string[]) {
  const context = fs.mkdtempSync(path.join(os.tmpdir(), "dockerfile-deps-"));
  const write = (file: string, contents: string) => {
    fs.mkdirSync(path.dirname(path.join(context, file)), { recursive: true });
    fs.writeFileSync(path.join(context, file), contents);
  };
  write("lib/widget/package.json", JSON.stringify({ name: "widget", files: ["dist"] }));
  write("app/service/package.json", JSON.stringify({ name: "service", dependencies: { widget: "file:../../lib/widget" } }));
  write("Dockerfile", `${lines.join("\n")}\n`);
  try {
    return dockerfileLocalFileDeps(path.join(context, "Dockerfile"), context);
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
}

const NEEDS = "app: npm ci (app/service) needs widget (dependencies)";

describe("local packages built in a stage", () => {
  it("accepts a package whose manifest and dist are copied from the stage that built it", () => {
    const deps = scan([...BUILDER, ...consumer(
      "COPY --from=builder /lib/widget/package.json /lib/widget/",
      "COPY --from=builder /lib/widget/dist /lib/widget/dist",
    )]);

    expect(deps.missing).toEqual([]);
    expect(deps.distDirs).toEqual([]);
  });

  it("accepts a package copied from a stage derived from the one that built it", () => {
    const deps = scan([...BUILDER, "FROM builder AS packaged", "RUN true", ...consumer(
      "COPY --from=packaged /lib/widget/package.json /lib/widget/",
      "COPY --from=packaged /lib/widget/dist /lib/widget/dist",
    )]);

    expect(deps.missing).toEqual([]);
  });

  it("reports the dist missing when only the manifest is copied from the stage", () => {
    const deps = scan([...BUILDER, ...consumer("COPY --from=builder /lib/widget/package.json /lib/widget/")]);

    expect(deps.missing).toEqual([`${NEEDS}: lib/widget/dist at /lib/widget/dist`]);
  });

  it("reports the package missing when copied from a stage that never built or received it", () => {
    const deps = scan(["FROM node:26 AS empty", "RUN true", ...consumer(
      "COPY --from=empty /lib/widget/package.json /lib/widget/",
      "COPY --from=empty /lib/widget/dist /lib/widget/dist",
    )]);

    expect(deps.missing).toEqual([
      `${NEEDS}: lib/widget/package.json at /lib/widget/package.json`,
      `${NEEDS}: lib/widget/dist at /lib/widget/dist`,
    ]);
  });

  it("ignores a copy from an outside build context or image", () => {
    const deps = scan(consumer(
      "COPY --from=widget-context /lib/widget/package.json /lib/widget/",
      "COPY --from=registry.example/widget:1 /lib/widget/dist /lib/widget/dist",
    ));

    expect(deps.missing).toEqual([
      `${NEEDS}: lib/widget/package.json at /lib/widget/package.json`,
      `${NEEDS}: lib/widget/dist at /lib/widget/dist`,
    ]);
  });
});
