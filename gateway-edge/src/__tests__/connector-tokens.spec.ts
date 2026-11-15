import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { firestoreData } = vi.hoisted(() => ({
  firestoreData: {} as Record<string, Record<string, unknown>>,
}));

vi.mock('@octogee/core/identity/platform-state-store', async () => {
  const { createDocumentFixtureStore } = await import('@octogee/core/testing/journal-store');
  return { platformStateStore: createDocumentFixtureStore(firestoreData) };
});

vi.mock('@octogee/core/connectors/kms', () => ({
  decryptSecret: vi.fn(async (enc: string) => {
    if (!enc.startsWith('ENC:')) throw new Error('mock decrypt: bad ciphertext');
    return enc.slice(4);
  }),
  encryptSecret: vi.fn(async (plain: string) => `ENC:${plain}`),
}));

vi.mock('@octogee/core/internal-fetch', () => ({
  internalFetch: vi.fn(),
  gatewayCredentialHeaders: vi.fn(async () => ({
    'x-octogee-gateway-credential-token': 'credential-token',
  })),
  sidecarBrokerHeaders: vi.fn(async () => ({
    'x-octogee-sidecar-broker-token': 'sidecar-token',
  })),
}));

import {
  ConnectorTokenBrokerError,
  readConnectorAccessToken,
  readOwnerGithubProjectCloneAccess,
  readOwnerRuntimeConnectorAccessToken,
  readConnectorClientCreds,
  getFreshAccessToken,
} from '@octogee/core/connectors/connector-tokens';
import { getConnector } from '@octogee/core/connectors';
import { decryptSecret } from '@octogee/core/connectors/kms';
import { internalFetch } from '@octogee/core/internal-fetch';
import { sidecarBrokerHeaders } from '@octogee/core/internal-fetch';
import { MalformedRecordError } from '@octogee/core/platform-state';
import { claimedTestUser, installTestUserIdentity } from "./helpers/user-identity.js";

beforeEach(() => {
  for (const k of Object.keys(firestoreData)) delete firestoreData[k];
  vi.mocked(decryptSecret).mockClear();
  vi.mocked(internalFetch).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.CONNECTOR_TOKEN_BROKER_URL;
  delete process.env.GATEWAY_ID;
  installTestUserIdentity(null);
  delete process.env.CONNECTOR_TOKEN_AUTHORITY;
});

