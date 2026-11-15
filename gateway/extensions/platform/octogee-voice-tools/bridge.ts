import { randomUUID } from 'node:crypto';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import type { SttStream, VoiceRelayClient } from '@octogee/core/voice-relay-client';
import {
  createRealtimeVoiceAgentTalkbackQueue,
  createSpeechThresholdGate,
  readPcm16AudioStats,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCreateRequest,
} from 'openclaw/plugin-sdk/realtime-voice';
import { createStreamingPcmResampler } from 'openclaw/plugin-sdk/realtime-voice-provider';

type Dependencies = { relay: VoiceRelayClient; logger: Pick<OpenClawPluginApi['logger'], 'info' | 'warn'> };
const FRAME_BYTES = 960;
const PREROLL_BYTES = FRAME_BYTES * 10;

function checkPlayback(signal: AbortSignal, current: boolean) {
  signal.throwIfAborted();
  if (!current) throw new DOMException('Voice playback interrupted', 'AbortError');
}

function waitForPlaybackMark({ request, responseId, timeoutMs, signal, assertCurrent, pendingMarks }: {
  request: RealtimeVoiceBridgeCreateRequest;
  responseId: string;
  timeoutMs: number;
  signal: AbortSignal;
  assertCurrent: () => void;
  pendingMarks: Map<string, () => void>;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => settle(new Error('Native voice playback acknowledgment timed out')), timeoutMs);
    const abort = () => settle(new DOMException('Voice playback interrupted', 'AbortError'));
    function settle(error?: Error) {
      if (settled) return;
      settled = true;
      pendingMarks.delete(responseId);
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    }
    const acknowledge = () => {
      if (settled) return;
      try { assertCurrent(); settle(); }
      catch (error) { settle(error instanceof Error ? error : new Error(String(error))); }
    };
    pendingMarks.set(responseId, acknowledge);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { request.onMark!(responseId, acknowledge); }
    catch (error) { settle(error instanceof Error ? error : new Error(String(error))); }
  });
}

