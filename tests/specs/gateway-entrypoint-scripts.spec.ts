import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import path from "path";

const platformRoot = path.resolve(__dirname, "../..");
const entrypoint = readFileSync(
  path.join(platformRoot, "gateway/entrypoint.sh"),
  "utf8",
);
const dockerfile = readFileSync(
  path.join(platformRoot, "gateway/Dockerfile"),
  "utf8",
);

function entrypointScripts(): string[] {
  const re = /\/octogee\/scripts\/([A-Za-z0-9_.\-/]+\.(?:ts|mjs|js))\b/g;
  const out = new Set<string>();
  for (const m of entrypoint.matchAll(re)) {
    const rel = `scripts/${m[1]}`;
    if (!rel.startsWith("scripts/node_modules/")) out.add(rel);
  }
  return [...out].sort();
}

function entrypointInfraGatewayScripts(): string[] {
  const re = /\/octogee\/gateway\/([A-Za-z0-9_.\-/]+\.(?:mjs|js|sh|json))\b/g;
  const out = new Set<string>();
  for (const m of entrypoint.matchAll(re)) {
    out.add(`gateway/${m[1]}`);
  }
  return [...out].sort();
}

function dockerCoverage(): { files: Set<string>; dirs: string[] } {
  const files = new Set<string>();
  const dirs: string[] = [];
  for (const line of dockerfile.split("\n")) {
    if (!/^\s*COPY\b/.test(line) || !line.includes("/octogee/scripts")) continue;
    const before = line.slice(0, line.indexOf("/octogee/scripts"));
    for (const tok of before.match(/\bscripts\/[A-Za-z0-9_.\-/]+/g) ?? []) {
      if (tok.endsWith("/")) dirs.push(tok);
      else files.add(tok.replace(/\*$/, ""));
    }
  }
  return { files, dirs };
}

function dockerInfraGatewayFiles(): Set<string> {
  const files = new Set<string>();
  for (const line of dockerfile.split("\n")) {
    if (!/^\s*COPY\b/.test(line) || !line.includes("/octogee/gateway")) continue;
    for (const tok of line.match(/\bgateway\/[A-Za-z0-9_.\-/]+/g) ?? []) {
      files.add(tok.replace(/\*$/, ""));
    }
  }
  return files;
}

const { files, dirs } = dockerCoverage();
const covered = (p: string) =>
  files.has(p) ||
  dirs.some((d) => p.startsWith(d)) ||
  p.startsWith("scripts/node_modules/");

describe("gateway entrypoint ↔ Dockerfile coverage", () => {
  it("finds the entry scripts (sanity — regex still matches)", () => {
    expect(entrypointScripts().length).toBeGreaterThan(0);
  });

  it("every script the entrypoint runs is COPYed into the gateway image", () => {
    const uncovered = entrypointScripts().filter((p) => !covered(p));
    expect(
      uncovered,
      `entrypoint.sh runs these but gateway/Dockerfile never COPYs them ` +
        `→ ERR_MODULE_NOT_FOUND crash-loop at boot: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  it("every script the entrypoint runs exists in the repo (no typo)", () => {
    const missing = entrypointScripts().filter(
      (p) => !existsSync(path.join(platformRoot, p)),
    );
    expect(missing, `entrypoint.sh references nonexistent scripts: ${missing.join(", ")}`).toEqual([]);
  });

  it("standard-image gateway scripts the entrypoint runs exist and are COPYed into the standard gateway image", () => {
    const scripts = entrypointInfraGatewayScripts();
    const copied = dockerInfraGatewayFiles();
    const missing = scripts.filter((p) => !existsSync(path.join(platformRoot, p)));
    const isolatedBaseScripts = new Set([
      "gateway/stamp-claude-first-run.mjs",
    ]);
    const uncopied = scripts.filter((p) => !isolatedBaseScripts.has(p) && !copied.has(p));

    expect(missing, `entrypoint.sh references nonexistent gateway files: ${missing.join(", ")}`).toEqual([]);
    expect(
      uncopied,
      `entrypoint.sh runs these but gateway/Dockerfile never COPYs them: ${uncopied.join(", ")}`,
    ).toEqual([]);
  });

  it("installs the octogee config status and adoption helper in every isolated gateway image", () => {
    expect(existsSync(path.join(platformRoot, "gateway/octogee"))).toBe(true);
    expect(dockerfile).toMatch(/COPY gateway\/octogee \/usr\/local\/bin\/octogee/);
    expect(dockerfile).toMatch(/chmod 755[^\n]*\/usr\/local\/bin\/octogee/);
  });

  it("ships no image capability markers — probes are identity-pure (GATEWAY-SIMPLE-ROLL-SPEC)", () => {
    expect(dockerfile).not.toContain("/opt/octogee/capabilities/");
  });

it("does not reinstate the unconditional openclaw file-log mirror", () => {
    expect(entrypoint).not.toContain("tail -F /tmp/openclaw-1000");
    expect(entrypoint).not.toContain("[openclaw-file]");
  });
});