describe('readConnectorAccessToken', () => {
  it('fails closed when CONNECTOR_TOKEN_BROKER_URL is unset', async () => {
    firestoreData['users/u-alice/secrets/github'] = {
      provider: 'github',
      tokens: { encryptedAccessToken: 'ENC:gho_plain', encryptedRefreshToken: null },
    };

    await expect(readConnectorAccessToken('u-alice', 'github')).rejects.toThrow(
      'CONNECTOR_TOKEN_BROKER_URL is required',
    );
    expect(internalFetch).not.toHaveBeenCalled();
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('fails closed when the broker is configured without GATEWAY_ID', async () => {
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';

    await expect(readConnectorAccessToken('u-alice', 'github')).rejects.toThrow(
      'CONNECTOR_TOKEN_BROKER_URL is set but GATEWAY_ID is missing',
    );
    expect(internalFetch).not.toHaveBeenCalled();
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('uses the connector token broker, avoiding local Firestore and KMS', async () => {
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';
    process.env.GATEWAY_ID = 'default';
    vi.mocked(internalFetch).mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'gho_brokered' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(readConnectorAccessToken('u-alice', 'github')).resolves.toBe('gho_brokered');

    expect(internalFetch).toHaveBeenCalledWith(
      'http://octogee-api.octogee-test.svc.cluster.local:3001/internal/connectors/access-token',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-octogee-gateway-credential-token': 'credential-token',
        },
        body: JSON.stringify({ gatewayId: 'default', uid: 'u-alice', connectorId: 'github' }),
      }),
      expect.any(Object),
    );
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('returns null when the broker returns 404', async () => {
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';
    process.env.GATEWAY_ID = 'default';
    vi.mocked(internalFetch).mockResolvedValue(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }));

    await expect(readConnectorAccessToken('u-alice', 'github')).resolves.toBeNull();
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('propagates broker failures without local fallback', async () => {
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';
    process.env.GATEWAY_ID = 'default';
    firestoreData['users/u-alice/secrets/github'] = {
      tokens: { encryptedAccessToken: 'ENC:local-token-must-not-be-used' },
    };
    vi.mocked(internalFetch).mockResolvedValue(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));

    const err = await readConnectorAccessToken('u-alice', 'github').then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ConnectorTokenBrokerError);
    expect(err).toMatchObject({
      status: 403,
      errorCode: 'forbidden',
    });
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('forwards project access context to the connector token broker', async () => {
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';
    process.env.GATEWAY_ID = 'member-gw';
    vi.mocked(internalFetch).mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'gho_brokered' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      readConnectorAccessToken('u-alice', 'github', {
        kind: 'project',
        requestingUid: 'u-bob',
        workspaceSlug: 'alice',
        projectSlug: 'octo',
      }),
    ).resolves.toBe('gho_brokered');

    expect(internalFetch).toHaveBeenCalledWith(
      'http://octogee-api.octogee-test.svc.cluster.local:3001/internal/connectors/access-token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          gatewayId: 'member-gw',
          uid: 'u-alice',
          connectorId: 'github',
          access: {
            kind: 'project',
            requestingUid: 'u-bob',
            workspaceSlug: 'alice',
            projectSlug: 'octo',
          },
        }),
      }),
      expect.any(Object),
    );
  });

  it('forwards owner-runtime access context for agent-side materialization', async () => {
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';
    process.env.GATEWAY_ID = 'walter';
    installTestUserIdentity(claimedTestUser('alice'));
    vi.mocked(internalFetch).mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'cf_brokered' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(readOwnerRuntimeConnectorAccessToken('cloudflare')).resolves.toBe('cf_brokered');

    expect(internalFetch).toHaveBeenCalledWith(
      'http://octogee-api.octogee-test.svc.cluster.local:3001/internal/connectors/access-token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          gatewayId: 'walter',
          connectorId: 'cloudflare',
          access: { kind: 'owner-runtime', builderSlug: 'alice' },
        }),
      }),
      expect.any(Object),
    );
  });

  it('fails closed when the user identity is not claimed', async () => {
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';
    process.env.GATEWAY_ID = 'walter';
    vi.mocked(internalFetch).mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'cf_brokered' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(readOwnerRuntimeConnectorAccessToken('cloudflare')).rejects.toThrow(
      'no claimed owner',
    );
    expect(internalFetch).not.toHaveBeenCalled();
  });

  it('uses the sidecar capability to obtain a GitHub project clone credential', async () => {
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';
    process.env.GATEWAY_ID = 'walter';
    installTestUserIdentity(claimedTestUser('alice'));
    vi.mocked(internalFetch).mockResolvedValue(
      new Response(JSON.stringify({
        accessToken: 'gho_brokered',
        repository: { owner: 'octogee-ai', repo: 'octogee' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await expect(readOwnerGithubProjectCloneAccess('octo')).resolves.toEqual({
      accessToken: 'gho_brokered',
      repository: { owner: 'octogee-ai', repo: 'octogee' },
    });

    expect(internalFetch).toHaveBeenCalledWith(
      'http://octogee-api.octogee-test.svc.cluster.local:3001/internal/connectors/github-project-clone-access',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-octogee-sidecar-broker-token': 'sidecar-token',
        },
        body: JSON.stringify({
          gatewayId: 'walter',
          connectorId: 'github',
          access: { kind: 'project-clone', builderSlug: 'alice', projectSlug: 'octo' },
        }),
      }),
      expect.any(Object),
    );
  });

  it('reports an unavailable sidecar capability as a typed broker failure', async () => {
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';
    process.env.GATEWAY_ID = 'walter';
    installTestUserIdentity(claimedTestUser('alice'));
    vi.mocked(sidecarBrokerHeaders).mockRejectedValueOnce(
      new Error('projected sidecar broker token unavailable'),
    );

    const error = await readOwnerGithubProjectCloneAccess('octo').then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toMatchObject({
      status: 503,
      errorCode: 'sidecar_broker_credential_unavailable',
    });
    expect(internalFetch).not.toHaveBeenCalled();
  });

  it('reads directly from Firestore+KMS when it is the connector-token authority (broker host, no broker URL)', async () => {
    process.env.CONNECTOR_TOKEN_AUTHORITY = '1';
    firestoreData['users/u-alice/secrets/github'] = {
      provider: 'github',
      tokens: { encryptedAccessToken: 'ENC:gho_direct', encryptedRefreshToken: null },
    };

    await expect(readConnectorAccessToken('u-alice', 'github')).resolves.toBe('gho_direct');
    expect(internalFetch).not.toHaveBeenCalled();
    expect(decryptSecret).toHaveBeenCalledWith('ENC:gho_direct');
  });

  it('trusted token refresh rotates an expired OAuth access token', async () => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          access_token: 'fresh_google',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      })) as never,
    );
    firestoreData['users/uid-owner/secrets/google'] = {
      provider: 'google',
      tokens: {
        encryptedAccessToken: 'ENC:expired_google',
        encryptedRefreshToken: 'ENC:refresh_google',
        expiresAt: Date.now() - 60_000,
        tokenType: 'Bearer',
      },
    };

    await expect(getFreshAccessToken('uid-owner', getConnector('google')!)).resolves.toEqual({
      ok: true,
      accessToken: 'fresh_google',
    });

    expect(firestoreData['users/uid-owner/secrets/google']).toMatchObject({
      provider: 'google',
      tokens: {
        encryptedAccessToken: 'ENC:fresh_google',
        encryptedRefreshToken: 'ENC:refresh_google',
        tokenType: 'Bearer',
      },
    });
  });

  it('trusted token refresh surfaces reauthorization without decrypting the stale access token', async () => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'invalid_grant' }),
      })) as never,
    );
    firestoreData['users/uid-owner/secrets/google'] = {
      provider: 'google',
      tokens: {
        encryptedAccessToken: 'ENC:expired_google',
        encryptedRefreshToken: 'ENC:refresh_google',
        expiresAt: Date.now() - 60_000,
        tokenType: 'Bearer',
      },
    };

    await expect(getFreshAccessToken('uid-owner', getConnector('google')!)).resolves.toEqual({
      ok: false,
      reason: 'reauth_required',
    });
    expect(decryptSecret).not.toHaveBeenCalledWith('ENC:expired_google');
  });

  it('authority direct-read returns null when the user has no stored token', async () => {
    process.env.CONNECTOR_TOKEN_AUTHORITY = '1';

    await expect(readConnectorAccessToken('u-nobody', 'github')).resolves.toBeNull();
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('the broker URL takes precedence over the authority flag (a gateway never reads direct)', async () => {
    process.env.CONNECTOR_TOKEN_AUTHORITY = '1';
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';
    process.env.GATEWAY_ID = 'default';
    firestoreData['users/u-alice/secrets/github'] = {
      tokens: { encryptedAccessToken: 'ENC:local-must-not-be-read' },
    };
    vi.mocked(internalFetch).mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'gho_brokered' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(readConnectorAccessToken('u-alice', 'github')).resolves.toBe('gho_brokered');
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('broker URL + authority but no GATEWAY_ID fails closed — never degrades to a direct read', async () => {
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';
    process.env.CONNECTOR_TOKEN_AUTHORITY = '1';
    firestoreData['users/u-alice/secrets/github'] = {
      tokens: { encryptedAccessToken: 'ENC:local-must-not-be-read' },
    };

    await expect(readConnectorAccessToken('u-alice', 'github')).rejects.toThrow(
      'CONNECTOR_TOKEN_BROKER_URL is set but GATEWAY_ID is missing',
    );
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('the authority direct-read enforces the brokerable allowlist (only code-hosting platform-read)', async () => {
    process.env.CONNECTOR_TOKEN_AUTHORITY = '1';
    firestoreData['users/u-dan/secrets/google'] = {
      tokens: { encryptedAccessToken: 'ENC:ya29_must_not_be_read' },
    };

    await expect(readConnectorAccessToken('u-dan', 'google')).rejects.toThrow(
      'connector not brokerable: google',
    );
    expect(decryptSecret).not.toHaveBeenCalled();
  });
});

describe('readConnectorClientCreds — platform env only', () => {
  it('reads the platform client from env', () => {
    process.env.GOOGLE_CLIENT_ID = 'env-id';
    process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
    expect(readConnectorClientCreds(getConnector('google')!)).toEqual({
      clientId: 'env-id',
      clientSecret: 'env-secret',
    });
  });

  it('returns null when env is unset', () => {
    expect(readConnectorClientCreds(getConnector('google')!)).toBeNull();
    expect(readConnectorClientCreds(getConnector('microsoft')!)).toBeNull();
  });

  it('treats empty and literal-placeholder values as unconfigured', () => {
    process.env.GOOGLE_CLIENT_ID = '';
    process.env.GOOGLE_CLIENT_SECRET = '';
    expect(readConnectorClientCreds(getConnector('google')!)).toBeNull();

    process.env.GOOGLE_CLIENT_ID = 'placeholder';
    process.env.GOOGLE_CLIENT_SECRET = 'placeholder';
    expect(readConnectorClientCreds(getConnector('google')!)).toBeNull();

    process.env.GOOGLE_CLIENT_ID = '  ';
    process.env.GOOGLE_CLIENT_SECRET = 'real-secret';
    expect(readConnectorClientCreds(getConnector('google')!)).toBeNull();
  });

  it('a legacy per-user client doc is dead weight — env decides, alone', () => {
    firestoreData['users/u-dan/secrets/google'] = {
      client: {
        encryptedClientId: 'ENC:dan-client.apps.googleusercontent.com',
        encryptedClientSecret: 'ENC:dan-secret',
      },
    };
    expect(readConnectorClientCreds(getConnector('google')!)).toBeNull();

    process.env.GOOGLE_CLIENT_ID = 'env-id';
    process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
    expect(readConnectorClientCreds(getConnector('google')!)).toEqual({
      clientId: 'env-id',
      clientSecret: 'env-secret',
    });
  });
});

describe('getFreshAccessToken — refresh-aware access', () => {
  function seedGoogleTokens(overrides: Record<string, unknown> = {}) {
    firestoreData['users/u-dan/secrets/google'] = {
      provider: 'google',
      tokens: {
        encryptedAccessToken: 'ENC:stale-access',
        encryptedRefreshToken: 'ENC:long-lived-refresh',
        expiresAt: Date.now() + 30 * 60 * 1000,
        tokenType: 'Bearer',
        ...overrides,
      },
    };
  }

  it('returns the stored token while it is still fresh (no provider call)', async () => {
    seedGoogleTokens();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const out = await getFreshAccessToken('u-dan', getConnector('google')!);
    expect(out).toEqual({ ok: true, accessToken: 'stale-access' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes an expired token with the platform client and persists the rotation', async () => {
    process.env.GOOGLE_CLIENT_ID = 'env-id';
    process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
    seedGoogleTokens({ expiresAt: Date.now() - 1000 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe('https://oauth2.googleapis.com/token');
        const body = String(init?.body);
        expect(body).toContain('grant_type=refresh_token');
        expect(body).toContain('refresh_token=long-lived-refresh');
        expect(body).toContain('client_id=env-id');
        expect(body).toContain('client_secret=env-secret');
        return new Response(
          JSON.stringify({ access_token: 'fresh-access', expires_in: 3600, token_type: 'Bearer' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const out = await getFreshAccessToken('u-dan', getConnector('google')!);
    expect(out).toEqual({ ok: true, accessToken: 'fresh-access' });

    const stored = firestoreData['users/u-dan/secrets/google'] as {
      provider: unknown;
      tokens: Record<string, unknown>;
      updatedAt: unknown;
    };
    expect(stored.provider).toBe('google');
    expect(stored.tokens.encryptedAccessToken).toBe('ENC:fresh-access');
    expect(stored.tokens.encryptedRefreshToken).toBe('ENC:long-lived-refresh');
    expect(stored.tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(typeof stored.updatedAt).toBe('number');
  });

  it('keeps connector fields written while the refresh was in flight', async () => {
    process.env.GOOGLE_CLIENT_ID = 'env-id';
    process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
    seedGoogleTokens({ expiresAt: Date.now() - 1000 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        firestoreData['users/u-dan/secrets/google'].accountEmail = 'dan@example.com';
        return new Response(
          JSON.stringify({ access_token: 'fresh-access', expires_in: 3600, token_type: 'Bearer' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    await expect(getFreshAccessToken('u-dan', getConnector('google')!)).resolves.toEqual({
      ok: true,
      accessToken: 'fresh-access',
    });
    const stored = firestoreData['users/u-dan/secrets/google'] as { accountEmail: unknown; tokens: Record<string, unknown> };
    expect(stored.accountEmail).toBe('dan@example.com');
    expect(stored.tokens.encryptedAccessToken).toBe('ENC:fresh-access');
  });

  it('does not resurrect a connector the user disconnected while the refresh was in flight', async () => {
    process.env.GOOGLE_CLIENT_ID = 'env-id';
    process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
    seedGoogleTokens({ expiresAt: Date.now() - 1000 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        delete firestoreData['users/u-dan/secrets/google'];
        return new Response(
          JSON.stringify({ access_token: 'fresh-access', expires_in: 3600, token_type: 'Bearer' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    await expect(getFreshAccessToken('u-dan', getConnector('google')!)).resolves.toEqual({
      ok: false,
      reason: 'not_connected',
    });
    expect(firestoreData['users/u-dan/secrets/google']).toBeUndefined();
  });

  it('reports reauth_required when a token expires and no platform client is configured', async () => {
    seedGoogleTokens({ expiresAt: Date.now() - 1000 });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(getFreshAccessToken('u-dan', getConnector('google')!)).resolves.toEqual({
      ok: false,
      reason: 'reauth_required',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports reauth_required when the provider rejects the refresh token', async () => {
    process.env.GOOGLE_CLIENT_ID = 'env-id';
    process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
    seedGoogleTokens({ expiresAt: Date.now() - 1000 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(getFreshAccessToken('u-dan', getConnector('google')!)).resolves.toEqual({
      ok: false,
      reason: 'reauth_required',
    });
  });

  it('a lost refresh race re-reads the doc and returns the winning rotation instead of reauth', async () => {
    process.env.GOOGLE_CLIENT_ID = 'env-id';
    process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
    seedGoogleTokens({ expiresAt: Date.now() - 1000 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        firestoreData['users/u-dan/secrets/google'].tokens = {
          encryptedAccessToken: 'ENC:winner-access',
          encryptedRefreshToken: 'ENC:winner-refresh',
          expiresAt: Date.now() + 3600_000,
          tokenType: 'Bearer',
        };
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    await expect(getFreshAccessToken('u-dan', getConnector('google')!)).resolves.toEqual({
      ok: true,
      accessToken: 'winner-access',
    });
  });

  it('reports reauth_required when an expired token has no refresh token', async () => {
    seedGoogleTokens({ expiresAt: Date.now() - 1000, encryptedRefreshToken: null });
    await expect(getFreshAccessToken('u-dan', getConnector('google')!)).resolves.toEqual({
      ok: false,
      reason: 'reauth_required',
    });
  });

  it('reports reauth_required when an expired token has a blank refresh token', async () => {
    seedGoogleTokens({ expiresAt: Date.now() - 1000, encryptedRefreshToken: '   ' });
    await expect(getFreshAccessToken('u-dan', getConnector('google')!)).resolves.toEqual({
      ok: false,
      reason: 'reauth_required',
    });
  });

  it('fails closed on a connector secret whose access token is not a string', async () => {
    seedGoogleTokens({ encryptedAccessToken: 42 });
    await expect(getFreshAccessToken('u-dan', getConnector('google')!)).rejects.toBeInstanceOf(
      MalformedRecordError,
    );
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('reports not_connected when there are no stored tokens', async () => {
    await expect(getFreshAccessToken('u-dan', getConnector('google')!)).resolves.toEqual({
      ok: false,
      reason: 'not_connected',
    });
  });

  it('tokens without an expiry (github PATs) pass through untouched', async () => {
    firestoreData['users/u-alice/secrets/github'] = {
      tokens: { encryptedAccessToken: 'ENC:ghp_token', encryptedRefreshToken: null },
    };
    await expect(getFreshAccessToken('u-alice', getConnector('github')!)).resolves.toEqual({
      ok: true,
      accessToken: 'ghp_token',
    });
  });
});
