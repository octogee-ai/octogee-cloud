import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  consumerDependencies,
  consumerSources,
  exportSpecifiers,
  publish,
  publishedManifest,
  publishedVersionExists,
  releaseVersion,
  undeclaredImports,
  unexpectedPackedFiles,
} from "../ci/release-packages.mjs";

const source = {
  name: "@octogee/core",
  version: "1.0.0",
  private: true,
  license: "MIT",
  type: "module",
  files: ["dist"],
  exports: {
    "./config": { types: "./dist/config.d.ts", default: "./dist/config.js" },
  },
  scripts: { build: "tsc" },
  dependencies: { pg: "^8.23.1" },
  devDependencies: { "@octogee/shared": "file:../shared", typescript: "^7.0.2" },
  peerDependencies: { "@octogee/shared": "^1.0.0", vitest: "^4.0.0" },
  peerDependenciesMeta: { vitest: { optional: true } },
  overrides: { qs: "^6.17.0" },
};
const options = { version: "0.2.0", directory: "core", publishedNames: ["@octogee/core", "@octogee/shared"] };

describe("release version", () => {
  it("takes the version from a vX.Y.Z tag", () => {
    expect(releaseVersion("v0.2.0")).toBe("0.2.0");
  });

  it.each(["0.2.0", "v0.2", "v0.2.0-rc.1", undefined])("refuses %s", (tag) => {
    expect(() => releaseVersion(tag)).toThrow("A release tag looks like v0.1.0");
  });
});

describe("published package manifest", () => {
  it("stamps the release version, pins sibling packages to it and drops what only builds in this repository", () => {
    const published = publishedManifest(source, options);
    expect(published.version).toBe("0.2.0");
    expect(published.peerDependencies).toEqual({ "@octogee/shared": "0.2.0", vitest: "^4.0.0" });
    expect(published.dependencies).toEqual({ pg: "^8.23.1" });
    for (const field of ["private", "scripts", "devDependencies", "overrides"]) expect(published).not.toHaveProperty(field);
  });

  it("names the repository directory it was published from", () => {
    expect(publishedManifest(source, options).repository).toEqual({
      type: "git", url: "git+https://github.com/octogee-ai/octogee-cloud.git", directory: "core",
    });
  });

  it("refuses a dependency that only resolves inside this repository", () => {
    expect(() => publishedManifest({ ...source, dependencies: { helper: "file:../helper" } }, options))
      .toThrow("names helper at file:../helper");
  });

  it("refuses a sibling package that is not in the published set", () => {
    expect(() => publishedManifest({ ...source, dependencies: { "@octogee/fleet-tools": "^1.0.0" } }, options))
      .toThrow("@octogee/fleet-tools, which is not in the published set");
  });

  it("refuses an export without types or outside dist", () => {
    expect(() => publishedManifest({ ...source, exports: { "./config": "./dist/config.js" } }, options))
      .toThrow("must name both types and default");
    expect(() => publishedManifest({ ...source, exports: { "./config": { types: "./src/config.ts", default: "./dist/config.js" } } }, options))
      .toThrow("points outside dist");
  });

  it("refuses a package with no license or a files list other than dist", () => {
    expect(() => publishedManifest({ ...source, license: undefined }, options)).toThrow("names no license");
    expect(() => publishedManifest({ ...source, files: ["dist", "src"] }, options)).toThrow("exactly its dist directory");
  });
});

describe("packed files", () => {
  it("reports export targets the tarball lacks and files outside dist", () => {
    expect(unexpectedPackedFiles(source, ["package.json", "LICENSE", "dist/config.js", "src/config.ts", "dist/config.spec.js"]))
      .toEqual(["missing dist/config.d.ts", "unexpected src/config.ts", "unexpected dist/config.spec.js"]);
  });

  it("accepts a tarball of dist, the manifest, the readme and the license", () => {
    expect(unexpectedPackedFiles(source, ["package.json", "README.md", "LICENSE", "dist/config.js", "dist/config.d.ts"])).toEqual([]);
  });
});

