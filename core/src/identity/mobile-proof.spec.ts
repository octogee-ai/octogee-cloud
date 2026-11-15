import { describe, expect, it } from 'vitest';
import { sign } from 'node:crypto';
import { generateIdentity, signConnectDevice } from '@octogee/shared/types/device-identity';
import {
  verifyMobileConnect,
  projectMobileHello,
  projectMobileDocument,
  mobileRoute,
  mobileDefaultAgent,
  projectMobileSessionFrame,
  isMobileMediaResource,
} from './mobile-proof.js';

const identity = generateIdentity();
function frame(role = 'node', nonce = 'challenge', signedAt = Date.now()) {
  const client = {
    id: 'openclaw-ios',
    version: 'test',
    mode: role === 'node' ? 'node' : 'ui',
    platform: 'ios',
    deviceFamily: 'iPhone',
  };
  return {
    type: 'req',
    id: 'connect',
    method: 'connect',
    params: {
      minProtocol: 4,
      maxProtocol: 4,
      client,
      role,
      scopes: [] as string[],
      auth: { bootstrapToken: 'bootstrap' },
      device: signConnectDevice({
        identity,
        clientId: client.id,
        clientMode: client.mode,
        role,
        scopes: [],
        nonce,
        token: 'bootstrap',
        platform: client.platform,
        deviceFamily: client.deviceFamily,
        signedAtMs: signedAt,
      }),
    },
  };
}

