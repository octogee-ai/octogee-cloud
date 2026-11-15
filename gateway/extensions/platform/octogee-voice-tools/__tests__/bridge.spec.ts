import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SttStreamEvents, TtsRequest } from '@octogee/core/voice-relay-client';
import type { RealtimeVoiceBridge, RealtimeVoiceBridgeCreateRequest } from 'openclaw/plugin-sdk/realtime-voice';
import { latestTalkback, resetVoiceSdk } from './voice-sdk.js';
vi.mock('openclaw/plugin-sdk/realtime-voice', async () => {
  const { realtimeVoice } = await import('./voice-sdk.js');
  return realtimeVoice;
});
vi.mock('openclaw/plugin-sdk/realtime-voice-provider', async () => {
  const { realtimeVoiceProvider } = await import('./voice-sdk.js');
  return realtimeVoiceProvider;
});
import { createOctogeeVoiceBridge } from '../bridge.js';

const bridges: RealtimeVoiceBridge[] = [];
function setup() {
  const streams: { events: SttStreamEvents; sendAudio: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> }[] = [];
  const relay = {
    openStt: vi.fn((events: SttStreamEvents) => {
      const stream = { events, sendAudio: vi.fn(), end: vi.fn(), abort: vi.fn() };
      streams.push(stream); return stream;
    }),
    tts: vi.fn(async function* (_request: TtsRequest) { yield Buffer.alloc(960); }),
  };
  const request = {
    providerConfig: {}, audioFormat: { encoding: 'pcm16', sampleRateHz: 24000, channels: 1 },
    onAudio: vi.fn(), onClearAudio: vi.fn(), onTranscript: vi.fn(), onEvent: vi.fn(),
    onResponseDone: vi.fn(), onMark: vi.fn(), onReady: vi.fn(), onError: vi.fn(), onClose: vi.fn(),
    runAgentConsult: vi.fn(async () => ({ text: 'Final answer' })),
    handleDelegationInput: vi.fn<() => 'control' | 'consult'>(() => 'consult'),
  } satisfies RealtimeVoiceBridgeCreateRequest;
  const bridge = createOctogeeVoiceBridge(request, { relay, logger: { info: vi.fn(), warn: vi.fn() } });
  bridges.push(bridge);
  return { bridge, request, relay, streams };
}

async function submit(bridge: RealtimeVoiceBridge, question = 'Question') {
  bridge.sendUserMessage?.(question);
  const { options, queue } = latestTalkback();
  expect(queue.enqueue).toHaveBeenLastCalledWith(question);
  const answer = await options.consult({ question, responseStyle: options.responseStyle, signal: new AbortController().signal });
  options.deliver(answer.text);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const bridge of bridges) bridge.close();
  bridges.length = 0;
  resetVoiceSdk();
  vi.useRealTimers();
});

