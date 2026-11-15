import { randomUUID } from 'node:crypto';
import { parseAgentId } from '@octogee/shared/types/identity';
import type { WebSocket } from 'ws';
import { isResponseFrame } from '@octogee/shared/types/openclaw-wire-core';
import { parseTalkClientMessage, resolveTalkSettings, TALK_PROTOCOL_VERSION, TALK_OUTPUT_SAMPLE_RATE, type ResolvedTalkSettings, type TalkClientMessage, type TalkServerEvent } from '@octogee/shared/types/voice';
import { openNativeUserSocket, type NativeUserSocket } from '../openclaw-control/native-user-client.js';
import { attachUpstreamRpcClient, type UpstreamRpcClient } from '@octogee/core/http-candidates/chat-proxy/openclaw/bridge-upstream-rpc';
import { VOICE_ARCHIVE_ENTRIES_MAX, VOICE_ARCHIVE_ENTRY_TEXT_MAX, VOICE_ARCHIVE_TEXT_MAX, VOICE_ARCHIVE_TRANSCRIPT_ID_MAX, type VoiceArchiveEntry } from '@octogee/core/voice-conversation';

const OPENAI_NATIVE_PROVIDER = 'octogee-openai';

interface NativeTalkOptions {
  provider?: 'octogee' | 'octogee-openai';
  onUnavailable?: (sessionId: string, reason: string) => void;
  voiceGrant: string;
  voiceGrantExpiresAt: number;
  conversation: { uid: string; gatewayId: string; agentId: string; sessionKey: string; threadRootPostId: string };
  send: (event: TalkServerEvent) => void;
  sendAudio: (audio: Buffer) => void;
  reauthorize: () => Promise<unknown>;
  bindSession: (sessionId: string) => Promise<{ sessionId: string; sessionKey: string; expiresAt: number }>;
  onClose?: () => void;
  log: (message: string, fields?: Record<string, unknown>) => void;
  open?: typeof openNativeUserSocket;
  attachRpc?: typeof attachUpstreamRpcClient;
}

function nativeRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Native voice sent a malformed frame');
  }
  return value as Record<string, unknown>;
}

function nativeEventFrame(value: unknown): { event: string; payload: unknown } | null {
  if (isResponseFrame(value)) return null;
  const frame = nativeRecord(value);
  if (frame.type !== 'event' || typeof frame.event !== 'string' || !frame.event) {
    throw new Error('Native voice sent a malformed frame');
  }
  return { event: frame.event, payload: frame.payload };
}

function validTalkEventFields(event: Record<string, unknown>): boolean {
  switch (event.type) {
    case 'transcript': return typeof event.text === 'string' &&
      (event.role === 'user' || event.role === 'assistant') && typeof event.final === 'boolean' &&
      (event.textMode === undefined || event.textMode === 'snapshot');
    case 'audio': return typeof event.audioBase64 === 'string';
    case 'mark': return typeof event.markName === 'string' && event.markName.length > 0;
    default: return true;
  }
}

function nativeTalkPayload(value: unknown): Record<string, unknown> {
  const event = nativeRecord(value);
  if (typeof event.relaySessionId !== 'string' || !event.relaySessionId ||
    typeof event.type !== 'string' || !event.type || !validTalkEventFields(event)) {
    throw new Error('Native voice sent a malformed Talk frame');
  }
  if (event.talkEvent !== undefined) {
    const talk = nativeRecord(event.talkEvent);
    if (talk.turnId !== undefined && (typeof talk.turnId !== 'string' || !talk.turnId)) {
      throw new Error('Native voice sent a malformed Talk frame');
    }
  }
  return event;
}

class NativeRpcError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

export class NativeTalkSession {
  sessionId = randomUUID();
  currentState: 'idle' | 'listening' | 'thinking' | 'speaking' | 'closed' = 'idle';
  private connection: NativeUserSocket | undefined;
  private started = false;
  private ready = false;
  private rpc: UpstreamRpcClient | undefined;
  private nativeId: string | undefined;
  private settings: ResolvedTalkSettings = resolveTalkSettings();
  private listening = false;
  private outputTurn = '';
  private reply = '';
  private audioStarted = false;
  private replayChunks: Buffer[] = [];
  private replayBytes = 0;
  private readonly marks = new Set<string>();
  private audioInFlight = 0;
  private readonly earlyEvents: Record<string, unknown>[] = [];
  private readonly archiveEntries: VoiceArchiveEntry[] = [];
  private readonly archivedTranscripts = new Set<string>();
  private archiveChars = 0;
  private archiveTruncated = false;
  private draining = false;
  private nativeEnded = false;
  private finalization: Promise<void> | undefined;
  constructor(private readonly options: NativeTalkOptions) {}

