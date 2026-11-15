import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { UserCredentialRejected, type UserIdentityProvider } from '@octogee/core/user-identity-provider';

const { mockDocs } = vi.hoisted(() => ({
  mockDocs: new Map<string, Record<string, unknown> | undefined>(),
}));

vi.mock("../lib/platform-state.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(mockDocs as Map<string, Record<string, unknown>>) };
});
vi.mock('../middleware/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  installUserIdentityProvider,
  requireAdmin,
  requireAuth,
  requireAuthAllowUnregistered,
  requireAuthenticatedUid,
  requireRecentAuthentication,
  RECENT_AUTH_MAX_AGE_SECONDS,
} from '../middleware/auth.js';

import { platformStateStore } from '../lib/platform-state.js';
import { logger } from '../middleware/logging.js';

afterEach(() => vi.useRealTimers());

function fakeProvider(users: Record<string, Record<string, unknown>> = { u1: { username: 'alice' } }) {
  return {
    verifyBearer: vi.fn<UserIdentityProvider['verifyBearer']>(async () => ({ uid: 'u1', authTime: null })),
    loadUser: vi.fn<UserIdentityProvider['loadUser']>(async (uid) => users[uid] ?? null),
  };
}

function runAuth(
  middleware: typeof requireAuth = requireAuth,
  authorization: string | null = 'Bearer fake',
): Promise<{ req: Request; nextCalled: boolean; status?: number; body?: unknown }> {
  return new Promise((resolve) => {
    const req = { headers: authorization === null ? {} : { authorization } } as unknown as Request;
    let status: number | undefined;
    const res = {
      status: (c: number) => {
        status = c;
        return res;
      },
      json: (body: unknown) => resolve({ req, nextCalled: false, status, body }),
    } as unknown as Response;
    middleware(req, res, () => resolve({ req, nextCalled: true, status }));
  });
}

describe('verifying the bearer through the installed user identity', () => {
  let identity: ReturnType<typeof fakeProvider>;

  beforeEach(() => {
    mockDocs.clear();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
    identity = fakeProvider();
    installUserIdentityProvider(identity);
  });

  it('refuses a request without a bearer before asking the identity', async () => {
    const result = await runAuth(requireAuthenticatedUid, null);

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Unauthenticated' });
    expect(identity.verifyBearer).not.toHaveBeenCalled();
  });

  it('answers 401 and warns when the identity rejects the credential', async () => {
    identity.verifyBearer.mockRejectedValueOnce(new UserCredentialRejected('Mattermost rejected the session'));

    const result = await runAuth(requireAuthenticatedUid);

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Invalid token' });
    expect(logger.warn).toHaveBeenCalledWith('Auth failed: Mattermost rejected the session');
  });

  it('answers 503 and logs an error when the identity cannot decide', async () => {
    identity.verifyBearer.mockRejectedValueOnce(new Error('Mattermost did not answer the session check within 5000 ms'));

    const result = await runAuth(requireAuthenticatedUid);

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'Authentication lookup unavailable' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('did not answer'));
  });

  it('attaches the verified uid and authentication time without loading the user on pod-local routes', async () => {
    identity.verifyBearer.mockResolvedValueOnce({ uid: 'u1', authTime: 1_700_000_000 });

    const { req, nextCalled } = await runAuth(requireAuthenticatedUid);

    expect(nextCalled).toBe(true);
    expect(req.uid).toBe('u1');
    expect(req.authTime).toBe(1_700_000_000);
    expect(identity.verifyBearer).toHaveBeenCalledWith('fake');
    expect(identity.loadUser).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('leaves the authentication time unset when the identity does not know it', async () => {
    const { req, nextCalled } = await runAuth(requireAuthenticatedUid);

    expect(nextCalled).toBe(true);
    expect(req.authTime).toBeUndefined();
  });
});

describe('requireAuth', () => {
  let identity: ReturnType<typeof fakeProvider>;

  beforeEach(() => {
    mockDocs.clear();
    vi.mocked(logger.warn).mockClear();
    identity = fakeProvider();
    installUserIdentityProvider(identity);
    mockDocs.set('workspaces/alice', { id: 'alice', ownerUid: 'u1' });
  });

  it('attaches the loaded user and its workspace', async () => {
    const { req, nextCalled } = await runAuth();

    expect(nextCalled).toBe(true);
    expect(identity.loadUser).toHaveBeenCalledWith('u1');
    expect(req.user).toEqual({ username: 'alice' });
    expect(req.workspaceSlug).toBe('alice');
  });

  it('takes isAdmin from the platform state store', async () => {
    const getRole = vi.spyOn(platformStateStore.users.records, 'getRole').mockResolvedValueOnce('admin');

    const { req } = await runAuth();

    expect(getRole).toHaveBeenCalledWith('u1');
    expect(req.isAdmin).toBe(true);
    getRole.mockRestore();
  });

  it('ignores admin-looking fields on the loaded user', async () => {
    installUserIdentityProvider(fakeProvider({ u1: { username: 'alice', role: 'admin', isAdmin: true, roles: 'system_admin' } }));

    const { req, nextCalled } = await runAuth(requireAdmin);

    expect(nextCalled).toBe(false);
    expect(req.isAdmin).toBe(false);
  });

  it('fails closed and logs when the role cannot be read', async () => {
    const getRole = vi.spyOn(platformStateStore.users.records, 'getRole').mockRejectedValueOnce(new Error('store unavailable'));

    const { req, nextCalled } = await runAuth();

    expect(nextCalled).toBe(true);
    expect(req.isAdmin).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('store unavailable'));
    getRole.mockRestore();
  });

  it.each(['suspended', 'deletion_scheduled', 'erasing'])(
    'rejects an account whose lifecycle is %s',
    async (status) => {
      installUserIdentityProvider(fakeProvider({ u1: { username: 'alice', accountLifecycle: { status } } }));

      const result = await runAuth();

      expect(result.nextCalled).toBe(false);
      expect(result.status).toBe(403);
      expect(result.req.user).toBeUndefined();
    },
  );

  it('rejects a verified bearer whose user does not exist', async () => {
    installUserIdentityProvider(fakeProvider({}));

    const result = await runAuth();

    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(403);
  });

  it('answers 503 and warns when the user cannot be loaded', async () => {
    identity.loadUser.mockRejectedValueOnce(new Error('store unavailable'));

    const result = await runAuth();

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'Authentication lookup unavailable' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('store unavailable'));
  });
});

