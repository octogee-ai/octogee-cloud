import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { uninitializedUserState } from '../lib/uninitialized-user-state.js';
import { recordIsolatedNativeInitialState } from '../lib/isolated-native-initial-state.js';

let root: string;
const agentId = 'octogee-alice-coach';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-isolated-target-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function write(relative: string) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'retained');
}
it('recognizes an uninitialized SQLite host with only generated provider configuration', () => {
  for (const file of ['models.json', '.platform-openai-managed', '.platform-openrouter-managed']) write(`agents/${agentId}/agent/${file}`);
  expect(uninitializedUserState(root, [agentId], { engine: 'sqlite', families: { agent: { engine: 'postgres' } } })).toBe(true);
});
it.each([
  'state/openclaw.sqlite', 'state/openclaw.sqlite-wal', 'client/credentials.sqlite', 'workspace-identity-ready', 'workspace-identity-bootstrap.json',
  `agents/${agentId}/agent/openclaw-agent.sqlite`, `agents/${agentId}/agent/auth-profiles.json`,
  `agents/${agentId}/sessions/transcript.jsonl`, `agents/${agentId}/memory/private.md`,
])('requires Native cleanup when durable or unknown state exists: %s', relative => {
  write(relative);
  expect(uninitializedUserState(root, [agentId], { engine: 'sqlite' })).toBe(false);
  expect(fs.readFileSync(path.join(root, relative), 'utf8')).toBe('retained');
});
it.each([{ engine: 'postgres' }, { engine: 'sqlite', families: { state: { engine: 'postgres' } } }])('refuses to infer absence from a PostgreSQL host selector: %j', database => {
  expect(uninitializedUserState(root, [agentId], database)).toBe(false);
});
it('refuses links even when their names match generated configuration', () => {
  write('outside'); fs.mkdirSync(path.join(root, 'agents', agentId, 'agent'), { recursive: true });
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'agents', agentId, 'agent/models.json'));
  expect(uninitializedUserState(root, [agentId], { engine: 'sqlite' })).toBe(false);
});
it('checks every agent before declaring an uninitialized target', () => {
  const project = 'octogee-alice-proj-orbit-coach';
  write(`agents/${project}/agent/openclaw-agent.sqlite`);
  expect(uninitializedUserState(root, [agentId, project], { engine: 'sqlite' })).toBe(false);
});
it('accepts only the exact unchanged Native-created host baseline on the same held pod', () => {
  write('state/openclaw.sqlite');
  recordIsolatedNativeInitialState(root, 'pod-one');
  expect(uninitializedUserState(root, [agentId], { engine: 'sqlite' }, 'pod-one')).toBe(true);
  expect(uninitializedUserState(root, [agentId], { engine: 'sqlite' }, 'pod-other')).toBe(false);
  fs.appendFileSync(path.join(root, 'state/openclaw.sqlite'), 'user state');
  expect(uninitializedUserState(root, [agentId], { engine: 'sqlite' }, 'pod-one')).toBe(false);
});

it('refuses user state belonging to an agent outside the requested cleanup list', () => {
  write('agents/unexpected/agent/openclaw-agent.sqlite');
  expect(uninitializedUserState(root, [agentId], { engine: 'sqlite' })).toBe(false);
});
