import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('opts the disposable image provisioner into a full Omarchy package upgrade', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vm-upgrade-'));
  try {
    const probe = path.join(dir, 'invocation');
    writeFileSync(path.join(dir, 'pacman'), '#!/bin/sh\nprintf "%s\\n" "${OMARCHY_ALLOW_DIRECT_PACMAN:-}" "$@" > "$UPGRADE_PROBE"\nexit 42\n', { mode: 0o755 });
    const source = readFileSync(path.resolve('../desktop/image/customize.sh'), 'utf8');
    const script = path.join(dir, 'customize.sh');
    writeFileSync(script, source.replaceAll('/tmp/pacman.log', path.join(dir, 'pacman.log')));
    const result = spawnSync('bash', [script], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, OMARCHY_VERSION: 'test', IMAGE_NAME: 'test', UPGRADE_PROBE: probe, OMARCHY_ALLOW_DIRECT_PACMAN: '' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    const [optIn, ...args] = readFileSync(probe, 'utf8').trimEnd().split('\n');
    expect(optIn).toBe('1');
    expect(args).toContain('-Syu');
    expect(args).toEqual(expect.arrayContaining(['at-spi2-core', 'python', 'python-pip']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function listenOn(socketPath: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

function stageMigrationRun(dir: string) {
  const runtimeDir = path.join(dir, 'run-user-1000');
  mkdirSync(runtimeDir);
  const stubs = {
    pacman: 'exit 0',
    id: 'echo 1000',
    loginctl: 'printf "%s\\n" "$@" >> "$SESSION_PROBE"\n[ "$1" = show-user ] && printf "%s\\n" "$RUNTIME_DIR"\nexit 0',
    systemctl: 'printf "%s\\n" "$@" >> "$SESSION_PROBE"\nexit 0',
    sleep: 'exit 0',
    install: 'printf "%s\\n" "$@" >> "$SESSION_PROBE"\ncat > "$SUDOERS_PROBE"',
    visudo: 'exit 0',
    sudo: 'printf "%s\\n" "${OMARCHY_ALLOW_DIRECT_PACMAN:-}" "$@" > "$MIGRATION_PROBE"\nexit "$MIGRATION_STATUS"',
    rm: 'exit 0',
    git: 'touch "$CONTINUATION_PROBE"\nexit 42',
  };
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  const source = readFileSync(path.resolve('../desktop/image/customize.sh'), 'utf8');
  const script = path.join(dir, 'customize.sh');
  writeFileSync(script, source.replaceAll('/tmp/pacman.log', path.join(dir, 'pacman.log')));
  const probes = {
    migration: path.join(dir, 'migration'), continued: path.join(dir, 'continued'),
    session: path.join(dir, 'session'), sudoers: path.join(dir, 'sudoers'),
  };
  const run = (migrationStatus: number) => spawnSync('bash', [script], {
    env: {
      ...process.env, PATH: `${dir}:${process.env.PATH}`, OMARCHY_VERSION: 'test', IMAGE_NAME: 'test',
      OMARCHY_ALLOW_DIRECT_PACMAN: '', MIGRATION_PROBE: probes.migration, MIGRATION_STATUS: String(migrationStatus),
      CONTINUATION_PROBE: probes.continued, SESSION_PROBE: probes.session, SUDOERS_PROBE: probes.sudoers, RUNTIME_DIR: runtimeDir,
    },
    encoding: 'utf8',
  });
  return { runtimeDir, probes, run };
}

it.each([0, 37])('runs migrations inside the desktop user\'s session without sudo prompts and propagates migration status %s', async (migrationStatus) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vm-migration-'));
  let bus: Server | undefined;
  try {
    const { runtimeDir, probes, run } = stageMigrationRun(dir);
    bus = await listenOn(path.join(runtimeDir, 'bus'));
    const result = run(migrationStatus);
    expect(readFileSync(probes.session, 'utf8').trimEnd().split('\n')).toEqual([
      'enable-linger', 'octo',
      'start', 'user@1000.service',
      'show-user', 'octo', '--property=RuntimePath', '--value',
      '-m', '0440', '/dev/stdin', '/etc/sudoers.d/zz-octo-build',
    ]);
    expect(readFileSync(probes.sudoers, 'utf8')).toBe('Defaults:octo !authenticate\n');
    expect(readFileSync(probes.migration, 'utf8').trimEnd().split('\n')).toEqual([
      '', '-H', '-u', 'octo', 'env', `XDG_RUNTIME_DIR=${runtimeDir}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=${runtimeDir}/bus`, 'bash', '-lc', 'omarchy migrate',
    ]);
    expect(result.status).toBe(migrationStatus === 0 ? 42 : migrationStatus);
    expect(existsSync(probes.continued)).toBe(migrationStatus === 0);
  } finally {
    bus?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('refuses to migrate when the desktop user\'s session bus never appears', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vm-migration-'));
  try {
    const { runtimeDir, probes, run } = stageMigrationRun(dir);
    const result = run(0);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`octo's user session bus never appeared at ${runtimeDir}/bus`);
    expect(existsSync(probes.sudoers)).toBe(false);
    expect(existsSync(probes.migration)).toBe(false);
    expect(existsSync(probes.continued)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(["4.5.0-2", "4.0.6-1", ""])("records the installed Omarchy version and refuses a stale or missing result (%s)", version => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-version-"));
  try {
    const source = readFileSync(path.resolve("../desktop/image/customize.sh"), "utf8");
    const fn = source.match(/^record_image_identity\(\) \{[\s\S]*?^\}/m)?.[0] ?? "";
    const envFile = path.join(dir, "vm.env");
    const result = spawnSync("bash", ["-c", `${fn.replaceAll("/etc/octogee-computer.env", envFile)}
omarchy() { printf '%s\\n' "$TEST_VERSION"; }
record_image_identity`], {
      env: { ...process.env, OMARCHY_VERSION: "4.5.0", IMAGE_NAME: "candidate", TEST_VERSION: version }, encoding: "utf8",
    });
    if (version === "4.5.0-2") {
      expect(result.status).toBe(0);
      expect(readFileSync(envFile, "utf8")).toBe("OMARCHY_ISO_VERSION=4.5.0\nOMARCHY_VERSION=4.5.0-2\nIMAGE_NAME=candidate\n");
    } else {
      expect(result.status).not.toBe(0);
      expect(existsSync(envFile)).toBe(false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
