import { link, readFile, unlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkpointGatewayCredentials, initializeCheckpointEdge, matchesRestartedCheckpoint, readCheckpointRestore, waitForCheckpointClaim } from './hobby-checkpoint-gate.js';

vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  link: vi.fn(),
  unlink: vi.fn(),
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
  it.each(['gateway', 'edge'] as const)('prepares a fresh %s without procfs and opens credentials only after a valid restore', async role => {
    for (const [key, value] of Object.entries(source)) vi.stubEnv(key, value);
    vi.stubEnv('OCTOGEE_CHECKPOINT_SNAPSHOT', '');
    const spec = Object.entries(current).map(([key, value]) => `${key}=${value}`).join('\0');
    const mountedPaths: string[] = [];
    const pending = Object.assign(new Error('not mounted'), { code: 'ENOENT' });
    let claimObserved = false;
    vi.mocked(readFile).mockImplementation(async input => {
      const file = String(input);
      mountedPaths.push(file);
      if (file === '/proc/gvisor/spec_environ') {
        if (!claimObserved) throw pending;
        return spec;
      }
      if (file.endsWith('/claim.json')) {
        if (claimObserved) return JSON.stringify(claim);
        claimObserved = true;
        throw pending;
      }
      if (file.endsWith('/token')) return 'test-token';
      if (file.endsWith('/agent-store-dsn')) return 'postgres://test/store';
      throw new Error('Unexpected file');
    });
    await expect(waitForCheckpointClaim(role)).resolves.toEqual(claim);
    expect(mountedPaths.map(file => file.split('/').at(-1))).toEqual([
      'claim.json', 'claim.json', 'spec_environ', 'token', 'agent-store-dsn',
    ]);
    expect(vi.mocked(writeFile).mock.calls.map(([path, body]) => [path, body])).toEqual([
      [`/tmp/octogee-hobby-checkpoint-${role}-prepared`, source.POD_UID],
      [`/tmp/octogee-hobby-checkpoint-${role}-restored`, current.POD_UID],
    ]);
  });

  it('rejects a received claim without gVisor restore evidence before reading credentials', async () => {
    for (const [key, value] of Object.entries(source)) vi.stubEnv(key, value);
    vi.stubEnv('OCTOGEE_CHECKPOINT_SNAPSHOT', '');
    const absent = Object.assign(new Error('missing gVisor restore evidence'), { code: 'ENOENT' });
    vi.mocked(readFile).mockImplementation(async path => {
      if (String(path).endsWith('/claim.json')) return JSON.stringify(claim);
      if (String(path) === '/proc/gvisor/spec_environ') throw absent;
      throw new Error('Attempted early credential read');
    });
    await expect(waitForCheckpointClaim('edge')).rejects.toBe(absent);
    expect(vi.mocked(writeFile).mock.calls.map(([, body]) => body)).toEqual([source.POD_UID]);
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

  it('normalizes projected Secret text once for the gateway and edge', async () => {
    await expect(checkpointGatewayCredentials(async () => ({
      token: '  example-token\r\n', agentStoreDsn: '\tpostgres://example/db\n',
    }))).resolves.toEqual({ token: 'example-token', agentStoreDsn: 'postgres://example/db' });
  });

  it.each([
    ['matching restart', current.POD_UID, claim, true],
    ['marker absent', null, claim, false],
    ['different marked pod', source.POD_UID, claim, false],
    ['different claim pod', current.POD_UID, { ...claim, podUid: source.POD_UID }, false],
    ['claim absent', current.POD_UID, null, false],
  ] as const)('%s checks restored edge custody before exposing credentials', async (_name, marker, receipt, allowed) => {
    for (const [name, value] of Object.entries(current)) vi.stubEnv(name, value);
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const reads: string[] = [];
    vi.mocked(readFile).mockImplementation(async path => {
      const file = String(path);
      reads.push(file);
      if (file.endsWith('/claim.json') && receipt) return JSON.stringify(receipt);
      if (file === '/tmp/octogee-hobby-checkpoint-edge-restored' && marker) return marker;
      if (file.endsWith('/token')) return 'example-token';
      if (file.endsWith('/agent-store-dsn')) return 'postgres://example/db';
      throw missing;
    });
    const admitted = waitForCheckpointClaim('edge');
    if (allowed) await expect(admitted).resolves.toEqual(claim);
    else await expect(admitted).rejects.toThrow('Expected previous checkpoint restoration in the same admitted pod');
    expect(reads.some(file => file.includes('/checkpoint-credentials/'))).toBe(allowed);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('keeps an ordinary edge untouched and rejects checkpoint placement on a routing edge', async () => {
    vi.stubEnv('OCTOGEE_CHECKPOINT_SLOT_ID', '');
    await expect(initializeCheckpointEdge(false)).resolves.toBeUndefined();
    vi.stubEnv('OCTOGEE_CHECKPOINT_SLOT_ID', current.OCTOGEE_CHECKPOINT_SLOT_ID);
    await expect(initializeCheckpointEdge(false)).rejects.toThrow('requires a private edge sidecar');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('initializes the edge environment from an admitted same-pod restart', async () => {
    for (const [name, value] of Object.entries(current)) vi.stubEnv(name, value);
    vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', '');
    vi.stubEnv('OPENCLAW_AGENT_STORE_DSN', '');
    vi.mocked(readFile).mockImplementation(async path => {
      const file = String(path);
      if (file.endsWith('/claim.json')) return JSON.stringify(claim);
      if (file.endsWith('/octogee-hobby-checkpoint-edge-restored')) return current.POD_UID;
      if (file.endsWith('/token')) return ' example-token\r\n';
      if (file.endsWith('/agent-store-dsn')) return ' postgres://test/store\n';
      throw new Error('Unexpected file');
    });
    await initializeCheckpointEdge(true);
    expect(process.env).toMatchObject({
      POD_UID: current.POD_UID,
      OPENCLAW_GATEWAY_TOKEN: 'example-token',
      OPENCLAW_AGENT_STORE_DSN: 'postgres://test/store',
    });
  });

  it('refuses a malformed Secret without turning it into a wait', async () => {
    const read = vi.fn().mockResolvedValue({ token: '', agentStoreDsn: 'postgres://test/store' });
    const wait = vi.fn();
    await expect(checkpointGatewayCredentials(read, wait)).rejects.toThrow('credentials are unavailable');
    expect(wait).not.toHaveBeenCalled();
  });
});

describe('single-use live standby boot', () => {
  const standby = { ...source, OCTOGEE_CHECKPOINT_MODE: 'live', OCTOGEE_CHECKPOINT_SNAPSHOT: '' };
  const liveClaim = {
    version: 2, mode: 'live', namespace: source.K8S_NAMESPACE, slotId: source.GATEWAY_ID, gatewayId: source.GATEWAY_ID,
    podUid: source.POD_UID, uid: claim.uid, slug: claim.slug, assignmentEpoch: 0,
  } as const;
  const missing = Object.assign(new Error('not mounted'), { code: 'ENOENT' });

  async function admit(receipt: object, previousOwner?: string) {
    for (const [name, value] of Object.entries(standby)) vi.stubEnv(name, value);
    if (previousOwner) {
      vi.mocked(link).mockRejectedValue(Object.assign(new Error('already exists'), { code: 'EEXIST' }));
    }
    vi.mocked(readFile).mockImplementation(async path => {
      const file = String(path);
      if (file.endsWith('/claim.json')) return JSON.stringify(receipt);
      if (file.endsWith('/checkpoint-owner/owner.json') && previousOwner) return previousOwner;
      if (file.endsWith('/token')) return 'test-token';
      if (file.endsWith('/agent-store-dsn')) return 'postgres://test/store';
      throw missing;
    });
    return waitForCheckpointClaim('gateway');
  }

  it('opens the same originally prepared Pod only after its exact live owner proof and credential projection', async () => {
    await expect(admit(liveClaim)).resolves.toEqual(liveClaim);
    expect(vi.mocked(readFile).mock.calls.some(([path]) => String(path).includes('/proc/gvisor/'))).toBe(false);
    expect(vi.mocked(link)).toHaveBeenCalledWith(expect.stringContaining('/checkpoint-owner/'),
      '/var/run/octogee/checkpoint-owner/owner.json');
    expect(vi.mocked(unlink)).toHaveBeenCalledOnce();
  });

  it.each([
    ['foreign Pod', { ...liveClaim, podUid: current.POD_UID }],
    ['foreign slot', { ...liveClaim, slotId: 'hobby-slot-two' }],
    ['foreign namespace', { ...liveClaim, namespace: 'other' }],
    ['later assignment epoch', { ...liveClaim, assignmentEpoch: 1 }],
    ['snapshot grant', claim],
  ])('refuses a %s before reading credentials', async (_name, receipt) => {
    await expect(admit(receipt)).rejects.toThrow();
    expect(vi.mocked(readFile).mock.calls.some(([path]) => String(path).includes('/checkpoint-credentials/'))).toBe(false);
  });

  it('permits both roles and a same-Pod restart to replay the identical owner', async () => {
    const original = JSON.stringify([liveClaim.uid, liveClaim.slug, 0, liveClaim.slotId, liveClaim.podUid, liveClaim.namespace]);
    await expect(admit(liveClaim, original)).resolves.toEqual(liveClaim);
    await expect(waitForCheckpointClaim('edge')).resolves.toEqual(liveClaim);
    await expect(waitForCheckpointClaim('gateway')).resolves.toEqual(liveClaim);
    expect(vi.mocked(link).mock.calls.map(([, destination]) => destination)).toEqual(
      Array(3).fill('/var/run/octogee/checkpoint-owner/owner.json'));
  });

  it('never rebinds either role on the same running Pod to a different account after a restart', async () => {
    const original = JSON.stringify([liveClaim.uid, liveClaim.slug, 0, liveClaim.slotId, liveClaim.podUid, liveClaim.namespace]);
    await expect(admit({ ...liveClaim, uid: 'other-user', slug: 'other-builder' }, original)).rejects.toThrow(/already bound/);
    expect(vi.mocked(readFile).mock.calls.some(([path]) => String(path).includes('/checkpoint-credentials/'))).toBe(false);
    await expect(waitForCheckpointClaim('edge')).rejects.toThrow(/already bound/);
    expect(vi.mocked(link).mock.calls.map(([, destination]) => destination)).toEqual([
      '/var/run/octogee/checkpoint-owner/owner.json', '/var/run/octogee/checkpoint-owner/owner.json',
    ]);
  });
});
