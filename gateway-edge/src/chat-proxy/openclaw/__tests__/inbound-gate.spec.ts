import { describe, expect, it } from 'vitest';
import {
  createGateState,
  evaluateInboundFrame,
  observeOutboundForState,
  type GateState,
} from '../inbound-gate.js';

const EXPECTED_AGENT = 'octogee-acme-coach';

it('makes a channel-scoped Activity connection read-only even after observing a run or approval', () => {
  const state = createGateState(EXPECTED_AGENT);
  state.readOnly = true;
  state.observedRunIds.add('run-1');
  state.observedApprovalIds.add('approval-1');
  for (const method of [
    'chat.abort', 'sessions.abort', 'exec.approval.resolve', 'plugin.approval.resolve',
    'sessions.subscribe', 'sessions.messages.subscribe',
    'octogee.activity.channelRunOrigin', 'octogee.activity.authorizeChannelRunInput',
  ]) {
    expect(evaluateInboundFrame(frame(method, { runId: 'run-1', approvalId: 'approval-1' }), false, state).accept).toBe(false);
  }
});

function makeState(overrides: Partial<{ runIds: string[]; approvalIds: string[] }> = {}): GateState {
  const state = createGateState(EXPECTED_AGENT);
  for (const r of overrides.runIds ?? []) state.observedRunIds.add(r);
  for (const a of overrides.approvalIds ?? []) state.observedApprovalIds.add(a);
  return state;
}

function frame(method: string, params: unknown): string {
  return JSON.stringify({ type: 'req', id: 'req-1', method, params });
}