describe('tenant speech provider on native Talk', () => {
  it('sends only final speech to the native consult queue and gives native control first refusal', async () => {
    vi.useFakeTimers();
    const { bridge, request, streams } = setup();
    await bridge.connect();
    bridge.sendAudio(Buffer.alloc(960, 0x10));
    expect(streams).toHaveLength(1);
    streams[0].events.onPartial?.('Open');
    expect(latestTalkback().queue.enqueue).not.toHaveBeenCalled();
    streams[0].events.onFinal?.('Open the news');
    expect(latestTalkback().queue.enqueue).toHaveBeenCalledWith('Open the news');
    request.handleDelegationInput.mockReturnValue('control');
    bridge.sendUserMessage?.('Stop');
    expect(latestTalkback().queue.enqueue).toHaveBeenCalledTimes(1);
    bridge.close();
  });

  it('ends the utterance after silence and aborts unfinished speech on close', async () => {
    vi.useFakeTimers();
    const { bridge, streams } = setup();
    await bridge.connect();
    bridge.sendAudio(Buffer.alloc(960, 0x10));
    await vi.advanceTimersByTimeAsync(700);
    expect(streams[0].end).toHaveBeenCalledOnce();
    bridge.close();
    expect(streams[0].abort).toHaveBeenCalledOnce();
    expect(latestTalkback().queue.close).toHaveBeenCalledOnce();
  });

  it('starts a new utterance after the microphone paused without sending silence frames', async () => {
    vi.useFakeTimers();
    const { bridge, streams } = setup();
    await bridge.connect();
    bridge.sendAudio(Buffer.alloc(960, 0x10));
    await vi.advanceTimersByTimeAsync(700);
    bridge.sendAudio(Buffer.alloc(960, 0x10));
    expect(streams).toHaveLength(2);
    bridge.close();
  });

  it('retires failed transcription before accepting another utterance', async () => {
    vi.useFakeTimers();
    const { bridge, streams, request } = setup();
    await bridge.connect();
    bridge.sendAudio(Buffer.alloc(960, 0x10));
    streams[0].events.onError?.(new Error('transcription unavailable'));
    expect(request.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'transcription unavailable' }));
    bridge.sendAudio(Buffer.alloc(960, 0x10));
    expect(streams).toHaveLength(2);
    expect(streams[0].sendAudio).toHaveBeenCalledTimes(1);
    bridge.close();
  });

  it('ending voice detaches audio without aborting the native agent consult', async () => {
    const { bridge, request } = setup();
    await bridge.connect();
    bridge.close({ disposition: 'detach' });
    expect(latestTalkback().queue.close).not.toHaveBeenCalled();
    expect(latestTalkback().options.isStopped()).toBe(true);
    expect(request.onClose).toHaveBeenCalledWith('completed');
    bridge.sendUserMessage?.('Should not submit');
    expect(latestTalkback().queue.enqueue).not.toHaveBeenCalled();
  });

  it('forwards native consults and serializes delivered final-answer playback', async () => {
    const { bridge, request, relay } = setup();
    await bridge.connect();
    await submit(bridge, 'First question');
    expect(request.runAgentConsult).toHaveBeenCalledExactlyOnceWith({ prompt: 'First question', signal: expect.any(AbortSignal) });
    expect(relay.tts).toHaveBeenCalledExactlyOnceWith({ text: 'Final answer', signal: expect.any(AbortSignal) });
    expect(request.onAudio).toHaveBeenCalledOnce();
    expect(request.onTranscript).toHaveBeenCalledWith('assistant', 'Final answer', true, { textMode: 'snapshot' });
    expect(request.onMark).toHaveBeenCalledOnce();
    expect(request.onResponseDone).not.toHaveBeenCalled();

    await submit(bridge, 'Second question');
    expect(request.runAgentConsult).toHaveBeenCalledTimes(2);
    expect(request.runAgentConsult).toHaveBeenNthCalledWith(2, { prompt: 'Second question', signal: expect.any(AbortSignal) });
    expect(relay.tts).toHaveBeenCalledOnce();
    const [firstName] = request.onMark.mock.calls[0];
    bridge.acknowledgeMark('wrong-response');
    await vi.advanceTimersByTimeAsync(0);
    expect(request.onResponseDone).not.toHaveBeenCalled();
    bridge.acknowledgeMark(firstName);
    await vi.advanceTimersByTimeAsync(0);
    expect(request.onResponseDone).toHaveBeenCalledExactlyOnceWith({ status: 'completed', responseId: firstName });
    expect(relay.tts).toHaveBeenCalledTimes(2);
    const [secondName] = request.onMark.mock.calls[1];
    expect(secondName).not.toBe(firstName);
    bridge.acknowledgeMark(secondName);
    await vi.advanceTimersByTimeAsync(0);
    expect(request.onResponseDone).toHaveBeenNthCalledWith(2, { status: 'completed', responseId: secondName });
    expect(request.onError).not.toHaveBeenCalled();
  });

  it('surfaces synthesis failures and releases speech resources', async () => {
    const { bridge, relay, request } = setup();
    await bridge.connect();
    relay.tts.mockImplementation(async function* () { yield await Promise.reject<Buffer>(new Error('speech relay unavailable')); });
    await submit(bridge);
    expect(request.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'speech relay unavailable' }));
    expect(request.onResponseDone).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'failed' }));
    expect(vi.getTimerCount()).toBe(0);
    bridge.close();
    expect(latestTalkback().queue.close).toHaveBeenCalledOnce();
  });

  it('accepts synchronous transport acknowledgments and makes duplicates inert', async () => {
    const { bridge, request } = setup();
    await bridge.connect();
    request.onMark.mockImplementation((name: string, callback: () => void) => {
      bridge.acknowledgeMark(name);
      callback();
      bridge.acknowledgeMark(name);
    });
    await submit(bridge);
    expect(request.onResponseDone).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'completed' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores unknown, undefined, and completed marks while the next answer waits', async () => {
    const { bridge, request } = setup();
    await bridge.connect();
    await submit(bridge, 'First question');
    const [oldName, oldCallback] = request.onMark.mock.calls[0];
    oldCallback();
    await vi.advanceTimersByTimeAsync(0);
    await submit(bridge, 'Second question');
    expect(request.onMark).toHaveBeenCalledTimes(2);
    bridge.acknowledgeMark();
    bridge.acknowledgeMark('unknown');
    bridge.acknowledgeMark(oldName);
    oldCallback();
    await vi.advanceTimersByTimeAsync(0);
    expect(request.onResponseDone).toHaveBeenCalledOnce();
    bridge.acknowledgeMark(request.onMark.mock.calls[1][0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(request.onResponseDone).toHaveBeenCalledTimes(2);
  });

  it.each(['barge-in', 'close'] as const)('cancels answer playback and removes pending marks on %s', async action => {
    const { bridge, request, relay } = setup();
    await bridge.connect();
    await submit(bridge);
    const [name, callback] = request.onMark.mock.calls[0];
    const signal = relay.tts.mock.calls[0][0].signal!;
    if (action === 'barge-in') bridge.handleBargeIn?.();
    if (action === 'close') bridge.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(true);
    expect(request.onResponseDone).toHaveBeenCalledExactlyOnceWith({ status: 'cancelled', responseId: name });
    bridge.acknowledgeMark(name);
    callback();
    await vi.advanceTimersByTimeAsync(0);
    expect(request.onResponseDone).toHaveBeenCalledOnce();
    expect(request.onClearAudio).toHaveBeenCalledWith('barge-in');
    expect(request.onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes timed out marks and ignores late acknowledgments', async () => {
    const { bridge, request } = setup();
    await bridge.connect();
    await submit(bridge);
    const [name, callback] = request.onMark.mock.calls[0];
    await vi.advanceTimersByTimeAsync(15_020);
    expect(request.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Native voice playback acknowledgment timed out' }));
    expect(request.onResponseDone).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'failed', responseId: name }));
    bridge.acknowledgeMark(name);
    callback();
    await vi.advanceTimersByTimeAsync(0);
    expect(request.onResponseDone).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans the pending mark and timer when mark emission throws', async () => {
    const { bridge, request } = setup();
    await bridge.connect();
    request.onMark.mockImplementation(() => { throw new Error('mark transport failed'); });
    await submit(bridge);
    expect(request.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'mark transport failed' }));
    expect(vi.getTimerCount()).toBe(0);
    bridge.acknowledgeMark(request.onMark.mock.calls[0][0]);
    expect(request.onResponseDone).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'failed' }));
  });

  it.each(['barge-in', 'close'] as const)('cancels playback by %s immediately after synchronous acknowledgment', async action => {
    const { bridge, request } = setup();
    await bridge.connect();
    request.onMark.mockImplementation((name: string) => {
      bridge.acknowledgeMark(name);
      if (action === 'barge-in') bridge.handleBargeIn?.();
      else bridge.close();
    });
    await submit(bridge);
    expect(request.onResponseDone).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'cancelled' }));
    expect(request.onResponseDone).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(vi.getTimerCount()).toBe(0);
  });
});