describe('native mobile admission proof', () => {
  it('allows native media selectors and tickets while rejecting duplicate or unknown query authority', () => {
    const base = 'https://api.octogee.com/__openclaw__/assistant-media?source=photo.png';
    expect(isMobileMediaResource(new URL(`${base}&meta=1&sessionKey=main&agentId=main`))).toBe(true);
    expect(
      isMobileMediaResource(new URL(`${base}&mediaTicket=v1.signed.ticket&variant=thumbnail&width=256`)),
    ).toBe(true);
    expect(isMobileMediaResource(new URL(`${base}&source=other.png`))).toBe(false);
    expect(isMobileMediaResource(new URL(`${base}&token=secret`))).toBe(false);
  });
  it('verifies the native phone key and leaves the signed frame intact', () => {
    const input = frame();
    const original = structuredClone(input);
    expect(verifyMobileConnect(input, 'challenge')).toMatchObject({
      deviceId: identity.deviceId,
      role: 'node',
      bootstrapToken: 'bootstrap',
    });
    expect(input).toEqual(original);
  });
  it('accepts the current Swift client compatibility signature with its fresh challenge and signed role', () => {
    const input = frame();
    const d = input.params.device;
    const payload = [
      'v2',
      d.id,
      input.params.client.id,
      input.params.client.mode,
      'node',
      '',
      String(d.signedAt),
      'bootstrap',
      d.nonce,
    ].join('|');
    d.signature = sign(null, Buffer.from(payload), identity.privateKeyPem).toString('base64url');
    expect(verifyMobileConnect(input, 'challenge')).toMatchObject({
      deviceId: identity.deviceId,
      role: 'node',
    });
    input.params.role = 'operator';
    expect(() => verifyMobileConnect(input, 'challenge')).toThrow();
  });
  it.each(['signature', 'key', 'nonce', 'time', 'protocol', 'scopes', 'role'])(
    'rejects a forged or out-of-contract %s',
    (kind) => {
      const input = frame();
      if (kind === 'signature') input.params.device.signature = 'A'.repeat(86);
      if (kind === 'key') input.params.device.id = 'a'.repeat(64);
      if (kind === 'nonce') input.params.device.nonce = 'another';
      if (kind === 'time') input.params.device.signedAt = 1;
      if (kind === 'protocol') input.params.maxProtocol = 3;
      if (kind === 'scopes') input.params.scopes = ['operator.admin'];
      if (kind === 'role') input.params.role = 'service';
      expect(() => verifyMobileConnect(input, 'challenge')).toThrow();
    },
  );
  it('routes only canonical enrollment IDs and the selected gateway', () => {
    const id = '2b7d671e-180d-4dab-a486-5224ad783155';
    expect(mobileRoute(`/g/walter/openclaw/mobile/${id}`, 'walter')).toEqual({
      enrollmentId: id,
      upstreamPath: '/',
    });
    expect(
      mobileRoute(`/api/g/walter/openclaw/mobile/${id}/__openclaw__/assistant-media?q=1`, 'walter')
        ?.upstreamPath,
    ).toBe('/__openclaw__/assistant-media?q=1');
    expect(mobileRoute(`/g/other/openclaw/mobile/${id}`, 'walter')).toBeNull();
    expect(mobileRoute(`/g/walter/openclaw/mobile/${id}/../config`, 'walter')).toBeNull();
    expect(mobileRoute(`/g/walter/openclaw/mobile/${id}//outside.example/assets/app.js`, 'walter')).toBeNull();
    expect(mobileRoute(`/g/walter/openclaw/mobile/${id}/\t/outside.example/assets/app.js`, 'walter')).toBeNull();
    expect(
      mobileRoute(
        `/g/walter/openclaw/mobile/${id}/__openclaw__/assistant-media?source=files%2Fphoto.png`,
        'walter',
      )?.upstreamPath,
    ).toBe('/__openclaw__/assistant-media?source=files%2Fphoto.png');
  });
  it('projects the enrollment mount without removing native handoff credentials', () => {
    const auth = {
      deviceToken: 'node-token',
      deviceTokens: [{ role: 'operator', deviceToken: 'operator-token', scopes: ['operator.read'] }],
    };
    const result = projectMobileHello(
      {
        type: 'res',
        id: 'c',
        ok: true,
        payload: { type: 'hello-ok', auth, controlUiUrl: 'http://127.0.0.1:18789/' },
      },
      'https://api.octogee.com',
      '/g/walter/openclaw/mobile/id',
    );
    expect(result.payload).toMatchObject({
      auth,
      controlUiBasePath: '/g/walter/openclaw/mobile/id',
      controlUiUrl: 'https://api.octogee.com/g/walter/openclaw/mobile/id',
    });
  });
  it('mounts embedded native documents and their bootstrap metadata without changing external links', () => {
    const html =
      '<html data-openclaw-control-ui-base-path="" data-openclaw-bootstrap-config="{&quot;basePath&quot;:&quot;&quot;}"><head><script src="/assets/app.js"></script></head><a href="https://example.com/">Link</a></html>';
    const result = projectMobileDocument(html, '/g/walter/openclaw/mobile/id');
    expect(result).toContain('<base href="/g/walter/openclaw/mobile/id/">');
    expect(result).toContain('src="/g/walter/openclaw/mobile/id/assets/app.js"');
    expect(result).toContain('&quot;basePath&quot;:&quot;/g/walter/openclaw/mobile/id&quot;');
    expect(result).toContain('href="https://example.com/"');
  });
  it('recognizes iOS main aliases and Android device-owned defaults without redirecting explicit conversations', () => {
    expect(mobileDefaultAgent('main', identity.deviceId, 'alice')).toBe('octogee-alice-coach');
    expect(
      mobileDefaultAgent(`agent:main:node-${identity.deviceId.slice(0, 12)}`, identity.deviceId, 'alice'),
    ).toBe('octogee-alice-coach');
    expect(mobileDefaultAgent('agent:octogee-alice-proj-demo-coach:main', identity.deviceId, 'alice')).toBe(
      'octogee-alice-proj-demo-coach',
    );
    expect(
      mobileDefaultAgent('agent:octogee-alice-coach:mattermost:group:channel', identity.deviceId, 'alice'),
    ).toBeNull();
    expect(
      mobileDefaultAgent('agent:octogee-alice-coach:node-aaaaaaaaaaaa', identity.deviceId, 'alice'),
    ).toBeNull();
  });
  it('projects conversation envelope keys without modifying transcript content or other sessions', () => {
    const canonical = 'agent:octogee-alice-coach:mattermost:group:channel';
    const frame = {
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: canonical,
        sessionInfo: { key: canonical },
        message: { text: canonical, key: canonical },
      },
    };
    expect(projectMobileSessionFrame(frame, new Map([[canonical, 'main']]))).toEqual({
      ...frame,
      payload: { ...frame.payload, sessionKey: 'main', sessionInfo: { key: 'main' } },
    });
    expect(
      projectMobileSessionFrame({ payload: { sessionKey: 'other' } }, new Map([[canonical, 'main']])),
    ).toEqual({ payload: { sessionKey: 'other' } });
  });
  it('projects selected session aliases in native lists without changing other entries', () => {
    const canonical = 'agent:octogee-alice-coach:mattermost:group:channel';
    const frame = {
      type: 'res',
      payload: { sessions: [{ key: canonical, sessionKey: canonical }, { key: 'other' }, null] },
    };
    expect(projectMobileSessionFrame(frame, new Map([[canonical, 'main']]))).toEqual({
      ...frame,
      payload: { sessions: [{ key: 'main', sessionKey: 'main' }, { key: 'other' }, null] },
    });
  });
});
