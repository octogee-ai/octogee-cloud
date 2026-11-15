import { describe, it, expect, vi, afterEach } from 'vitest';
import { CONNECTOR_CATALOG } from "@octogee/shared/types/connectors";
import {
  getConnector,
  connectorRedirectUri,
  isConnectorAgentRuntimeTokenMaterializable,
  isConnectorTokenBrokerable,
} from './index.js';
import { catalogMeta } from './def.js';
import { revokeObsidianConnection } from './obsidian.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_OAUTH_REDIRECT_URI;
  delete process.env.API_PUBLIC_URL;
});

function mockFetchJson(expectations: { url: RegExp; auth?: string; body: unknown; status?: number }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      const match = expectations.find((e) => e.url.test(u));
      if (!match) throw new Error(`unexpected fetch: ${u}`);
      if (match.auth) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers.Authorization).toBe(match.auth);
      }
      return new Response(JSON.stringify(match.body), {
        status: match.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

describe('connector catalog (shared)', () => {
  it('spans the four roadmap families plus productivity', () => {
    const families = new Set(CONNECTOR_CATALOG.map((m) => m.family));
    expect(families).toEqual(
      new Set(['code-hosting', 'deploy-hosting', 'registry', 'ai', 'cloud', 'productivity']),
    );
  });

  it('has unique ids', () => {
    const ids = CONNECTOR_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every 'fields' connector declares capture fields (the /fields route stores with non-merge set)", () => {
    for (const m of CONNECTOR_CATALOG) {
      if (m.captureMethods.includes('fields')) {
        expect(m.captureFields?.length, m.id).toBeGreaterThan(0);
      }
    }
  });

  it('marks exactly the registry-implemented connectors', () => {
    const implemented = CONNECTOR_CATALOG.filter((m) => m.implemented).map((m) => m.id).sort();
    expect(implemented).toEqual(['aws', 'azure', 'cloudflare', 'docker', 'gcp', 'gemini', 'github', 'google', 'microsoft', 'netlify', 'npm', 'obsidian', 'vercel']);
  });
});

describe('connector registry (gateway-edge)', () => {
  it('resolves catalog metadata through the shared connector helper', () => {
    expect(catalogMeta('github')).toMatchObject({ id: 'github', implemented: true });
    expect(() => catalogMeta('not-a-connector' as never)).toThrow(
      'Connector not-a-connector is missing from CONNECTOR_CATALOG',
    );
  });

  it('returns undefined for catalog stubs and unknown ids', () => {
    expect(getConnector('yahoo')).toBeUndefined();
    expect(getConnector('not-a-connector')).toBeUndefined();
  });

  it('github: oauth-web + device + pat, platform-read, repo scope, owner-runtime materializable', () => {
    const def = getConnector('github');
    expect(def).toBeDefined();
    expect(def!.meta.id).toBe('github');
    expect(def!.meta.consumption).toBe('platform-read');
    expect(def!.meta.agentRuntimeMaterializable).toBe(true);
    expect(def!.meta.captureMethods).toEqual(['oauth-web', 'device', 'pat']);
    expect(def!.meta.scopes).toEqual(['repo']);
    expect(isConnectorTokenBrokerable('github')).toBe(true);
    expect(isConnectorAgentRuntimeTokenMaterializable('github')).toBe(true);
    expect(def!.oauth).toMatchObject({
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      clientIdEnv: 'GITHUB_CLIENT_ID',
      clientSecretEnv: 'GITHUB_CLIENT_SECRET',
    });
    expect(def!.device).toMatchObject({
      codeUrl: 'https://github.com/login/device/code',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      clientIdEnv: 'GITHUB_CLIENT_ID',
    });
  });

  it('google: oauth-web only, agent-runtime, incremental offline-access auth params, capability-union scopes', () => {
    const def = getConnector('google');
    expect(def!.meta.captureMethods).toEqual(['oauth-web']);
    expect(def!.meta.consumption).toBe('agent-runtime');
    expect(def!.meta.scopes).toEqual([
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/tasks',
      'https://www.googleapis.com/auth/contacts.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ]);
    expect(isConnectorAgentRuntimeTokenMaterializable('google')).toBe(false);
    expect(isConnectorAgentRuntimeTokenMaterializable('microsoft')).toBe(false);
    expect(def!.oauth).toMatchObject({
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      revocationUrl: 'https://oauth2.googleapis.com/revoke',
      clientIdEnv: 'GOOGLE_CLIENT_ID',
      clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
      extraAuthParams: {
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
      },
    });
  });

  it('google resolves capability request scopes; github/microsoft have no capability map', () => {
    const google = getConnector('google')!;
    expect(google.capabilityRequestScopes!('gmail')).toEqual([
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
    ]);
    expect(google.capabilityRequestScopes!('tasks')).toEqual([
      'https://www.googleapis.com/auth/tasks',
      'https://www.googleapis.com/auth/userinfo.email',
    ]);
    expect(google.capabilityRequestScopes!('contacts')).toEqual([
      'https://www.googleapis.com/auth/contacts.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ]);
    expect(google.capabilityRequestScopes!('drive-full')).toEqual([
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ]);
    expect(google.capabilityRequestScopes!('nope')).toBeNull();
    expect(getConnector('github')!.capabilityRequestScopes).toBeUndefined();
    expect(getConnector('microsoft')!.capabilityRequestScopes).toBeUndefined();
  });

  it('google unions a comma-separated capability selection into one consent request', () => {
    const google = getConnector('google')!;
    expect(google.capabilityRequestScopes!('calendar,gmail,calendar')).toEqual([
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/gmail.modify',
    ]);
    expect(google.capabilityRequestScopes!('calendar')).toEqual([
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/userinfo.email',
    ]);
  });

  it.each(['calendar,voice', 'calendar,drive-full', 'calendar,', ','])(
    'google refuses the capability selection %s rather than requesting part of it',
    (selection) => {
      expect(getConnector('google')!.capabilityRequestScopes!(selection)).toBeNull();
    },
  );

  it('google has a capability deep probe; github/microsoft have none', () => {
    expect(typeof getConnector('google')!.deepProbe).toBe('function');
    expect(getConnector('github')!.deepProbe).toBeUndefined();
    expect(getConnector('microsoft')!.deepProbe).toBeUndefined();
  });

  it('obsidian uses local pairing and keeps credentials behind brokered agent tools', () => {
    const def = getConnector('obsidian');
    expect(def?.meta).toMatchObject({
      id: 'obsidian',
      captureMethods: ['local-pairing'],
      consumption: 'agent-runtime',
      implemented: true,
    });
    expect(def?.validateFields).toBeUndefined();
    expect(def?.validateStoredFields).toBeTypeOf('function');
    expect(def?.revokeStoredFields).toBeTypeOf('function');
    expect(isConnectorAgentRuntimeTokenMaterializable('obsidian')).toBe(false);
  });

  it('obsidian revokes its dedicated Headless session on disconnect', async () => {
    const runner = vi.fn(async () => ({ stdout: 'Logged out.', stderr: '' }));
    await revokeObsidianConnection({ authToken: 'dedicated-token' }, runner);
    expect(runner).toHaveBeenCalledWith(['logout'], {
      env: { OBSIDIAN_AUTH_TOKEN: 'dedicated-token' },
      timeoutMs: 30_000,
    });
  });

  it('google deep probe checks each granted capability and names them all', async () => {
    const calls = mockFetchJson([
      {
        url: /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events(?:\?|$)/,
        auth: 'Bearer g-tok',
        body: { items: [] },
      },
      {
        url: /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/profile(?:\?|$)/,
        auth: 'Bearer g-tok',
        body: { emailAddress: 'dan@x.com' },
      },
      {
        url: /^https:\/\/www\.googleapis\.com\/drive\/v3\/about(?:\?|$)/,
        auth: 'Bearer g-tok',
        body: { user: { emailAddress: 'dan@x.com' } },
      },
      {
        url: /^https:\/\/tasks\.googleapis\.com\/tasks\/v1\/users\/@me\/lists(?:\?|$)/,
        auth: 'Bearer g-tok',
        body: { items: [] },
      },
      {
        url: /^https:\/\/people\.googleapis\.com\/v1\/people\/me\/connections(?:\?|$)/,
        auth: 'Bearer g-tok',
        body: { connections: [] },
      },
    ]);
    await expect(
      getConnector('google')!.deepProbe!('g-tok', [
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/tasks',
        'https://www.googleapis.com/auth/contacts.readonly',
        'https://www.googleapis.com/auth/userinfo.email',
      ]),
    ).resolves.toEqual({
      probe: 'calendar.events+gmail.profile+drive.about+tasks.tasklists+people.connections',
      detail: 'calendar, gmail, drive, tasks, contacts',
    });
    expect(calls).toHaveLength(5);
  });

  // tests/live/google-connector-durability.live.spec.ts hand-maintains a
  // CAPABILITY_PROBE_RE mirror of these names (that package never imports
  // gateway-edge source) — update both together when a probe is added or renamed.
  it('names exactly five capability probes', async () => {
    const probeNameByScope: [string, string][] = [
      ['https://www.googleapis.com/auth/calendar.events', 'calendar.events'],
      ['https://www.googleapis.com/auth/gmail.modify', 'gmail.profile'],
      ['https://www.googleapis.com/auth/drive.file', 'drive.about'],
      ['https://www.googleapis.com/auth/tasks', 'tasks.tasklists'],
      ['https://www.googleapis.com/auth/contacts.readonly', 'people.connections'],
    ];
    const names = new Set<string>();
    for (const [scope, expectedName] of probeNameByScope) {
      mockFetchJson([{ url: /.*/, body: {} }]);
      const result = await getConnector('google')!.deepProbe!('g-tok', [scope]);
      expect(result.probe).toBe(expectedName);
      names.add(result.probe);
    }
    expect(names).toEqual(
      new Set(['calendar.events', 'gmail.profile', 'drive.about', 'tasks.tasklists', 'people.connections']),
    );
  });

  it('google deep probe only probes the granted capability', async () => {
    const calls = mockFetchJson([
      {
        url: /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/profile(?:\?|$)/,
        auth: 'Bearer g-tok',
        body: { emailAddress: 'dan@x.com' },
      },
    ]);
    await expect(
      getConnector('google')!.deepProbe!('g-tok', [
        'https://www.googleapis.com/auth/gmail.modify',
      ]),
    ).resolves.toEqual({ probe: 'gmail.profile', detail: 'gmail' });
    expect(calls).toHaveLength(1);
  });

  it('google deep probe with only tasks granted probes tasklists alone', async () => {
    const calls = mockFetchJson([
      {
        url: /^https:\/\/tasks\.googleapis\.com\/tasks\/v1\/users\/@me\/lists(?:\?|$)/,
        auth: 'Bearer g-tok',
        body: { items: [] },
      },
    ]);
    await expect(
      getConnector('google')!.deepProbe!('g-tok', ['https://www.googleapis.com/auth/tasks']),
    ).resolves.toEqual({ probe: 'tasks.tasklists', detail: 'tasks' });
    expect(calls).toHaveLength(1);
  });

  it('google deep probe with only contacts granted probes people connections alone', async () => {
    const calls = mockFetchJson([
      {
        url: /^https:\/\/people\.googleapis\.com\/v1\/people\/me\/connections(?:\?|$)/,
        auth: 'Bearer g-tok',
        body: { connections: [] },
      },
    ]);
    await expect(
      getConnector('google')!.deepProbe!('g-tok', [
        'https://www.googleapis.com/auth/contacts.readonly',
      ]),
    ).resolves.toEqual({ probe: 'people.connections', detail: 'contacts' });
    expect(calls).toHaveLength(1);
  });

  it('google deep probe reports identity-only when no capability scope is granted', async () => {
    const calls = mockFetchJson([]);
    await expect(getConnector('google')!.deepProbe!('g-tok', [])).resolves.toEqual({
      probe: 'identity',
      detail: 'no capability scopes granted',
    });
    expect(calls).toHaveLength(0);
  });

  it('google deep probe throws on a non-OK capability response (scope missing/revoked)', async () => {
    mockFetchJson([
      {
        url: /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/profile(?:\?|$)/,
        body: { error: 'forbidden' },
        status: 403,
      },
    ]);
    await expect(
      getConnector('google')!.deepProbe!('g-tok', ['https://www.googleapis.com/auth/gmail.modify']),
    ).rejects.toThrow('403');
  });

  it('microsoft: oauth-web only, mail+calendar scopes', () => {
    const def = getConnector('microsoft');
    expect(def!.meta.captureMethods).toEqual(['oauth-web']);
    expect(def!.meta.scopes).toContain('Mail.Read');
    expect(def!.meta.scopes).toContain('offline_access');
    expect(def!.oauth).toMatchObject({
      authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      clientIdEnv: 'MICROSOFT_CLIENT_ID',
      clientSecretEnv: 'MICROSOFT_CLIENT_SECRET',
    });
  });
});

describe('connectorRedirectUri', () => {
  it('derives the callback from API_PUBLIC_URL by default', () => {
    process.env.API_PUBLIC_URL = 'https://api-test.octogee.com';
    expect(connectorRedirectUri(getConnector('github')!)).toBe(
      'https://api-test.octogee.com/api/connect/github/callback',
    );
  });

  it('falls back to the prod API host when API_PUBLIC_URL is unset', () => {
    delete process.env.API_PUBLIC_URL;
    expect(connectorRedirectUri(getConnector('github')!)).toBe(
      'https://api.octogee.com/api/connect/github/callback',
    );
  });

  it('honors the per-connector redirect-uri env override', () => {
    process.env.GITHUB_OAUTH_REDIRECT_URI = 'https://example.com/cb';
    expect(connectorRedirectUri(getConnector('github')!)).toBe('https://example.com/cb');
  });
});

describe('github identity', () => {
  it('fetches GET /user with the bearer token and returns login as accountLabel', async () => {
    const calls = mockFetchJson([
      { url: /^https:\/\/api\.github\.com\/user$/, auth: 'Bearer gho_tok', body: { login: 'chris-e' } },
    ]);

    const identity = await getConnector('github')!.fetchIdentity('gho_tok');
    expect(identity).toEqual({ accountLabel: 'chris-e' });
    expect(calls).toHaveLength(1);
  });

  it('throws on a non-OK response (bad PAT)', async () => {
    mockFetchJson([
      { url: /^https:\/\/api\.github\.com\/user$/, body: { message: 'Bad credentials' }, status: 401 },
    ]);
    await expect(getConnector('github')!.fetchIdentity('bad')).rejects.toThrow('401');
  });

  it('throws when the response has no login', async () => {
    mockFetchJson([{ url: /^https:\/\/api\.github\.com\/user$/, body: {} }]);
    await expect(getConnector('github')!.fetchIdentity('tok')).rejects.toThrow('login');
  });
});

describe('PAT connector identities (vercel, cloudflare, gemini)', () => {
  it('vercel: GET /v2/user with the bearer token, username as accountLabel', async () => {
    mockFetchJson([
      { url: /^https:\/\/api\.vercel\.com\/v2\/user$/, auth: 'Bearer vc-tok', body: { user: { username: 'chris' } } },
    ]);
    await expect(getConnector('vercel')!.fetchIdentity('vc-tok')).resolves.toEqual({
      accountLabel: 'chris',
    });
  });

  it('vercel: throws on a rejected token', async () => {
    mockFetchJson([{ url: /^https:\/\/api\.vercel\.com\/v2\/user$/, body: { error: 'forbidden' }, status: 403 }]);
    await expect(getConnector('vercel')!.fetchIdentity('bad')).rejects.toThrow('403');
  });

  it('cloudflare: verifies the token is active via tokens/verify', async () => {
    mockFetchJson([
      {
        url: /^https:\/\/api\.cloudflare\.com\/client\/v4\/user\/tokens\/verify$/,
        auth: 'Bearer cf-tok',
        body: { success: true, result: { id: 'abc123def456', status: 'active' } },
      },
    ]);
    await expect(getConnector('cloudflare')!.fetchIdentity('cf-tok')).resolves.toEqual({
      accountLabel: 'token …def456',
    });
  });

  it('cloudflare: throws when the token is not active', async () => {
    mockFetchJson([
      {
        url: /^https:\/\/api\.cloudflare\.com\/client\/v4\/user\/tokens\/verify$/,
        body: { success: true, result: { id: 'x', status: 'disabled' } },
      },
    ]);
    await expect(getConnector('cloudflare')!.fetchIdentity('cf-tok')).rejects.toThrow('disabled');
  });

  it('gemini: validates the AI Studio key via the models list header auth (key never in URL)', async () => {
    const calls = mockFetchJson([
      { url: /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models$/, body: { models: [{ name: 'gemini' }] } },
    ]);
    await expect(getConnector('gemini')!.fetchIdentity('AIza-key')).resolves.toEqual({
      accountLabel: 'AI Studio key',
    });
    expect(calls[0].url).not.toContain('AIza-key');
    expect((calls[0].init?.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-key');
  });

  it('gemini: throws on an invalid key', async () => {
    mockFetchJson([
      { url: /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models$/, body: { error: {} }, status: 400 },
    ]);
    await expect(getConnector('gemini')!.fetchIdentity('bad')).rejects.toThrow('400');
  });
});

describe('PAT connector identities (netlify, npm)', () => {
  it('netlify: GET /api/v1/user, email as accountLabel', async () => {
    mockFetchJson([
      { url: /^https:\/\/api\.netlify\.com\/api\/v1\/user$/, auth: 'Bearer nf-tok', body: { email: 'c@x.com' } },
    ]);
    await expect(getConnector('netlify')!.fetchIdentity('nf-tok')).resolves.toEqual({
      accountLabel: 'c@x.com',
    });
  });

  it('npm: whoami username as accountLabel; throws on rejection', async () => {
    mockFetchJson([
      { url: /^https:\/\/registry\.npmjs\.org\/-\/whoami$/, auth: 'Bearer npm_x', body: { username: 'chris' } },
    ]);
    await expect(getConnector('npm')!.fetchIdentity('npm_x')).resolves.toEqual({
      accountLabel: 'chris',
    });
    mockFetchJson([{ url: /^https:\/\/registry\.npmjs\.org\/-\/whoami$/, body: {}, status: 401 }]);
    await expect(getConnector('npm')!.fetchIdentity('bad')).rejects.toThrow('401');
  });
});

describe('fields-credential validation (docker, azure, gcp)', () => {
  it('docker: logs in to Docker Hub with username+token; username as accountLabel', async () => {
    mockFetchJson([
      { url: /^https:\/\/hub\.docker\.com\/v2\/users\/login$/, body: { token: 'jwt' } },
    ]);
    await expect(
      getConnector('docker')!.validateFields!({ username: 'chris', token: 'dckr_pat_x' }),
    ).resolves.toEqual({ accountLabel: 'chris' });
  });

  it('docker: throws on rejected login', async () => {
    mockFetchJson([
      { url: /^https:\/\/hub\.docker\.com\/v2\/users\/login$/, body: { detail: 'nope' }, status: 401 },
    ]);
    await expect(
      getConnector('docker')!.validateFields!({ username: 'chris', token: 'bad' }),
    ).rejects.toThrow('401');
  });

  it('azure: mints a client-credentials token against the tenant', async () => {
    const calls = mockFetchJson([
      {
        url: /^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/,
        body: { access_token: 'az-tok' },
      },
    ]);
    await expect(
      getConnector('azure')!.validateFields!({
        tenantId: '11111111-2222-3333-4444-555555555555',
        clientId: 'abcd1234-app',
        clientSecret: 'shh',
      }),
    ).resolves.toEqual({ accountLabel: 'app abcd1234…' });
    expect(String((calls[0].init?.body as URLSearchParams).toString())).toContain(
      'grant_type=client_credentials',
    );
  });

  it('azure: rejects a non-tenant-shaped id before any network call', async () => {
    const calls = mockFetchJson([
      { url: /^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/, body: { access_token: 'x' } },
    ]);
    await expect(
      getConnector('azure')!.validateFields!({ tenantId: 'not a tenant', clientId: 'c', clientSecret: 's' }),
    ).rejects.toThrow(/tenant/i);
    expect(calls).toHaveLength(0);
  });

  it('azure: accepts a GUID tenant and a domain tenant', async () => {
    mockFetchJson([{ url: /^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/, body: { access_token: 'tok' } }]);
    await expect(
      getConnector('azure')!.validateFields!({
        tenantId: '11111111-2222-3333-4444-555555555555',
        clientId: 'abcd1234',
        clientSecret: 's',
      }),
    ).resolves.toMatchObject({ accountLabel: expect.stringContaining('abcd1234') });
    mockFetchJson([{ url: /^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/, body: { access_token: 'tok' } }]);
    await expect(
      getConnector('azure')!.validateFields!({
        tenantId: 'contoso.onmicrosoft.com',
        clientId: 'abcd1234',
        clientSecret: 's',
      }),
    ).resolves.toMatchObject({ accountLabel: expect.stringContaining('abcd1234') });
  });

  it('azure: throws when the principal is rejected', async () => {
    mockFetchJson([
      { url: /^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/, body: { error: 'invalid_client' }, status: 401 },
    ]);
    await expect(
      getConnector('azure')!.validateFields!({
        tenantId: '11111111-2222-3333-4444-555555555555',
        clientId: 'x',
        clientSecret: 'bad',
      }),
    ).rejects.toThrow('401');
  });

  it('gcp: rejects non-JSON and non-service-account keys before any network call', async () => {
    await expect(
      getConnector('gcp')!.validateFields!({ serviceAccountJson: 'not-json' }),
    ).rejects.toThrow('not valid JSON');
    await expect(
      getConnector('gcp')!.validateFields!({
        serviceAccountJson: JSON.stringify({ type: 'authorized_user' }),
      }),
    ).rejects.toThrow('service_account');
  });
});

describe('google + microsoft identity', () => {
  it('google: returns the userinfo email', async () => {
    mockFetchJson([
      { url: /^https:\/\/www\.googleapis\.com\/oauth2\/v2\/userinfo$/, auth: 'Bearer g-tok', body: { email: 'a@b.com' } },
    ]);
    await expect(getConnector('google')!.fetchIdentity('g-tok')).resolves.toEqual({
      accountLabel: 'a@b.com',
    });
  });

  it('microsoft: prefers mail, falls back to userPrincipalName', async () => {
    mockFetchJson([
      { url: /^https:\/\/graph\.microsoft\.com\/v1\.0\/me$/, body: { userPrincipalName: 'upn@b.com' } },
    ]);
    await expect(getConnector('microsoft')!.fetchIdentity('m-tok')).resolves.toEqual({
      accountLabel: 'upn@b.com',
    });
  });
});
