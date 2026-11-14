import { createHash, randomBytes } from 'node:crypto';
import type { GatewayTicket, Stored } from '@octogee/core/platform-state';
import { VOICE_ARCHIVE_POST_KIND, VOICE_TURN_POST_KIND, voiceTurnMessage, type VoiceArchiveRequest, type VoiceConversation, type VoiceGrantBinding, type VoiceGrantEndRequest, type VoiceGrantRequest, type VoiceTurnPost, type VoiceTurnRequest } from '@octogee/core/voice-conversation';
import { resolveVoiceConversationContext, resolveVoiceChannel, type WorkspaceConversationDeps } from './workspace-conversation.js';
import { parseAgentId } from '@octogee/shared/types/identity';
import { isMattermostPostId } from '@octogee/shared/types/mattermost-session-route';

const PURPOSE = 'voice.turn.post';
const GRANT_TTL_MS = 30 * 60_000;
const MAX_TURNS = 256;
const MATTERMOST_ID = /^[a-z0-9]{26}$/u;
interface GrantIdentity { uid: string; gatewayId: string; workspaceSlug: string; ownerUid: string; channelId: string; threadRootPostId: string; agentId: string; sessionKey: string }
type TurnReceipt = { digest: string; state: 'pending' | 'failed' } | { digest: string; state: 'posted'; post: VoiceTurnPost };
interface GrantDocument extends GrantIdentity {
  purpose: typeof PURPOSE;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  sessionId: string | null;
  callerMmUserId: string | null;
  turns: Record<string, TurnReceipt>;
  archive?: TurnReceipt;
}
export class VoicePostingGrantError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = 'VoicePostingGrantError'; }
}
function deny(): never { throw new VoicePostingGrantError(403, 'voice_grant_forbidden'); }
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/');
}
function validIdentity(body: Partial<GrantIdentity>): boolean {
  const agent = parseAgentId(body.agentId ?? '');
  return [body.uid, body.gatewayId, body.ownerUid].every(boundedId) && typeof body.workspaceSlug === 'string' && /^[a-z0-9-]{1,64}$/u.test(body.workspaceSlug) &&
    typeof body.channelId === 'string' && MATTERMOST_ID.test(body.channelId) && isMattermostPostId(body.threadRootPostId) && agent.kind !== 'unknown' && agent.username === body.workspaceSlug &&
    ['channel', 'group'].some(kind => body.sessionKey === `agent:${body.agentId}:mattermost:${kind}:${body.channelId}`);
}
function grantHash(voiceGrant: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(voiceGrant)) deny();
  return createHash('sha256').update(voiceGrant).digest('hex');
}
function grantBody(ticket: Stored<GatewayTicket> | null): unknown {
  if (ticket === null) return undefined;
  return { ...ticket.grant, uid: ticket.uid, gatewayId: ticket.gatewayId, expiresAt: ticket.expiresAt };
}
async function readGrant(deps: WorkspaceConversationDeps, voiceGrant: string): Promise<unknown> {
  return grantBody(await deps.store.access.gatewayTickets.get(grantHash(voiceGrant)));
}
export function createVoicePostingGrant(identity: GrantIdentity, now = Date.now()) {
  if (!validIdentity(identity)) throw new Error('Voice grant identity is invalid');
  const voiceGrant = randomBytes(32).toString('base64url');
  const expiresAt = now + GRANT_TTL_MS;
  const document: GrantDocument = { ...identity, purpose: PURPOSE, createdAt: now, expiresAt, revokedAt: null, sessionId: null, callerMmUserId: null, turns: {} };
  return { voiceGrant, voiceGrantExpiresAt: expiresAt, path: `gatewayTickets/${grantHash(voiceGrant)}`, document };
}
function validLifetime(body: Partial<GrantDocument>): boolean {
  return typeof body.createdAt === 'number' && Number.isFinite(body.createdAt) && body.createdAt <= Date.now() &&
    typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt) && body.expiresAt > body.createdAt && body.expiresAt <= body.createdAt + GRANT_TTL_MS;
}
function parseGrant(value: unknown, gatewayId: string): GrantDocument {
  const body = record(value) as Partial<GrantDocument> | null;
  if (!body || body.purpose !== PURPOSE || body.gatewayId !== gatewayId || !validIdentity(body)) deny();
  if (!validLifetime(body) || !record(body.turns)) deny();
  if (body.sessionId !== null && !boundedId(body.sessionId)) deny();
  if (body.callerMmUserId !== null && (typeof body.callerMmUserId !== 'string' || !MATTERMOST_ID.test(body.callerMmUserId))) deny();
  return body as GrantDocument;
}
function activeGrant(value: unknown, gatewayId: string): GrantDocument {
  const grant = parseGrant(value, gatewayId);
  if (grant.revokedAt !== null || grant.expiresAt <= Date.now()) deny();
  return grant;
}
function matchesResolved(grant: GrantDocument, resolved: NonNullable<Awaited<ReturnType<typeof resolveVoiceConversationContext>>>): boolean {
  const { context, scope } = resolved;
  return grant.uid === context.uid && grant.gatewayId === context.gatewayId && grant.workspaceSlug === context.workspaceSlug &&
    grant.ownerUid === scope.ownerUid && grant.channelId === context.channelId && grant.threadRootPostId === context.threadRootPostId && grant.agentId === context.agentId && grant.sessionKey === context.sessionKey &&
    (grant.callerMmUserId === null || grant.callerMmUserId === context.callerMmUserId);
}
async function authorizeGrant(deps: WorkspaceConversationDeps, grant: GrantDocument) {
  const resolved = await resolveVoiceConversationContext(deps, grant);
  if (!resolved || !matchesResolved(grant, resolved)) deny();
  return resolved;
}
function grantBinding(context: VoiceConversation, grant: GrantDocument, sessionId: string): VoiceGrantBinding {
  return { ...context, sessionId, expiresAt: grant.expiresAt };
}
export async function bindWorkspaceVoiceGrant(deps: WorkspaceConversationDeps, gatewayId: string, request: VoiceGrantRequest): Promise<VoiceGrantBinding> {
  const ticketId = grantHash(request.voiceGrant);
  const initial = activeGrant(await readGrant(deps, request.voiceGrant), gatewayId);
  if (initial.sessionId !== null && initial.sessionId !== request.sessionId) deny();
  const resolved = await authorizeGrant(deps, initial);
  const grant = await deps.store.transaction({ label: 'voice-grant-bind' }, async tx => {
    const current = activeGrant(grantBody(await tx.access.gatewayTickets.get(ticketId)), gatewayId);
    if (!matchesResolved(current, resolved) || (current.sessionId !== null && current.sessionId !== request.sessionId)) deny();
    await tx.access.gatewayTickets.patchGrant(ticketId, { sessionId: request.sessionId, callerMmUserId: resolved.context.callerMmUserId });
    return current;
  });
  const { scope } = resolved;
  return grantBinding({ ...resolved.context, nativeInterrupt: scope.gatewayClass === 'isolated' && scope.nativeAccess && scope.auth.config.builderAccess?.controlUiEnabled === true }, grant, request.sessionId);
}
export async function endWorkspaceVoiceGrant(deps: WorkspaceConversationDeps, gatewayId: string, request: VoiceGrantEndRequest): Promise<{ revoked: true }> {
  const ticketId = grantHash(request.voiceGrant);
  await deps.store.transaction({ label: 'voice-grant-end' }, async tx => {
    const current = parseGrant(grantBody(await tx.access.gatewayTickets.get(ticketId)), gatewayId);
    if (request.sessionId !== undefined && current.sessionId !== null && current.sessionId !== request.sessionId) deny();
    if (current.revokedAt === null) await tx.access.gatewayTickets.patchGrant(ticketId, { revokedAt: Date.now() });
  });
  return { revoked: true };
}
function turnDigest(request: VoiceTurnRequest): string {
  return createHash('sha256').update(JSON.stringify([voiceTurnMessage(request.text), request.ingressToken ?? null])).digest('hex');
}
function replayTurn(turn: TurnReceipt, digest: string): VoiceTurnPost {
  if (turn.digest !== digest) throw new VoicePostingGrantError(409, 'voice_turn_conflict');
  if (turn.state === 'posted') return turn.post;
  if (turn.state === 'failed') throw new VoicePostingGrantError(502, 'voice_turn_failed');
  throw new VoicePostingGrantError(409, 'voice_turn_pending');
}
async function reserveTurn(deps: WorkspaceConversationDeps, gatewayId: string, request: VoiceTurnRequest, resolved: NonNullable<Awaited<ReturnType<typeof resolveVoiceConversationContext>>>, digest: string) {
  const ticketId = grantHash(request.voiceGrant);
  return deps.store.transaction({ label: 'voice-grant-reserve-turn' }, async tx => {
    const grant = activeGrant(grantBody(await tx.access.gatewayTickets.get(ticketId)), gatewayId);
    if (grant.sessionId !== request.sessionId || !matchesResolved(grant, resolved)) deny();
    if (Object.hasOwn(grant.turns, request.turnId)) return replayTurn(grant.turns[request.turnId], digest);
    if (Object.keys(grant.turns).length >= MAX_TURNS) throw new VoicePostingGrantError(429, 'voice_turn_limit');
    await tx.access.gatewayTickets.patchGrant(ticketId, { turns: { ...grant.turns, [request.turnId]: { state: 'pending', digest } } });
    return null;
  });
}
async function finishTurn(deps: WorkspaceConversationDeps, gatewayId: string, request: VoiceTurnRequest, receipt: TurnReceipt): Promise<void> {
  const ticketId = grantHash(request.voiceGrant);
  await deps.store.transaction({ label: 'voice-grant-finish-turn' }, async tx => {
    const grant = parseGrant(grantBody(await tx.access.gatewayTickets.get(ticketId)), gatewayId);
    const existing = grant.turns[request.turnId];
    if (!existing || existing.digest !== receipt.digest || existing.state !== 'pending') throw new Error('Voice turn reservation changed before delivery settled');
    await tx.access.gatewayTickets.patchGrant(ticketId, { turns: { ...grant.turns, [request.turnId]: receipt } });
  });
}
async function createTurnPost(deps: WorkspaceConversationDeps, token: string, context: { channelId: string; threadRootPostId: string; callerMmUserId: string }, request: VoiceTurnRequest): Promise<VoiceTurnPost> {
  const createPost = deps.createPost ?? (async (credential, body) => {
    const { createChannelSessionMattermostClient } = await import('../../../gateway-edge/src/lib/channel-session-model-control.js');
    return createChannelSessionMattermostClient({ baseUrl: process.env.MM_INTERNAL_URL ?? '', token: credential }).postJson(['posts'], body);
  });
  const props = { octogee: { kind: VOICE_TURN_POST_KIND, turnId: request.turnId }, ...(request.ingressToken === undefined ? {} : { openclaw_consult_ingress: request.ingressToken }) };
  const post = record(await createPost(token, { channel_id: context.channelId, root_id: context.threadRootPostId, message: voiceTurnMessage(request.text), props }));
  if (!post || typeof post.id !== 'string' || !MATTERMOST_ID.test(post.id) || post.channel_id !== context.channelId || post.root_id !== context.threadRootPostId || post.user_id !== context.callerMmUserId) throw new VoicePostingGrantError(502, 'voice_turn_unverified');
  return { postId: post.id, channelId: context.channelId, threadRootPostId: context.threadRootPostId, userId: context.callerMmUserId };
}
export async function postWorkspaceVoiceTurn(deps: WorkspaceConversationDeps, gatewayId: string, request: VoiceTurnRequest): Promise<VoiceTurnPost> {
  const initial = activeGrant(await readGrant(deps, request.voiceGrant), gatewayId);
  if (initial.sessionId !== request.sessionId) deny();
  const resolved = await authorizeGrant(deps, initial);
  const digest = turnDigest(request);
  const replay = await reserveTurn(deps, gatewayId, request, resolved, digest);
  let post: VoiceTurnPost;
  try {
    let createPost = deps.createPost;
    if (!createPost) {
      const { createChannelSessionMattermostClient } = await import('../../../gateway-edge/src/lib/channel-session-model-control.js');
      createPost = (credential, body) => createChannelSessionMattermostClient({ baseUrl: process.env.MM_INTERNAL_URL ?? '', token: credential }).postJson(['posts'], body);
    }
    const fresh = await authorizeGrant(deps, initial);
    const current = activeGrant(await readGrant(deps, request.voiceGrant), gatewayId);
    if (current.sessionId !== request.sessionId || !matchesResolved(current, fresh)) deny();
    if (replay) {
      if (replay.channelId !== current.channelId || replay.threadRootPostId !== current.threadRootPostId || replay.userId !== current.callerMmUserId) deny();
      return replay;
    }
    post = await createTurnPost({ ...deps, createPost }, fresh.token, fresh.context, request);
  }
  catch (error) {
    if (!replay) await finishTurn(deps, gatewayId, request, { digest, state: 'failed' });
    if (error instanceof VoicePostingGrantError) throw error;
    throw new VoicePostingGrantError(502, 'voice_turn_failed');
  }
  await finishTurn(deps, gatewayId, request, { digest, state: 'posted', post });
  return post;
}

