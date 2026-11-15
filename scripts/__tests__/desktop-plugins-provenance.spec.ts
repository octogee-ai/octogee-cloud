import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const share = fileURLToPath(new URL('../../desktop/rootfs/usr/share/omarchy/octo-desktop', import.meta.url));
const plugins = join(share, 'plugins');
const provenance = JSON.parse(readFileSync(join(plugins, 'provenance.json'), 'utf8')) as { plugins: Record<string, { repository: string; commit: string; license: string }> };
const vendored = readdirSync(plugins, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
}

describe('vendored Omarchy shell plugins', () => {
  it('match the provenance record, each pinned to an exact upstream commit', () => {
    expect(Object.keys(provenance.plugins).sort()).toEqual(vendored);
    for (const [id, record] of Object.entries(provenance.plugins)) {
      expect(record.commit, id).toMatch(/^[0-9a-f]{40}$/);
      expect(record.repository, id).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
      expect(record.license, id).toBe('MIT');
      expect(readFileSync(join(plugins, id, 'LICENSE'), 'utf8')).toContain('MIT License');
    }
  });

  it('declare the directory name as their manifest id and ship no symlinks', () => {
    for (const id of vendored) {
      const manifest = JSON.parse(readFileSync(join(plugins, id, 'manifest.json'), 'utf8')) as { id: string; schemaVersion: number; kinds: string[] };
      expect(manifest.id).toBe(id);
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.kinds.length).toBeGreaterThan(0);
      for (const file of walk(join(plugins, id))) expect(lstatSync(file).isSymbolicLink(), file).toBe(false);
    }
  });

  it('are exactly the plugins the Familiar style enables in shell.json', () => {
    const entries = JSON.parse(readFileSync(join(share, 'shell-plugins.json'), 'utf8')) as { id: string; items?: { desktop?: string; exec?: string; spacer?: boolean }[] }[];
    expect(entries.map((entry) => entry.id).sort()).toEqual(vendored);
    const dock = entries.find((entry) => entry.id === 'rdf.dock');
    expect(dock?.items?.filter((item) => !item.spacer).every((item) => item.desktop || item.exec)).toBe(true);
    const familiar = readFileSync(join(share, 'familiar.lua'), 'utf8');
    expect(familiar).toContain('community.window-switcher');
  });
});
