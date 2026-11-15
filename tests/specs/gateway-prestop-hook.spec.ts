import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseAllDocuments } from "yaml";
import { expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
it.each([0, 124])("preserves flush exit %s and makes hook output visible in container logs", (status) => {
  const rendered = execFileSync("helm", ["template", "audit", "charts/octogee-gateway", "--set", "gatewayId=audit", "--set", "image.repository=example/gateway", "--set", "gatewayEdge.image.repository=example/edge", "--set", "env.mmSiteUrl=https://example.test", "--set", "env.mmInternalUrl=http://mattermost:8065", "--set", "gatewayEdge.publicAppOrigins[0]=https://app-test.octogee.com"], { cwd: root, encoding: "utf8" });
  const deployment = parseAllDocuments(rendered).map((doc) => doc.toJSON()).find((doc) => doc?.kind === "Deployment");
  const gateway = deployment.spec.template.spec.containers.find((container: { name: string }) => container.name === "gateway");
  const dir = mkdtempSync("/tmp/octogee-prestop-");
  try {
    const timeout = path.join(dir, "timeout");
    writeFileSync(timeout, `#!/bin/sh\necho flush-started\necho flush-detail >&2\nexit ${status}\n`, { mode: 0o700 });
    const command = gateway.lifecycle.preStop.exec.command[2].replaceAll("/proc/1/fd/1", `${dir}/stdout`).replaceAll("/proc/1/fd/2", `${dir}/stderr`);
    const result = spawnSync("sh", ["-c", command], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
    expect(result.status).toBe(status);
    expect(readFileSync(`${dir}/stdout`, "utf8")).toContain("flush-started");
    const errors = readFileSync(`${dir}/stderr`, "utf8");
    expect(errors).toContain("flush-detail");
    if (status) expect(errors).toContain("🔴 [prestop-flush] failed exitCode=124");
    else expect(errors).not.toContain("failed exitCode");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