describe('evaluateInboundFrame — method allowlist', () => {
  it('rejects binary frames outright', () => {
    const state = makeState();
    const res = evaluateInboundFrame(Buffer.from('anything'), true, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('binary');
  });

  it('rejects oversize frames', () => {
    const state = makeState();
    const big = JSON.stringify({ type: 'req', id: 'x', method: 'chat.abort', params: { runId: 'r1', filler: 'x'.repeat(70_000) } });
    const res = evaluateInboundFrame(big, false, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('oversized');
  });

  it('rejects unparseable JSON', () => {
    const state = makeState();
    const res = evaluateInboundFrame('{not json', false, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('unparseable');
  });

  it('rejects non-req frames', () => {
    const state = makeState();
    const res = evaluateInboundFrame(JSON.stringify({ type: 'event', event: 'whatever' }), false, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('wrong-type');
  });

  it('rejects unknown methods (config.get)', () => {
    const state = makeState({ runIds: ['r1'] });
    const res = evaluateInboundFrame(frame('config.get', {}), false, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('method-not-allowlisted');
  });

  it('rejects unknown methods (config.patch)', () => {
    const state = makeState();
    const res = evaluateInboundFrame(frame('config.patch', { x: 1 }), false, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('method-not-allowlisted');
  });

  it('rejects unknown methods (channels.status)', () => {
    const state = makeState();
    const res = evaluateInboundFrame(frame('channels.status', {}), false, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('method-not-allowlisted');
  });

  it('rejects unknown methods (gateway pairing/admin)', () => {
    const state = makeState();
    expect(evaluateInboundFrame(frame('device.pair.request', {}), false, state).accept).toBe(false);
    expect(evaluateInboundFrame(frame('node.pair.request', {}), false, state).accept).toBe(false);
    expect(evaluateInboundFrame(frame('admin.anything', {}), false, state).accept).toBe(false);
  });
});

describe('evaluateInboundFrame — chat.abort', () => {
  it('accepts when runId is observed', () => {
    const state = makeState({ runIds: ['run-A'] });
    const res = evaluateInboundFrame(frame('chat.abort', { runId: 'run-A' }), false, state);
    expect(res.accept).toBe(true);
    expect(res.reason).toBe('allowed');
  });

  it('rejects when runId is not observed', () => {
    const state = makeState({ runIds: ['run-A'] });
    const res = evaluateInboundFrame(frame('chat.abort', { runId: 'run-B' }), false, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('run-id-not-observed');
  });

  it('rejects when runId is missing', () => {
    const state = makeState({ runIds: ['run-A'] });
    const res = evaluateInboundFrame(frame('chat.abort', {}), false, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('missing-required-param');
  });

  it('rejects when sessionKey targets a different agent', () => {
    const state = makeState({ runIds: ['run-A'] });
    const res = evaluateInboundFrame(
      frame('chat.abort', { runId: 'run-A', sessionKey: 'agent:octogee-other-coach:s1' }),
      false,
      state,
    );
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('session-key-mismatch');
  });

  it('accepts when sessionKey targets this agent', () => {
    const state = makeState({ runIds: ['run-A'] });
    const res = evaluateInboundFrame(
      frame('chat.abort', { runId: 'run-A', sessionKey: `agent:${EXPECTED_AGENT}:s1` }),
      false,
      state,
    );
    expect(res.accept).toBe(true);
  });
});

describe('evaluateInboundFrame — approval.resolve', () => {
  it('accepts exec.approval.resolve when approvalId is observed', () => {
    const state = makeState({ approvalIds: ['appr-1'] });
    const res = evaluateInboundFrame(
      frame('exec.approval.resolve', { approvalId: 'appr-1', decision: 'approved' }),
      false,
      state,
    );
    expect(res.accept).toBe(true);
  });

  it('accepts plugin.approval.resolve when approvalId is observed', () => {
    const state = makeState({ approvalIds: ['appr-1'] });
    const res = evaluateInboundFrame(
      frame('plugin.approval.resolve', { approvalId: 'appr-1', decision: 'denied' }),
      false,
      state,
    );
    expect(res.accept).toBe(true);
  });

  it('rejects when approvalId is not observed', () => {
    const state = makeState({ approvalIds: ['appr-other'] });
    const res = evaluateInboundFrame(
      frame('exec.approval.resolve', { approvalId: 'appr-1', decision: 'approved' }),
      false,
      state,
    );
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('approval-id-not-observed');
  });

  it('rejects when approvalId is missing', () => {
    const state = makeState({ approvalIds: ['appr-1'] });
    const res = evaluateInboundFrame(
      frame('exec.approval.resolve', { decision: 'approved' }),
      false,
      state,
    );
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('missing-required-param');
  });

  it('rejects the legacy browser id field instead of approvalId', () => {
    const state = makeState({ approvalIds: ['appr-1'] });
    const res = evaluateInboundFrame(
      frame('exec.approval.resolve', { id: 'appr-1', decision: 'approved' }),
      false,
      state,
    );
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('missing-required-param');
  });

  it('rejects approval resolution when sessionKey targets a different agent', () => {
    const state = makeState({ approvalIds: ['appr-1'] });
    const res = evaluateInboundFrame(
      frame('plugin.approval.resolve', {
        approvalId: 'appr-1',
        decision: 'approved',
        sessionKey: 'agent:octogee-other-coach:s1',
      }),
      false,
      state,
    );
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('session-key-mismatch');
  });
});

describe('observeOutboundForState — populates observed sets', () => {
  it('extracts runId from per-user event payloads', () => {
    const state = makeState();
    const f = JSON.stringify({
      type: 'event',
      event: 'chat',
      payload: { sessionKey: `agent:${EXPECTED_AGENT}:s1`, runId: 'run-X' },
    });
    observeOutboundForState(f, state);
    expect(state.observedRunIds.has('run-X')).toBe(true);
  });

  it('extracts approvalId from exec.approval.requested events', () => {
    const state = makeState();
    const f = JSON.stringify({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { sessionKey: `agent:${EXPECTED_AGENT}:s1`, approvalId: 'appr-X', runId: 'run-Y' },
    });
    observeOutboundForState(f, state);
    expect(state.observedApprovalIds.has('appr-X')).toBe(true);
    expect(state.observedRunIds.has('run-Y')).toBe(true);
  });

  it('extracts approvalId from plugin.approval.requested events', () => {
    const state = makeState();
    const f = JSON.stringify({
      type: 'event',
      event: 'plugin.approval.requested',
      payload: { sessionKey: `agent:${EXPECTED_AGENT}:s1`, approvalId: 'appr-Y' },
    });
    observeOutboundForState(f, state);
    expect(state.observedApprovalIds.has('appr-Y')).toBe(true);
  });

  it('ignores events for other agents (defense in depth)', () => {
    const state = makeState();
    const f = JSON.stringify({
      type: 'event',
      event: 'chat',
      payload: { sessionKey: 'agent:octogee-other-coach:s1', runId: 'run-leak' },
    });
    observeOutboundForState(f, state);
    expect(state.observedRunIds.has('run-leak')).toBe(false);
  });

  it('ignores non-event frames', () => {
    const state = makeState();
    observeOutboundForState(JSON.stringify({ type: 'res', id: 'x', ok: true }), state);
    expect(state.observedRunIds.size).toBe(0);
    expect(state.observedApprovalIds.size).toBe(0);
  });

  it('caps observed sets at 500 entries (oldest evicted)', () => {
    const state = makeState();
    for (let i = 0; i < 600; i++) {
      const f = JSON.stringify({
        type: 'event',
        event: 'chat',
        payload: { sessionKey: `agent:${EXPECTED_AGENT}:s1`, runId: `run-${i}` },
      });
      observeOutboundForState(f, state);
    }
    expect(state.observedRunIds.size).toBe(500);
    expect(state.observedRunIds.has('run-0')).toBe(false);
    expect(state.observedRunIds.has('run-599')).toBe(true);
  });
});

describe('browser WebSocket authorization boundary', () => {
  it('does not allow arbitrary full-scope upstream methods', () => {
    const state = makeState({ runIds: ['run-X'], approvalIds: ['appr-X'] });
    for (const method of [
      'config.get',
      'config.patch',
      'admin.users.list',
      'operator.secrets.read',
      'device.pair.request',
    ]) {
      expect(evaluateInboundFrame(frame(method, {}), false, state)).toEqual({
        accept: false,
        reason: 'method-not-allowlisted',
      });
    }
  });

  it('requires chat.abort runId to be observed from this agent before accepting', () => {
    const state = makeState();
    const outbound = JSON.stringify({
      type: 'event',
      event: 'chat',
      payload: { sessionKey: `agent:${EXPECTED_AGENT}:s1`, runId: 'run-X' },
    });

    expect(evaluateInboundFrame(frame('chat.abort', { runId: 'run-X' }), false, state)).toEqual({
      accept: false,
      reason: 'run-id-not-observed',
    });

    observeOutboundForState(outbound, state);

    expect(evaluateInboundFrame(frame('chat.abort', { runId: 'run-X' }), false, state)).toEqual({
      accept: true,
      reason: 'allowed',
    });
  });

  it('requires approvalId to be observed from this agent before accepting', () => {
    const state = makeState();
    const outbound = JSON.stringify({
      type: 'event',
      event: 'exec.approval.requested',
      payload: {
        sessionKey: `agent:${EXPECTED_AGENT}:s1`,
        approvalId: 'appr-X',
        runId: 'run-X',
      },
    });

    expect(
      evaluateInboundFrame(
        frame('exec.approval.resolve', { approvalId: 'appr-X', decision: 'approved' }),
        false,
        state,
      ),
    ).toEqual({
      accept: false,
      reason: 'approval-id-not-observed',
    });

    observeOutboundForState(outbound, state);

    expect(
      evaluateInboundFrame(
        frame('exec.approval.resolve', { approvalId: 'appr-X', decision: 'approved' }),
        false,
        state,
      ),
    ).toEqual({
      accept: true,
      reason: 'allowed',
    });
  });

  it('does not learn run or approval IDs from another agent outbound stream', () => {
    const state = makeState();
    observeOutboundForState(
      JSON.stringify({
        type: 'event',
        event: 'exec.approval.requested',
        payload: {
          sessionKey: 'agent:octogee-other-coach:s1',
          approvalId: 'appr-leak',
          runId: 'run-leak',
        },
      }),
      state,
    );

    expect(evaluateInboundFrame(frame('chat.abort', { runId: 'run-leak' }), false, state)).toEqual({
      accept: false,
      reason: 'run-id-not-observed',
    });
    expect(
      evaluateInboundFrame(
        frame('exec.approval.resolve', { approvalId: 'appr-leak', decision: 'approved' }),
        false,
        state,
      ),
    ).toEqual({
      accept: false,
      reason: 'approval-id-not-observed',
    });
  });
});
