import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
import { bootFreshUserHost } from '../lib/isolated-native-bootstrap.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('lets a PostgreSQL-state Native gateway finish a graceful stop that outlasts ten seconds, then releases the stop timer', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'isolated-native-process-'));
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn((signal: string) => {
      if (signal === 'SIGTERM') setTimeout(() => child.emit('close', 0, null), 15_000);
      else queueMicrotask(() => child.emit('close', null, signal));
      return true;
    }),
  });
  spawn.mockReturnValue(child);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  try {
    const result = bootFreshUserHost(root, { HOME: root });
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'));
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it.each([0, 1, null])('requires a successful Native process close after readiness: %s', async (code) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'isolated-native-process-'));
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close', code, code === null ? 'SIGKILL' : null)); return true; }),
  });
  spawn.mockReturnValue(child);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  try {
    const result = bootFreshUserHost(root, { HOME: root });
    if (code === 0) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow('native initialization exited');
    expect(spawn.mock.calls[0][2].env.OPENCLAW_NO_RESPAWN).toBe('1');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
