import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { sourceRecoveryDiscoveryDriver } from './shared-source-discovery.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(service = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'source-discovery-'))); roots.push(root);
  const stores = ['octogee-alice-coach', 'octogee-alice-proj-orbit-coach'].map((agentId, index) => ({
    uid: 'alice-uid', slug: 'alice', assignmentEpoch: 3, agentId,
    storeId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, schema: `owned_${index}`,
  }));
  const config = { agents: { ownership: 'explicit', entries: {} as Record<string, { agentDir: string }> }, bindings: [] as { agentId: string }[] };
  function add(agentId: string, storeId: string, schema: string) {
    const dir = path.join(root, 'agents', agentId, 'agent'); fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(root, 'agents', agentId, 'sessions'));
    const file = path.join(dir, 'openclaw-agent.sqlite'), db = new DatabaseSync(file);
    try {
      db.exec('CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)');
      db.prepare('INSERT INTO openclaw_engine_anchor VALUES (?, ?, ?)').run(storeId, 'postgres', schema);
    } finally { db.close(); }
    return file;
  }
  for (const store of stores) {
    add(store.agentId, store.storeId, store.schema);
    config.agents.entries[store.agentId] = { agentDir: path.join(root, 'agents', store.agentId, 'agent') };
  }
  if (service) {
    add('octogee-unmatched-route', '00000000-0000-4000-8000-000000000003', 'owned_service');
    config.bindings.push({ agentId: 'octogee-unmatched-route' });
  }
  const saveConfig = () => fs.writeFileSync(path.join(root, 'openclaw.json'), JSON.stringify(config)); saveConfig();
  const run = (podUid = 'pod-uid') => spawnSync(process.execPath, ['--input-type=commonjs'], {
    input: sourceRecoveryDiscoveryDriver('pod-uid', stores), encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, OPENCLAW_STATE_DIR: root, POD_UID: podUid },
  });
  return { root, stores, config, add, saveConfig, run };
}
function bytes(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  function visit(dir: string) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else entries[path.relative(root, file)] = fs.readFileSync(file).toString('base64');
    }
  }
  visit(root); return entries;
}
describe('retained PostgreSQL source discovery preflight', () => {
  it.each([true, false])('reads the full owned agent/project and selected service anchors without changing bytes, service=%s', service => {
    const f = fixture(service), before = bytes(f.root);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = f.run(); expect(result.stderr).not.toContain('Error'); expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ version: 1, podUid: 'pod-uid',
        agentIds: [...f.stores.map(store => store.agentId), ...(service ? ['octogee-unmatched-route'] : [])].sort() });
      expect(bytes(f.root)).toEqual(before);
    }
  });
  it('refuses an unconfigured foreign directory before opening any anchor and succeeds after operator removes only that alias', () => {
    const f = fixture(), foreign = path.join(f.root, 'agents', 'octogee-foreign-coach'); fs.mkdirSync(foreign);
    const file = path.join(f.root, 'agents', f.stores[0].agentId, 'agent', 'openclaw-agent.sqlite');
    const original = fs.readFileSync(file); fs.writeFileSync(file, 'not SQLite');
    const before = bytes(f.root), refused = f.run();
    expect(refused.status).toBe(1); expect(refused.stderr).toContain('foreign agent directories: octogee-foreign-coach');
    expect(refused.stderr).not.toContain('not a database'); expect(bytes(f.root)).toEqual(before);
    fs.renameSync(foreign, path.join(f.root, 'preserved-foreign-alias')); fs.writeFileSync(file, original);
    expect(f.run().status).toBe(0); expect(fs.existsSync(foreign)).toBe(false);
  });
  it('accepts a service selected only by explicit entries', () => {
    const f = fixture(); f.config.bindings = []; f.config.agents.entries['octogee-unmatched-route'] = { agentDir: path.join(f.root, 'agents/octogee-unmatched-route/agent') }; f.saveConfig();
    expect(f.run().status).toBe(0);
  });
  it('refuses an unselected service directory', () => {
    const f = fixture(); f.config.bindings = []; f.saveConfig();
    expect(f.run().stderr).toContain('foreign agent directories: octogee-unmatched-route');
  });
  it.each(['uid', 'store-id', 'schema', 'service-alias', 'missing-service', 'hardlink', 'symlink', 'custom-agent-path', 'custom-session-path'])('refuses %s without changing local bytes', kind => {
    const f = fixture(), store = f.stores[0], file = path.join(f.root, 'agents', store.agentId, 'agent', 'openclaw-agent.sqlite');
    if (kind === 'store-id') store.storeId = '00000000-0000-4000-8000-000000000009';
    if (kind === 'schema') store.schema = 'different_schema';
    if (kind === 'service-alias') {
      const service = new DatabaseSync(path.join(f.root, 'agents/octogee-unmatched-route/agent/openclaw-agent.sqlite'));
      service.prepare('UPDATE openclaw_engine_anchor SET store_id = ?').run(store.storeId); service.close();
    }
    if (kind === 'missing-service') fs.rmSync(path.join(f.root, 'agents/octogee-unmatched-route'), { recursive: true });
    if (kind === 'hardlink') fs.linkSync(file, path.join(f.root, 'retained-anchor-link'));
    if (kind === 'symlink') { fs.renameSync(path.dirname(file), path.join(f.root, 'moved-agent')); fs.symlinkSync(path.join(f.root, 'moved-agent'), path.dirname(file)); }
    if (kind === 'custom-agent-path') { f.config.agents.entries[store.agentId].agentDir = '/outside/agent'; f.saveConfig(); }
    if (kind === 'custom-session-path') { Object.assign(f.config, { session: { store: '/outside/{agentId}/sessions.json' } }); f.saveConfig(); }
    const before = kind === 'symlink' ? null : bytes(f.root), result = f.run(kind === 'uid' ? 'recreated-pod' : undefined);
    expect(result.status).toBe(1); expect(result.stderr).toBeTruthy();
    if (before) expect(bytes(f.root)).toEqual(before);
  });
});
