import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const enroll = fileURLToPath(new URL('../../desktop/image/rootfs/usr/local/bin/octo-limine-enroll', import.meta.url));
const temporary: string[] = [];
const CURRENT = 'e1263785717d485eadd546d029f57eec';
const BUILD = '98ef3c4a73534d4c89f032d48ddb95fe';
const HASH = 'ac4ebd48412c66a6e7ec7ee842962ae3';

function conf(ids: string[], hash = HASH) {
  return `timeout: 0\n${ids.map((id) => `/+Omarchy\ncomment: machine-id=${id} order-priority=50\n  //linux-omarchy\n  path: boot():/EFI/Linux/omarchy_linux-omarchy.efi#${hash}\n`).join('')}`;
}

function fixture(opts: { ids: string[]; recordedHash?: string; fileHash?: string; machineId?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'octo-limine-enroll-'));
  temporary.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'etc'));
  const confPath = join(root, 'limine.conf');
  const uki = join(root, 'omarchy_linux-omarchy.efi');
  const marker = join(root, 'state/limine-enrolled');
  const calls = join(root, 'calls.log');
  writeFileSync(confPath, conf(opts.ids));
  writeFileSync(uki, 'kernel');
  const shim = (name: string, body: string) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "$CALLS"\n${body}`, { mode: 0o755 });
  shim('limine-entry-tool', 'id="$2"; python3 - "$CONF" "$id" <<\'PY\'\nimport re,sys\np,i=sys.argv[1],sys.argv[2]; s=open(p).read()\ns=re.sub(r"/\\+Omarchy\\ncomment: machine-id=%s[^\\n]*\\n  //linux-omarchy\\n  path: [^\\n]*\\n" % i, "", s)\nopen(p,"w").write(s)\nPY');
  shim('limine-update', `python3 - "$CONF" "$NEW_HASH" <<'PY'\nimport re,sys\np,h=sys.argv[1],sys.argv[2]; s=open(p).read()\nopen(p,'w').write(re.sub(r"efi#[0-9a-f]+", "efi#"+h, s))\nPY`);
  shim('b2sum', `printf '%s  %s\\n' "${opts.fileHash ?? HASH}" "$1"`);
  writeFileSync(join(bin, 'cat'), `#!/usr/bin/env bash\nif [[ "$1" == /etc/machine-id ]]; then printf '%s\\n' "${opts.machineId ?? CURRENT}"; else /bin/cat "$@"; fi\n`, { mode: 0o755 });
  const run = () => execFileSync('bash', [enroll], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, CONF: confPath, NEW_HASH: opts.recordedHash ?? HASH, OCTO_LIMINE_CONF: confPath, OCTO_LIMINE_MARKER: marker, OCTO_LIMINE_UKI: uki },
    stdio: 'pipe',
  }).toString();
  return { run, calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []), conf: () => readFileSync(confPath, 'utf8'), marker };
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('octo-limine-enroll', () => {
  it('removes the image build\'s OS entry, regenerates under this machine id, and records completion', () => {
    const state = fixture({ ids: [BUILD, CURRENT] });
    state.run();
    expect(state.calls()).toEqual([`limine-entry-tool --remove-entry ${BUILD} --quiet`, 'limine-update ', expect.stringContaining('b2sum')]);
    expect(state.conf()).not.toContain(BUILD);
    expect(state.conf()).toContain(CURRENT);
    expect(existsSync(state.marker)).toBe(true);
  });

  it('leaves a config that already belongs to this machine alone apart from regenerating it', () => {
    const state = fixture({ ids: [CURRENT] });
    state.run();
    expect(state.calls().filter((c) => c.startsWith('limine-entry-tool'))).toEqual([]);
    expect(existsSync(state.marker)).toBe(true);
  });

  it('fails without recording completion when the regenerated kernel image does not match its recorded hash', () => {
    const state = fixture({ ids: [BUILD, CURRENT], recordedHash: 'deadbeefdeadbeefdeadbeefdeadbeef', fileHash: HASH });
    expect(() => state.run()).toThrow(/records hash deadbeef/);
    expect(existsSync(state.marker)).toBe(false);
  });

  it('refuses to run before systemd has committed a machine id', () => {
    const state = fixture({ ids: [BUILD], machineId: '' });
    expect(() => state.run()).toThrow(/machine-id is not set yet/);
    expect(existsSync(state.marker)).toBe(false);
  });
});