function archiveDigest(request: VoiceArchiveRequest): string {
  return createHash('sha256').update(JSON.stringify([request.entries.map(entry => [entry.transcriptId, entry.role, entry.text]), request.truncated])).digest('hex');
}
function replayArchive(receipt: TurnReceipt, digest: string): VoiceTurnPost {
  if (receipt.digest !== digest) throw new VoicePostingGrantError(409, 'voice_archive_conflict');
  if (receipt.state === 'posted') return receipt.post;
  if (receipt.state === 'failed') throw new VoicePostingGrantError(502, 'voice_archive_failed');
  throw new VoicePostingGrantError(409, 'voice_archive_pending');
}
function archiveMessage(request: VoiceArchiveRequest, participantMmUserId: string): string {
  const lines = [
    'Voice call record',
    `Participant: ${participantMmUserId}`,
    'Received finalized speech before close; not proof of playback or later task completion.',
    '',
    ...request.entries.map(entry => `${entry.role === 'user' ? 'Participant' : 'Coach'}: ${entry.text.trim().replace(/\s+/gu, ' ').replaceAll('@', '＠')}`),
  ];
  const notice = '\n[Record truncated.]';
  const text = lines.join('\n');
  const maxChars = 16000;
  if (text.length <= maxChars - notice.length) return text + (request.truncated ? notice : '');
  const prefix = text.slice(0, maxChars - notice.length);
  return prefix.replace(/[\uD800-\uDBFF]$/u, '') + notice;
}
async function reserveArchive(deps: WorkspaceConversationDeps, gatewayId: string, request: VoiceArchiveRequest, resolved: NonNullable<Awaited<ReturnType<typeof resolveVoiceConversationContext>>>, digest: string) {
  const ticketId = grantHash(request.voiceGrant);
  return deps.store.transaction({ label: 'voice-grant-reserve-archive' }, async tx => {
    const grant = activeGrant(grantBody(await tx.access.gatewayTickets.get(ticketId)), gatewayId);
    if (grant.sessionId !== request.sessionId || !matchesResolved(grant, resolved)) deny();
    if (grant.archive) return replayArchive(grant.archive, digest);
    await tx.access.gatewayTickets.patchGrant(ticketId, { archive: { state: 'pending', digest } });
    return null;
  });
}
async function finishArchive(deps: WorkspaceConversationDeps, gatewayId: string, request: VoiceArchiveRequest, receipt: TurnReceipt): Promise<void> {
  const ticketId = grantHash(request.voiceGrant);
  await deps.store.transaction({ label: 'voice-grant-finish-archive' }, async tx => {
    const grant = parseGrant(grantBody(await tx.access.gatewayTickets.get(ticketId)), gatewayId);
    if (!grant.archive || grant.archive.digest !== receipt.digest || grant.archive.state !== 'pending') throw new Error('Voice archive reservation changed before delivery settled');
    await tx.access.gatewayTickets.patchGrant(ticketId, { archive: receipt });
  });
}
async function conversationAgentCredential(deps: WorkspaceConversationDeps, ownerUid: string, agentId: string) {
  const agent = parseAgentId(agentId);
  if (agent.kind === 'unknown') deny();
  const secretId = agent.kind === 'project' ? `projectAgentMattermost-${agent.project}` : 'coachMattermost';
  const secret = await deps.store.secrets.get(ownerUid, secretId);
  if (!secret || secret.kind === 'connector' || !secret.personalToken.trim() ||
    secret.mattermostUserId === null || !MATTERMOST_ID.test(secret.mattermostUserId)) deny();
  return { defaultAgentMmUserId: secret.mattermostUserId, coachToken: secret.personalToken };
}
export async function startWorkspaceVoiceConversation(deps: WorkspaceConversationDeps, claim: { uid: string; channelId: string; threadRootPostId?: string }) {
  if (claim.threadRootPostId !== undefined) return resolveVoiceConversationContext(deps, { ...claim, threadRootPostId: claim.threadRootPostId });
  const resolved = await resolveVoiceChannel(deps, claim);
  if (!resolved) return null;
  const { defaultAgentMmUserId, coachToken } = await conversationAgentCredential(deps, resolved.scope.ownerUid, resolved.context.agentId);
  if (defaultAgentMmUserId !== resolved.agentMmUserId) deny();
  const body = { channel_id: claim.channelId, root_id: '', message: '🎙 Voice conversation',
    props: { octogee: { kind: 'voice-conversation', participantMmUserId: resolved.context.callerMmUserId } } };
  let createPost = deps.createPost;
  if (!createPost) {
    const { createChannelSessionMattermostClient } = await import('../../../gateway-edge/src/lib/channel-session-model-control.js');
    const client = createChannelSessionMattermostClient({ baseUrl: process.env.MM_INTERNAL_URL ?? '', token: coachToken });
    createPost = (_credential, post) => client.postJson(['posts'], post);
  }
  const posted = record(await createPost(coachToken, body));
  if (!posted || !isMattermostPostId(posted.id) || posted.channel_id !== claim.channelId || posted.root_id !== '' || posted.user_id !== defaultAgentMmUserId) {
    throw new VoicePostingGrantError(502, 'voice_conversation_unverified');
  }
  return resolveVoiceConversationContext(deps, { ...claim, threadRootPostId: posted.id });
}
function verifiedArchivePost(value: unknown, current: GrantDocument, defaultAgentMmUserId: string): VoiceTurnPost {
  const posted = record(value);
  if (!posted || typeof posted.id !== 'string' || !MATTERMOST_ID.test(posted.id) || posted.channel_id !== current.channelId || posted.root_id !== current.threadRootPostId || posted.user_id !== defaultAgentMmUserId) throw new VoicePostingGrantError(502, 'voice_archive_unverified');
  return { postId: posted.id, channelId: current.channelId, threadRootPostId: current.threadRootPostId, userId: defaultAgentMmUserId };
}
export async function archiveWorkspaceVoiceCall(deps: WorkspaceConversationDeps, gatewayId: string, request: VoiceArchiveRequest): Promise<VoiceTurnPost> {
  const initial = activeGrant(await readGrant(deps, request.voiceGrant), gatewayId);
  if (initial.sessionId !== request.sessionId || initial.callerMmUserId === null) deny();
  const resolved = await authorizeGrant(deps, initial);
  const { defaultAgentMmUserId, coachToken } = await conversationAgentCredential(deps, initial.ownerUid, initial.agentId);
  let createPost = deps.createPost;
  if (!createPost) {
    const { createChannelSessionMattermostClient } = await import('../../../gateway-edge/src/lib/channel-session-model-control.js');
    const client = createChannelSessionMattermostClient({ baseUrl: process.env.MM_INTERNAL_URL ?? '', token: coachToken });
    createPost = (_credential, body) => client.postJson(['posts'], body);
  }
  const digest = archiveDigest(request);
  const replay = await reserveArchive(deps, gatewayId, request, resolved, digest);
  let post: VoiceTurnPost;
  try {
    const fresh = await authorizeGrant(deps, initial);
    const current = activeGrant(await readGrant(deps, request.voiceGrant), gatewayId);
    if (current.sessionId !== request.sessionId || !matchesResolved(current, fresh) || fresh.agentMmUserId !== defaultAgentMmUserId) deny();
    if (replay) {
      if (replay.channelId !== current.channelId || replay.threadRootPostId !== current.threadRootPostId || replay.userId !== defaultAgentMmUserId) deny();
      return replay;
    }
    post = verifiedArchivePost(await createPost(coachToken, {
      channel_id: current.channelId,
      root_id: current.threadRootPostId,
      message: archiveMessage(request, fresh.context.callerMmUserId),
      props: { octogee: { kind: VOICE_ARCHIVE_POST_KIND, sessionId: request.sessionId, participantMmUserId: fresh.context.callerMmUserId, truncated: request.truncated } },
    }), current, defaultAgentMmUserId);
  } catch (error) {
    if (!replay) await finishArchive(deps, gatewayId, request, { digest, state: 'failed' });
    if (error instanceof VoicePostingGrantError) throw error;
    throw new VoicePostingGrantError(502, 'voice_archive_failed');
  }
  await finishArchive(deps, gatewayId, request, { digest, state: 'posted', post });
  return post;
}
