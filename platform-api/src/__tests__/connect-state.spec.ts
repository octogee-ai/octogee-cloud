import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { generateConnectState, verifyConnectState, CONNECT_STATE_TTL_SECONDS } from '../lib/connect-state.js';

const TEST_SECRET = 'test-connect-state-secret-for-hmac';

beforeAll(() => {
  process.env.CONNECT_STATE_SECRET = TEST_SECRET;
});

afterAll(() => {
  delete process.env.CONNECT_STATE_SECRET;
});

describe('connect state — generate + verify roundtrip', () => {
  it('generates a signed state that verifies back to the same payload', () => {
    const { state, nonce, expiresAt } = generateConnectState({
      uid: 'u-alice',
      connector: 'github',
      returnUrl: '/settings/account#connections',
    });

    expect(state).toContain('.');
    expect(nonce.length).toBeGreaterThanOrEqual(16);
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const payload = verifyConnectState(state);
    expect(payload.uid).toBe('u-alice');
    expect(payload.connector).toBe('github');
    expect(payload.returnUrl).toBe('/settings/account#connections');
    expect(payload.nonce).toBe(nonce);
  });

  it('expires within the short TTL window (minutes, not days)', () => {
    const { expiresAt } = generateConnectState({
      uid: 'u-alice',
      connector: 'github',
      returnUrl: '/d',
    });
    const ttlMs = expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeLessThanOrEqual(CONNECT_STATE_TTL_SECONDS * 1000 + 1000);
    expect(ttlMs).toBeGreaterThan((CONNECT_STATE_TTL_SECONDS - 60) * 1000);
  });

  it('mints a distinct single-use nonce per state', () => {
    const a = generateConnectState({ uid: 'u', connector: 'github', returnUrl: '/' });
    const b = generateConnectState({ uid: 'u', connector: 'github', returnUrl: '/' });
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.state).not.toBe(b.state);
  });
});

describe('connect state — rejection paths', () => {
  it('rejects a tampered payload (uid swap) with a signature error', () => {
    const { state } = generateConnectState({
      uid: 'u-victim',
      connector: 'github',
      returnUrl: '/d',
    });
    const [payloadStr, sig] = state.split('.');
    const decoded = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf-8'));
    decoded.uid = 'u-attacker';
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${sig}`;

    expect(() => verifyConnectState(forged)).toThrow('Invalid state signature');
  });

  it('rejects a tampered signature', () => {
    const { state } = generateConnectState({ uid: 'u', connector: 'github', returnUrl: '/d' });
    const [payloadStr] = state.split('.');
    expect(() => verifyConnectState(`${payloadStr}.AAAA`)).toThrow('Invalid state signature');
  });

  it('rejects malformed state (no dot separator)', () => {
    expect(() => verifyConnectState('not-a-state')).toThrow('Invalid state format');
  });

  it('rejects an unsigned legacy-style state (the integrations.ts vuln shape)', () => {
    const legacy = Buffer.from(
      JSON.stringify({ uid: 'u-victim', returnUrl: '/dashboard' }),
    ).toString('base64url');
    expect(() => verifyConnectState(legacy)).toThrow('Invalid state format');
  });

  it('rejects an expired state', () => {
    const expired = {
      uid: 'u',
      connector: 'github',
      returnUrl: '/d',
      nonce: 'n-1',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    };
    const payloadStr = Buffer.from(JSON.stringify(expired)).toString('base64url');
    const sig = crypto.createHmac('sha256', TEST_SECRET).update(payloadStr).digest('base64url');

    expect(() => verifyConnectState(`${payloadStr}.${sig}`)).toThrow('State has expired');
  });

  it('rejects a state signed with a different secret', () => {
    const payload = {
      uid: 'u',
      connector: 'github',
      returnUrl: '/d',
      nonce: 'n-1',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    };
    const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', 'some-other-secret').update(payloadStr).digest('base64url');

    expect(() => verifyConnectState(`${payloadStr}.${sig}`)).toThrow('Invalid state signature');
  });

  it('throws when CONNECT_STATE_SECRET is missing', () => {
    const saved = process.env.CONNECT_STATE_SECRET;
    delete process.env.CONNECT_STATE_SECRET;

    expect(() =>
      generateConnectState({ uid: 'u', connector: 'github', returnUrl: '/d' }),
    ).toThrow('CONNECT_STATE_SECRET');

    process.env.CONNECT_STATE_SECRET = saved;
  });
});
