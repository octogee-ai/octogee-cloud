import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DESKTOP_HOME_PATHS } from '../lib/vm-gateway-agent/home-checkpoint';

const browser = fileURLToPath(new URL('../../desktop/rootfs/usr/local/bin/octo-desktop-browser', import.meta.url));
const temporaryHomes: string[] = [];
const EGRESS_MODE_DIR = '.config/octogee';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'octo-browser-start-'));
  temporaryHomes.push(home);
  const bin = join(home, 'bin');
  const sessions = join(home, '.config/octogee-chromium/Default/Sessions');
  mkdirSync(bin);
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(bin, 'chromium'), '#!/usr/bin/bash\nprintf "%s\\n" "$@" > "$CAPTURE_FILE"\nprintf "%s" "${ACCESSIBILITY_ENABLED-unset}" > "$CAPTURE_FILE.a11y"\n', { mode: 0o755 });
  const stateDir = join(home, EGRESS_MODE_DIR);
  return {
    home,
    sessions,
    recordEgressMode(mode: string) {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'egress-mode'), mode);
    },
    launch(args: string[] = [], homepage?: string, noSandbox?: string, extraEnv: Record<string, string> = {}) {
      const capture = join(home, 'arguments');
      execFileSync('bash', [browser, ...args], {
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CAPTURE_FILE: capture, OCTO_HOME_URL: homepage ?? '', OCTO_CHROMIUM_NO_SANDBOX: noSandbox, ...extraEnv },
        stdio: 'pipe',
      });
      return readFileSync(capture, 'utf8').trimEnd().split('\n');
    },
  };
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('desktop Chromium startup', () => {
  it('loads Chromium\'s AT-SPI bridge so the browser registers on the accessibility bus', () => {
    const state = fixture();
    const args = state.launch();
    expect(args).toContain('--force-renderer-accessibility');
    expect(readFileSync(join(state.home, 'arguments.a11y'), 'utf8')).toBe('1');
  });

  it.each([undefined, '0'])('keeps the Chromium sandbox enabled with opt-out %s', (value) => {
    expect(fixture().launch([], undefined, value)).not.toContain('--no-sandbox');
  });

  it('disables the sandbox only for the explicit development opt-out', () => {
    expect(fixture().launch([], undefined, '1').filter((arg) => arg === '--no-sandbox')).toHaveLength(1);
  });

  it.each(['', 'true', 'false', '2'])('rejects invalid sandbox opt-out %j before Chromium starts', (value) => {
    const state = fixture();
    expect(() => state.launch([], undefined, value)).toThrow('OCTO_CHROMIUM_NO_SANDBOX must be 0 or 1');
    expect(existsSync(join(state.home, 'arguments'))).toBe(false);
  });

  it.each([
    ['no recorded mode', undefined],
    ['cloud mode', 'cloud\n'],
  ])('connects Chromium directly with %s, so the VM never depends on the egress listener', (_label, mode) => {
    const state = fixture();
    if (mode !== undefined) state.recordEgressMode(mode);
    const args = state.launch();
    expect(args.some((arg) => arg.startsWith('--proxy-server') || arg.startsWith('--host-resolver-rules') || arg.startsWith('--force-webrtc-ip-handling-policy'))).toBe(false);
  });

  it('routes Chromium through the egress listener, WebRTC included, only in desktop mode', () => {
    const state = fixture();
    state.recordEgressMode('desktop\n');
    expect(state.launch()).toEqual(expect.arrayContaining([
      '--proxy-server=socks5://127.0.0.1:1080',
      '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ]));
    const forcedOff = fixture();
    forcedOff.recordEgressMode('desktop\n');
    expect(forcedOff.launch([], undefined, undefined, { OCTO_CHROMIUM_EGRESS_PROXY: '0' }).some((arg) => arg.startsWith('--proxy-server'))).toBe(false);
  });

  it('keeps the recorded egress mode in a home folder the VM checkpoint carries across image replacement', () => {
    expect(DESKTOP_HOME_PATHS).toContain(EGRESS_MODE_DIR);
  });

  it('refuses to start Chromium on an unrecognised recorded egress mode', () => {
    const state = fixture();
    state.recordEgressMode('tor\n');
    expect(() => state.launch()).toThrow('unknown egress mode');
    expect(existsSync(join(state.home, 'arguments'))).toBe(false);
  });

  it('opens the Desk as a frameless app window on the persistent loopback CDP profile', () => {
    const state = fixture();
    const args = state.launch();
    expect(args).toEqual(expect.arrayContaining([
      `--user-data-dir=${state.home}/.config/octogee-chromium`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=9222',
      '--app=http://127.0.0.1:7777/desk',
    ]));
    expect(args).not.toContain('--start-maximized');
    expect(args).not.toContain('http://127.0.0.1:7777/desk');
  });

  it.each([[[]], [['--new-tab', 'https://example.com']]])('always exposes the renderer accessibility tree (args %j)', (args) => {
    expect(fixture().launch(args)).toContain('--force-renderer-accessibility');
  });

  it('never restores old browser windows over the Desk at session start, even with a saved session', () => {
    const state = fixture();
    writeFileSync(join(state.sessions, 'Session_123'), 'saved session');
    const args = state.launch();
    expect(args).not.toContain('--restore-last-session');
    expect(args.filter((arg) => !arg.startsWith('--'))).toEqual([]);
  });

  it('opens the configured Desk URL as the app window', () => {
    const state = fixture();
    expect(state.launch([], 'http://127.0.0.1:7777/desk?dev=1')).toContain('--app=http://127.0.0.1:7777/desk?dev=1');
  });

  it('passes explicit browser requests through without startup URLs or session restoration', () => {
    const state = fixture();
    const args = state.launch(['--new-tab', 'file:///home/octo/Documents/a%20page.html']);
    expect(args.slice(-2)).toEqual(['--new-tab', 'file:///home/octo/Documents/a%20page.html']);
    expect(args).not.toContain('--restore-last-session');
    expect(args).not.toContain('--start-maximized');
    expect(args.some((arg) => arg.startsWith('--app='))).toBe(false);
  });
});
