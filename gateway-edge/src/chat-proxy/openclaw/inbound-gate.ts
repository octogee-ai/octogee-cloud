import { PER_USER_EVENTS } from '@octogee/core/channels/frame-filter';

export interface GateState {
  expectedAgentId: string;
  readOnly?: boolean;
  observedRunIds: Set<string>;
  observedApprovalIds: Set<string>;
}

export type InboundReason =
  | 'allowed'
  | 'binary'
  | 'oversized'
  | 'unparseable'
  | 'wrong-type'
  | 'method-not-allowlisted'
  | 'missing-required-param'
  | 'session-key-mismatch'
  | 'run-id-not-observed'
  | 'approval-id-not-observed';

export interface InboundDecision {
  accept: boolean;
  reason: InboundReason;
}

const ALLOWED_METHODS = new Set([
  'chat.abort',
  'exec.approval.resolve',
  'plugin.approval.resolve',
]);

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_OBSERVED = 500;

export function createGateState(expectedAgentId: string): GateState {
  return {
    expectedAgentId,
    observedRunIds: new Set<string>(),
    observedApprovalIds: new Set<string>(),
  };
}

export function evaluateInboundFrame(
  frame: string | Buffer,
  isBinary: boolean,
  state: GateState,
): InboundDecision {
  if (isBinary) return reject('binary');

  const text = typeof frame === 'string' ? frame : frame.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) return reject('oversized');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return reject('unparseable');
  }
  if (!isRecord(parsed)) return reject('unparseable');

  if (parsed.type !== 'req' || typeof parsed.method !== 'string') return reject('wrong-type');

  const method = parsed.method;
  if (state.readOnly) return reject('method-not-allowlisted');
  if (!ALLOWED_METHODS.has(method)) return reject('method-not-allowlisted');

  const params = isRecord(parsed.params) ? parsed.params : {};
  const sessionDecision = evaluateSessionKey(params, state);
  if (sessionDecision) return sessionDecision;

  if (method === 'chat.abort') {
    return evaluateRunAbort(params, state);
  }

  if (method === 'exec.approval.resolve' || method === 'plugin.approval.resolve') {
    return evaluateApprovalResolve(params, state);
  }

  return reject('method-not-allowlisted');
}

function evaluateSessionKey(
  params: Record<string, unknown>,
  state: GateState,
): InboundDecision | null {
  const sessionKey = typeof params.sessionKey === 'string' ? params.sessionKey : undefined;
  if (sessionKey !== undefined && !sessionKey.startsWith(`agent:${state.expectedAgentId}:`)) {
    return reject('session-key-mismatch');
  }
  return null;
}

function evaluateRunAbort(
  params: Record<string, unknown>,
  state: GateState,
): InboundDecision {
  const runId = typeof params.runId === 'string' ? params.runId : '';
  if (!runId) return reject('missing-required-param');
  if (!state.observedRunIds.has(runId)) return reject('run-id-not-observed');
  return allow();
}

function evaluateApprovalResolve(
  params: Record<string, unknown>,
  state: GateState,
): InboundDecision {
  const approvalId = typeof params.approvalId === 'string' ? params.approvalId : '';
  if (!approvalId) return reject('missing-required-param');
  if (!state.observedApprovalIds.has(approvalId)) return reject('approval-id-not-observed');
  return allow();
}

export function observeOutboundForState(rawFrame: string, state: GateState): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFrame);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;
  if (parsed.type !== 'event' || typeof parsed.event !== 'string') return;
  if (!PER_USER_EVENTS.has(parsed.event)) return;

  const payload = isRecord(parsed.payload) ? parsed.payload : {};
  const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : '';
  if (!sessionKey.startsWith(`agent:${state.expectedAgentId}:`)) return;

  const runId = typeof payload.runId === 'string' ? payload.runId : '';
  if (runId) addCapped(state.observedRunIds, runId);

  const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : '';
  if (approvalId) addCapped(state.observedApprovalIds, approvalId);
}

function addCapped(set: Set<string>, value: string): void {
  if (set.has(value)) return;
  if (set.size >= MAX_OBSERVED) {
    const oldest = set.values().next().value;
    if (oldest) set.delete(oldest);
  }
  set.add(value);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reject(reason: Exclude<InboundReason, 'allowed'>): InboundDecision {
  return { accept: false, reason };
}

function allow(): InboundDecision {
  return { accept: true, reason: 'allowed' };
}
