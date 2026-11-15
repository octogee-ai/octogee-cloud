import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordIsolatedNativeInitialState, isolatedNativeInitialStateMatches } from '../lib/isolated-native-initial-state.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-native-initial-'));
  fs.mkdirSync(path.join(root, 'state'));
  fs.writeFileSync(path.join(root, 'state/openclaw.sqlite'), 'Native-created initial state');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it('binds unchanged initialized host state to its exact pod', () => {
  recordIsolatedNativeInitialState(root, 'pod-one');
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(true);
  expect(isolatedNativeInitialStateMatches(root, 'pod-two')).toBe(false);
  expect(isolatedNativeInitialStateMatches(root, undefined)).toBe(false);
});
it('refuses a baseline that grows beyond its byte cap after it is opened', () => {
  recordIsolatedNativeInitialState(root, 'pod-one');
  const file = path.join(root, '.builder-native-initial-state.json');
  const read = fs.fstatSync;
  const stat = vi.spyOn(fs, 'fstatSync').mockImplementationOnce(((fd: number) => {
    const initial = read(fd);
    fs.appendFileSync(file, ' '.repeat(1024));
    return initial;
  }) as typeof fs.fstatSync);
  try { expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(false); }
  finally { stat.mockRestore(); }
});
it('refuses the baseline after any database mutation', () => {
  recordIsolatedNativeInitialState(root, 'pod-one');
  fs.appendFileSync(path.join(root, 'state/openclaw.sqlite'), 'later writes');
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(false);
});
it.each(['openclaw.sqlite-wal', 'other-state'])('refuses extra state even if its database bytes are unchanged: %s', file => {
  recordIsolatedNativeInitialState(root, 'pod-one');
  fs.writeFileSync(path.join(root, 'state', file), 'retained');
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(false);
});
it('refuses a linked database and preserves its target', () => {
  recordIsolatedNativeInitialState(root, 'pod-one');
  fs.renameSync(path.join(root, 'state/openclaw.sqlite'), path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'state/openclaw.sqlite'));
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(false);
  expect(fs.readFileSync(path.join(root, 'outside'), 'utf8')).toBe('Native-created initial state');
});
it('does not infer an initialized baseline without a matching record', () => {
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(false);
  recordIsolatedNativeInitialState(root, undefined);
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(false);
});

it('records the Native clean-close seal and refuses any later seal change', () => {
  fs.writeFileSync(path.join(root, 'state/openclaw.sqlite.seal'), 'Native clean-close seal');
  recordIsolatedNativeInitialState(root, 'pod-one');
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(true);
  fs.appendFileSync(path.join(root, 'state/openclaw.sqlite.seal'), 'changed');
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(false);
});
it('binds the baseline to its original canonical state directory', () => {
  recordIsolatedNativeInitialState(root, 'pod-one');
  const moved = root + '-moved';
  fs.renameSync(root, moved);
  fs.symlinkSync(moved, root);
  try { expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(false); }
  finally { fs.unlinkSync(root); fs.renameSync(moved, root); }
});
it.each(['openclaw.sqlite-wal', 'openclaw.sqlite-journal', 'openclaw-quarantine.sqlite'])('never records an unsafe fresh-state family: %s', file => {
  fs.writeFileSync(path.join(root, 'state', file), 'retained changes');
  expect(() => recordIsolatedNativeInitialState(root, 'pod-one')).toThrow('closed and canonical');
});
it('records a closed database family including empty sidecars and shared memory', () => {
  for (const file of ['openclaw.sqlite-wal', 'openclaw.sqlite-journal']) fs.writeFileSync(path.join(root, 'state', file), '');
  fs.writeFileSync(path.join(root, 'state/openclaw.sqlite-shm'), 'shared memory');
  recordIsolatedNativeInitialState(root, 'pod-one');
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(true);
  fs.appendFileSync(path.join(root, 'state/openclaw.sqlite-shm'), 'changed');
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(false);
});

it('binds fresh client credentials and refuses later identities before replacing unused state', () => {
  fs.mkdirSync(path.join(root, 'client'));
  fs.writeFileSync(path.join(root, 'client/credentials.sqlite'), 'Native-created client companion');
  recordIsolatedNativeInitialState(root, 'pod-one');
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(true);
  fs.appendFileSync(path.join(root, 'client/credentials.sqlite'), 'paired device');
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(false);
});
it('refuses a client companion created after initial state was recorded', () => {
  recordIsolatedNativeInitialState(root, 'pod-one');
  fs.mkdirSync(path.join(root, 'client'));
  fs.writeFileSync(path.join(root, 'client/credentials.sqlite'), 'later credentials');
  expect(isolatedNativeInitialStateMatches(root, 'pod-one')).toBe(false);
});

it('refuses a linked client directory and retains its credentials', () => {
  fs.mkdirSync(path.join(root, 'external-client'));
  fs.writeFileSync(path.join(root, 'external-client/credentials.sqlite'), 'retained credentials');
  fs.symlinkSync(path.join(root, 'external-client'), path.join(root, 'client'));
  expect(() => recordIsolatedNativeInitialState(root, 'pod-one')).toThrow('closed and canonical');
  expect(fs.readFileSync(path.join(root, 'external-client/credentials.sqlite'), 'utf8')).toBe('retained credentials');
});
it('refuses a client companion with a nonempty transaction journal', () => {
  fs.mkdirSync(path.join(root, 'client'));
  fs.writeFileSync(path.join(root, 'client/credentials.sqlite'), 'Native-created client companion');
  fs.writeFileSync(path.join(root, 'client/credentials.sqlite-wal'), 'uncheckpointed credentials');
  expect(() => recordIsolatedNativeInitialState(root, 'pod-one')).toThrow('closed and canonical');
});