describe('requireAuthAllowUnregistered', () => {
  beforeEach(() => {
    mockDocs.clear();
  });

  it('accepts a verified bearer before its user exists', async () => {
    const identity = fakeProvider({});
    installUserIdentityProvider(identity);

    const result = await runAuth(requireAuthAllowUnregistered);

    expect(result.nextCalled).toBe(true);
    expect(result.req.uid).toBe('u1');
    expect(result.req.user).toBeUndefined();
    expect(result.req.workspaceSlug).toBeNull();
    expect(identity.verifyBearer).toHaveBeenCalledWith('fake');
  });

  it.each(['suspended', 'deletion_scheduled', 'erasing'])(
    'still rejects an existing account whose lifecycle is %s',
    async (status) => {
      installUserIdentityProvider(fakeProvider({ u1: { accountLifecycle: { status } } }));

      const result = await runAuth(requireAuthAllowUnregistered);

      expect(result.nextCalled).toBe(false);
      expect(result.status).toBe(403);
    },
  );
});

describe('requireRecentAuthentication', () => {
  it('allows a token inside the recent-login window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const now = Math.floor(Date.now() / 1000);
    const req = { authTime: now - RECENT_AUTH_MAX_AGE_SECONDS } as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    const next = vi.fn();

    requireRecentAuthentication(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a valid token whose original authentication is stale', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const now = Math.floor(Date.now() / 1000);
    const req = { authTime: now - RECENT_AUTH_MAX_AGE_SECONDS - 1 } as Request;
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json } as unknown as Response;
    const next = vi.fn();

    requireRecentAuthentication(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: 'auth/requires-recent-login',
      message: 'Recent authentication required',
    });
  });

  it('rejects a request whose identity does not know when the user signed in', () => {
    const req = {} as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    const next = vi.fn();

    requireRecentAuthentication(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('with no user identity installed', () => {
  it('answers 503 and logs an error instead of authenticating', async () => {
    vi.resetModules();
    const fresh = await import('../middleware/auth.js');
    const { logger: freshLogger } = await import('../middleware/logging.js');

    const result = await runAuth(fresh.requireAuthenticatedUid);

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'Authentication unavailable' });
    expect(freshLogger.error).toHaveBeenCalledWith(expect.stringContaining('no user identity provider is installed'));
  });

  it('refuses to load a user', async () => {
    vi.resetModules();
    const fresh = await import('../middleware/auth.js');

    await expect(fresh.loadUserWithInstalledProvider('u1')).rejects.toThrow('no user identity provider is installed');
  });
});
