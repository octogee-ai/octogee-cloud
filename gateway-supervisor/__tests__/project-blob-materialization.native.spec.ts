import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
describe.skipIf(process.env.OCTOGEE_NATIVE_DOCKER_TEST !== "1")("native Linux GCS project-cache reader", () => {
  it("verifies actual HTTP streams and filesystem publication in a cached, network-isolated container", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "project-blob-native-"));
    const name = `project-blob-native-${randomUUID()}`;
    try {
      await run(path.resolve("node_modules/.bin/esbuild"), [path.resolve("lib/project-blob-materialization.ts"), "--bundle", "--platform=node", "--format=esm", "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);", `--outfile=${path.join(fixture, "reader.ts")}`]);
      await fs.copyFile(path.resolve("__tests__/project-blob-materialization.fixture.mjs"), path.join(fixture, "fixture.mjs"));
      await fs.writeFile(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
      const result = await run("docker", ["run", "--rm", "--pull=never", "--network=none", "--entrypoint=node", "--name", name,
        "-v", `${fixture}:/fixture:ro`, process.env.OCTOGEE_NATIVE_DOCKER_IMAGE || "node:22-bookworm-slim",
        "--experimental-strip-types", "/fixture/fixture.mjs"], { timeout: 25_000, maxBuffer: 1024 * 1024 });
      expect(result.stdout).toContain("native blob scenarios: 7 passed");
    } finally {
      await run("docker", ["rm", "-f", name]).catch(error => { if (!String(error.stderr).includes("No such container")) throw error; });
      await fs.rm(fixture, { recursive: true, force: true });
    }
  }, 30_000);
});
