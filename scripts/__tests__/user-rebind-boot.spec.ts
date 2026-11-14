import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const entrypoint = readFileSync(path.resolve(import.meta.dirname, "../../infra/gateway/entrypoint.sh"), "utf8");
const start = entrypoint.indexOf("BUILDER_SLUG=\"\"\nif [");
const end = entrypoint.indexOf("\nif [ \"$GATEWAY_CLASS_EFFECTIVE\" = \"isolated\" ]; then\n  log \"Pre-boot: removing", start);
if (start < 0 || end < 0) throw new Error("User identity boot section missing");
const identityBoot = entrypoint.slice(start, end);

it.each([
  ["gce-vm", "omarchy", 72, 0],
  ["gce-vm", "x11", 72, 72],
  ["cluster", "x11", 72, 72],
  ["gce-vm", "omarchy", 2, 2],
])("handles %s %s identity exit %s as %s", (runtime, desktop, identityStatus, expected) => {
  const script = `GATEWAY_CLASS_EFFECTIVE=isolated; GATEWAY_ID=old; GATEWAY_RUNTIME_KIND=${runtime}; GATEWAY_COMPUTER_DESKTOP=${desktop}; TSX=identity
log() { :; }
identity() { return ${identityStatus}; }
${identityBoot}`;
  expect(spawnSync("/bin/sh", ["-c", script]).status).toBe(expected);
});
