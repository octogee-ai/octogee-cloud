import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { WsUpgradeRouter } from '@octogee/core/ws/upgrade-router';
import { generateIdentity, signConnectDevice } from '@octogee/shared/types/device-identity';
import { sendWsRequest } from '@octogee/shared/types/openclaw-wire-core';
import type { NativeMobileBinding } from '@octogee/shared/types/native-mobile';
import { createMobileGateway } from './mobile.js';
import { createOpenClawControlProxyIdentity, openProxyIdentitySocket } from './proxy-identity.js';
import { mobileDigest } from './mobile-proof.js';
import { installTestUserIdentity } from '../__tests__/helpers/user-identity.js';

const source = process.env.OPENCLAW_NATIVE_MOBILE_SOURCE;
const ID = 'b57c9773-4598-41a0-b536-3e14e4689995';
async function listen(server: net.Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
  });
}

it.skipIf(!source).each(['ios', 'android'])(
  'pairs both native %s roles, delivers media, invokes a phone capability, and reconnects after gateway and edge restarts',
  async (platform) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octogee-native-mobile-'));
    const sockets: WebSocket[] = [];
    const servers: http.Server[] = [];
    let child: ChildProcess | undefined;
    let output = '';
    try {
      await fs.access(path.join(source!, 'dist/entry.js'));
      const reserve = net.createServer();
      const nativePort = await listen(reserve);
      await new Promise<void>((r) => reserve.close(() => r()));
      const scopes = [
        'operator.admin',
        'operator.read',
        'operator.write',
        'operator.approvals',
        'operator.questions',
        'operator.pairing',
      ];
      const uiRoot = path.join(root, 'control-ui');
      await fs.mkdir(uiRoot);
      await fs.writeFile(
        path.join(uiRoot, 'index.html'),
        '<html><head><script src="/g/walter/openclaw/assets/acceptance.js"></script></head><body><openclaw-app></openclaw-app></body></html>',
      );
      await fs.mkdir(path.join(uiRoot, 'assets'));
      await fs.writeFile(path.join(uiRoot, 'assets/acceptance.js'), 'export const accepted = true;');
      const config = {
        gateway: {
          mode: 'local',
          port: nativePort,
          bind: 'loopback',
          publicOrigin: 'https://api.octogee.com',
          controlUi: { enabled: true, root: uiRoot, basePath: '/g/walter/openclaw' },
          trustedProxies: ['127.0.0.1', '::1'],
          auth: {
            mode: 'trusted-proxy',
            identityScopes: { owner: scopes, 'svc:gateway-edge': scopes },
            trustedProxy: {
              userHeader: 'x-octogee-user',
              requiredHeaders: ['x-octogee-proxy'],
              allowLoopback: true,
              deviceAutoApprove: { enabled: true, scopes },
            },
          },
          roles: {
            default: 'admin',
            definitions: { admin: { agents: '*', scopes, sessions: { others: 'write' } } },
          },
        },
        plugins: { enabled: false },
        agents: { defaults: { workspace: path.join(root, 'workspace') } },
      };
      await fs.writeFile(path.join(root, 'openclaw.json'), JSON.stringify(config), { mode: 0o600 });
      async function startNative() {
        child = spawn(
          process.execPath,
          [
            path.join(source!, 'dist/entry.js'),
            'gateway',
            'run',
            '--allow-unconfigured',
            '--port',
            String(nativePort),
          ],
          {
            cwd: source!,
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              TMPDIR: root,
              LANG: 'en_US.UTF-8',
              NO_COLOR: '1',
              OPENCLAW_STATE_DIR: root,
              OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json'),
              OPENCLAW_NO_RESPAWN: '1',
              OPENCLAW_SKIP_CHANNELS: '1',
              OPENCLAW_SKIP_CANVAS_HOST: '1',
              OPENCLAW_DISABLE_BONJOUR: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        child.stdout?.on('data', (data) => {
          output = (output + data).slice(-20000);
        });
        child.stderr?.on('data', (data) => {
          output = (output + data).slice(-20000);
        });
        for (let i = 0; i < 120; i++) {
          if (child.exitCode !== null)
            throw Error(
              `Native gateway exited: ${output.replace(/(?:token|password)[=:][^\s]+/giu, '<redacted>')}`,
            );
          try {
            await new Promise<void>((resolve, reject) => {
              const socket = net.connect(nativePort, '127.0.0.1', () => {
                socket.end();
                resolve();
              });
              socket.on('error', reject);
            });
            const ready = await fetch(`http://127.0.0.1:${nativePort}/readyz`, {
              signal: AbortSignal.timeout(1000),
            });
            if (ready.ok) return;
            await new Promise((r) => setTimeout(r, 250));
          } catch {
            await new Promise((r) => setTimeout(r, 250));
          }
        }
        throw Error('Native mobile gateway startup timed out');
      }
      await startNative();
      const env = {
        GATEWAY_ID: 'walter',
        GATEWAY_REVISION_ID: 'walter',
        GATEWAY_CLASS: 'isolated',
        GATEWAY_PROFILE: 'isolated',
        OPENCLAW_CONTROL_IDENTITY: 'per-user',
        API_PUBLIC_URL: 'https://api.octogee.com',
        OPENCLAW_GATEWAY_URL: `http://127.0.0.1:${nativePort}`,
        OPENCLAW_DIR: root,
      };
      const headers = (uid: string) => ({
        'x-octogee-user': uid,
        'x-octogee-proxy': '1',
        'x-forwarded-for': '203.0.113.20',
        'x-forwarded-proto': 'https',
        origin: 'https://api.octogee.com',
      });
      const identity = createOpenClawControlProxyIdentity({
        env,
        upstreamBase: () => new URL(env.OPENCLAW_GATEWAY_URL),
        podAddress: () => '203.0.113.20',
      });
      identity.userHeaders = (s) => headers(s.uid);
      identity.serviceHeaders = () => headers('svc:gateway-edge');
      identity.syncProfile = async () => {};
      identity.syncChannelMemberships = async () => {};
      const rpc = async (method: string, params: Record<string, unknown>) => {
        const ws = await openProxyIdentitySocket({
          url: new URL(`ws://127.0.0.1:${nativePort}`),
          headers: headers('svc:gateway-edge'),
          timeoutMs: 10000,
        });
        try {
          return await sendWsRequest({ ws, id: crypto.randomUUID(), method, params, timeoutMs: 15000 });
        } finally {
          ws.close();
        }
      };
      let binding: NativeMobileBinding = {
        id: ID,
        gatewayId: 'walter',
        uid: 'owner',
        workspaceSlug: 'alice',
        allocation: 'allocation',
        state: 'pending',
        setupExpiresAt: Date.now() + 300000,
        httpTokens: [],
      };
      const broker = async (operation: string, _id: string, fields: Record<string, unknown> = {}) => {
        if (binding.state === 'revoked') throw Error('revoked');
        if (operation === 'issued') binding = { ...binding, ...fields } as NativeMobileBinding;
        if (operation === 'reserve')
          binding = { ...binding, ...fields, state: 'reserved' } as NativeMobileBinding;
        if (operation === 'commit')
          binding = { ...binding, ...fields, state: 'awaiting-operator' } as NativeMobileBinding;
        if (operation === 'active') binding.state = 'active';
        if (operation === 'tokens') binding = { ...binding, ...fields } as NativeMobileBinding;
        if (operation === 'revoke') binding.state = 'revoked';
        return structuredClone(binding);
      };
      installTestUserIdentity({
        gatewayId: 'walter',
        state: 'claimed',
        ownerUid: 'owner',
        builderSlug: 'alice',
        leaseId: null,
        generation: null,
      });
      const mount = `/api/g/walter/openclaw/mobile/${ID}`;
      async function startEdge() {
        const mobile = createMobileGateway({
          env,
          identity,
          broker,
          rpc,
          auth: (req, _res, next) => {
            req.uid = 'owner';
            next();
          },
        });
        const app = express();
        app.use(express.json());
        app.use('/api/g/:gatewayId/openclaw/mobile', mobile.router);
        app.use(((error, _req, res, _next) =>
          res.status(500).json({ error: error.message })) as express.ErrorRequestHandler);
        const server = http.createServer(app);
        const upgrades = new WsUpgradeRouter();
        mobile.attach(upgrades);
        upgrades.attach(server);
        servers.push(server);
        return await listen(server);
      }
      let port = await startEdge();
      const response = await request(`http://127.0.0.1:${port}`).post(`${mount}/setup`).send({});
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const setup = JSON.parse(Buffer.from(response.body.setupCode, 'base64url').toString());
      expect(setup.url).toBe(`wss://api.octogee.com/g/walter/openclaw/mobile/${ID}`);
      expect(binding.bootstrapHash).toBe(mobileDigest(setup.bootstrapToken));
      const phone = generateIdentity();
      async function connect(
        role: 'node' | 'operator',
        credential: { bootstrapToken?: string; deviceToken?: string },
      ) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${mount}`);
        sockets.push(ws);
        const hello = await new Promise<Record<string, any>>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Native handshake timeout')), 15000);
          ws.once('error', reject);
          ws.once('close', () => {
            clearTimeout(timer);
            reject(Error('Native handshake closed'));
          });
          ws.on('message', (bytes) => {
            const f = JSON.parse(bytes.toString());
            if (f.event === 'connect.challenge') {
              const requestedScopes =
                role === 'node' ? [] : ['operator.admin', 'operator.read', 'operator.write'];
              const client = {
                id: platform === 'ios' ? 'openclaw-ios' : 'openclaw-android',
                version: 'test',
                mode: role === 'node' ? 'node' : 'ui',
                platform,
                deviceFamily: platform === 'ios' ? 'iPhone' : 'Android',
              };
              const device = signConnectDevice({
                identity: phone,
                clientId: client.id,
                clientMode: client.mode,
                role,
                scopes: requestedScopes,
                nonce: f.payload.nonce,
                token: credential.bootstrapToken ?? credential.deviceToken,
                platform: client.platform,
                deviceFamily: client.deviceFamily,
              });
              if (platform === 'ios') {
                const payload = [
                  'v2',
                  device.id,
                  client.id,
                  client.mode,
                  role,
                  requestedScopes.join(','),
                  String(device.signedAt),
                  credential.bootstrapToken ?? credential.deviceToken ?? '',
                  f.payload.nonce,
                ].join('|');
                device.signature = sign(null, Buffer.from(payload), phone.privateKeyPem).toString(
                  'base64url',
                );
              }
              ws.send(
                JSON.stringify({
                  type: 'req',
                  id: 'connect',
                  method: 'connect',
                  params: {
                    minProtocol: 4,
                    maxProtocol: 4,
                    client,
                    role,
                    scopes: requestedScopes,
                    caps: ['device'],
                    commands: ['device.status'],
                    permissions: {},
                    auth: credential,
                    device,
                  },
                }),
              );
            } else if (f.id === 'connect') {
              clearTimeout(timer);
              f.ok ? resolve(f.payload) : reject(Error(JSON.stringify(f.error)));
            } else if (f.event === 'node.invoke.request')
              ws.send(
                JSON.stringify({
                  type: 'req',
                  id: 'invoke-result',
                  method: 'node.invoke.result',
                  params: {
                    id: f.payload.id,
                    nodeId: phone.deviceId,
                    ok: true,
                    payload: { batteryLevel: 90 },
                  },
                }),
              );
          });
        });
        return { ws, hello };
      }
      const node = await connect('node', { bootstrapToken: setup.bootstrapToken });
      const operatorToken = node.hello.auth.deviceTokens.find(
        (t: { role: string }) => t.role === 'operator',
      ).deviceToken;
      const operator = await connect('operator', { deviceToken: operatorToken });
      expect(binding.state).toBe('active');
      const me = (await sendWsRequest({
        ws: operator.ws,
        id: 'self',
        method: 'users.self',
        params: {},
        timeoutMs: 5000,
      })) as { profile: { emails: string[] } };
      expect(me.profile.emails).toContain('owner');
      const settings = await request(`http://127.0.0.1:${port}`)
        .get(`${mount}/settings`)
        .set('Authorization', `Bearer ${operatorToken}`);
      expect(settings.status, settings.text.slice(0, 256)).toBe(200);
      expect(settings.text).toContain(
        `data-openclaw-control-ui-base-path="${mount.replace('/api/g/', '/g/')}"`,
      );
      expect(settings.text).toContain(`<base href="${mount.replace('/api/g/', '/g/')}/">`);
      expect(settings.text).toContain(`src="${mount.replace('/api/g/', '/g/')}/assets/acceptance.js"`);
      const bundle = await request(`http://127.0.0.1:${port}`).get(`${mount}/assets/acceptance.js`);
      expect(bundle.status, bundle.text).toBe(200);
      expect(bundle.text).toBe('export const accepted = true;');
      const mediaPath = path.join(root, 'media', 'mobile-acceptance.txt');
      await fs.mkdir(path.dirname(mediaPath), { recursive: true });
      await fs.writeFile(mediaPath, 'mobile media bytes');
      const mediaUrl = `${mount}/__openclaw__/assistant-media?${new URLSearchParams({ source: mediaPath })}`;
      const edgeUrl = `http://127.0.0.1:${port}`;
      expect((await request(edgeUrl).get(mediaUrl)).status).toBe(401);
      const metadata = await request(edgeUrl)
        .get(`${mediaUrl}&meta=1`)
        .set('Authorization', `Bearer ${operatorToken}`);
      expect(metadata.status, JSON.stringify(metadata.body)).toBe(200);
      expect(metadata.body.available).toBe(true);
      const ticketUrl = `${mediaUrl}&mediaTicket=${encodeURIComponent(metadata.body.mediaTicket)}`;
      const media = await request(edgeUrl).get(ticketUrl);
      expect(media.status, media.text).toBe(200);
      expect(media.text).toBe('mobile media bytes');
      const range = await request(edgeUrl).get(ticketUrl).set('Range', 'bytes=7-11');
      expect(range.status).toBe(206);
      expect(range.text).toBe('media');
      expect((await request(edgeUrl).get(`${mediaUrl}&mediaTicket=v1.invalid.signature`)).status).not.toBe(
        200,
      );
      const invoked = await rpc('node.invoke', {
        nodeId: phone.deviceId,
        command: 'device.status',
        params: {},
        timeoutMs: 5000,
        idempotencyKey: crypto.randomUUID(),
      });
      expect(invoked).toMatchObject({ ok: true });
      node.ws.terminate();
      operator.ws.terminate();
      await stop(child!);
      await startNative();
      port = await startEdge();
      const reconnectedNode = await connect('node', { deviceToken: node.hello.auth.deviceToken });
      const reconnected = await connect('operator', { deviceToken: operatorToken });
      expect(reconnected.hello.auth.role).toBe('operator');
      expect(reconnectedNode.hello.auth.role).toBe('node');
      const rotated = (await sendWsRequest({
        ws: reconnected.ws,
        id: 'rotate-node',
        method: 'device.token.rotate',
        params: { deviceId: phone.deviceId, role: 'node' },
        timeoutMs: 5000,
      })) as { token?: string; tokenDelivery: string };
      expect(rotated.tokenDelivery).toBe('withheld-cross-device');
      expect(rotated.token).toBeUndefined();
      expect(binding.state).toBe('revoked');
      expect(
        (
          await request(`http://127.0.0.1:${port}`)
            .get(mediaUrl)
            .set('Authorization', `Bearer ${operatorToken}`)
        ).status,
      ).not.toBe(200);
    } finally {
      sockets.forEach((socket) => socket.terminate());
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      if (child) await stop(child);
      installTestUserIdentity(null);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
