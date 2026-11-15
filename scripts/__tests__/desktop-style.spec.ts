import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const rootfs = fileURLToPath(new URL('../../desktop/rootfs', import.meta.url));
const style = join(rootfs, 'usr/local/bin/octo-desktop-style');
const temporary: string[] = [];

const stockHyprland = 'require("default.hypr.bootstrap")\nrequire("hypr.bindings")\nrequire("hypr.autostart")\n';
const familiarRequire = 'package.loaded["octo-desktop.familiar"] = nil require("octo-desktop.familiar")';

function fixture(opts: { live?: boolean; currentTheme?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'octo-desktop-style-'));
  temporary.push(root);
  const home = join(root, 'home');
  const share = join(root, 'share');
  const bin = join(root, 'bin');
  const calls = join(root, 'calls.log');
  mkdirSync(join(home, '.config/hypr'), { recursive: true });
  mkdirSync(join(home, '.local/state/omarchy/current'), { recursive: true });
  mkdirSync(join(share, 'config/omarchy'), { recursive: true });
  mkdirSync(bin);
  cpSync(join(rootfs, 'usr/share/omarchy/octo-desktop'), join(share, 'octo-desktop'), { recursive: true });
  writeFileSync(join(share, 'config/omarchy/shell.json'), JSON.stringify({ version: 1, bar: { position: 'top', layout: { left: [{ id: 'omarchy.menu' }], center: [], right: [] } }, plugins: [] }));
  writeFileSync(join(home, '.config/hypr/hyprland.lua'), stockHyprland);
  if (opts.currentTheme) writeFileSync(join(home, '.local/state/omarchy/current/theme.name'), `${opts.currentTheme}\n`);
  const shim = (name: string, body = '') => writeFileSync(join(bin, name), `#!/usr/bin/env bash\nprintf '%s %s headless=%s\\n' "${name}" "$*" "\${OMARCHY_THEME_HEADLESS-0}" >> "$CALLS"\n${body}`, { mode: 0o755 });
  shim('omarchy-theme-set', 'mkdir -p "$XDG_STATE_HOME/omarchy/current"; printf "%s\\n" "$1" | tr "[:upper:] " "[:lower:]-" > "$XDG_STATE_HOME/omarchy/current/theme.name"');
  shim('hyprctl', opts.live ? '[[ "$1 $2" == "plugin list" ]] && echo "Plugin hyprbars"; exit 0' : 'exit 1');
  shim('omarchy-shell');
  const run = (...args: string[]) => {
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), OMARCHY_PATH: share, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, HYPRLAND_INSTANCE_SIGNATURE: opts.live ? 'sig' : '' };
    if (!opts.live) delete (env as Record<string, string | undefined>).HYPRLAND_INSTANCE_SIGNATURE;
    return execFileSync('bash', [style, ...args], { env, stdio: 'pipe' }).toString();
  };
  return {
    home,
    share,
    run,
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []),
    hyprland: () => readFileSync(join(home, '.config/hypr/hyprland.lua'), 'utf8'),
    shell: () => JSON.parse(readFileSync(join(home, '.config/omarchy/shell.json'), 'utf8')) as { plugins: { id: string }[]; bar: unknown },
    plugin: (id: string) => join(home, '.config/omarchy/plugins', id),
    theme: () => readFileSync(join(home, '.local/state/omarchy/current/theme.name'), 'utf8').trim(),
  };
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('octo-desktop-style', () => {
  it('applies the Familiar style to a fresh home without a session and records the choice', () => {
    const state = fixture();
    state.run('apply');
    expect(state.run('status').trim()).toBe('familiar');
    expect(state.hyprland()).toBe(`${stockHyprland}\n${familiarRequire}\n`);
    for (const id of ['rdf.dock', 'community.window-switcher']) {
      expect(lstatSync(state.plugin(id)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(state.plugin(id))).toBe(join(state.share, 'octo-desktop/plugins', id));
    }
    const shell = state.shell();
    expect(shell.plugins.map((p) => p.id)).toEqual(['rdf.dock', 'community.window-switcher']);
    expect(shell.bar).toMatchObject({ position: 'top' });
    expect(existsSync(join(state.home, '.config/omarchy/themes/octogee/colors.toml'))).toBe(true);
    expect(state.theme()).toBe('octogee');
    expect(state.calls()).toEqual(['omarchy-theme-set octogee headless=1']);
  });

  it('is idempotent: applying again adds nothing and leaves the theme choice alone', () => {
    const state = fixture();
    state.run('apply');
    writeFileSync(join(state.home, '.local/state/omarchy/current/theme.name'), 'nord\n');
    state.run('apply');
    state.run('apply');
    expect(state.hyprland().split(familiarRequire)).toHaveLength(2);
    expect(state.shell().plugins.map((p) => p.id)).toEqual(['rdf.dock', 'community.window-switcher']);
    expect(state.theme()).toBe('nord');
    expect(state.calls()).toEqual(['omarchy-theme-set octogee headless=1']);
  });

  it('switches to the stock Omarchy desktop removing only what Familiar added', () => {
    const state = fixture();
    state.run('familiar');
    mkdirSync(state.plugin('acme.weather'), { recursive: true });
    const shell = state.shell();
    writeFileSync(join(state.home, '.config/omarchy/shell.json'), JSON.stringify({ ...shell, plugins: [...shell.plugins, { id: 'acme.weather' }] }));
    writeFileSync(join(state.home, '.config/hypr/hyprland.lua'), `${state.hyprland()}require("hypr.mine")\n`);
    state.run('omarchy');
    expect(state.run('status').trim()).toBe('omarchy');
    expect(state.hyprland()).toBe(`${stockHyprland}\nrequire("hypr.mine")\n`);
    expect(state.shell().plugins.map((p) => p.id)).toEqual(['acme.weather']);
    expect(existsSync(state.plugin('rdf.dock'))).toBe(false);
    expect(existsSync(state.plugin('acme.weather'))).toBe(true);
    expect(state.theme()).toBe('tokyo-night');
    state.run('apply');
    expect(state.hyprland()).not.toContain('octo-desktop.familiar');
    expect(state.shell().plugins.map((p) => p.id)).toEqual(['acme.weather']);
  });

  it('leaves a theme the user picked themselves when switching to Omarchy', () => {
    const state = fixture();
    state.run('familiar');
    writeFileSync(join(state.home, '.local/state/omarchy/current/theme.name'), 'nord\n');
    state.run('omarchy');
    expect(state.theme()).toBe('nord');
    expect(state.calls()).toEqual(['omarchy-theme-set octogee headless=1']);
  });

  it('keeps a plugin the user installed by hand: no link over it, and its shell.json entry survives a switch to Omarchy', () => {
    const state = fixture();
    mkdirSync(state.plugin('rdf.dock'), { recursive: true });
    writeFileSync(join(state.plugin('rdf.dock'), 'manifest.json'), '{}');
    mkdirSync(join(state.home, '.config/omarchy'), { recursive: true });
    writeFileSync(join(state.home, '.config/omarchy/shell.json'), JSON.stringify({ plugins: [{ id: 'rdf.dock', edge: 'left' }] }));
    state.run('familiar');
    expect(lstatSync(state.plugin('rdf.dock')).isSymbolicLink()).toBe(false);
    expect(lstatSync(state.plugin('community.window-switcher')).isSymbolicLink()).toBe(true);
    expect(state.shell().plugins).toEqual([{ id: 'rdf.dock', edge: 'left' }, expect.objectContaining({ id: 'community.window-switcher' })]);
    state.run('omarchy');
    expect(state.shell().plugins).toEqual([{ id: 'rdf.dock', edge: 'left' }]);
    expect(existsSync(state.plugin('rdf.dock'))).toBe(true);
    expect(existsSync(state.plugin('community.window-switcher'))).toBe(false);
  });

  it('reloads the running session and themes live when Hyprland is up', () => {
    const state = fixture({ live: true });
    state.run('familiar');
    expect(state.calls()).toEqual([
      'hyprctl -j version headless=0',
      'omarchy-theme-set octogee headless=0',
      'hyprctl -j version headless=0',
      'hyprctl reload headless=0',
      'omarchy-shell -q shell rescanPlugins headless=0',
      'omarchy-shell shell reloadConfig headless=0',
    ]);
  });

  it('unloads the title bars live before returning to the stock Omarchy desktop', () => {
    const state = fixture({ live: true, currentTheme: 'octogee' });
    state.run('omarchy');
    expect(state.calls()).toContain(`hyprctl plugin unload ${join(state.share, 'octo-desktop/hyprbars.so')} headless=0`);
    expect(state.calls().indexOf('hyprctl plugin unload ' + join(state.share, 'octo-desktop/hyprbars.so') + ' headless=0')).toBeLessThan(state.calls().indexOf('hyprctl reload headless=0'));
    expect(state.theme()).toBe('tokyo-night');
  });

  it('colours the octogee theme with the agent look accent and keeps it across a plain re-apply', () => {
    const state = fixture();
    state.run('familiar', '--accent', '#0ea5e9');
    const colors = () => readFileSync(join(state.home, '.config/omarchy/themes/octogee/colors.toml'), 'utf8');
    expect(colors()).toContain('accent = "#0ea5e9"');
    expect(colors()).toContain('blue = "#0ea5e9"');
    expect(colors()).toContain('bright_blue = "#0ea5e9"');
    expect(colors()).toContain('selection = "#b7e3f8"');
    expect(colors()).toContain('mode = "light"');
    state.run('familiar');
    expect(colors()).toContain('accent = "#0ea5e9"');
    state.run('familiar', '--accent', '#65a30d');
    expect(colors()).toContain('accent = "#65a30d"');
    expect(colors()).toContain('selection = "#d1e3b6"');
    expect(state.calls().filter((c) => c.startsWith('omarchy-theme-set'))).toHaveLength(3);
  });

  it('ships the brand coral as the default accent and refuses malformed accents', () => {
    const state = fixture();
    state.run('familiar');
    expect(readFileSync(join(state.home, '.config/omarchy/themes/octogee/colors.toml'), 'utf8')).toContain('accent = "#e74e3c"');
    for (const bad of ['blue', '#FFF', '#0EA5E9', '0ea5e9', '']) {
      expect(() => state.run('familiar', '--accent', bad)).toThrow(/accent must be/);
    }
    expect(() => state.run('omarchy', '--accent', '#0ea5e9')).toThrow(/usage: octo-desktop-style/);
    expect(() => state.run('familiar', '--accent')).toThrow(/accent must be/);
  });

  it('refuses an unknown command', () => {
    const state = fixture();
    expect(() => state.run('mac')).toThrow(/usage: octo-desktop-style/);
  });
});
