import { describe, expect, it, vi } from 'vitest';
import { createOpenAiVoiceCatalog } from './openai-catalog.js';

describe('OpenAI voice catalog', () => {
  it('lists the supported Live voices without sending a platform key to the client', async () => {
    const fetchImpl = vi.fn();
    const catalog = await createOpenAiVoiceCatalog('platform-secret', fetchImpl).list();
    expect(catalog).toEqual({ configured: true, default: { id: 'marin', name: 'Marin' }, voices: [{ id: 'marin', name: 'Marin' }, { id: 'cedar', name: 'Cedar' }] });
    expect(JSON.stringify(catalog)).not.toContain('platform-secret');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('previews the selected voice with central OpenAI TTS and returns 24 kHz WAV', async () => {
    const pcm = Buffer.from([0, 1, 2, 3]);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(pcm));
    const wav = await createOpenAiVoiceCatalog('platform-secret', fetchImpl).preview({ voice: 'cedar', name: 'Octo' });
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.subarray(44)).toEqual(pcm);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.openai.com/v1/audio/speech', expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer platform-secret' }) }));
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'cedar', response_format: 'pcm' });
  });
  it('rejects unsupported voices before paying for synthesis and surfaces upstream failures', async () => {
    const fetchImpl = vi.fn(async () => new Response('denied', { status: 503 }));
    const catalog = createOpenAiVoiceCatalog('platform-secret', fetchImpl);
    await expect(catalog.preview({ voice: 'en_paul_neutral' })).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(catalog.preview({ voice: 'marin' })).rejects.toThrow();
  });
});
