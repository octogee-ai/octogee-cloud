import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const packages = ["gateway-edge", "platform-api"];

describe("service Dockerfiles", () => {
  it.each(packages)("copies the local file-deps sync script before %s runs npm build", (packageDir) => {
    const dockerfile = fs.readFileSync(path.resolve("..", packageDir, "Dockerfile"), "utf8");
    const syncCopyIndex = dockerfile.indexOf("scripts/ops/sync-local-file-deps.mjs /scripts/ops/sync-local-file-deps.mjs");
    const buildIndex = dockerfile.indexOf("RUN npm run build");

    expect(syncCopyIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(syncCopyIndex).toBeLessThan(buildIndex);
  });
});