export function createOctogeeVoiceBridge(request: RealtimeVoiceBridgeCreateRequest, dependencies: Dependencies): RealtimeVoiceBridge {
  if (request.audioFormat && (request.audioFormat.encoding !== 'pcm16' || request.audioFormat.sampleRateHz !== 24000)) {
    throw new Error('Octogee voice requires native PCM16 24 kHz audio');
  }
  if (!request.runAgentConsult) throw new Error('Octogee voice requires an authenticated native agent consult');
  const pendingMarks = new Map<string, () => void>();
  let connected = false;
  let closed = false;
  let input: Buffer = Buffer.alloc(0);
  let preroll: Buffer = Buffer.alloc(0);
  let utterance: { stream: SttStream; resampler: ReturnType<typeof createStreamingPcmResampler>; bytes: number } | undefined;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  const streams = new Set<SttStream>();
  const createGate = () => createSpeechThresholdGate({ rmsThreshold: 250, peakThreshold: 1500, speechFrames: 3, silenceFrames: 35 });
  let gate = createGate();
  let speech = Promise.resolve();
  let queuedSpeech = 0;
  let outputGeneration = 0;
  let outputAbort: AbortController | undefined;

  function report(error: unknown) {
    const failure = error instanceof Error ? error : new Error(String(error));
    dependencies.logger.warn(`Octogee voice: ${failure.message}`);
    request.onError?.(failure);
  }
  function clearOutput() {
    outputGeneration++;
    outputAbort?.abort();
    request.onClearAudio('barge-in');
  }
  async function play(text: string, generation: number) {
    const controller = new AbortController();
    const signal = controller.signal;
    const assertCurrent = () => checkPlayback(signal, connected && !closed && generation === outputGeneration);
    assertCurrent();
    if (!request.onMark) throw new Error('Native playback acknowledgments are required for audio responses');
    outputAbort = controller;
    const responseId = randomUUID();
    let audioBytes = 0;
    request.onEvent?.({ direction: 'server', type: 'response.created', responseId });
    request.onTranscript?.('assistant', text, true, { textMode: 'snapshot' });
    try {
      for await (const audio of dependencies.relay.tts({ text, signal, ...(typeof request.providerConfig.voice === 'string' ? { voice: request.providerConfig.voice } : {}) })) {
        assertCurrent();
        audioBytes += audio.length;
        request.onAudio(audio, { itemId: responseId });
      }
      assertCurrent();
      await waitForPlaybackMark({ request, responseId, timeoutMs: audioBytes / 48 + 15_000, signal, assertCurrent, pendingMarks });
      assertCurrent();
      request.onResponseDone?.({ status: 'completed', responseId });
    } catch (error) {
      request.onResponseDone?.(signal.aborted || generation !== outputGeneration
        ? { status: 'cancelled', responseId }
        : { status: 'failed', responseId, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      if (outputAbort === controller) outputAbort = undefined;
    }
  }
  function speakReply(text: string): void {
    if (!text.trim() || closed) return;
    if (text.length > 16_000 || queuedSpeech >= 8) {
      report(new Error('Voice response exceeds the bounded speech queue'));
      return;
    }
    const generation = outputGeneration;
    queuedSpeech++;
    const next = speech.then(() => play(text, generation));
    speech = next.then(() => {}, () => {}).finally(() => { queuedSpeech--; });
    void next.catch(error => {
      if (!(error instanceof Error && error.name === 'AbortError')) report(error);
    });
  }
  const talkback = createRealtimeVoiceAgentTalkbackQueue({
    debounceMs: 200, isStopped: () => closed, logger: dependencies.logger,
    logPrefix: 'Octogee Talk', responseStyle: 'Speak naturally and concisely.', fallbackText: '',
    consult: async ({ question, signal }) => {
      try { return await request.runAgentConsult!({ prompt: question, signal }); }
      catch (error) {
        if (!signal.aborted) report(error);
        throw error;
      }
    },
    deliver: speakReply,
  });
  function acceptText(text: string, fromMicrophone: boolean) {
    const trimmed = text.trim();
    if (!trimmed || !connected || closed) return;
    if (fromMicrophone) request.onTranscript?.('user', trimmed, true, { textMode: 'snapshot' });
    if (request.handleDelegationInput?.(trimmed, speakReply) !== 'control') talkback.enqueue(trimmed);
  }
  function releaseUtterance(stream: SttStream) {
    if (utterance?.stream !== stream) return;
    utterance = undefined;
    clearTimeout(silenceTimer);
    silenceTimer = undefined;
    gate = createGate();
    preroll = Buffer.alloc(0);
  }
  function endUtterance() {
    const current = utterance;
    if (!current) return;
    releaseUtterance(current.stream);
    const tail = current.resampler.flush();
    if (tail.length) current.stream.sendAudio(tail);
    current.stream.end();
  }
  function beginUtterance() {
    if (streams.size >= 4) { report(new Error('Speech transcription is not keeping up with microphone input')); return; }
    const stream: SttStream = dependencies.relay.openStt({
      onPartial: text => { if (!closed) request.onTranscript?.('user', text, false, { textMode: 'snapshot' }); },
      onFinal: text => {
        streams.delete(stream);
        releaseUtterance(stream);
        acceptText(text, true);
      },
      onError: error => {
        streams.delete(stream);
        releaseUtterance(stream);
        if (!closed) report(error);
      },
    });
    streams.add(stream);
    utterance = { stream, resampler: createStreamingPcmResampler(24_000, 16_000), bytes: preroll.length };
    const audio = utterance.resampler.process(preroll);
    if (audio.length) stream.sendAudio(audio);
  }
  return {
    outputAudioMode: 'response', handlesInputAudioBargeIn: true, supportsToolResultSuppression: true,
    async connect() {
      if (closed) throw new Error('Voice session is closed');
      connected = true;
      request.onReady?.();
    },
    isConnected: () => connected && !closed,
    setMediaTimestamp() {},
    sendAudio(audio) {
      if (!connected || closed) return;
      input = Buffer.concat([input, audio]);
      while (input.length >= FRAME_BYTES) {
        const frame = input.subarray(0, FRAME_BYTES);
        input = input.subarray(FRAME_BYTES);
        preroll = Buffer.concat([preroll, frame]).subarray(-PREROLL_BYTES);
        const stats = readPcm16AudioStats(frame);
        const onset = gate.accept(stats);
        const wasActive = Boolean(utterance);
        if (!utterance && onset) {
          if (request.interruptResponseOnInputAudio !== false) clearOutput();
          beginUtterance();
        }
        if (!utterance) continue;
        if (wasActive) {
          const converted = utterance.resampler.process(frame);
          if (converted.length) utterance.stream.sendAudio(converted);
          utterance.bytes += frame.length;
        }
        if (stats.rms >= 250 || stats.peak >= 1500 || !silenceTimer) {
          clearTimeout(silenceTimer);
          silenceTimer = setTimeout(endUtterance, 700);
        }
        if (utterance.bytes >= 48_000 * 45) endUtterance();
      }
    },
    sendUserMessage: text => acceptText(text, false),
    handleBargeIn: clearOutput,
    acknowledgeMark(markName) {
      if (markName !== undefined) pendingMarks.get(markName)?.();
    },
    submitToolResult(_callId, _result, options) {
      if (!options?.suppressResponse) throw new Error('Octogee speech provider receives agent answers through native consult delivery');
    },
    close(options) {
      if (closed) return;
      closed = true;
      connected = false;
      clearTimeout(silenceTimer);
      if (options?.disposition !== 'detach') talkback.close();
      for (const stream of streams) stream.abort();
      streams.clear();
      utterance = undefined;
      input = Buffer.alloc(0);
      preroll = Buffer.alloc(0);
      clearOutput();
      request.onClose?.('completed');
    },
  };
}
