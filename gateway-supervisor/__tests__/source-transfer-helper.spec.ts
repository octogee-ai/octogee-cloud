import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { admitSourceTree, parseSourceTransferRequest, sharedMigrationAgentIds, sourcesForPushMode } from '../lib/source-transfer-plan.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function root() { const value = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-test-'))); roots.push(value); return value; }
const request = { resourceAdmission: { observedAt: Date.now(), sourceMemoryMax: 8 * 1024 ** 3, sourceMemoryCurrent: 3 * 1024 ** 3 }, version: 1, executionId: 'transfer-123', operationId: 'op-123', claimStartedAt: 123, migrationId: 'migration-123', uid: 'user-123', slug: 'alice', sourceGatewayId: 'shared-123', sourcePodUid: 'pod-123', assignmentEpoch: 4, mode: 'final', includeActivationManifest: true, targetHost: '10.1.2.3', targetPort: 8873, targetCertificatePem: '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n', transferUser: 'migration', transferKey: 'private-transfer-key' };
describe('source transfer admission', () => {
 it('binds a final transfer to the exact execution and pod', () => { expect(parseSourceTransferRequest(request, 'transfer-123', 'pod-123')).toEqual(request); expect(() => parseSourceTransferRequest(request, 'other', 'pod-123')).toThrow(); expect(() => parseSourceTransferRequest(request, 'transfer-123', 'other')).toThrow(); });
 it('rejects arbitrary command/path fields and nonfinal modes', () => { for (const change of [{ command: 'anything' }, { sourceRoot: '/elsewhere' }, { mode: 'pre' }, { transferKey: 'line\nbreak' }, { targetHost: 'host;command' }]) expect(() => parseSourceTransferRequest({ ...request, ...change }, 'transfer-123', 'pod-123')).toThrow(); });
 it('includes archived owned agents while excluding foreign identities', async () => { const dir = await root(); for (const agent of ['octogee-alice-coach', 'octogee-alice-proj-weekend-coach', 'octogee-bob-coach']) { await fs.mkdir(path.join(dir, 'agents', agent), { recursive: true }); } expect(sharedMigrationAgentIds(dir, 'alice')).toEqual(['octogee-alice-coach', 'octogee-alice-proj-weekend-coach']); });
 it('preserves final selection and omits only the separately transferred user keys', () => { const sources = ['customers/alice', 'customer-keys/alice', 'agents/octogee-alice-coach'].map(p => ({ cwd: '/state', path: p })); expect(sourcesForPushMode(sources, 'alice', 'final')).toEqual([sources[0], sources[2]]); });
 it('rejects symlinks, foreign paths and oversized exports before transfer', async () => { const dir = await root(); await fs.mkdir(path.join(dir, 'customers/alice'), { recursive: true }); await fs.writeFile(path.join(dir, 'customers/alice/file'), '1234'); const sources = [{ cwd: dir, path: 'customers/alice' }]; expect(await admitSourceTree(dir, 'alice', sources, { maxBytes: 4 })).toMatchObject({ bytes: 4, files: 1 }); await expect(admitSourceTree(dir, 'alice', sources, { maxBytes: 3 })).rejects.toThrow(); await fs.symlink('/tmp', path.join(dir, 'customers/alice/link')); await expect(admitSourceTree(dir, 'alice', sources)).rejects.toThrow(); await expect(admitSourceTree(dir, 'alice', [{ cwd: dir, path: '../foreign' }])).rejects.toThrow(); await expect(admitSourceTree(dir, 'alice', [{ cwd: dir, path: 'customers/bob' }])).rejects.toThrow(); });
});

