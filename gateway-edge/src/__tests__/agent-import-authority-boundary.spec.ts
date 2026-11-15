import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

function source(relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

describe("agent import sidecar authority boundary", () => {
  it("uses UID-only authentication and delegates platform authority to the broker", () => {
    const index = source("src/index.ts");
    const runtime = source("src/lib/agent-import-runtime.ts");
    const store = source("src/lib/agent-import-store.ts");
    const git = source("../core/src/http-candidates/agent-transfer/agent-import-git.ts");
    const importSource = source("../core/src/http-candidates/agent-transfer/agent-import-source.ts");
    const dockerfile = source("Dockerfile");

    expect(index).toMatch(/agentImportsLocality\.use\(authenticationFailureLimit, requireAuthenticatedUid\)/);
    expect(index).not.toMatch(/agentImportsLocality\.use\(requireAuth\)/);
    expect(`${runtime}\n${store}`).not.toMatch(/from ["']\.\/db\.js["']/);
    expect(`${runtime}\n${store}`).not.toMatch(/from ["']\.\/firestoreReads\.js["']/);
    expect(`${runtime}\n${store}`).not.toMatch(/from ["']\.\/default-agent-identity\.js["']/);
    expect(`${runtime}\n${store}`).not.toMatch(/storage\.bucket\(|db\.doc\(/);
    expect(`${runtime}\n${store}`).toContain("internalFetch");
    expect(`${runtime}\n${git}\n${importSource}`).not.toContain("spawnSync");
    expect(dockerfile).toContain("CGO_ENABLED=0 go install");
    expect(dockerfile).toContain("COPY --from=gitleaks-builder /go/bin/gitleaks /usr/local/bin/gitleaks");
  });
});
