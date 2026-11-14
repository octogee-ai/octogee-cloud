import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../middleware/auth.js", () => ({ requireAuthenticatedUid: (req: { uid?: string }, _res: unknown, next: () => void) => { req.uid = "caller"; next(); } }));
import { WorkspaceNativeAccessError } from "../lib/workspace-native-access.js";
import { createWorkspaceRolesRouter } from "../routes/workspace-roles.js";

interface StoredProfile { id: string; aliases: string[]; role: string | null }
const isEmailAddress = (alias: string) => /^[^\s@/:]+@[^\s@/:]+$/u.test(alias);
const projected = ({ aliases, ...profile }: StoredProfile) => ({ ...profile, emails: aliases.filter(isEmailAddress) });

const resolveIdentity = vi.fn();
const openClient = vi.fn();
const call = vi.fn();
const close = vi.fn();
let profiles: StoredProfile[] = [];
const signedIn = (uid: string) => profiles.find(profile => profile.aliases.includes(uid.toLowerCase()));

function nativeGateway(uid: string, method: string, params: Record<string, unknown>) {
  if (method === 'users.list') return { ok: true, result: { profiles: profiles.map(projected) } };
  if (method === 'users.self') return { ok: true, result: { profile: projected(signedIn(uid)!) } };
  if (method === 'config.get') return { ok: true, result: { config: { gateway: { roles: { default: 'member', definitions: { member: {}, admin: {}, custom: {} } } } } } };
  if (method === 'users.setRole') {
    const profile = profiles.find(entry => entry.id === params.profileId)!;
    profile.role = params.role as string | null;
    return { ok: true, result: { profile: projected(profile) } };
  }
  throw new Error('unexpected method');
}
function app() {
  const app = express(); app.use(express.json());
  app.use('/api/g/:gatewayId/workspace-roles', createWorkspaceRolesRouter({ resolveIdentity, openClient }));
  return app;
}
const setRoleConnections = () => call.mock.calls.filter(([method]) => method === 'users.setRole').map(([, , uid]) => uid);
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('GATEWAY_CLASS', 'isolated'); vi.stubEnv('OPENCLAW_CONTROL_IDENTITY', 'per-user');
  profiles = [{ id: 'native-caller', aliases: ['caller'], role: 'admin' }];
  resolveIdentity.mockImplementation(async input => ({ uid: 'caller', gatewayId: 'walter', workspaceSlug: 'alice', targetUid: input.targetUid }));
  openClient.mockImplementation(async (uid: string) => {
    if (!signedIn(uid)) profiles.push({ id: `native-${uid}`, aliases: [uid.toLowerCase()], role: null });
    return { scopes: new Set(['operator.admin']), call: (method: string, params: Record<string, unknown>) => call(method, params, uid), close };
  });
  call.mockImplementation(async (method: string, params: Record<string, unknown>, uid: string) => nativeGateway(uid, method, params));
});
afterEach(() => vi.unstubAllEnvs());
describe('native workspace role settings', () => {
  it('lists the role choices without reading every profile', async () => {
    const res = await request(app()).get('/api/g/walter/workspace-roles');
    expect(res.body).toEqual({ canManageRoles: true, roles: ['member', 'admin', 'custom'], defaultRole: 'member' });
    expect(call.mock.calls.map(([method]) => method)).toEqual(['config.get']);
  });
  it("reads a member's assigned role from the profile the member signs in to", async () => {
    profiles.push({ id: 'native-member', aliases: ['member'], role: 'admin' });
    const res = await request(app()).get('/api/g/walter/workspace-roles/member');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ role: 'admin' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(resolveIdentity).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: 'walter', targetUid: 'member' }));
    expect(call).toHaveBeenCalledWith('users.self', {}, 'member');
    expect(call.mock.calls.some(([method]) => method === 'users.list')).toBe(false);
    expect(close).toHaveBeenCalledTimes(2);
  });
  it('reads no role for a member without an assigned role', async () => {
    expect((await request(app()).get('/api/g/walter/workspace-roles/Newcomer')).body).toEqual({ role: null });
  });
  it('fails when OpenClaw returns no signed-in profile for the member', async () => {
    call.mockImplementation(async (method: string, params: Record<string, unknown>, uid: string) =>
      method === 'users.self' ? { ok: false, reason: 'profile unavailable' } : nativeGateway(uid, method, params));
    const res = await request(app()).get('/api/g/walter/workspace-roles/member');
    expect(res.status).toBe(500);
    expect(close).toHaveBeenCalledTimes(2);
  });
  it("rejects member role reads without native admin scope before signing in as the member", async () => {
    openClient.mockResolvedValueOnce({ scopes: new Set(['operator.read']), call, close });
    await request(app()).get('/api/g/walter/workspace-roles/member').expect(403);
    expect(openClient).toHaveBeenCalledOnce();
    expect(call).not.toHaveBeenCalled();
  });
  it('passes on the broker refusal of a member outside the workspace without opening a native connection', async () => {
    resolveIdentity.mockRejectedValueOnce(new WorkspaceNativeAccessError(404, 'Workspace access unavailable'));
    const res = await request(app()).get('/api/g/walter/workspace-roles/stranger');
    expect(res.status).toBe(404);
    expect(openClient).not.toHaveBeenCalled();
  });
  it('assigns a member role by the profile the member signs in to, from the caller connection', async () => {
    profiles.push({ id: 'native-member', aliases: ['member'], role: 'member' });
    expect((await request(app()).get('/api/g/walter/workspace-roles')).body).toMatchObject({ roles: ['member','admin','custom'] });
    expect((await request(app()).patch('/api/g/walter/workspace-roles/member').send({ role: 'admin' })).body).toEqual({ role: 'admin' });
    expect(call).toHaveBeenCalledWith('users.self', {}, 'member');
    expect(call).toHaveBeenCalledWith('users.setRole', { profileId: 'native-member', role: 'admin' }, 'caller');
    expect(setRoleConnections()).toEqual(['caller']);
    expect(profiles.find(profile => profile.id === 'native-member')!.role).toBe('admin');
  });
  it('creates a member profile that does not exist yet before assigning its role', async () => {
    expect((await request(app()).patch('/api/g/walter/workspace-roles/Newcomer').send({ role: 'custom' })).body).toEqual({ role: 'custom' });
    expect(profiles).toContainEqual({ id: 'native-Newcomer', aliases: ['newcomer'], role: 'custom' });
    expect(setRoleConnections()).toEqual(['caller']);
  });
  it('fails without assigning a role when OpenClaw returns no signed-in profile', async () => {
    call.mockImplementation(async (method: string, params: Record<string, unknown>, uid: string) =>
      method === 'users.self' ? { ok: false, reason: 'profile unavailable' } : nativeGateway(uid, method, params));
    const res = await request(app()).patch('/api/g/walter/workspace-roles/member').send({ role: 'admin' });
    expect(res.status).toBe(500);
    expect(setRoleConnections()).toEqual([]);
    expect(close).toHaveBeenCalledTimes(2);
  });
  it('preserves OpenClaw permission denials', async () => {
    call.mockImplementation(async (method: string, params: Record<string, unknown>, uid: string) =>
      method === 'users.setRole' ? { ok: false, reason: 'missing scope: operator.admin' } : nativeGateway(uid, method, params));
    const res = await request(app()).patch('/api/g/walter/workspace-roles/member').send({ role: 'admin' });
    expect(res.status).toBe(403); expect(res.body.error).toContain('operator.admin');
  });
  it('does not show role management when native scopes lack admin', async () => {
    openClient.mockResolvedValueOnce({ scopes: new Set(['operator.read']), call, close });
    expect((await request(app()).get('/api/g/walter/workspace-roles')).body.canManageRoles).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });
  it('rejects role updates without native admin scope before calling any native methods', async () => {
    openClient.mockResolvedValueOnce({ scopes: new Set(['operator.read']), call, close });
    await request(app()).patch('/api/g/walter/workspace-roles/member').send({ role: 'admin' }).expect(403);
    expect(call).not.toHaveBeenCalled();
    expect(openClient).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
  it('rejects malformed role updates before opening a native connection', async () => {
    await request(app()).patch('/api/g/walter/workspace-roles/member').send({ role: false }).expect(400);
    expect(openClient).not.toHaveBeenCalled();
  });
  it('bounds role updates independently of role reads', async () => {
    const client = request(app());
    for (let attempt = 0; attempt < 30; attempt++) {
      await client.patch('/api/g/walter/workspace-roles/member').send({ role: 'admin' }).expect(200);
    }
    await client.patch('/api/g/walter/workspace-roles/member').send({ role: 'admin' }).expect(429);
    expect(openClient).toHaveBeenCalledTimes(60);
    await client.get('/api/g/walter/workspace-roles').expect(200);
  });
  it('never reaches the broker or runtime on a shared gateway', async () => {
    vi.stubEnv('GATEWAY_CLASS', 'shared');
    expect((await request(app()).get('/api/g/walter/workspace-roles')).status).toBe(404);
    expect(resolveIdentity).not.toHaveBeenCalled(); expect(openClient).not.toHaveBeenCalled();
  });
  it('confirms self-demotion through a new native connection after OpenClaw disconnects the caller', async () => {
    call.mockImplementation(async (method: string, params: Record<string, unknown>, uid: string) => {
      const result = nativeGateway(uid, method, params);
      return method === 'users.setRole' ? { ok: false, reason: 'upstream-ws-closed' } : result;
    });
    const res = await request(app()).patch('/api/g/walter/workspace-roles/caller').send({ role: 'member' });
    expect(res.status).toBe(200); expect(res.body).toEqual({ role: 'member' });
    expect(openClient.mock.calls.every(([uid]) => uid === 'caller')).toBe(true);
    expect(setRoleConnections()).toEqual(['caller']);
  });
});
