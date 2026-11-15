import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../desktop/image/rootfs/usr/local/bin/octo-metadata-ssh-keys', import.meta.url));
const homes: string[] = [];
const nativeDocker = process.env.OCTOGEE_NATIVE_DOCKER_TEST === '1';
type Reply = { code: number; body: string };

function fixture(instanceKeys = '', projectKeys = '', block = 'false') {
  const home = mkdtempSync(join(tmpdir(), 'octo-ssh-keys-'));
  homes.push(home);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  mkdirSync(join(home, '.ssh'));
  const authorized = join(home, '.ssh/authorized_keys');
  writeFileSync(authorized, 'ssh-ed25519 old-key\n');
  const replies: Record<string, Reply> = {
    'instance/id': { code: 200, body: '123' },
    'instance/attributes/block-project-ssh-keys': { code: 200, body: block },
    'instance/attributes/ssh-keys': { code: 200, body: instanceKeys },
    'project/attributes/ssh-keys': { code: 200, body: projectKeys },
  };
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
path = args[-1].split('/computeMetadata/v1/')[1]
reply = json.loads(Path(os.environ['REPLIES']).read_text())[path]
if '-o' in args:
    Path(args[args.index('-o') + 1]).write_text(reply['body'])
    print(reply['code'], end='')
else:
    print(reply['body'], end='')
    if reply['code'] >= 400: sys.exit(22)
`, { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), '#!/usr/bin/bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'chown'), '#!/usr/bin/bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'install'), `#!/usr/bin/bash
args=()
while (( $# )); do
  case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac
done
exec /usr/bin/install "\${args[@]}"
`, { mode: 0o755 });
  const copy = join(home, 'sync-keys');
  writeFileSync(copy, readFileSync(script, 'utf8').replace('home=/home/$user', `home='${home}'`));
  return {
    replies,
    run() {
      const path = join(home, 'replies.json');
      writeFileSync(path, JSON.stringify(replies));
      if (process.platform !== 'linux' && nativeDocker) {
        return execFileSync('docker', ['run', '--rm', '--pull', 'never', '--platform', 'linux/amd64', '--network', 'none',
          '--mount', `type=bind,source=${home},target=${home}`, '-e', `REPLIES=${path}`,
          '-e', `PATH=${bin}:/usr/bin:/usr/sbin:/bin`, '--entrypoint', '/usr/bin/bash', 'octogee-desktop:spike', copy],
          { encoding: 'utf8', stdio: 'pipe' });
      }
      return execFileSync('bash', [copy], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPLIES: path }, encoding: 'utf8', stdio: 'pipe' });
    },
    keys: () => readFileSync(authorized, 'utf8'),
    mode: () => statSync(authorized).mode & 0o777,
  };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux' && !nativeDocker)('native desktop metadata SSH authorization', () => {
  it.each([200, 404])('revokes the final removed key when metadata returns %s', (code) => {
    const state = fixture();
    state.replies['instance/attributes/ssh-keys'] = { code, body: '' };
    state.replies['project/attributes/ssh-keys'] = { code, body: '' };
    state.run();
    expect(state.keys()).toBe('');
    expect(state.mode()).toBe(0o600);
  });

  it('selects only octo keys and deduplicates instance and project entries', () => {
    const state = fixture('octo:ssh-ed25519 key-one\nother:ssh-ed25519 ignored', 'octo:ssh-ed25519 key-one\nocto:ssh-ed25519 key-two');
    state.run();
    expect(state.keys()).toBe('ssh-ed25519 key-one\nssh-ed25519 key-two\n');
  });

  it.each(['true', 'TRUE'])('honors project-key blocking %s while retaining instance keys', (block) => {
    const state = fixture('octo:ssh-ed25519 instance-key', 'octo:ssh-ed25519 project-key', block);
    state.run();
    expect(state.keys()).toBe('ssh-ed25519 instance-key\n');
  });

  it('revokes expired keys and binds active expiration into OpenSSH authorization', () => {
    const state = fixture('octo:ssh-ed25519 expired google-ssh {"userName":"octo","expireOn":"2000-01-01T00:00:00+0000"}\nocto:ssh-ed25519 active google-ssh {"userName":"octo","expireOn":"2099-01-01T00:00:00+0000"}');
    state.run();
    expect(state.keys()).toBe('expiry-time="20990101000000Z" ssh-ed25519 active google-ssh {"userName":"octo","expireOn":"2099-01-01T00:00:00+0000"}\n');
  });

  it.each(['', 'bad-date'])('fails malformed expiration %j without changing current authorization', (expiry) => {
    const state = fixture(`octo:ssh-ed25519 bad google-ssh {"userName":"octo","expireOn":"${expiry}"}`);
    expect(() => state.run()).toThrow();
    expect(state.keys()).toBe('ssh-ed25519 old-key\n');
  });

  it('refuses fresh-boot SSH admission on an unreachable metadata server without replaying old authorization', () => {
    const state = fixture('octo:ssh-ed25519 current-key');
    state.replies['instance/id'] = { code: 503, body: 'temporarily unavailable' };
    expect(() => state.run()).toThrow();
    expect(state.keys()).toBe('ssh-ed25519 old-key\n');
  });

  it('preserves current keys and fails explicitly on metadata errors', () => {
    const state = fixture('octo:ssh-ed25519 new-key');
    state.replies['project/attributes/ssh-keys'] = { code: 503, body: 'temporarily unavailable' };
    expect(() => state.run()).toThrow('metadata project/attributes/ssh-keys returned HTTP 503');
    expect(state.keys()).toBe('ssh-ed25519 old-key\n');
  });
});
