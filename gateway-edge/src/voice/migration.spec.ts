import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createVoiceMigrationRegistry, createVoiceMigrationHandler } from './migration.js';

function request(body: unknown, token = 'secret', address = '127.0.0.1') {
  const req = new PassThrough();
  Object.assign(req, { method: 'POST', headers: { authorization: `Bearer ${token}` }, socket: { remoteAddress: address } });
  req.end(JSON.stringify(body));
  let status = 0; let result: unknown;
  const res = { writeHead(code: number) { status = code; }, end(raw: string) { result = JSON.parse(raw); } };
  return { req: req as unknown as IncomingMessage, res: res as unknown as ServerResponse, status: () => status, body: () => result };
}

describe('voice migration registry', () => {
  it('ends a call after a bounded migration grace period and cancels the timer on resume', () => {
    vi.useFakeTimers();
    try {
      const registry = createVoiceMigrationRegistry();
      const end = vi.fn();
      registry.begin('alice', end);
      registry.hold('alice', 'move-1');
      vi.advanceTimersByTime(19_999);
      expect(end).not.toHaveBeenCalled();
      registry.resume('alice', 'move-1');
      vi.advanceTimersByTime(1);
      expect(end).not.toHaveBeenCalled();
      registry.hold('alice', 'move-2');
      vi.advanceTimersByTime(20_000);
      expect(end).toHaveBeenCalledOnce();
      expect(registry.hold('alice', 'move-2')).toBe(1);
    } finally { vi.useRealTimers(); }
  });
  it('does not let an old close callback erase a later call', () => {
    const registry = createVoiceMigrationRegistry();
    const closeOld = registry.begin('alice')!;
    closeOld();
    registry.begin('alice');
    closeOld();
    expect(registry.hold('alice', 'move-1')).toBe(1);
  });

  it('holds new admissions while keeping existing idle calls counted until their own close', () => {
    const registry = createVoiceMigrationRegistry();
    const close = registry.begin('alice')!;
    expect(registry.hold('alice', 'move-1')).toBe(1);
    expect(registry.begin('alice')).toBeNull();
    expect(registry.hold('bob', 'move-2')).toBe(0);
    close(); close();
    expect(registry.hold('alice', 'move-1')).toBe(0);
    registry.resume('alice', 'move-1');
    expect(registry.begin('alice')).toBeTypeOf('function');
  });
  it('does not let a stale resume release a newer migration hold', () => {
    const registry = createVoiceMigrationRegistry();
    registry.hold('alice', 'move-1');
    expect(() => registry.hold('alice', 'move-2')).toThrow(/another migration/);
    expect(() => registry.resume('alice', 'move-2')).toThrow(/another migration/);
    expect(registry.begin('alice')).toBeNull();
  });
  it('keeps admission closed when preparation outlives the takeover lease', () => {
    let now = 0;
    const registry = createVoiceMigrationRegistry({ now: () => now });
    registry.hold('alice', 'move-1');
    now = 179_000;
    expect(registry.begin('alice')).toBeNull();
    registry.resume('alice', 'move-1');
    expect(registry.begin('alice')).toBeTypeOf('function');
  });

  it('allows a newer authenticated operation to take over an expired hold without reopening admission', () => {
    let now = 0;
    const registry = createVoiceMigrationRegistry({ now: () => now });
    registry.hold('alice', 'move-1');
    now = 179_000;
    expect(registry.hold('alice', 'move-2')).toBe(0);
    expect(() => registry.resume('alice', 'move-1')).toThrow(/another migration/);
    expect(registry.begin('alice')).toBeNull();
    registry.resume('alice', 'move-2');
    expect(registry.begin('alice')).toBeTypeOf('function');
  });

  it('lets another operation release a hold whose takeover lease expired', () => {
    let now = 0;
    const registry = createVoiceMigrationRegistry({ now: () => now });
    registry.hold('alice', 'failed-move');
    now = 119_999;
    expect(() => registry.resume('alice', 'unmount-1')).toThrow(/another migration/);
    expect(registry.begin('alice')).toBeNull();
    now = 120_000;
    expect(registry.resume('alice', 'unmount-1')).toBe(0);
    expect(registry.begin('alice')).toBeTypeOf('function');
  });

  it('transfers an expired admission hold without expiring an active call', () => {
    let now = 0;
    const registry = createVoiceMigrationRegistry({ now: () => now });
    registry.begin('alice');
    registry.hold('alice', 'old');
    now = 120_001;
    expect(registry.hold('alice', 'new')).toBe(1);
  });
});

describe('voice migration handler', () => {
  it('authenticates loopback requests and returns the live call count', async () => {
    const registry = createVoiceMigrationRegistry(); registry.begin('alice');
    const handler = createVoiceMigrationHandler({ gatewayToken: 'secret', registry });
    const r = request({ slug: 'alice', operationId: 'move-1', phase: 'hold' });
    await handler(r.req, r.res);
    expect(r.status()).toBe(200); expect(r.body()).toEqual({ activeCalls: 1 });
  });
  it('answers 409 to a resume while another migration holds a live lease, then 200 once it expires', async () => {
    let now = 0;
    const registry = createVoiceMigrationRegistry({ now: () => now });
    registry.hold('alice', 'failed-move');
    const handler = createVoiceMigrationHandler({ gatewayToken: 'secret', registry });
    const live = request({ slug: 'alice', operationId: 'unmount-1', phase: 'resume' });
    await handler(live.req, live.res);
    expect(live.status()).toBe(409);
    now = 120_000;
    const expired = request({ slug: 'alice', operationId: 'unmount-1', phase: 'resume' });
    await handler(expired.req, expired.res);
    expect(expired.status()).toBe(200); expect(expired.body()).toEqual({ activeCalls: 0 });
  });
  it.each([['wrong', '127.0.0.1'], ['secret', '10.0.0.2']])('rejects untrusted credentials or peers', async (token, peer) => {
    const registry = createVoiceMigrationRegistry();
    const r = request({ slug: 'alice', operationId: 'move-1', phase: 'hold' }, token, peer);
    await createVoiceMigrationHandler({ gatewayToken: 'secret', registry })(r.req, r.res);
    expect(r.status()).toBe(401); expect(registry.begin('alice')).toBeTypeOf('function');
  });
});
