import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "../..");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(["isolated", "shared"])("makes the %s OpenClaw state root private before any pre-boot step runs", async (gatewayClass) => {
  const root = await mkdtemp(path.join(tmpdir(), "openclaw-dir-private-"));
  roots.push(root);
  const state = path.join(root, ".openclaw");
  await mkdir(state);
  await chmod(state, 0o2775);
  const prefix = (await readFile(path.join(repo, "infra/gateway/entrypoint.sh"), "utf8"))
    .split("# ── User identity")[0]
    .replace("export OPENCLAW_DIR=/home/node/.openclaw", `export OPENCLAW_DIR='${state}'`)
    .replaceAll("/octogee", repo);
  const result = spawnSync("sh", ["-s"], {
    input: `${prefix}\nmkdir -m 700 "$OPENCLAW_DIR/control"\nnode -e "for (const p of [process.env.OPENCLAW_DIR, process.env.OPENCLAW_DIR + '/control']) console.log('mode=' + (require('node:fs').statSync(p).mode & 0o7777).toString(8))"\n`,
    encoding: "utf8",
    env: { ...process.env, OCTOGEE_LIBEXEC_DIR: path.join(repo, "infra/gateway"), HOME: root, GATEWAY_CLASS: gatewayClass, GATEWAY_RUNTIME_KIND: "cluster", GATEWAY_ID: "gw-private" },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("mode=700\nmode=700\n");
});
