import { isDeepStrictEqual } from 'node:util';
import type { UntypedRecord } from '@octogee/core/platform-state';
import type { SourceRecoveryAgentStore } from '@octogee/core/shared-source-recovery';
import type { SharedPodRecoveryDeps } from './shared-restore-runtime.js';

export function sourceRecoveryDiscoveryDriver(podUid: string, stores: readonly SourceRecoveryAgentStore[]): string {
  return `const input = ${JSON.stringify({ podUid, stores })};\n` + String.raw`
function sourceRecoveryDiscoveryPreflight() {
  const fs = require('node:fs'), path = require('node:path');
  const fail = message => { throw new Error('source discovery requires stale local store resolution before source recovery: ' + message); };
  if (!input.podUid || process.env.POD_UID !== input.podUid) fail('retained Pod identity changed');
  const root = path.resolve(process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_DIR || '/home/node/.openclaw');
  const directory = file => {
    if (!fs.lstatSync(file).isDirectory() || fs.realpathSync(file) !== file) fail('noncanonical directory ' + file);
  };
  const regularFile = file => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file) fail('noncanonical file ' + file);
    return stat;
  };
  directory(root);
  const configPath = path.resolve(process.env.OPENCLAW_CONFIG_PATH || path.join(root, 'openclaw.json'));
  regularFile(configPath);
  if (fs.statSync(configPath).size > 4 * 1024 * 1024) fail('config exceeds discovery bound');
  const configBytes = fs.readFileSync(configPath), config = JSON.parse(configBytes.toString('utf8'));
  if (config.agents?.ownership !== 'explicit' || !config.agents.entries || typeof config.agents.entries !== 'object' ||
      Array.isArray(config.agents.entries) || config.agents.list !== undefined) fail('canonical explicit agent entries required');
  if (config.session?.store !== undefined) fail('custom session discovery root requires operator review');
  const agentsRoot = path.join(root, 'agents'); directory(agentsRoot);
  const selected = new Map();
  for (const store of input.stores) {
    if (!/^octogee-[a-z0-9][a-z0-9_-]*-coach$/.test(store.agentId) || selected.has(store.agentId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(store.storeId) ||
        !/^[a-z_][a-z0-9_]{0,62}$/.test(store.schema)) fail('captured agent roster is invalid');
    selected.set(store.agentId, store);
  }
  if (!selected.size) fail('captured agent roster is empty');
  const serviceId = 'octogee-unmatched-route';
  if (config.agents.entries[serviceId] || config.bindings?.some(binding => binding.agentId === serviceId)) selected.set(serviceId, null);
  for (const [agentId, entry] of Object.entries(config.agents.entries)) {
    if (entry?.agentDir !== undefined && entry.agentDir !== path.join(agentsRoot, agentId, 'agent')) fail('custom agent discovery path: ' + agentId);
  }
  const entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  if (entries.length > 4096) fail('agent directory count exceeds discovery bound');
  const foreign = entries.filter(entry => entry.isDirectory() && !selected.has(entry.name)).map(entry => entry.name).sort();
  if (foreign.length) fail('foreign agent directories: ' + foreign.join(', '));
  if (entries.some(entry => entry.isSymbolicLink())) fail('symlink in agent discovery root');
  const files = [...selected].map(([agentId, expected]) => {
    const agentRoot = path.join(agentsRoot, agentId); directory(agentRoot);
    const agentDir = path.join(agentRoot, 'agent'); directory(agentDir);
    const file = path.join(agentDir, 'openclaw-agent.sqlite'); regularFile(file);
    const sessions = path.join(agentRoot, 'sessions');
    if (fs.existsSync(sessions)) directory(sessions);
    return { agentId, expected, file };
  });
  const { DatabaseSync } = require('node:sqlite'), identities = [];
  for (const { agentId, expected, file } of files) {
    const db = new DatabaseSync(file, { readOnly: true });
    let rows;
    try { rows = db.prepare('SELECT store_id, engine, schema FROM openclaw_engine_anchor').all(); }
    finally { db.close(); }
    const row = rows[0];
    if (rows.length !== 1 || row.engine !== 'postgres' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.store_id) ||
        !/^[a-z_][a-z0-9_]{0,62}$/.test(row.schema) ||
        expected && (row.store_id !== expected.storeId || row.schema !== expected.schema) ||
        identities.some(identity => identity.storeId === row.store_id || identity.schema === row.schema)) fail('PostgreSQL anchor identity changed: ' + agentId);
    identities.push({ agentId, storeId: row.store_id, schema: row.schema });
    regularFile(file);
  }
  if (!fs.readFileSync(configPath).equals(configBytes)) fail('serving config changed during discovery');
  directory(agentsRoot);
  if (JSON.stringify(fs.readdirSync(agentsRoot).sort()) !== JSON.stringify(entries.map(entry => entry.name).sort())) fail('agent discovery roster changed');
  return { version: 1, podUid: input.podUid, agentIds: identities.map(identity => identity.agentId).sort() };
}
try { process.stdout.write(JSON.stringify(sourceRecoveryDiscoveryPreflight())); }
catch (error) { process.stderr.write(String(error.message)); process.exitCode = 1; }
`;
}

export async function assertSourceRecoveryDiscovery(deps: Pick<SharedPodRecoveryDeps, 'namespace' | 'runKubectl'>, pod: UntypedRecord,
  stores: readonly SourceRecoveryAgentStore[]): Promise<void> {
  const result = await deps.runKubectl(['-n', deps.namespace, 'exec', pod.metadata.name, '-c', 'gateway', '-i', '--', 'node', '--input-type=commonjs'],
    { stdin: sourceRecoveryDiscoveryDriver(pod.metadata.uid, stores), timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`source discovery requires stale local store resolution before source recovery: ${result.stderr.trim().slice(0, 4096)}`);
  let proof: { version: number; podUid: string; agentIds: string[] };
  try { proof = JSON.parse(result.stdout); } catch { throw new Error('source discovery receipt is invalid'); }
  const expected = stores.map(store => store.agentId).sort();
  if (!isDeepStrictEqual(Object.keys(proof).sort(), ['agentIds', 'podUid', 'version']) || proof.version !== 1 || proof.podUid !== pod.metadata.uid ||
      !isDeepStrictEqual(proof.agentIds, expected) && !isDeepStrictEqual(proof.agentIds, [...expected, 'octogee-unmatched-route'].sort())) {
    throw new Error('source discovery receipt does not match the captured agent roster');
  }
}
