import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkpointGatewayCredentials, matchesRestartedCheckpoint, readCheckpointRestore, waitForCheckpointClaim } from './hobby-checkpoint-gate.js';

vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

const source = { GATEWAY_ID: 'hobby-slot-one', OCTOGEE_CHECKPOINT_SLOT_ID: 'hobby-slot-one', POD_UID: 'a14b565b-622b-43f6-b064-4df67e4ba917', K8S_NAMESPACE: 'test' };
const current = { ...source, POD_UID: '298d9765-ee20-43b4-9512-ff11a342ef64', OCTOGEE_CHECKPOINT_SNAPSHOT: 'snapshot-one' };
const claim = { version: 1, slotId: source.GATEWAY_ID, gatewayId: source.GATEWAY_ID, snapshotName: current.OCTOGEE_CHECKPOINT_SNAPSHOT,
  podUid: current.POD_UID, uid: 'actual-user', slug: 'actual-slug', assignmentEpoch: 0 } as const;

describe('single-use checkpoint boot', () => {
  it('allows container restart only after that role restored in this exact Pod UID', () => {
    expect(matchesRestartedCheckpoint(current, claim, current.POD_UID)).toBe(true);
    expect(matchesRestartedCheckpoint(current, claim, source.POD_UID)).toBe(false);
    expect(matchesRestartedCheckpoint({ ...current, POD_UID: source.POD_UID }, claim, current.POD_UID)).toBe(false);
  });

  it('admits only a different actual pod with the exact immutable claim before reading credentials', () => {
    expect(readCheckpointRestore(source, current, claim)).toEqual(claim);
  });

  it.each([
    ['source pod replay', source, current, { ...claim, podUid: source.POD_UID }],
    ['foreign slot', source, current, { ...claim, slotId: 'hobby-slot-two' }],
    ['foreign snapshot', source, current, { ...claim, snapshotName: 'snapshot-two' }],
    ['foreign namespace', source, { ...current, K8S_NAMESPACE: 'other' }, claim],
    ['cold fallback', current, current, claim],
    ['empty owner', source, current, { ...claim, uid: '' }],
    ['wrong version', source, current, { ...claim, version: 2 }],
  ])('fails closed on %s', (_title, boot, fresh, receipt) => {
    expect(readCheckpointRestore(boot, fresh, receipt)).toBeNull();
  });
});

describe('checkpoint credential projection', () => {
  it('does not read an already-mounted Secret until the exact restored claim arrives', async () => {
    for (const [key, value] of Object.entries(source)) vi.stubEnv(key, value);
    vi.stubEnv('OCTOGEE_CHECKPOINT_SNAPSHOT', '');
    const spec = Object.entries(current).map(([key, value]) => `${key}=${value}`).join('\0');
    const mountedPaths: string[] = [];
    const pending = Object.assign(new Error('not mounted'), { code: 'ENOENT' });
    let claimObserved = false;
    vi.mocked(readFile).mockImplementation(async input => {
      const file = String(input);
      mountedPaths.push(file);
      if (file === '/proc/gvisor/spec_environ') return spec;
      if (file.endsWith('/claim.json')) {
        if (claimObserved) return JSON.stringify(claim);
        claimObserved = true;
        throw pending;
      }
      if (file.endsWith('/token')) return 'test-token';
      if (file.endsWith('/agent-store-dsn')) return 'postgres://test/store';
      throw new Error('Unexpected file');
    });
    await expect(waitForCheckpointClaim('gateway')).resolves.toEqual(claim);
    expect(mountedPaths.map(file => file.split('/').at(-1))).toEqual([
      'spec_environ', 'claim.json', 'claim.json', 'spec_environ', 'token', 'agent-store-dsn',
    ]);
    expect(vi.mocked(writeFile).mock.calls.map(([, body]) => body)).toEqual([source.POD_UID, current.POD_UID]);
  });


  it('waits for the scoped Secret data after an otherwise ready restored claim', async () => {
    const read = vi.fn().mockRejectedValueOnce(Object.assign(new Error('not mounted'), { code: 'ENOENT' }))
      .mockResolvedValueOnce({ token: 'test-token', agentStoreDsn: 'postgres://test/store' });
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(checkpointGatewayCredentials(read, wait)).resolves.toEqual({
      token: 'test-token', agentStoreDsn: 'postgres://test/store',
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
  });

  it('refuses a malformed Secret without turning it into a wait', async () => {
    const read = vi.fn().mockResolvedValue({ token: '', agentStoreDsn: 'postgres://test/store' });
    const wait = vi.fn();
    await expect(checkpointGatewayCredentials(read, wait)).rejects.toThrow('credentials are unavailable');
    expect(wait).not.toHaveBeenCalled();
  });
});
