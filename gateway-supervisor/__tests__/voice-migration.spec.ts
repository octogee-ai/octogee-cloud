import { describe, expect, it, vi } from 'vitest';
import { updateVoiceMigration } from '../lib/voice-migration.js';

const input = { slug: 'alice', operationId: 'move-1', phase: 'hold' as const };
const env = { OPENCLAW_GATEWAY_TOKEN: 'secret' };

describe('updateVoiceMigration', () => {
  it('queries the local authenticated registry with the operation binding', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ activeCalls: 2 })));
    await expect(updateVoiceMigration(input, { env, fetch })).resolves.toEqual({ activeCalls: 2 });
    expect(String(fetch.mock.calls[0]?.[0])).toBe('http://127.0.0.1:3001/internal/openclaw/voice/v1/migration');
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify(input) }));
  });
  it.each(['https://127.0.0.1', 'http://remote.example', 'http://127.0.0.1/other', 'http://user:password@localhost'])('does not send gateway credentials to %s', async (url) => {
    const fetch = vi.fn();
    await expect(updateVoiceMigration(input, { env: { ...env, GATEWAY_EDGE_INTERNAL_URL: url }, fetch })).rejects.toThrow(/loopback/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([new Response('{}', { status: 503 }), new Response('{"activeCalls":-1}')])('fails closed when voice state is unavailable or invalid', async (response) => {
    await expect(updateVoiceMigration(input, { env, fetch: vi.fn(async () => response) })).rejects.toThrow();
  });
});