describe("runtime imports", () => {
  it("reports a package a module imports but the manifest does not declare", () => {
    const modules = [{ path: "dist/testing/app.js", source: 'import request from "supertest";\nimport { x } from "pg";\nconst y = await import("node:fs");\nimport "./side.js";' }];
    expect(undeclaredImports(publishedManifest(source, options), modules)).toEqual(["dist/testing/app.js imports supertest"]);
  });

  it("accepts builtins, subpaths of declared packages and a flag argument named from", () => {
    const modules = [{ path: "dist/a.js", source: 'import { join } from "path";\nimport { vi } from "vitest/node";\nimport { y } from "@octogee/shared/types/agent";\nrun(["--from", file, "--json"]);' }];
    expect(undeclaredImports(publishedManifest(source, options), modules)).toEqual([]);
  });
});

describe("scratch consumer", () => {
  it("imports and type-checks every export of every published package", () => {
    const shared = { ...source, name: "@octogee/shared", exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } };
    expect(exportSpecifiers(shared)).toEqual(["@octogee/shared"]);
    const { specifiers, imports, types } = consumerSources([publishedManifest(source, options), shared]);
    expect(specifiers).toEqual(["@octogee/core/config", "@octogee/shared"]);
    expect(imports).toContain('"@octogee/core/config"');
    expect(types).toContain('import * as module1 from "@octogee/shared";');
  });

  it("installs the optional peers the exports need, but not a sibling package", () => {
    const published = publishedManifest({ ...source, peerDependenciesMeta: { vitest: { optional: true }, "@octogee/shared": { optional: true } } }, options);
    expect(consumerDependencies([published, { ...source, name: "@octogee/shared" }])).toEqual({ vitest: "^4.0.0" });
  });
});

describe("npm publish", () => {
  const out = mkdtempSync(join(tmpdir(), "release-packages-"));
  writeFileSync(join(out, "packages.json"), JSON.stringify([
    { name: "@octogee/shared", version: "0.2.0", directory: "shared", tarball: "/release/octogee-shared-0.2.0.tgz" },
    { name: "@octogee/core", version: "0.2.0", directory: "core", tarball: "/release/octogee-core-0.2.0.tgz" },
  ]));

  it("treats E404 as unpublished and fails on any other npm error", () => {
    expect(publishedVersionExists("@octogee/core", "0.2.0", () => ({ status: 0, stdout: '"0.2.0"\n', stderr: "" }))).toBe(true);
    expect(publishedVersionExists("@octogee/core", "0.2.0", () => ({ status: 1, stdout: "", stderr: "npm error code E404\n" }))).toBe(false);
    expect(() => publishedVersionExists("@octogee/core", "0.2.0", () => ({ status: 1, stdout: "", stderr: "npm error code ETIMEDOUT\n" })))
      .toThrow("npm view @octogee/core@0.2.0 failed");
  });

  it("publishes what is missing with provenance and public access, and skips what a previous run published", () => {
    const npm = vi.fn();
    const outcomes = publish({ out, exists: (name: string) => name === "@octogee/shared", npm });
    expect(outcomes).toEqual([{ name: "@octogee/shared", published: false }, { name: "@octogee/core", published: true }]);
    expect(npm).toHaveBeenCalledExactlyOnceWith(["publish", "/release/octogee-core-0.2.0.tgz", "--access", "public", "--provenance"]);
  });

  it("dry runs without provenance under its own dist-tag, so a placeholder version below latest still passes", () => {
    const npm = vi.fn();
    publish({ out, dryRun: true, exists: () => false, npm });
    expect(npm).toHaveBeenLastCalledWith(["publish", "/release/octogee-core-0.2.0.tgz", "--access", "public", "--dry-run", "--tag", "dry-run"]);
  });

  it("stops at the first package npm refuses", () => {
    const npm = vi.fn(() => { throw new Error("npm error code ENEEDAUTH"); });
    expect(() => publish({ out, exists: () => false, npm })).toThrow("ENEEDAUTH");
    expect(npm).toHaveBeenCalledOnce();
  });
});
