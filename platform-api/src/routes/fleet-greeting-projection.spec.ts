import { describe, expect, it } from 'vitest';
import { snapshotGreetingPosted } from './fleet-broker.js';
describe('old provisioner scheduling receipt projection', () => {
  it('projects an actual persisted successful scheduling receipt without changing it', () => {
    const receipt = { ok: true, jobId: '71dd1a31-9202-476d-a306-bef98550f694', at: { seconds: 1790611043 } };
    const before = structuredClone(receipt);
    expect(snapshotGreetingPosted(receipt)).toBe(true);
    expect(receipt).toEqual(before);
  });
  it.each([undefined, null, {}, {ok:false,error:'failed'}, {ok:'true',jobId:'job'}, {ok:true}, {ok:true,jobId:''}, {ok:true,jobId:'   '}])('does not synthesize scheduling success from %j', greeting => {
    expect(snapshotGreetingPosted(greeting)).toBe(false);
  });
});
