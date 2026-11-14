

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");
const entrypoint = readFileSync(
  path.join(repoRoot, "infra/gateway/entrypoint.sh"),
  "utf8",
);
const fleetController = readFileSync(
  path.join(repoRoot, "scripts/entrypoints/fleet-controller.ts"),
  "utf8",
);
const gatewayDeployment = readFileSync(
  path.join(repoRoot, "helm/octogee-gateway/templates/deployment.yaml"),
  "utf8",
);
const gatewayValues = readFileSync(
  path.join(repoRoot, "helm/octogee-gateway/values.yaml"),
  "utf8",
);

describe("infra/gateway/entrypoint.sh — no permanent platform persona", () => {
  it("does not bootstrap a bot, PAT, operator agent id, or ops workspace", () => {
    expect(entrypoint).not.toMatch(/bootstrap-mac-ops|MAC_OPS|MM_BOT_USERNAME/);
    expect(entrypoint).not.toMatch(/OPERATOR_AGENT_(?:ID|SLUG)|octogee-ops-/);
    expect(entrypoint).not.toMatch(/workspace\/ops/);
  });
});

describe("User plugin-root preparation", () => {
  it("retires config-adjacent aliases without touching their runtime targets", () => {
    const root = mkdtempSync(path.join(tmpdir(), "plugin-roots-"));
    try {
      const config = path.join(root, "system_config");
      mkdirSync(config);
      for (const name of ["npm", "extensions"]) {
        mkdirSync(path.join(root, name));
        writeFileSync(path.join(root, name, "retained"), name);
        symlinkSync(path.join(root, name), path.join(config, name));
      }
      const run = preparePluginRoots(root);
      expect(run.status, run.stderr).toBe(0);
      for (const name of ["npm", "extensions"]) {
        expect(lstatSync(path.join(config, name), { throwIfNoEntry: false })).toBeUndefined();
        expect(readFileSync(path.join(root, name, "retained"), "utf8")).toBe(name);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses an unrecognized alias without replacing or following it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "plugin-roots-"));
    try {
      const config = path.join(root, "system_config"), unowned = path.join(root, "user-plugins");
      mkdirSync(config);
      mkdirSync(unowned);
      writeFileSync(path.join(unowned, "retained"), "user data");
      symlinkSync(unowned, path.join(config, "npm"));
      const run = preparePluginRoots(root);
      expect(run.status).not.toBe(0);
      expect(readlinkSync(path.join(config, "npm"))).toBe(unowned);
      expect(readFileSync(path.join(unowned, "retained"), "utf8")).toBe("user data");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

function preparePluginRoots(root: string) {
  const start = entrypoint.indexOf('if [ "$GATEWAY_CLASS_EFFECTIVE" != "shared" ]; then', entrypoint.indexOf("# ── Prepare canonical plugin roots"));
  const end = entrypoint.indexOf('\nchmod 600 "$OPENCLAW_CONFIG_PATH"', start);
  spawnSync("git", ["init", "-q", path.join(root, "system_config")], { stdio: "ignore" });
  return spawnSync("sh", ["-c", `set -e\nlog() { printf '%s\\n' "$*"; }\n${entrypoint.slice(start, end)}`], {
    encoding: "utf8",
    env: { ...process.env, GATEWAY_CLASS_EFFECTIVE: "isolated", OPENCLAW_DIR: root, OPENCLAW_CONFIG_PATH: path.join(root, "system_config", "openclaw.json") },
  });
}

describe("Gateway startup state authority", () => {
  it.each([undefined, "/unexpected-state"])("pins preparation children to the canonical state when inherited state is %s", (inheritedState) => {
    const setup = entrypoint.slice(0, entrypoint.indexOf("# Consistent ISO timestamp logging"));
    const configPath = "/home/node/.openclaw/system_config/openclaw.json";
    const run = spawnSync("sh", ["-c", `${setup}\n"$1" -e 'process.stdout.write(JSON.stringify({state:process.env.OPENCLAW_STATE_DIR,config:process.env.OPENCLAW_CONFIG_PATH}))'`, "_", process.execPath], {
      encoding: "utf8",
      env: { ...process.env, OCTOGEE_LIBEXEC_DIR: path.join(repoRoot, "infra/gateway"), GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: "", OPENCLAW_STATE_DIR: inheritedState, OPENCLAW_CONFIG_PATH: configPath },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ state: "/home/node/.openclaw", config: configPath });
  });
});

describe("infra/gateway/entrypoint.sh — identity-pure boot (GATEWAY-SIMPLE-ROLL-SPEC)", () => {
  it("consults no roll, fleet, or boot-transaction state anywhere in boot", () => {
    expect(entrypoint).not.toMatch(/system-config-roll-boot/);
    expect(entrypoint).not.toMatch(/system-config-boot-transaction/);
    expect(entrypoint).not.toMatch(/system-config-status-server/);
    expect(entrypoint).not.toMatch(/SYSTEM_CONFIG_BOOT_ROLE/);
    expect(entrypoint).not.toMatch(/boot-accepted/);
    expect(entrypoint).not.toMatch(/source-frozen|target-candidate/);
    expect(entrypoint).not.toMatch(/GATEWAY_REVISION_ID/);
  });

  it("restores owner-bound runtime system_config before OpenClaw starts", () => {
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    expect(restoreIdx).toBeGreaterThan(-1);
    const openclawStartIdx = entrypoint.indexOf("openclaw gateway run");
    expect(openclawStartIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeLessThan(openclawStartIdx);
  });

  it("recovers an earlier gateway container's locks once OpenClaw's config path is set and before any step can take them", () => {
    const step = `GATEWAY_CLASS="$GATEWAY_CLASS_EFFECTIVE" "$TSX" /octogee/scripts/entrypoints/recover-restarted-gateway-container-locks.ts\n`;
    const recoverIdx = entrypoint.indexOf(step);
    expect(recoverIdx).toBeGreaterThan(-1);
    const configPathIdx = entrypoint.indexOf(`export OPENCLAW_CONFIG_PATH="\${OPENCLAW_CONFIG_PATH:-$OPENCLAW_DIR/openclaw.json}"\nfi\n`);
    expect(configPathIdx).toBeGreaterThan(-1);
    expect(recoverIdx).toBeGreaterThan(configPathIdx);
    for (const later of ["system-config-restore.ts", "isolated-runtime-state-restore.ts", "agent-anchor-restore.ts", "pre-boot-config.ts",
      "surge-openclaw-supervisor.ts", "openclaw gateway run"]) {
      expect(entrypoint.indexOf(later)).toBeGreaterThan(recoverIdx);
    }
    expect(entrypoint.lastIndexOf("\nif [", recoverIdx)).toBeLessThan(entrypoint.lastIndexOf("\nfi\n", recoverIdx));
  });

  it("hydrates the configured user credential after restore and before OpenClaw", () => {
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    const hydrateIdx = entrypoint.indexOf("configured-user-bootstrap.ts");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    expect(hydrateIdx).toBeGreaterThan(restoreIdx);
    expect(openclawIdx).toBeGreaterThan(hydrateIdx);
  });

  it("quarantines persisted shared gateway user cron host-execution rows before OpenClaw starts", () => {
    const quarantineIdx = entrypoint.indexOf("quarantine-user-cron-jobs.mjs");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    expect(quarantineIdx).toBeGreaterThan(-1);
    expect(quarantineIdx).toBeLessThan(openclawIdx);
    const block = entrypoint.slice(entrypoint.indexOf("if [", quarantineIdx), openclawIdx);
    expect(block).toMatch(/GATEWAY_CLASS_EFFECTIVE[^\n]*= "shared"/);
    expect(block).toMatch(/node "\$USER_CRON_QUARANTINE"/);
  });

  it("gates system_config restore on non-shared class and explicit user slug", () => {
    const restoreBlock = entrypoint.slice(
      entrypoint.indexOf("Owner-bound runtime system_config restore"),
      entrypoint.indexOf("apply-gateway-class-policy.mjs"),
    );
    expect(restoreBlock).toMatch(/GATEWAY_CLASS_EFFECTIVE/);
    expect(restoreBlock).toMatch(/!= "shared"/);
    expect(restoreBlock).toMatch(/\$\{BUILDER_SLUG\}/);
  });

  it("reads the user identity from the broker before any owner-scoped pre-boot step", () => {
    const identityIdx = entrypoint.indexOf("/octogee/scripts/entrypoints/user-identity.ts");
    const identityBlock = entrypoint.slice(entrypoint.indexOf("# ── User identity"), entrypoint.indexOf('GIT_SSH_HOST="'));
    expect(identityIdx).toBeGreaterThan(-1);
    expect(identityIdx).toBeLessThan(entrypoint.indexOf("IdentityFile"));
    expect(identityIdx).toBeLessThan(entrypoint.indexOf("system-config-restore.ts"));
    expect(identityBlock).toMatch(/BUILDER_SLUG=\$\("\$TSX" \/octogee\/scripts\/entrypoints\/user-identity\.ts\)/);
    expect(identityBlock).toMatch(/identity_status" -eq 2[\s\S]*?exit 2/);
    expect(identityBlock).toMatch(/sleep 5/);
    expect(entrypoint).not.toMatch(/GATEWAY_BUILDER_SLUG|GATEWAY_OWNER_UID/);
    expect(entrypoint).not.toMatch(/UNOWNED_OPERATOR_PREWARM/);
  });

  it("retries restore and hydration against the data plane without exiting", () => {
    expect(entrypoint).toMatch(/until "\$TSX" \/octogee\/scripts\/entrypoints\/system-config-restore\.ts/);
    expect(entrypoint).toMatch(/until "\$TSX" \/octogee\/scripts\/entrypoints\/configured-user-bootstrap\.ts/);
    const retryIdx = entrypoint.indexOf("until \"$TSX\" /octogee/scripts/entrypoints/system-config-restore.ts");
    const retryBlock = entrypoint.slice(retryIdx, entrypoint.indexOf("else", retryIdx));
    expect(retryBlock).toMatch(/sleep 5/);
    expect(retryBlock).not.toMatch(/exit\s+[1-9]/);
  });

  it("restores the user PostgreSQL identity before OpenClaw", () => {
    const hydrateIdx = entrypoint.indexOf("configured-user-bootstrap.ts");
    const runtimeRestoreIdx = entrypoint.indexOf("isolated-runtime-state-restore.ts");
    const supervisorIdx = entrypoint.indexOf("supervise_runner surge-openclaw-supervisor");

    expect(runtimeRestoreIdx).toBeGreaterThan(hydrateIdx);
    expect(runtimeRestoreIdx).toBeLessThan(supervisorIdx);
  });

  it("lands recorded PostgreSQL agent anchors after the runtime-state restore and before OpenClaw", () => {
    const runtimeRestoreIdx = entrypoint.indexOf("isolated-runtime-state-restore.ts");
    const anchorIdx = entrypoint.indexOf("agent-anchor-restore.ts");
    const supervisorIdx = entrypoint.indexOf("supervise_runner surge-openclaw-supervisor");

    expect(anchorIdx).toBeGreaterThan(runtimeRestoreIdx);
    expect(anchorIdx).toBeLessThan(supervisorIdx);
    expect(entrypoint).toMatch(/until "\$TSX" \/octogee\/scripts\/entrypoints\/agent-anchor-restore\.ts/);
  });

  it("starts the probed runner plane only after the actual OpenClaw process", () => {
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    const fleetControllerIdx = entrypoint.indexOf("supervise_runner fleet-controller");

    expect(fleetControllerIdx).toBeGreaterThan(restoreIdx);
    expect(fleetControllerIdx).toBeGreaterThan(openclawIdx);
    expect(gatewayDeployment).toMatch(/startupProbe:[\s\S]*?path:\s*\/startup-ready[\s\S]*?port:\s*\{\{ \.Values\.env\.fleetControllerPort/);
    expect(gatewayValues).toMatch(
      /startup:\s+initialDelaySeconds:\s*15\s+periodSeconds:\s*10\s+failureThreshold:\s*60/,
    );
  });

  it("prepares canonical plugin roots before Native startup", () => {
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    const hydrateIdx = entrypoint.indexOf("configured-user-bootstrap.ts");
    const pluginRootsIdx = entrypoint.indexOf(
      "Prepare canonical plugin roots",
    );
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");

    expect(pluginRootsIdx).toBeGreaterThan(restoreIdx);
    expect(pluginRootsIdx).toBeGreaterThan(hydrateIdx);
    expect(pluginRootsIdx).toBeLessThan(watcherIdx);
    expect(pluginRootsIdx).toBeLessThan(openclawIdx);
    expect(entrypoint).toMatch(/for runtime_name in npm extensions/);
    expect(entrypoint).toMatch(/\.git\/info\/exclude/);
    expect(entrypoint).toMatch(/git -C "\$OPENCLAW_CONFIG_DIR" ls-files/);
    expect(entrypoint).toMatch(/mktemp -d/);
    expect(entrypoint).toMatch(/mv "\$runtime_root" "\$RUNTIME_ROOT_QUARANTINE\//);
    expect(entrypoint).not.toMatch(/rm -rf "\$OPENCLAW_CONFIG_DIR\//);
  });

  it("keeps one supervised config watcher for isolated gateways", () => {
    expect(entrypoint).toMatch(/supervise_runner\s+system-config-watch\s+5000\s+"\$TSX"/);
    expect(entrypoint.match(/supervise_runner\s+system-config-watch/g)).toHaveLength(1);
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const guard = entrypoint.slice(entrypoint.lastIndexOf("if [", watcherIdx), watcherIdx);
    expect(guard).toMatch(/"\$GATEWAY_CLASS_EFFECTIVE" = "isolated"/);
  });

  it("claims the user identity before any owner-scoped pre-boot step and never boots unclaimed", () => {
    const identityBlock = entrypoint.slice(entrypoint.indexOf("# ── User identity"), entrypoint.indexOf('GIT_SSH_HOST="'));
    expect(identityBlock).toMatch(/identity_status" -eq 2 \]; then\s+log "FATAL/);
    expect(identityBlock).not.toMatch(/-eq 3/);
    expect(entrypoint).not.toMatch(/STANDBY|OVERLAY_GATE|await-overlay/);
    const restoreIdx = entrypoint.indexOf("system-config-restore.ts");
    expect(entrypoint.slice(entrypoint.lastIndexOf("if [", restoreIdx), restoreIdx)).toMatch(/"\$GATEWAY_CLASS_EFFECTIVE" != "shared"/);
    for (const userOnly of ["clean-user-project-placeholders.ts", "IdentityFile", "mark-overlay-applied"]) {
      const idx = entrypoint.indexOf(userOnly);
      expect(entrypoint.slice(entrypoint.lastIndexOf("if [", idx), idx), userOnly).toMatch(/"\$GATEWAY_CLASS_EFFECTIVE" = "isolated"/);
    }
    for (const runner of ["github-cli-auth-hydrate.ts", "isolated-toolchain-hydrator.ts", "system-config-watch.ts"]) {
      const idx = entrypoint.indexOf(`/octogee/scripts/entrypoints/${runner}`);
      expect(entrypoint.slice(entrypoint.lastIndexOf("\n", idx), idx), runner).toMatch(/supervise_runner \S+ \d+ "\$TSX" $/);
    }
  });

  it("stamps a claimed boot's overlay after its config is composed and before OpenClaw starts", () => {
    const stampIdx = entrypoint.indexOf("user-claim.ts mark-overlay-applied");
    expect(stampIdx).toBeGreaterThan(entrypoint.lastIndexOf('node "$CLASS_POLICY"'));
    expect(stampIdx).toBeGreaterThan(entrypoint.indexOf("ensure-configured-agent-runtime-dirs.ts"));
    expect(stampIdx).toBeLessThan(entrypoint.indexOf("supervise_runner surge-openclaw-supervisor"));
  });

  it("starts OpenClaw before the durable watcher and auxiliary runners", () => {
    const watcherIdx = entrypoint.indexOf("supervise_runner system-config-watch");
    const fleetIdx = entrypoint.indexOf("supervise_runner fleet-controller");
    const openclawIdx = entrypoint.indexOf("openclaw gateway run");
    expect(watcherIdx).toBeGreaterThan(openclawIdx);
    expect(fleetIdx).toBeGreaterThan(openclawIdx);
    expect(entrypoint).toContain("OpenClaw gateway healthy; starting auxiliary runners");
  });

  it("delegates the user OpenClaw process to the hold-capable surge supervisor", () => {
    const supervisorIdx = entrypoint.indexOf("supervise_runner surge-openclaw-supervisor");
    const directStartIdx = entrypoint.indexOf("openclaw gateway run");
    expect(supervisorIdx).toBeGreaterThan(-1);
    const branchIdx = entrypoint.lastIndexOf('if [ "$GATEWAY_CLASS_EFFECTIVE" = "isolated" ]; then', supervisorIdx);
    expect(branchIdx).toBeGreaterThan(-1);
    const nearestGuard = entrypoint.lastIndexOf("if [", supervisorIdx);
    expect(nearestGuard, "every user boot starts the supervisor").toBe(branchIdx);
    expect(supervisorIdx).toBeLessThan(directStartIdx);
    const userBranch = entrypoint.slice(supervisorIdx, directStartIdx);
    expect(userBranch).not.toMatch(/until curl/);
    expect(entrypoint).not.toContain("OPENCLAW_SKIP_CHANNELS");
  });

  it("does not launch OpenClaw validation, Doctor, checkpoint, or session migration CLIs during boot", () => {
    expect(entrypoint).not.toContain("openclaw config validate");
    expect(entrypoint).not.toContain("openclaw secrets audit");
    expect(entrypoint).not.toContain("openclaw doctor");
    expect(entrypoint).not.toContain("system-config-checkpoint.ts");
    expect(entrypoint).not.toContain("OPENCLAW_SESSION_SQLITE_MIGRATION_MODE");
  });

  it("hardens the active config unconditionally — no role-dependent permission arms", () => {
    const hardenBlock = entrypoint.slice(
      entrypoint.indexOf("# ── Harden file permissions"),
      entrypoint.indexOf("# ── Project immutable plugin extensions"),
    );
    expect(hardenBlock).toMatch(/chmod 600 "\$OPENCLAW_CONFIG_PATH"/);
    expect(hardenBlock).not.toMatch(/SYSTEM_CONFIG_BOOT_ROLE/);
    expect(hardenBlock).not.toMatch(/FATAL/);
  });

  it("runs pre-boot env patches without requiring the removed Firebase SA key", () => {
    const prebootBlock = entrypoint.slice(
      entrypoint.indexOf("Pre-boot: sync env/runtime config"),
      entrypoint.indexOf("Start OpenClaw before auxiliary runners"),
    );
    expect(prebootBlock).toMatch(/OPENCLAW_CONFIG_PATH/);
    expect(prebootBlock).not.toMatch(/SA_KEY_PATH/);
    expect(prebootBlock).not.toMatch(/octogee-test-sa-key\.json/);
  });
});

describe("infra/gateway/entrypoint.sh — isolated-only user runtime", () => {
  it("rejects retired user gateway classes and profiles", () => {
    expect(entrypoint).toMatch(/shared\|isolated/);
    expect(entrypoint).toMatch(/GATEWAY_CLASS must be shared or isolated/);
    expect(entrypoint).toMatch(/GATEWAY_PROFILE must be standard or isolated/);
    expect(entrypoint).not.toMatch(/shared\|user\|operator|standard\|user\|operator/);
  });

  it("loads the native-agent bootstrap only for isolated gateways without weakening Agent policy", () => {
    const stamperRegion = entrypoint.match(
      /[\s\S]{0,200}stamp-claude-first-run\.mjs[\s\S]{0,250}/,
    )?.[0];
    expect(stamperRegion).toMatch(/GATEWAY_CLASS_EFFECTIVE[\s\S]*= "isolated"[\s\S]*-f/);
    expect(entrypoint).not.toMatch(/apply-isolated-codex-sandbox\.mjs/);
    expect(entrypoint).not.toMatch(/apply-operator-codex-sandbox\.mjs/);
    expect(entrypoint).not.toMatch(/operator\.env/);
  });

  it("converges user GitHub auth and defers native runtime stamping", () => {
    const healthyIdx = entrypoint.indexOf("OpenClaw gateway healthy");
    const fleetIdx = entrypoint.indexOf("supervise_runner fleet-controller");
    const stamperIdx = entrypoint.indexOf("stamp-claude-first-run.mjs");
    expect(entrypoint).toContain("supervise_runner github-cli-auth");
    expect(entrypoint).toContain("github-cli-auth-hydrate.ts");
    expect(fleetIdx).toBeGreaterThan(healthyIdx);
    expect(stamperIdx).toBeGreaterThan(healthyIdx);
  });
});

describe("infra/gateway/entrypoint.sh — supervised in-pod runners + metrics", () => {
  it("routes only non-code auxiliary runners through supervise-runner on user gateways", () => {
    const runners: Record<string, string> = {
      "fleet-controller": "5000",
      "byosub-syncback": "30000",
      "isolated-toolchain-hydrator": "30000",
    };
    for (const [runner, restartDelayMs] of Object.entries(runners)) {
      expect(entrypoint).toMatch(
        new RegExp(`supervise_runner\\s+${runner}\\s+${restartDelayMs}\\b`),
      );
    }
  });

  it("does not start the Firebase-backed local provisioner in gateway pods", () => {
    expect(entrypoint).not.toMatch(/supervise_runner\s+provisioner\b/);
    expect(entrypoint).not.toMatch(/entrypoints\/local-provisioner\.ts/);
  });

  it("never starts site-build-api inside the credential-bearing gateway container", () => {
    expect(entrypoint).not.toMatch(/supervise_runner\s+site-build\b/);
    expect(entrypoint).toContain("site-build-api disabled");
  });

  it("never starts the retired in-gateway preview proxy", () => {
    expect(entrypoint).not.toMatch(/supervise_runner\s+preview-proxy\b/);
  });

  it("starts the always-on runner-metrics-exporter", () => {
    expect(entrypoint).toMatch(/runner-metrics-exporter\.ts/);
  });

  it("supervise_runner keeps a thin guard so a dead supervisor restarts", () => {
    const fnRegion = entrypoint.slice(
      entrypoint.indexOf("supervise_runner() {"),
      entrypoint.indexOf("supervise_runner fleet-controller"),
    );
    expect(fnRegion).toMatch(/while true/);
    expect(fnRegion).toMatch(/\$SUPERVISE/);
    expect(fnRegion).toMatch(/--restart-delay-ms=\$\{_restart_delay_ms\}/);
    expect(entrypoint).toMatch(/SUPERVISE=[^\n]*supervise-runner\.ts/);
  });

  it("forwards SIGTERM to the process group and joins OpenClaw before returning its status", () => {
    const shutdownIdx = entrypoint.indexOf("shutdown() {");
    const trapIdx = entrypoint.indexOf("trap shutdown TERM INT");
    const fleetIdx = entrypoint.indexOf("supervise_runner fleet-controller");
    const shutdown = entrypoint.slice(shutdownIdx, trapIdx);
    expect(shutdown).toMatch(/kill -TERM 0/);
    const wait = 'wait "$OPENCLAW_PID" || _shutdown_status=$?';
    const exit = 'exit "$_shutdown_status"';
    expect(shutdown).toContain(wait);
    expect(shutdown).toContain(exit);
    expect(shutdown.indexOf(wait)).toBeLessThan(shutdown.indexOf(exit));
    expect(trapIdx).toBeLessThan(fleetIdx);
    expect(entrypoint.match(/trap shutdown TERM INT/g)).toHaveLength(1);
    expect(gatewayDeployment).toMatch(/kind:\s*Deployment/);
    expect(gatewayDeployment).not.toMatch(/restartPolicy:\s*(?:Never|OnFailure)/);
  });
});

describe("infra/gateway/entrypoint.sh — a dead OpenClaw process exits the shared container", () => {
  it("waits on the OpenClaw PID after the runners start and leaves isolated pods on the supervisor", () => {
    const tail = entrypoint.slice(entrypoint.indexOf("supervise_runner byosub-syncback"));
    expect(tail).toMatch(/if \[ "\$GATEWAY_CLASS_EFFECTIVE" = "shared" \]; then\s+exit_when_openclaw_dies "\$OPENCLAW_PID"\s+else\s+wait\s+fi/);
    expect(entrypoint.slice(0, entrypoint.indexOf("supervise_runner fleet-controller")))
      .toContain("exit_when_openclaw_dies() {");
  });

  it("runs the same pre-stop flush the kubelet path runs before exiting", () => {
    expect(entrypoint).toMatch(/PRESTOP_FLUSH="timeout 10s \$TSX \/octogee\/scripts\/entrypoints\/prestop-flush\.ts"/);
    expect(exitWhenOpenClawDiesFunction()).toMatch(/\$PRESTOP_FLUSH \|\| log/);
    expect(gatewayDeployment).toMatch(/timeout \{\{ \.Values\.preStopFlush\.timeoutSeconds \| default 10 \}\}s [^\n]*prestop-flush\.ts/);
  });

  describe("exit_when_openclaw_dies (POSIX sh harness)", () => {
    it("exits the container with OpenClaw's status after logging FATAL and flushing", () => {
      const run = runExitWhenOpenClawDies({ childExit: "kill -ABRT $$", flushExit: 0 });
      expect(run.status).toBe(134);
      expect(run.stdout).toContain("FATAL: OpenClaw gateway process exited (status=134)");
      expect(run.stdout).toContain("exiting container so Kubernetes restarts it");
      expect(run.stdout).toContain("flush-ran");
      expect(run.stdout.indexOf("FATAL")).toBeLessThan(run.stdout.indexOf("flush-ran"));
    });

    it("never exits 0 on a clean OpenClaw exit, so Kubernetes still records a failure", () => {
      const run = runExitWhenOpenClawDies({ childExit: "exit 0", flushExit: 0 });
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("FATAL: OpenClaw gateway process exited (status=1)");
    });

    it("logs a failed flush and still exits with OpenClaw's status", () => {
      const run = runExitWhenOpenClawDies({ childExit: "exit 7", flushExit: 3 });
      expect(run.status).toBe(7);
      expect(run.stdout).toContain("prestop-flush failed (exit 3)");
    });
  });
});

function exitWhenOpenClawDiesFunction(): string {
  const start = entrypoint.indexOf("exit_when_openclaw_dies() {");
  expect(start).toBeGreaterThan(-1);
  const end = entrypoint.indexOf("\n}\n", start);
  return entrypoint.slice(start, end + 3);
}

function runExitWhenOpenClawDies(input: { childExit: string; flushExit: number }) {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-exit-"));
  const flush = path.join(dir, "flush.sh");
  writeFileSync(flush, `#!/bin/sh\necho flush-ran\nexit ${input.flushExit}\n`, { mode: 0o755 });
  const harness = path.join(dir, "harness.sh");
  writeFileSync(
    harness,
    [
      "#!/bin/sh",
      "set -e",
      'log() { echo "[entrypoint] $*"; }',
      `PRESTOP_FLUSH="${flush}"`,
      exitWhenOpenClawDiesFunction(),
      `sh -c '${input.childExit}' &`,
      "OPENCLAW_PID=$!",
      "sleep 0.2",
      'exit_when_openclaw_dies "$OPENCLAW_PID"',
      'echo "unreachable"',
    ].join("\n"),
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-c", 'set -m; sh "$1" & wait $!', "_", harness], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.stdout).not.toContain("unreachable");
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("scripts/entrypoints/fleet-controller.ts — db-less local persistence loops", () => {

  it("keeps brokered GCS blob sync wired into the live gateway controller", () => {
    expect(fleetController).toMatch(/blobSyncAllWithOptions/);
    expect(fleetController).toMatch(/createBrokeredBlobStore/);
  });

  it("publishes durable-config runtime health to the broker in place of the retired status server", () => {
    expect(fleetController).toMatch(/createSystemConfigStatusPublisher/);
    expect(fleetController).toMatch(/refreshSystemConfigRuntimeHealth/);
    expect(fleetController).toMatch(/recordSystemConfigStatus/);
  });
});

describe("per-user control identity — pod token stays out of the OpenClaw process", () => {
  const supervisor = readFileSync(
    path.join(repoRoot, "scripts/entrypoints/surge-openclaw-supervisor.ts"),
    "utf8",
  );

  it("exports the in-pod relay credential under its own name before OpenClaw starts", () => {
    const relayExport = entrypoint.indexOf('export OCTOGEE_POD_RELAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN"');
    const openClawStart = entrypoint.indexOf("openclaw gateway run");
    expect(relayExport).toBeGreaterThan(-1);
    expect(relayExport).toBeLessThan(openClawStart);
  });

  it("spawns the user OpenClaw process through the identity-aware environment filter", () => {
    expect(supervisor).toMatch(/env:\s*openClawProcessEnv\(\)/);
    expect(supervisor).toMatch(/OPENCLAW_GATEWAY_TOKEN: podToken, \.\.\.rest/);
  });

  it("threads the control identity to both gateway containers from one chart value", () => {
    expect(gatewayDeployment).toMatch(/\$controlIdentity := ternary/);
    expect(gatewayDeployment.match(/name:\s*OPENCLAW_CONTROL_IDENTITY/g)).toHaveLength(2);
    expect(gatewayValues).toMatch(/controlIdentity:\s*shared-operator/);
  });
});
