import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Pins the contract of the OPENCLAW_GATEWAY_TOKEN require block in
// infra/gateway/entrypoint.sh.
//
// Pre-PR #TBD: entrypoint sourced infra/gateway/resolve-gateway-token.sh,
// which had three fallback layers (env > openclaw.json > fresh random per
// boot). The fresh-random branch caused token drift across reboots on
// isolated gateways where openclaw.json was edited out-of-band, and the
// kubectl-set-env workaround that filled the gap on walter's gateway-edge
// container led to field-manager collision that silently dropped
// INTERNAL_SERVICE_KEY when the helm chart did its next dedup pass.
//
// New model: platform-owned. The fleet controller creates a per-gateway K8s secret
// `gateway-auth-token-<id>`; the chart threads OPENCLAW_GATEWAY_TOKEN via
// secretKeyRef on every container that needs it. Entrypoint REQUIRES the
// env to be non-empty — no fallback, no in-pod generation. If the secret
// is missing the chart fails to render. If somehow the env is empty
// anyway, entrypoint crash-loops the pod with a FATAL banner so the
// failure surfaces in `kubectl describe pod` rather than silently
// producing a gateway nobody can authenticate against.

const ENTRYPOINT = path.resolve(__dirname, "../../infra/gateway/entrypoint.sh");

function runGuardBlock(envToken: string | undefined): {
  status: number | null;
  stderr: string;
} {
  // Run JUST the `require token` guard from entrypoint.sh, not the whole
  // boot — extract the single line via sed so the rest of the entrypoint
  // (which would try to do real K8s/MM/Gitea work) doesn't execute.
  const script = `
    set -e
    log() { echo "$*" >&2; }
    # Mirror the exact guard from entrypoint.sh — keep this in sync if the
    # message format changes there.
    sed -n '/^# ── Require OPENCLAW_GATEWAY_TOKEN/,/^# ── End require/p' "$1" | sh
  `;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  };
  if (envToken !== undefined) env.OPENCLAW_GATEWAY_TOKEN = envToken;
  const r = spawnSync("sh", ["-c", script, "--", ENTRYPOINT], { encoding: "utf8", env });
  return { status: r.status, stderr: r.stderr };
}

describe("infra/gateway/entrypoint.sh — OPENCLAW_GATEWAY_TOKEN platform-owned (fail-loud)", () => {
  it("accepts a non-empty OPENCLAW_GATEWAY_TOKEN from env (the chart's secretKeyRef path)", () => {
    const result = runGuardBlock("a".repeat(48));
    expect(result.status).toBe(0);
  });

  it("FATAL when OPENCLAW_GATEWAY_TOKEN is empty (the fleet controller didn't seed gateway-auth-token-<id>, or chart-secret binding broke)", () => {
    const result = runGuardBlock("");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/OPENCLAW_GATEWAY_TOKEN/);
    expect(result.stderr).toMatch(/FATAL/i);
  });

  it("FATAL when OPENCLAW_GATEWAY_TOKEN is unset entirely (e.g. accidentally trimmed from the chart's env block)", () => {
    const result = runGuardBlock(undefined);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/OPENCLAW_GATEWAY_TOKEN/);
    expect(result.stderr).toMatch(/FATAL/i);
  });
});

