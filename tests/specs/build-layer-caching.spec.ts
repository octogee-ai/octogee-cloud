import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) => readFileSync(path.join(repoRoot, relativePath), "utf8");

// Dependency-install layers (package*.json COPY + npm ci) must precede the
// source COPY in every first-party Dockerfile — otherwise every source edit
// busts the npm ci layer even with a working cache backend. All of these
// already order correctly; this pins the invariant so it can't regress.
const dockerfileOrderingTargets = [
  { file: "platform-api/Dockerfile", depsMarker: "RUN npm ci --ignore-scripts", sourceMarker: "COPY platform-api/src/ ./src/" },
  { file: "fleet-controller/Dockerfile", depsMarker: "RUN npm ci", sourceMarker: "COPY fleet-controller/src ./src" },
  { file: "gateway-edge/Dockerfile", depsMarker: "RUN npm ci --ignore-scripts", sourceMarker: "COPY gateway-edge/src/ ./src/" },
];

describe.each(dockerfileOrderingTargets)("$file keeps deps-before-source layer ordering", ({ file, depsMarker, sourceMarker }) => {
  it("installs dependencies before the source tree is copied in", () => {
    const source = read(file);
    const depsIndex = source.indexOf(depsMarker);
    const sourceIndex = source.indexOf(sourceMarker);
    expect(depsIndex, `expected to find "${depsMarker}" in ${file}`).toBeGreaterThan(-1);
    expect(sourceIndex, `expected to find "${sourceMarker}" in ${file}`).toBeGreaterThan(-1);
    expect(depsIndex).toBeLessThan(sourceIndex);
  });
});