import { prepareSourceTransferStage } from '../lib/source-transfer-stage.js';
import { sourceTransferRsyncArgs } from '../lib/source-transfer-rsync.js';
it('requires a real applied fingerprint before writing any executable plan', async () => {
 const state = await root();
 const scratch = await fs.mkdtemp('/tmp/octogee-source-transfer-'); roots.push(scratch);
 await fs.mkdir(path.join(state, 'customers/alice'), { recursive: true });
 await fs.writeFile(path.join(state, 'customers/alice/file'), 'data');
 await fs.writeFile(path.join(scratch, 'request.json'), JSON.stringify(request));
 await expect(prepareSourceTransferStage('plan', scratch, request.executionId, request.sourcePodUid, state)).rejects.toThrow('source has no applied fingerprint');
 await expect(fs.stat(path.join(scratch, 'plan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('retains live SQLite exclusions and exact final rsync deletion semantics', () => {
 const args = sourceTransferRsyncArgs([{ cwd: '/state/', path: 'agents/octogee-alice-coach' }], '/private/pass', 'rsync://migration@127.0.0.1/state/', 'final');
 expect(args).toContain('--delete-delay'); expect(args).toContain('--exclude=openclaw-agent.sqlite'); expect(args).toContain('--exclude=openclaw-agent.sqlite-*'); expect(args).toContain('/state/./agents/octogee-alice-coach');
 expect(sourceTransferRsyncArgs([], '/private/pass', 'target', 'pre')).not.toContain('--delete-delay');
});
it('rejects owned directory symlinks instead of silently omitting archived state', async () => {
 const state = await root(); await fs.mkdir(path.join(state, 'agents'));
 await fs.symlink('/tmp', path.join(state, 'agents/octogee-alice-proj-weekend-coach'));
 expect(() => sharedMigrationAgentIds(state, 'alice')).toThrow();
});
it('does not charge excluded Codex database bytes to mandatory state but still rejects symlinks', async () => {
 const state = await root();
 const agent = 'agents/octogee-alice-coach';
 const home = path.join(state, agent, 'agent/codex-home');
 await fs.mkdir(home, { recursive: true });
 await fs.writeFile(path.join(home, 'goals_1.sqlite'), 'large optional state');
 await fs.writeFile(path.join(home, 'goals_1.sqlite-wal'), 'journal');
 await fs.writeFile(path.join(home, 'config.toml'), 'keep');
 expect(await admitSourceTree(state, 'alice', [{ cwd: state, path: agent }], { maxBytes: 4 })).toMatchObject({ bytes: 4, files: 1 });
 await fs.symlink('/tmp', path.join(home, 'state_5.sqlite'));
 await expect(admitSourceTree(state, 'alice', [{ cwd: state, path: agent }])).rejects.toThrow();
});
it('admits owned state without traversing excluded legacy Codex helpers and still rejects durable-state symlinks', async () => {
 const state = await root(), agent = 'agents/octogee-alice-coach';
 const home = path.join(state, agent, 'agent/codex-home');
 const temporary = path.join(home, 'tmp/arg0/codex-arg0l58nfp');
 await fs.mkdir(temporary, { recursive: true });
 await fs.symlink('/usr/local/lib/node_modules/@openai/codex/bin/codex', path.join(temporary, 'apply_patch'));
 await fs.writeFile(path.join(home, 'config.toml'), 'keep');
 expect(await admitSourceTree(state, 'alice', [{ cwd: state, path: agent }], { maxBytes: 4 })).toEqual({ bytes: 4, files: 1 });
 await fs.symlink('/tmp', path.join(home, 'auth.json'));
 await expect(admitSourceTree(state, 'alice', [{ cwd: state, path: agent }])).rejects.toThrow('unsupported source file type');
});
it('plans and finishes owned state with a genuine activation manifest and optional Codex snapshots', async () => {
 const state = await root();
 const scratch = await fs.mkdtemp('/tmp/octogee-source-transfer-'); roots.push(scratch);
 await fs.mkdir(path.join(state, 'customers/alice'), { recursive: true });
 await fs.writeFile(path.join(state, 'customers/alice/file'), 'data');
 const home = path.join(state, 'agents/octogee-alice-coach/agent/codex-home');
 await fs.mkdir(home, { recursive: true });
 const db = new DatabaseSync(path.join(home, 'goals_1.sqlite'));
 db.exec("CREATE TABLE goals(value TEXT); INSERT INTO goals VALUES ('goal')");
 db.close();
 await fs.writeFile(path.join(state, 'applied-fingerprints.json'), JSON.stringify({ alice: 'actual-applied-fingerprint' }));
 await fs.mkdir(path.join(state, 'secrets'));
 await fs.writeFile(path.join(state, 'secrets/mattermost-accounts.json'), JSON.stringify({ 'alice-coach': 'synthetic-token' }));
 await fs.writeFile(path.join(state, 'openclaw.json'), JSON.stringify({ agents: { list: [{ id: 'octogee-alice-coach' }] }, channels: { mattermost: { accounts: { 'alice-coach': { botToken: 'synthetic-token' } } } }, bindings: [{ agentId: 'octogee-alice-coach', match: { channel: 'mattermost', accountId: 'alice-coach' } }] }));
 await fs.writeFile(path.join(scratch, 'request.json'), JSON.stringify(request));
 await prepareSourceTransferStage('plan', scratch, request.executionId, request.sourcePodUid, state);
 expect(JSON.parse(await fs.readFile(path.join(scratch, 'plan.json'), 'utf8'))).toEqual({ snapshots: [] });
 await prepareSourceTransferStage('finish', scratch, request.executionId, request.sourcePodUid, state);
 const transfer = JSON.parse(await fs.readFile(path.join(scratch, 'transfer.json'), 'utf8'));
 expect(transfer.args).toContain(`${state}/./customers/alice`);
 expect(transfer.args).toContain(`${scratch}/snapshots/./agents/octogee-alice-coach/agent/codex-home/.octogee-codex-snapshots`);
 expect(await fs.stat(path.join(scratch, 'snapshots/agents/octogee-alice-coach/agent/codex-home/.octogee-codex-snapshots/goals_1.sqlite.backup'))).toBeTruthy();
 expect(transfer.args.join(' ')).not.toContain(request.transferKey);
 expect(await fs.readFile(path.join(scratch, 'rsync.pass'), 'utf8')).toBe(`${request.transferKey}\n`);
 expect((await fs.stat(path.join(scratch, 'rsync.pass'))).mode & 0o777).toBe(0o600);
});

it('refuses PostgreSQL anchors in the read-only retained-pod SQLite helper', async () => {
 const state = await root();
 const scratch = await fs.mkdtemp('/tmp/octogee-source-transfer-'); roots.push(scratch);
 const agentDir = path.join(state, 'agents/octogee-alice-coach/agent');
 await fs.mkdir(agentDir, { recursive: true });
 const db = new DatabaseSync(path.join(agentDir, 'openclaw-agent.sqlite'));
 db.exec('CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)');
 db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run('1514f000-4540-4f4e-92a1-831adeac3d5b', 'octogee_agent_fixture'); db.close();
 await fs.writeFile(path.join(state, 'applied-fingerprints.json'), JSON.stringify({ alice: 'applied' }));
 await fs.writeFile(path.join(state, 'openclaw.json'), JSON.stringify({ agents: { list: [{ id: 'octogee-alice-coach' }] }, channels: { mattermost: { accounts: { 'alice-coach': { botToken: 'synthetic-token' } } } }, bindings: [] }));
 await fs.writeFile(path.join(scratch, 'request.json'), JSON.stringify(request));
 await expect(prepareSourceTransferStage('plan', scratch, request.executionId, request.sourcePodUid, state)).rejects.toThrow('requires a live source Gateway with agents.detach');
 await expect(fs.stat(path.join(scratch, 'plan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
