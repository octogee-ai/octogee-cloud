import { describe, expect, it } from 'vitest';
import { matchesRestartedCheckpoint, readCheckpointRestore } from './hobby-checkpoint-gate.js';

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