  get boundNativeSessionId(): string | undefined { return this.nativeId; }
  get archive(): { entries: VoiceArchiveEntry[]; truncated: boolean } {
    return { entries: this.archiveEntries.map(entry => ({ ...entry })), truncated: this.archiveTruncated };
  }
  private safeError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replaceAll(this.options.voiceGrant, '[redacted]');
  }
  private isClosed(): boolean { return this.currentState === 'closed'; }
  private get continuousOutput(): boolean { return this.options.provider === OPENAI_NATIVE_PROVIDER; }
  private async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.rpc) throw new Error('Native voice is not connected');
    const response = await this.rpc.call<T>(method, params);
    if (!response.ok) throw new NativeRpcError(response.reason, response.error?.code);
    return response.result;
  }
  private state(state: Exclude<NativeTalkSession['currentState'], 'closed'>): void {
    this.currentState = state;
    this.options.send({ type: 'state', state, ...(this.outputTurn ? { turnId: this.outputTurn } : {}) });
  }
  private fail(error: unknown, drain = false): void {
    if (this.isClosed()) return;
    this.archiveTruncated = true;
    this.options.log('native voice transport failed', { error: this.safeError(error) });
    this.options.send({ type: 'error', code: 'internal', message: this.safeError(error), recoverable: false });
    if (drain) void this.finalize();
    else this.close();
  }
  private readonly onMessage = (data: WebSocket.RawData) => {
    if (this.isClosed() && !this.draining) return;
    try {
      const frame = nativeEventFrame(JSON.parse(data.toString()));
      if (!frame) return;
      if (this.isClosed() && frame.event !== 'talk.event') return;
      if (frame.event === 'ui.command') { this.forwardUiCommand(nativeRecord(frame.payload)); return; }
      if (frame.event !== 'talk.event') return;
      const event = nativeTalkPayload(frame.payload);
      if (!this.nativeId) {
        if (this.earlyEvents.length >= 100) throw new Error('Native voice startup event limit exceeded');
        this.earlyEvents.push(event); return;
      }
      this.handleNativeEvent(event);
    } catch (error) {
      this.fail(error instanceof SyntaxError ? new Error('Native voice sent a malformed frame') : error);
    }
  };
  private forwardUiCommand(payload: Record<string, unknown>): void {
    if (parseAgentId(this.options.conversation.agentId).kind !== 'coach') { this.options.log('project voice cannot control workspace surfaces'); return; }
    if (!this.nativeId) { this.options.log('native voice UI command rejected before grant binding'); return; }
    const target = this.options.conversation;
    const command = nativeRecord(payload.command);
    const commandSessionKey = command.sessionKey;
    const explicitScope = payload.sessionKey === target.sessionKey || commandSessionKey === target.sessionKey;
    const boundScope = (payload.agentId === undefined || payload.agentId === target.agentId) &&
      (payload.sessionKey === undefined || payload.sessionKey === target.sessionKey) &&
      (commandSessionKey === undefined || commandSessionKey === target.sessionKey);
    if (!explicitScope || !boundScope) {
      this.options.log('native voice UI command rejected outside bound conversation');
      return;
    }
    this.options.send({ type: 'ui.command', payload });
  }
  private receiveTranscript(event: Record<string, unknown>): void {
    if (typeof event.text !== 'string') return;
    if (event.final) this.recordFinalSpeech(event);
    if (event.role === 'user') {
      this.options.send({ type: event.final ? 'transcript.final' : 'transcript.delta', turnId: this.outputTurn, text: event.text, ...(event.final ? { reason: 'endpoint' as const } : {}) } as TalkServerEvent);
      if (event.final && !this.continuousOutput) this.state('thinking');
    } else if (event.role === 'assistant') {
      this.reply = event.textMode === 'snapshot' ? event.text : this.reply + event.text;
      this.options.send({ type: 'reply.final', turnId: this.outputTurn, text: this.reply });
    }
  }
  private recordFinalSpeech(event: Record<string, unknown>): void {
    const { text, transcriptId, role } = event;
    if (typeof text !== 'string' || !text.trim() || (role !== 'user' && role !== 'assistant')) return;
    if (typeof transcriptId !== 'string' || transcriptId.length > VOICE_ARCHIVE_TRANSCRIPT_ID_MAX || !/^[A-Za-z0-9:_-]+$/u.test(transcriptId)) {
      this.archiveTruncated = true;
      this.options.log('native voice archive omitted speech without a valid transcript identity');
      return;
    }
    if (this.archivedTranscripts.has(transcriptId)) return;
    const available = Math.min(VOICE_ARCHIVE_ENTRY_TEXT_MAX, VOICE_ARCHIVE_TEXT_MAX - this.archiveChars);
    if (this.archiveEntries.length >= VOICE_ARCHIVE_ENTRIES_MAX || available <= 0) { this.archiveTruncated = true; return; }
    let compact = text.slice(0, available);
    if (/[\uD800-\uDBFF]$/u.test(compact)) compact = compact.slice(0, -1);
    this.archiveTruncated ||= compact.length !== text.length;
    if (!compact.trim()) return;
    this.archivedTranscripts.add(transcriptId);
    this.archiveEntries.push({ transcriptId, role, text: compact });
    this.archiveChars += compact.length;
  }
  private receiveAudio(event: Record<string, unknown>): void {
    if (typeof event.audioBase64 !== 'string') return;
    if (!this.audioStarted) {
      this.audioStarted = true;
      if (!this.continuousOutput) this.state('speaking');
      this.options.send({ type: 'audio.start', turnId: this.outputTurn, sampleRate: TALK_OUTPUT_SAMPLE_RATE });
    }
    const audio = Buffer.from(event.audioBase64, 'base64');
    if (this.replayBytes + audio.length <= 16 * 1024 * 1024) { this.replayChunks.push(audio); this.replayBytes += audio.length; }
    else { this.replayChunks = []; this.replayBytes = 16 * 1024 * 1024 + 1; }
    this.options.sendAudio(audio);
  }
  private selectOutputTurn(event: Record<string, unknown>): void {
    const talk = event.talkEvent as { turnId?: string } | undefined;
    if (talk?.turnId && talk.turnId !== this.outputTurn) {
      this.outputTurn = talk.turnId; this.audioStarted = false; this.reply = ''; this.replayChunks = []; this.replayBytes = 0;
    }
    this.outputTurn ||= this.nativeId!;
  }
  private handleNativeEvent(event: Record<string, unknown>): void {
    if (event.relaySessionId !== this.nativeId) return;
    if (this.isClosed()) {
      // Native publishes finalized GPT-Live speech during graceful close.
      // Drain only this call's final text, never audio, UI commands or control.
      this.drainFinalSpeech(event);
      return;
    }
    this.selectOutputTurn(event);
    switch (event.type) {
      case 'ready': this.publishReady(); break;
      case 'responseStarted': if (!this.continuousOutput) this.state('thinking'); break;
      case 'transcript': this.receiveTranscript(event); break;
      case 'audio': this.receiveAudio(event); break;
      case 'audioDone': this.options.send({ type: 'audio.end', turnId: this.outputTurn, cancelled: false }); break;
      case 'clear':
        this.marks.clear(); this.audioStarted = false;
        this.options.send({ type: 'audio.end', turnId: this.outputTurn, cancelled: true });
        this.state(this.listening ? 'listening' : 'idle'); break;
      case 'mark':
        if (typeof event.markName !== 'string') return;
        this.marks.add(event.markName); this.options.send({ type: 'audio.mark', name: event.markName }); break;
      case 'error':
      case 'close': this.receiveTerminalEvent(event); break;
    }
  }
  private drainFinalSpeech(event: Record<string, unknown>): void {
    if (this.draining && event.type === 'transcript' && event.final === true) this.recordFinalSpeech(event);
  }
  private receiveTerminalEvent(event: Record<string, unknown>): void {
    if (event.type === 'close') {
      this.nativeEnded = true;
      this.options.log('native voice session ended', { reason: event.reason === 'completed' ? 'completed' : 'error', outputCancelled: (event.talkEvent as { payload?: { reason?: string } } | undefined)?.payload?.reason === 'output-cancelled' });
    }
    this.handleUnavailable(this.safeError(event.message ?? 'Native voice session ended'));
  }
  private publishReady(): void {
    this.ready = true;
    const engines = this.options.provider === OPENAI_NATIVE_PROVIDER ? { stt: 'openai:gpt-live-1', tts: 'openai:gpt-live-1' } : { stt: 'native', tts: 'native' };
    this.options.send({ type: 'session.ready', sessionId: this.sessionId, protocol: TALK_PROTOCOL_VERSION, input: { sampleRate: 24000 }, output: { sampleRate: TALK_OUTPUT_SAMPLE_RATE }, engines, capabilities: { speed: false, interrupt: true, bargeIn: true, ...(this.continuousOutput ? { continuousOutput: true } : {}) }, settings: this.settings });
  }
  private handleUnavailable(reason: string): void {
    if (this.isClosed()) return;
    if (this.options.provider === OPENAI_NATIVE_PROVIDER && !this.ready && this.options.onUnavailable) {
      this.close(false);
      this.options.onUnavailable(this.nativeId ?? this.sessionId, reason);
    } else this.fail(new Error(reason), this.ready && Boolean(this.nativeId));
  }
  private async connectNative(): Promise<boolean> {
    const caps = parseAgentId(this.options.conversation.agentId).kind === 'coach' ? ['ui-commands'] : [];
    const connection = await (this.options.open ?? openNativeUserSocket)(this.options.conversation.uid, this.options.conversation.gatewayId, process.env, { caps, purpose: 'voice', channelSessionKey: this.options.conversation.sessionKey, threadRootPostId: this.options.conversation.threadRootPostId });
    if (this.isClosed()) { connection.ws.close(); return false; }
    this.connection = connection;
    this.rpc = (this.options.attachRpc ?? attachUpstreamRpcClient)(connection.ws, { timeoutMs: 15000 });
    connection.ws.on('message', this.onMessage);
    connection.ws.on('close', () => { if (!this.isClosed()) this.fail(new Error('Native voice connection closed')); });
    connection.ws.on('error', (error) => this.fail(error));
    return true;
  }
  private async createNativeSession(): Promise<{ sessionId: string; relaySessionId: string } | null> {
    try {
      return await this.call('talk.session.create', { sessionKey: this.options.conversation.sessionKey, mode: 'realtime', transport: 'gateway-relay', brain: 'agent-consult', provider: this.options.provider ?? 'octogee', voice: this.settings.voice, silenceDurationMs: 700 });
    } catch (error) {
      if (!(error instanceof NativeRpcError) || error.code !== 'UNAVAILABLE' || this.options.provider !== OPENAI_NATIVE_PROVIDER || !this.options.onUnavailable) throw error;
      this.handleUnavailable(this.safeError(error));
      return null;
    }
  }
  private async startSession(message: Extract<TalkClientMessage, { type: 'session.start' }>): Promise<void> {
    if (this.started) throw new Error('Voice session already started');
    this.started = true;
    if (message.mode !== 'converse') throw new Error('Native Talk requires conversation mode');
    if (!/^[A-Za-z0-9_-]{43}$/u.test(this.options.voiceGrant) || this.options.voiceGrantExpiresAt <= Date.now()) throw new Error('Native voice grant is unavailable');
    this.settings = { ...resolveTalkSettings(message.settings), endpointing: 'normal' };
    if (this.options.provider === OPENAI_NATIVE_PROVIDER && !['marin', 'cedar'].includes(this.settings.voice)) this.settings.voice = 'marin';
    await this.options.reauthorize();
    if (!await this.connectNative()) return;
    const created = await this.createNativeSession();
    if (!created) return;
    if (this.isClosed()) return;
    if (typeof created.sessionId !== 'string' || created.sessionId !== created.relaySessionId) throw new Error('Native voice returned an invalid session');
    await this.bindCreatedSession(created.sessionId);
    if (this.isClosed()) return;
    this.nativeId = created.sessionId;
    for (const event of this.earlyEvents.splice(0)) this.handleNativeEvent(event);
  }
  private async bindCreatedSession(sessionId: string): Promise<void> {
    try {
      const bound = await this.options.bindSession(sessionId);
      if (bound.sessionId !== sessionId || bound.sessionKey !== this.options.conversation.sessionKey ||
        typeof bound.expiresAt !== 'number' || !Number.isFinite(bound.expiresAt) ||
        bound.expiresAt <= Date.now() || bound.expiresAt > this.options.voiceGrantExpiresAt) {
        throw new Error('Native voice grant binding does not match');
      }
    } catch {
      const error = new Error('Native voice grant binding failed');
      this.fail(error);
      throw error;
    }
  }
  private async interruptAgent(requestId: string): Promise<void> {
    const wasAwaitingRun = this.currentState === 'thinking';
    this.options.send({ type: 'agent.interrupting', requestId });
    try {
      await this.options.reauthorize();
      const result = await this.call('talk.session.steer', { sessionId: this.nativeId, sessionKey: this.options.conversation.sessionKey, text: 'Stop', mode: 'cancel' });
      if (result.reason === 'no_active_run' && wasAwaitingRun) throw new Error('The native agent has not confirmed an active run yet. Try interrupting again.');
      if (result.sessionKey !== this.options.conversation.sessionKey || (!result.aborted && result.reason !== 'no_active_run')) throw new Error(typeof result.message === 'string' ? result.message : 'Native agent did not confirm interruption');
      this.options.send({ type: 'agent.interrupted', requestId, status: result.aborted ? 'aborted' : 'no-active-run' });
    } catch (error) { this.options.send({ type: 'agent.interrupted', requestId, status: 'failed', message: this.safeError(error) }); }
  }
  private updateSettings(settings: Extract<TalkClientMessage, { type: 'settings.update' }>['settings']): void {
    const next = resolveTalkSettings(this.settings, settings);
    if (next.voice !== this.settings.voice || next.endpointing !== this.settings.endpointing) {
      this.options.send({ type: 'error', code: 'internal', message: 'End voice and reconnect to apply the new voice or listening pace.', recoverable: true });
    }
    this.settings = { ...next, voice: this.settings.voice, endpointing: this.settings.endpointing };
    this.options.send({ type: 'settings', settings: this.settings });
  }
  private replay(): void {
    if (this.replayChunks.length) {
      this.state('speaking');
      this.options.send({ type: 'audio.start', turnId: this.outputTurn, sampleRate: TALK_OUTPUT_SAMPLE_RATE });
      for (const audio of this.replayChunks) { this.options.sendAudio(audio); }
      this.options.send({ type: 'audio.end', turnId: this.outputTurn, cancelled: false });
    } else this.options.send({ type: 'error', code: 'internal', message: 'There is no complete recent audio to replay.', recoverable: true });
  }
  private async handleControl(message: TalkClientMessage): Promise<void> {
    switch (message.type) {
      case 'listen.start': this.listening = true; this.state('listening'); break;
      case 'listen.stop': this.listening = false; this.state('idle'); break;
      case 'turn.commit': this.listening = false; this.state('idle'); break;
      case 'speak.cancel':
        if (this.continuousOutput) {
          this.options.send({ type: 'error', code: 'internal', message: 'This voice uses continuous audio. Mute agent audio or speak naturally to continue.', recoverable: true });
          break;
        }
        await this.options.reauthorize(); await this.call('talk.session.cancelOutput', { sessionId: this.nativeId, reason: 'output-cancelled' }); break;
      case 'agent.interrupt': await this.interruptAgent(message.requestId); break;
      case 'playback.mark':
        if (this.marks.delete(message.name)) await this.call('talk.session.acknowledgeMark', { sessionId: this.nativeId, markName: message.name });
        break;
      case 'playback.done': this.audioStarted = false; this.state(this.listening ? 'listening' : 'idle'); break;
      case 'settings.update': this.updateSettings(message.settings); break;
      case 'replay': this.replay(); break;
    }
  }
  async handleText(raw: string): Promise<void> {
    const message = parseTalkClientMessage(raw);
    if (!message) throw new Error('Invalid voice message');
    if (this.currentState === 'closed') return;
    if (message.type === 'session.end') { void this.finalize(); return; }
    if (message.type === 'session.start') { await this.startSession(message); return; }
    if (!this.nativeId) throw new Error('Native voice is still connecting');
    await this.handleControl(message);
  }
  handleAudio(audio: Buffer): void {
    if (!this.nativeId || !this.listening || this.currentState === 'closed') return;
    if (++this.audioInFlight > 64) { this.fail(new Error('Native voice audio connection is too slow')); return; }
    void this.call('talk.session.appendAudio', { sessionId: this.nativeId, audioBase64: audio.toString('base64') }).catch(error => this.fail(error)).finally(() => { this.audioInFlight--; });
  }
  finalize(): Promise<void> {
    if (this.finalization) return this.finalization;
    if (this.isClosed()) return Promise.resolve();
    this.currentState = 'closed'; this.marks.clear();
    this.draining = true;
    this.finalization = Promise.resolve().then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (this.nativeId && !this.nativeEnded) {
          await Promise.race([
            this.call('talk.session.close', { sessionId: this.nativeId, disposition: 'detach' }),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Native voice finalization timed out')), 5_000); }),
          ]);
        }
      } catch (error) {
        this.archiveTruncated = true;
        this.options.log('native voice finalization incomplete', { error: this.safeError(error) });
      } finally {
        clearTimeout(timer);
        this.draining = false;
        this.rpc?.dispose(); this.connection?.ws.off('message', this.onMessage); this.connection?.ws.close();
      }
    });
    this.options.onClose?.();
    return this.finalization;
  }
  close(notify = true): void {
    if (this.currentState === 'closed') return;
    this.currentState = 'closed'; this.marks.clear();
    this.rpc?.dispose(); this.connection?.ws.off('message', this.onMessage); this.connection?.ws.close();
    if (notify) this.options.onClose?.();
  }
}