function runPublishBlock(opts: {
  profile?: string;
  nodeExit?: number;
  publish?: string;
}): {
  status: number | null;
  stderr: string;
  calledNode: boolean;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-token-publish-"));
  try {
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    const marker = path.join(tmp, "node-called");
    const fakeNode = path.join(bin, "node");
    fs.writeFileSync(
      fakeNode,
      '#!/bin/sh\necho called > "$FAKE_NODE_MARKER"\nexit "$FAKE_NODE_EXIT"\n',
    );
    fs.chmodSync(fakeNode, 0o755);

    const script = `
      set -e
      log() { echo "$*" >&2; }
      export GATEWAY_ID=gw-test
      export GCP_PROJECT_ID=octogee-test
      export OPENCLAW_GATEWAY_TOKEN=token-for-test
      eval "$(sed -n '/^# Publish the fresh gateway auth token/,/^# ── End gateway auth token publish/p' "$1")"
    `;
    const r = spawnSync("sh", ["-c", script, "--", ENTRYPOINT], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        FAKE_NODE_MARKER: marker,
        FAKE_NODE_EXIT: String(opts.nodeExit ?? 0),
        GATEWAY_PROFILE: opts.profile ?? "",
        GATEWAY_AUTH_SECRET_MANAGER_PUBLISH: opts.publish ?? "",
      },
    });
    return {
      status: r.status,
      stderr: r.stderr,
      calledNode: fs.existsSync(marker),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("infra/gateway/entrypoint.sh — gateway token Secret Manager publish boundary", () => {
  it("skips Secret Manager publish by default on standard gateways", () => {
    const result = runPublishBlock({ profile: "standard", nodeExit: 2 });
    expect(result.status).toBe(0);
    expect(result.calledNode).toBe(false);
    expect(result.stderr).toMatch(/skipping gateway auth token Secret Manager publish/);
  });

  it("skips Secret Manager publish by default on isolated gateways", () => {
    const result = runPublishBlock({ profile: "isolated", nodeExit: 2 });
    expect(result.status).toBe(0);
    expect(result.calledNode).toBe(false);
    expect(result.stderr).toMatch(/skipping gateway auth token Secret Manager publish/);
  });

  it("publishes to Secret Manager only when explicitly requested", () => {
    const result = runPublishBlock({ profile: "standard", nodeExit: 0, publish: "true" });
    expect(result.status).toBe(0);
    expect(result.calledNode).toBe(true);
    expect(result.stderr).toMatch(/gateway auth token published to Secret Manager/);
  });
});


function runnerBlockSource(): string {
  const src = fs.readFileSync(ENTRYPOINT, "utf8");
  const start = src.indexOf("# ── In-pod runners:");
  const end = src.indexOf("# ── Runner metrics exporter", start);
  if (start < 0 || end < 0) {
    throw new Error("could not locate the runner startup block in entrypoint.sh");
  }
  return [
    "supervise_runner() {",
    "  echo \"$*\" >> \"$RUNNER_MARKER\"",
    "}",
    src.slice(start, end),
  ].join("\n");
}

function runRunnerBlock(
  profile: string,
  opts: { gatewayClass?: string } = {},
): {
  status: number | null;
  stderr: string;
  runners: string[];
  commands: Map<string, string>;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "entrypoint-runners-"));
  try {
    const marker = path.join(tmp, "runners");
    const gatewayClass = opts.gatewayClass ?? (profile === "isolated" ? "isolated" : "shared");
    const script = `
      set -e
      log() { echo "$*" >&2; }
      TSX=/octogee/scripts/node_modules/.bin/tsx
      ${runnerBlockSource()}
    `;
    const r = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GATEWAY_PROFILE: profile,
        GATEWAY_CLASS_EFFECTIVE: gatewayClass,
        RUNNER_MARKER: marker,
      },
    });
    const calls = fs.existsSync(marker)
      ? fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean)
      : [];
    const commands = new Map<string, string>();
    for (const call of calls) {
      const [name, , ...command] = call.split(" ");
      commands.set(name, command.join(" "));
    }
    return { status: r.status, stderr: r.stderr, runners: [...commands.keys()], commands };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("infra/gateway/entrypoint.sh — in-pod runner boundary", () => {
  it("starts only the db-less controller and neutral side runners on isolated gateways", () => {
    const result = runRunnerBlock("isolated");
    expect(result.status).toBe(0);
    expect(result.runners).toContain("fleet-controller");
    expect(result.runners).not.toContain("preview-proxy");
    expect(result.runners).not.toContain("provisioner");
    expect(result.runners).not.toContain("site-build");
    expect(result.runners).toContain("byosub-syncback");
    expect(result.runners).toContain("system-config-watch");
    expect(result.runners).toContain("isolated-toolchain-hydrator");
    expect(result.stderr).toMatch(/site-build-api disabled/);
  });

  it("starts isolated gateway user runners immediately", () => {
    const result = runRunnerBlock("isolated");
    expect(result.status).toBe(0);
    expect(result.commands.get("system-config-watch")).toBe(
      "/octogee/scripts/node_modules/.bin/tsx /octogee/scripts/entrypoints/system-config-watch.ts",
    );
    expect(result.commands.get("isolated-toolchain-hydrator")).toBe(
      "/octogee/scripts/node_modules/.bin/tsx /octogee/scripts/entrypoints/isolated-toolchain-hydrator.ts",
    );
  });

  it("does not start optional user tool hydration on shared gateways", () => {
    const result = runRunnerBlock("standard", { gatewayClass: "shared" });
    expect(result.status).toBe(0);
    expect(result.runners).not.toContain("isolated-toolchain-hydrator");
  });

  it("starts the db-less fleet controller and cattle side runners on standard gateways", () => {
    const result = runRunnerBlock("standard");
    expect(result.status).toBe(0);
    expect(result.runners).toEqual([
      "fleet-controller",
      "byosub-syncback",
    ]);
    expect(result.commands.get("fleet-controller")).toBe(
      "/octogee/infra/gateway/shared-auxiliary-runner.sh /octogee/scripts/entrypoints/fleet-controller.ts",
    );
    expect(result.stderr).toMatch(/In-gateway project code runners disabled/);
  });

  it("starts compiled Shared auxiliary scripts directly with bounded thread pools", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shared-auxiliary-runner-"));
    try {
      const fakeNode = path.join(tmp, "node");
      fs.writeFileSync(fakeNode, '#!/bin/sh\nprintf "%s\\n" "$NODE_OPTIONS" "$UV_THREADPOOL_SIZE" "$GOMAXPROCS" "$@"\n', { mode: 0o700 });
      const wrapper = path.resolve(path.dirname(ENTRYPOINT), "shared-auxiliary-runner.sh");
      const result = spawnSync("/bin/sh", [wrapper, "/octogee/scripts/entrypoints/fleet-controller.ts", "two words"], {
        encoding: "utf8",
        env: { PATH: tmp, NODE_OPTIONS: "--no-deprecation --max-old-space-size=5632", UV_THREADPOOL_SIZE: "4" },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        "--no-deprecation --max-old-space-size=5632 --v8-pool-size=1",
        "1",
        "1",
        "/octogee/scripts/shared-runners/fleet-controller.mjs",
        "two words",
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

describe("infra/gateway/entrypoint.sh — shell var export contract (subprocess visibility)", () => {
  // OpenClaw and the config helpers run as subprocesses and read OPENCLAW_DIR
  // from their environment. If the
  // top-level OPENCLAW_DIR assignment isn't `export`ed, every subprocess
  // gets KeyError → `set -e` → crashloop. Caught by independent audit on
  // PR #1166 (the test harness happened to export OPENCLAW_DIR itself,
  // masking the production gap). Pin the contract structurally so the
  // export can never be removed without failing this test.
  it("exports OPENCLAW_DIR (visible to subprocesses; not just a shell-local var)", () => {
    const entrypoint = fs.readFileSync(ENTRYPOINT, "utf8");
    expect(entrypoint).toMatch(/^export\s+OPENCLAW_DIR=/m);
  });

  it("exports OPENCLAW_GATEWAY_TOKEN (regression guard — same class as OPENCLAW_DIR)", () => {
    const entrypoint = fs.readFileSync(ENTRYPOINT, "utf8");
    expect(entrypoint).toMatch(/^export\s+OPENCLAW_GATEWAY_TOKEN\b/m);
  });

  it("exports GATEWAY_ID (regression guard — referenced by OpenClaw config substitution)", () => {
    const entrypoint = fs.readFileSync(ENTRYPOINT, "utf8");
    expect(entrypoint).toMatch(/^export\s+GATEWAY_ID=/m);
  });
});

describe("infra/gateway/entrypoint.sh — gateway token stays outside durable config", () => {
  it("does not patch OPENCLAW_GATEWAY_TOKEN into openclaw.json", () => {
    const entrypoint = fs.readFileSync(ENTRYPOINT, "utf8");
    expect(entrypoint).not.toMatch(/setdefault\("gateway"[\s\S]*\["token"\]/);
    expect(entrypoint).not.toMatch(/gateway\.auth\.token re-synced/);
  });
});

describe("infra/gateway/entrypoint.sh — no per-user sourced secret seam", () => {
  it("does not source the retired operator.env file", () => {
    const entrypoint = fs.readFileSync(ENTRYPOINT, "utf8");
    expect(entrypoint).not.toMatch(/operator\.env/);
  });
});
