import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isProductModule,
  loadPlatformBoundaryManifest,
  outsideDependenciesOf,
  platformBoundaryReport,
  platformDependencyReport,
  platformFiles,
  platformReferenceReport,
  productReferencesOf,
  reachableSources,
  resolveImport,
  type PlatformBoundaryManifest,
} from "../lib/platform-boundary.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const manifest = loadPlatformBoundaryManifest(repoRoot);
const report = platformBoundaryReport(manifest, repoRoot);
const referenceReport = platformReferenceReport(manifest, repoRoot);
const dependencyReport = platformDependencyReport(manifest, repoRoot);

const fixtureManifest: PlatformBoundaryManifest = {
  platformEntrypoints: [],
  platformRoots: ["platform/scripts/", "platform/infra/"],
  productModules: ["product/", "platform/scripts/product/", "platform/infra/gateway/extensions/product/", "platform/shared/types/feature-flags.ts"],
  ratchet: [],
  referenceRatchet: [],
  dependencyRatchet: [],
};

describe("platform boundary", () => {
  it("resolves relative, package and alias imports to repository sources, declared or not", () => {
    const from = resolve(repoRoot, "platform/octogee-api/src/main.ts");
    expect(resolveImport("./app.js", from, repoRoot)).toBe(resolve(repoRoot, "platform/octogee-api/src/app.ts"));
    expect(resolveImport("@octogee/core/deployment-environment", from, repoRoot))
      .toBe(resolve(repoRoot, "platform/core/src/deployment-environment.ts"));
    expect(resolveImport("@octogee/shared/types/feature-flags", from, repoRoot))
      .toBe(resolve(repoRoot, "platform/shared/types/feature-flags.ts"));
    expect(resolveImport("../../gateway-edge/src/routes/mount-cluster-routes.js", from, repoRoot))
      .toBe(resolve(repoRoot, "platform/gateway-edge/src/routes/mount-cluster-routes.ts"));
    expect(resolveImport("@octogee/product-core/customer-hosting", from, repoRoot))
      .toBe(resolve(repoRoot, "product/core/src/customer-hosting.ts"));
    expect(resolveImport("@octogee/product-shared/types/billing", from, repoRoot))
      .toBe(resolve(repoRoot, "product/shared/types/billing.ts"));
    expect(resolveImport("@octogee/product-core/not-exported", from, repoRoot)).toBeNull();
    expect(resolveImport("@octogee/product-shared/types/billing", resolve(repoRoot, "platform/core/src/index.ts"), repoRoot))
      .toBe(resolve(repoRoot, "product/shared/types/billing.ts"));
    expect(resolveImport("express", from, repoRoot)).toBeNull();
  });

  it("follows package symlinks so an aliased import resolves to its real source", () => {
    const from = resolve(repoRoot, "functions/src/orchestrator/trial-grant.ts");
    expect(resolveImport("../_shared/types/glm.js", from, repoRoot)).toBe(resolve(repoRoot, "platform/shared/types/glm.ts"));
  });

  it("matches product modules by file or directory prefix", () => {
    expect(isProductModule("app/src/main.tsx", ["app/"])).toBe(true);
    expect(isProductModule("platform/gateway-edge/src/routes/posts.ts", ["platform/gateway-edge/src/routes/posts.ts"])).toBe(true);
    expect(isProductModule("platform/gateway-edge/src/routes/posts-query.ts", ["platform/gateway-edge/src/routes/posts.ts"])).toBe(false);
  });

  it("names every product module reachable from a platform entrypoint in the ratchet", () => {
    expect(report.newViolations, "new product reach from platform entrypoints; move the import behind the product extension or, if unavoidable, add it to the ratchet").toEqual([]);
  });

  it("keeps the ratchet honest: every entry is still reachable", () => {
    expect(report.staleRatchet, "ratchet entries no longer reached from platform entrypoints; remove them from platform/scripts/lib/platform-boundary.json").toEqual([]);
  });

  it("keeps the product composition roots out of the platform entrypoints", () => {
    for (const root of ["product/octogee-api/src/index.ts", "product/octogee-api/src/product.ts", "product/octogee-api/src/main.ts", "product/octogee-api/src/cluster/routes/product-cluster-routes.ts", "product/glm-controller/src/main.ts", "product/gateway-edge/src/main.ts", "functions/src/index.ts"]) {
      expect(manifest.platformEntrypoints).not.toContain(root);
      expect(report.reached).not.toContain(root);
    }
  });

  it("keeps the Firestore test store on the product side and out of non-test files", () => {
    expect(isProductModule("platform/core/src/testing/firestore-store/store.ts", manifest.productModules)).toBe(true);
    expect(isProductModule("platform/core/dist/testing/firestore-store/store.js", manifest.productModules)).toBe(true);
    expect(platformFiles(manifest, repoRoot).filter((file) => file.includes("testing/firestore-store"))).toEqual([]);
    expect([...reachableSources(manifest.platformEntrypoints, repoRoot)].filter((file) => file.includes("testing/firestore-store"))).toEqual([]);
    const isTestFile = (file: string) =>
      /\.spec\.ts$/.test(file) || file.includes("/test-setup/") || file.startsWith("platform/core/src/testing/firestore-store/");
    const importers = execFileSync("git", ["grep", "--recurse-submodules", "-l", "testing/firestore-store", "--", "*.ts", ":!*/dist/*"], { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .filter((file) => file !== "" && /["']([^"']*testing\/firestore-store[^"']*)["']/.test(readFileSync(resolve(repoRoot, file), "utf8")));
    expect(importers.filter((file) => !isTestFile(file))).toEqual([]);
  });

  it("finds product paths a platform file names by repository path, platform path or parent-relative path", () => {
    expect(productReferencesOf("platform/infra/gateway/Dockerfile", "COPY infra/gateway/extensions/product/ /octogee/extensions/\n", fixtureManifest, repoRoot))
      .toEqual(["platform/infra/gateway/extensions/product/"]);
    expect(productReferencesOf("platform/scripts/ci/run.mjs", "run('node', ['platform/scripts/product/ops/seed.ts'])\n", fixtureManifest, repoRoot))
      .toEqual(["platform/scripts/product/"]);
    expect(productReferencesOf("platform/scripts/ops/run.sh", 'node "$(dirname "$0")/../product/ops/seed.ts"\n', fixtureManifest, repoRoot))
      .toEqual(["platform/scripts/product/"]);
    expect(productReferencesOf("platform/scripts/setup.sh", "npm run --prefix scripts -- npx tsx product/ops/seed.ts\n", fixtureManifest, repoRoot))
      .toEqual(["platform/scripts/product/"]);
    expect(productReferencesOf("platform/infra/gateway/run.sh", "npx tsx product/ops/seed.ts\n", fixtureManifest, repoRoot))
      .toEqual([]);
    expect(productReferencesOf("platform/scripts/ops/run.sh", "see scripts/productive-notes.md, ../../product/x and /octogee/scripts/product/x\n", fixtureManifest, repoRoot))
      .toEqual([]);
  });

  it.each([
    ["a leading ./", "platform/scripts/ops/run.sh", "tsx ./scripts/product/ops/a.ts\n", "platform/scripts/product/"],
    ["a braced variable root", "platform/scripts/ops/run.sh", 'node "${REPO}/scripts/product/ops/a.ts"\n', "platform/scripts/product/"],
    ["a plain variable root", "platform/scripts/ops/run.sh", 'node "$REPO/scripts/product/ops/a.ts"\n', "platform/scripts/product/"],
    ["a command substitution root", "platform/scripts/ops/run.sh", 'node "$(git rev-parse --show-toplevel)/platform/scripts/product/ops/a.ts"\n', "platform/scripts/product/"],
    ["a ./ Docker source", "platform/infra/gateway/Dockerfile", "COPY ./infra/gateway/extensions/product/ /x/\n", "platform/infra/gateway/extensions/product/"],
    ["a script-directory root", "platform/scripts/setup.sh", 'source "$SCRIPT_DIR/product/secrets.sh"\n', "platform/scripts/product/"],
    ["a ./ path from its platform root", "platform/scripts/setup.sh", "npx tsx ./product/ops/a.ts\n", "platform/scripts/product/"],
    ["a repository path climbed to from a directory", "platform/scripts/ops/run.ts", 'resolve(here, "../../scripts/product/ops/a.ts")\n', "platform/scripts/product/"],
  ])("finds a product path written with %s", (_form, file, source, entry) => {
    expect(productReferencesOf(file, source, fixtureManifest, repoRoot)).toEqual([entry]);
  });

  it("finds product modules a platform TypeScript file imports", () => {
    expect(productReferencesOf("platform/scripts/ops/report.ts", 'import { FLAGS } from "../../shared/types/feature-flags.js";\n', fixtureManifest, repoRoot))
      .toEqual(["platform/shared/types/feature-flags.ts"]);
    expect(productReferencesOf("platform/scripts/ops/report.ts", 'import { TIERS } from "@octogee/product-shared/types/billing";\n', fixtureManifest, repoRoot))
      .toEqual(["product/"]);
    expect(productReferencesOf("platform/scripts/ops/report.ts", 'import { glm } from "../../shared/types/glm.js";\n', fixtureManifest, repoRoot))
      .toEqual([]);
  });

  it("treats tests and product paths under platform roots as outside the platform", () => {
    const files = platformFiles(manifest, repoRoot);
    expect(files).toContain("platform/infra/gateway/Dockerfile");
    expect(files.some((file) => file.startsWith("platform/infra/gateway/extensions/product/"))).toBe(false);
    expect(files.some((file) => file.includes("/__tests__/"))).toBe(false);
  });

  it("names every platform reference to a product path in the reference ratchet", () => {
    expect(referenceReport.newViolations, "platform files under platformRoots reference product paths; move the reference into a product file or, if unavoidable, add it to referenceRatchet").toEqual([]);
  });

  it("keeps the reference ratchet honest: every entry is still referenced", () => {
    expect(referenceReport.staleRatchet, "referenceRatchet entries no longer referenced; remove them from platform/scripts/lib/platform-boundary.json").toEqual([]);
  });

  it("finds packages a platform manifest or lockfile installs from outside platform/", () => {
    const manifestSource = JSON.stringify({
      dependencies: { "@octogee/core": "file:../core", "@octogee/product-core": "file:../../product/core", express: "^5.0.0" },
      devDependencies: { "@octogee/product-shared": "file:../../product/shared" },
    });
    expect(outsideDependenciesOf("platform/glm-controller/package.json", manifestSource, repoRoot))
      .toEqual(["platform/glm-controller/package.json -> @octogee/product-core", "platform/glm-controller/package.json -> @octogee/product-shared"]);
    const lockSource = JSON.stringify({
      packages: {
        "": { dependencies: { "@octogee/product-core": "file:../../product/core" } },
        "node_modules/@octogee/core": { resolved: "file:../core" },
        "node_modules/@octogee/product-core": { resolved: "file:../../product/core" },
        "../../product/shared": { name: "@octogee/product-shared" },
        "node_modules/@octogee/product-shared": { resolved: "../../product/shared", link: true },
        "node_modules/express": { resolved: "https://registry.npmjs.org/express/-/express-5.0.0.tgz" },
      },
    });
    expect(outsideDependenciesOf("platform/glm-controller/package-lock.json", lockSource, repoRoot))
      .toEqual(["platform/glm-controller/package-lock.json -> @octogee/product-core", "platform/glm-controller/package-lock.json -> @octogee/product-shared"]);
  });

  it("names every platform package dependency from outside platform/ in the dependency ratchet", () => {
    expect(dependencyReport.newViolations, "platform package manifests or lockfiles install packages from outside platform/; list product libraries in the product overlay's overlay-dependencies.json").toEqual([]);
  });

  it("keeps the dependency ratchet honest: every entry is still installed", () => {
    expect(dependencyReport.staleRatchet, "dependencyRatchet entries no longer installed; remove them from platform/scripts/lib/platform-boundary.json").toEqual([]);
  });
});
