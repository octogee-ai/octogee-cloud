import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_LOOK, characterSvg } from '@octogee/shared/types/agent-characters';

const desktop = (path: string) => readFileSync(fileURLToPath(new URL(`../../desktop/${path}`, import.meta.url)), 'utf8');
const DESK_URL = 'http://127.0.0.1:7777/desk';

describe('the Desk page shipped on the desktop image', () => {
  it('ships the shared default character drawing so the page never drifts from the PWA', () => {
    expect(desktop('rootfs/usr/share/omarchy/octo-desktop/desk/character.svg').trim()).toBe(characterSvg(DEFAULT_AGENT_LOOK));
  });

  it('is Chromium\'s homepage and new tab through the managed policy and every OCTO_HOME_URL default', () => {
    const policy = JSON.parse(desktop('image/rootfs/etc/chromium/policies/managed/octogee-desk.json')) as Record<string, unknown>;
    expect(policy).toEqual({ HomepageLocation: DESK_URL, HomepageIsNewTabPage: false, NewTabPageLocation: DESK_URL });
    expect(desktop('image/rootfs/etc/systemd/system/octo-desktop.service')).toContain(`Environment=OCTO_HOME_URL=${DESK_URL}`);
    expect(desktop('rootfs/usr/local/bin/octo-desktop-browser')).toContain(`"--app=\${OCTO_HOME_URL:-${DESK_URL}}"`);
    expect(desktop('docker-compose.yml')).toContain(`OCTO_HOME_URL: \${OCTO_HOME_URL:-${DESK_URL}}`);
  });

  it('polls the control API for state and launches apps through it with a JSON request', () => {
    const script = desktop('rootfs/usr/share/omarchy/octo-desktop/desk/desk.js');
    expect(script).toContain("'/desk/state'");
    expect(script).toMatch(/fetch\('\/launch', \{ method: 'POST', headers: \{ 'content-type': 'application\/json' \}/u);
    expect(desktop('rootfs/usr/share/omarchy/octo-desktop/desk/index.html')).toContain('Welcome back');
  });
  it("formats the clock in the user's zone and falls back to the browser zone only without one", () => {
    const sandbox: { octoDeskClock?: { clockText: (date: Date, zone: string | null) => string }; console: Console } = { console };
    runInNewContext(desktop('rootfs/usr/share/omarchy/octo-desktop/desk/desk-clock.js'), sandbox);
    const noon = new Date(Date.UTC(2026, 0, 1, 12, 0));
    const expected = (zone?: string) => noon.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) });
    expect(sandbox.octoDeskClock!.clockText(noon, 'Asia/Tokyo')).toBe(expected('Asia/Tokyo'));
    expect(sandbox.octoDeskClock!.clockText(noon, 'America/Chicago')).toBe(expected('America/Chicago'));
    expect(expected('Asia/Tokyo')).not.toBe(expected('America/Chicago'));
    expect(sandbox.octoDeskClock!.clockText(noon, null)).toBe(expected());
    expect(sandbox.octoDeskClock!.clockText(noon, 'Mars/Olympus')).toBe(expected());
    expect(desktop('rootfs/usr/share/omarchy/octo-desktop/desk/index.html')).toContain('/desk/desk-clock.js');
  });
});
