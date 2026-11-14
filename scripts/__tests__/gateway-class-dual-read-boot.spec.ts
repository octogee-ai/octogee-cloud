import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "../..");
const entrypoint = fs.readFileSync(path.join(repo, "infra/gateway/entrypoint.sh"), "utf8");
const header = entrypoint.slice(0, entrypoint.indexOf("# Consistent ISO timestamp logging"));

function boot(env: Record<string, string>) {
  const run = spawnSync("sh", ["-c", `${header}\nprintf '%s' "$GATEWAY_CLASS_EFFECTIVE"`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, OCTOGEE_LIBEXEC_DIR: path.join(repo, "infra/gateway"), ...env },
  });
  return { status: run.status, effectiveClass: run.stdout, stderr: run.stderr };
}

describe("gateway entrypoint class and profile", () => {
  it("boots the class and profile a previous controller renders as builder exactly as isolated", () => {
    const isolated = boot({ GATEWAY_CLASS: "isolated", GATEWAY_PROFILE: "isolated" });
    expect(isolated).toMatchObject({ status: 0, effectiveClass: "isolated" });
    expect(boot({ GATEWAY_CLASS: "builder", GATEWAY_PROFILE: "builder" })).toEqual(isolated);
    expect(boot({ GATEWAY_CLASS: "isolated", GATEWAY_PROFILE: "builder" })).toEqual(isolated);
    expect(boot({})).toMatchObject({ status: 0, effectiveClass: "shared" });
  });

  it("still refuses unknown classes and profiles", () => {
    expect(boot({ GATEWAY_CLASS: "operator" })).toMatchObject({ status: 1, stderr: expect.stringContaining("GATEWAY_CLASS must be shared or isolated") });
    expect(boot({ GATEWAY_CLASS: "isolated", GATEWAY_PROFILE: "operator" }))
      .toMatchObject({ status: 1, stderr: expect.stringContaining("GATEWAY_PROFILE must be standard or isolated") });
  });
});
