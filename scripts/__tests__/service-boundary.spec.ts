import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SERVICES = ["platform-api", "gateway-edge", "llm-broker", "fleet-controller"] as const;
const cloudRoot = resolve(import.meta.dirname, "../..");

type Manifest = Record<string, unknown>;

function otherServices(service: string): string[] {
  return SERVICES.filter((other) => other !== service);
}

function namesOtherService(path: string, service: string): string | undefined {
  const segments = path.replace(/^\.\//, "").split("/").filter((segment) => segment !== "" && segment !== "." && segment !== "..");
  return otherServices(service).find((other) => segments[0] === other);
}

function packageReferences(service: string, manifest: Manifest, packageNames: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, spec] of Object.entries((manifest[field] ?? {}) as Record<string, string>)) {
      const byName = packageNames.get(name);
      const byPath = spec.startsWith("file:") ? namesOtherService(spec.slice("file:".length), service) : undefined;
      const other = byName && byName !== service ? byName : byPath;
      if (other) found.push(`${service}/package.json ${field} ${name} -> ${other}`);
    }
  }
  return found;
}

function dockerfileReferences(service: string, dockerfile: string): string[] {
  const found: string[] = [];
  for (const line of dockerfile.split("\n")) {
    const instruction = line.trim().match(/^(COPY|ADD)\s+(.*)$/i);
    if (!instruction || /--from=/.test(instruction[2]!)) continue;
    const words = instruction[2]!.split(/\s+/).filter((word) => !word.startsWith("--"));
    for (const source of words.slice(0, -1)) {
      const other = namesOtherService(source, service);
      if (other) found.push(`${service}/Dockerfile ${source} -> ${other}`);
    }
  }
  return found;
}

function tsconfigReferences(service: string, file: string, tsconfig: Manifest): string[] {
  const paths = [
    ...((tsconfig.include ?? []) as string[]),
    ...((tsconfig.files ?? []) as string[]),
    ...((tsconfig.references ?? []) as Array<{ path: string }>).map((reference) => reference.path),
    ...Object.values(((tsconfig.compilerOptions as Manifest | undefined)?.paths ?? {}) as Record<string, string[]>).flat(),
    ...(typeof tsconfig.extends === "string" ? [tsconfig.extends] : []),
  ];
  return paths
    .filter((path) => path.startsWith(".."))
    .flatMap((path) => {
      const other = namesOtherService(path, service);
      return other ? [`${service}/${file} ${path} -> ${other}`] : [];
    });
}

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

function serviceBoundaryViolations(root: string): string[] {
  const packageNames = new Map(SERVICES.map((service) => [readJson(resolve(root, service, "package.json")).name as string, service]));
  return SERVICES.flatMap((service) => {
    const dir = resolve(root, service);
    const tsconfigs = ["tsconfig.json", "tsconfig.spec.json", "tsconfig.build.json"].filter((file) => existsSync(resolve(dir, file)));
    return [
      ...packageReferences(service, readJson(resolve(dir, "package.json")), packageNames),
      ...(existsSync(resolve(dir, "Dockerfile")) ? dockerfileReferences(service, readFileSync(resolve(dir, "Dockerfile"), "utf8")) : []),
      ...tsconfigs.flatMap((file) => tsconfigReferences(service, file, readJson(resolve(dir, file)))),
    ];
  });
}

describe("service build boundary", () => {
  it("builds each service from its own directory and the libraries, never another service's", () => {
    expect(serviceBoundaryViolations(cloudRoot), "a service's package.json, Dockerfile and tsconfig may name only its own directory, the libraries and build tooling").toEqual([]);
  });
});

describe("packageReferences", () => {
  const names = new Map([["@octogee/gateway-edge", "gateway-edge"], ["@octogee/platform-api", "platform-api"]]);

  it("allows the libraries and the service's own package", () => {
    expect(packageReferences("platform-api", {
      name: "@octogee/platform-api",
      dependencies: { "@octogee/core": "file:../core", express: "^5.0.0" },
      devDependencies: { "@octogee/core-testing": "file:../core-testing" },
    }, names)).toEqual([]);
  });

  it("flags another service by package name or by file path", () => {
    expect(packageReferences("platform-api", {
      dependencies: { "@octogee/gateway-edge": "^1.0.0" },
      devDependencies: { "broker-alias": "file:../llm-broker" },
    }, names)).toEqual([
      "platform-api/package.json dependencies @octogee/gateway-edge -> gateway-edge",
      "platform-api/package.json devDependencies broker-alias -> llm-broker",
    ]);
  });
});

describe("dockerfileReferences", () => {
  it("allows the service, the libraries, tooling and stage copies", () => {
    expect(dockerfileReferences("llm-broker", [
      "COPY core/dist /core/dist",
      "COPY llm-broker/src/ ./src/",
      "COPY scripts/ops/sync-local-file-deps.mjs /scripts/ops/",
      "COPY --from=builder /llm-broker/dist ./dist",
    ].join("\n"))).toEqual([]);
  });

  it("flags a copy of another service's files", () => {
    expect(dockerfileReferences("platform-api", [
      "COPY gateway-edge/src/ /gateway-edge/src/",
      "ADD --chown=node llm-broker/package.json fleet-controller/tsconfig.json ./",
    ].join("\n"))).toEqual([
      "platform-api/Dockerfile gateway-edge/src/ -> gateway-edge",
      "platform-api/Dockerfile llm-broker/package.json -> llm-broker",
      "platform-api/Dockerfile fleet-controller/tsconfig.json -> fleet-controller",
    ]);
  });
});

describe("tsconfigReferences", () => {
  it("flags includes, references, paths and extends that reach another service", () => {
    expect(tsconfigReferences("platform-api", "tsconfig.json", {
      extends: "../gateway-edge/tsconfig.json",
      include: ["src/**/*.ts", "../gateway-edge/src/**/*.ts"],
      references: [{ path: "../llm-broker" }, { path: "../core" }],
      compilerOptions: { paths: { "@edge/*": ["../gateway-edge/src/*"] } },
    })).toEqual([
      "platform-api/tsconfig.json ../gateway-edge/src/**/*.ts -> gateway-edge",
      "platform-api/tsconfig.json ../llm-broker -> llm-broker",
      "platform-api/tsconfig.json ../gateway-edge/src/* -> gateway-edge",
      "platform-api/tsconfig.json ../gateway-edge/tsconfig.json -> gateway-edge",
    ]);
  });
});
