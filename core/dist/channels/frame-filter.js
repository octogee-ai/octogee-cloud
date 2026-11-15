import { redactStructuredSecrets } from '@octogee/shared/types/secret-redaction';
import { activityConversationMessage } from './activity-message.js';
export const PER_USER_EVENTS = new Set([
    "agent",
    "chat",
    "chat.side_result",
    "exec.approval.requested",
    "exec.approval.resolved",
    "plugin.approval.requested",
    "plugin.approval.resolved",
    "sessions.changed",
    "session.message",
    "session.tool",
    "diagnostic",
]);
const SYSTEM_EVENTS = new Set([
    "heartbeat",
    "health",
    "tick",
    "cron",
    "presence",
    "shutdown",
    "update.available",
    "voicewake.changed",
    "talk.mode",
    "device.pair.requested",
    "device.pair.resolved",
    "node.pair.requested",
    "node.pair.resolved",
]);
const MISSING_ACTIVITY_IDENTITY = { forward: false, reason: 'missing-identity' };
function isObjectRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isEventEnvelope(raw) {
    return isObjectRecord(raw) && raw.type === 'event';
}
function activityFrameDecision(raw, expectedKey) {
    if (!isEventEnvelope(raw))
        return MISSING_ACTIVITY_IDENTITY;
    if (!['agent', 'session.tool', 'session.message'].includes(String(raw.event)))
        return { forward: false, reason: 'unknown-event-class' };
    const payload = raw.payload;
    if (!isObjectRecord(payload))
        return { forward: false, reason: 'invalid-payload' };
    const key = payload.sessionKey;
    if (typeof key !== 'string' || !key)
        return MISSING_ACTIVITY_IDENTITY;
    const prefix = `${expectedKey}:thread:`;
    const matches = key === expectedKey || key.startsWith(prefix) && /^[a-z0-9]{26}$/u.test(key.slice(prefix.length));
    if (!matches)
        return { forward: false, reason: 'identity-mismatch' };
    if (raw.event === 'session.message')
        return activityConversationMessage(payload.message)
            ? { forward: true, reason: 'matched-identity' } : { forward: false, reason: 'invalid-payload' };
    if (!isObjectRecord(payload.data))
        return { forward: false, reason: 'invalid-payload' };
    return ['lifecycle', 'tool', 'plan'].includes(String(payload.stream))
        ? { forward: true, reason: 'matched-identity' }
        : { forward: false, reason: 'identity-mismatch' };
}
export function sanitizeActivityFrame(raw) {
    const frame = JSON.parse(raw);
    if (frame.event === 'session.message') {
        const { sessionKey } = frame.payload;
        const identity = Object.fromEntries(['runId', 'messageId', 'idempotencyKey', 'clientRunId'].flatMap(key => {
            const value = frame.payload[key];
            return typeof value === 'string' && value.length <= 512 ? [[key, value]] : [];
        }));
        const seq = frame.payload.messageSeq;
        const messageSeq = typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
        return JSON.stringify({ type: frame.type, event: frame.event, payload: { sessionKey, ...identity, messageSeq, message: activityConversationMessage(frame.payload.message) } });
    }
    const { runId, sessionKey, seq, ts, stream } = frame.payload;
    const data = frame.payload.data;
    const displayFields = ['phase', 'name', 'args', 'result', 'partialResult', 'isError', 'steps', 'status', 'aborted', 'stopReason', 'timeoutPhase', 'providerStarted', 'error', 'executionSettled', 'fallbackExhaustedFailure'];
    const safe = redactStructuredSecrets(Object.fromEntries(displayFields.filter(key => data && key in data).map(key => [key, data[key]])));
    if (data?.toolCallId !== undefined)
        safe.toolCallId = data.toolCallId;
    return JSON.stringify({ type: frame.type, event: frame.event, payload: { runId, sessionKey, seq, ts, stream, data: safe } });
}
export function shouldForwardFrame(rawFrame, ctx) {
    let parsed;
    try {
        parsed = JSON.parse(rawFrame);
    }
    catch {
        if (ctx.sessionKey)
            return MISSING_ACTIVITY_IDENTITY;
        return { forward: true, reason: "unparseable" };
    }
    if (ctx.sessionKey)
        return activityFrameDecision(parsed, ctx.sessionKey);
    if (!isEventEnvelope(parsed)) {
        return { forward: true, reason: "non-event-frame" };
    }
    const envelope = parsed;
    const event = typeof envelope.event === "string" ? envelope.event : "";
    if (SYSTEM_EVENTS.has(event)) {
        return { forward: true, reason: "system-event" };
    }
    if (!PER_USER_EVENTS.has(event)) {
        return { forward: false, reason: "unknown-event-class" };
    }
    const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
    const sessionKey = payload.sessionKey;
    if (typeof sessionKey !== "string" || sessionKey.length === 0) {
        return { forward: false, reason: "missing-identity" };
    }
    if (sessionKey.startsWith(`agent:${ctx.expectedAgentId}:`)) {
        return { forward: true, reason: "matched-identity" };
    }
    return { forward: false, reason: "identity-mismatch" };
}
export class ExpectedAgentIdError extends Error {
    name = "ExpectedAgentIdError";
    constructor(message) {
        super(message);
    }
}
export function deriveExpectedAgentId(uid, userData) {
    const username = typeof userData.username === "string" ? userData.username : "";
    const fallback = typeof userData.defaultWorkspaceId === "string" ? userData.defaultWorkspaceId : "";
    const slug = username || fallback;
    if (!slug) {
        throw new ExpectedAgentIdError(`users/${uid} has neither username nor defaultWorkspaceId set`);
    }
    return `octogee-${slug}-coach`;
}
export async function resolveExpectedAgentId(db, uid) {
    const snap = await db.doc(`users/${uid}`).get();
    if (!snap.exists) {
        throw new ExpectedAgentIdError(`users/${uid} does not exist — cannot derive expectedAgentId`);
    }
    return deriveExpectedAgentId(uid, snap.data() ?? {});
}
