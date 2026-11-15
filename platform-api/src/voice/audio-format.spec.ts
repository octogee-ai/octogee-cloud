import { describe, expect, it } from "vitest";
import {
  Int16Resampler,
  WavParseError,
  WavStreamParser,
  bufferToInt16,
  decodePcmToMonoInt16,
  encodeWav,
  int16ToBuffer,
} from "./audio-format.js";

function wavWithChunks(opts: {
  sampleRate?: number;
  channels?: number;
  format?: 1 | 3;
  bits?: 16 | 32;
  dataSize?: number;
  extraChunk?: boolean;
  samples: Buffer;
}): Buffer {
  const { sampleRate = 24_000, channels = 1, format = 1, bits = 16, samples } = opts;
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(format, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * channels * (bits / 8), 8);
  fmt.writeUInt16LE(channels * (bits / 8), 12);
  fmt.writeUInt16LE(bits, 14);
  const parts: Buffer[] = [];
  parts.push(Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"));
  parts.push(Buffer.from("fmt "), u32(fmt.length), fmt);
  if (opts.extraChunk) {
    const list = Buffer.from("INFOsoftware");
    parts.push(Buffer.from("LIST"), u32(list.length), list);
  }
  parts.push(Buffer.from("data"), u32(opts.dataSize ?? samples.length), samples);
  return Buffer.concat(parts);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

describe("WavStreamParser", () => {
  it("parses a header split across reads and returns whole-frame sample bytes", () => {
    const samples = int16ToBuffer(Int16Array.from([1, -2, 3, -4, 5]));
    const wav = wavWithChunks({ samples, dataSize: 0xffffffff, extraChunk: true });
    const parser = new WavStreamParser();
    const out: Buffer[] = [];
    for (let i = 0; i < wav.length; i += 7) out.push(parser.feed(wav.subarray(i, Math.min(wav.length, i + 7))));
    expect(parser.format).toEqual({ sampleRate: 24_000, channels: 1, encoding: "s16le" });
    const joined = Buffer.concat(out);
    expect(bufferToInt16(joined)).toEqual(Int16Array.from([1, -2, 3, -4, 5]));
  });

  it("holds back a dangling half frame until the next read completes it", () => {
    const samples = int16ToBuffer(Int16Array.from([100, 200]));
    const wav = wavWithChunks({ samples });
    const parser = new WavStreamParser();
    const first = parser.feed(wav.subarray(0, wav.length - 1));
    const second = parser.feed(wav.subarray(wav.length - 1));
    expect(bufferToInt16(Buffer.concat([first, second]))).toEqual(Int16Array.from([100, 200]));
    expect(first.length % 2).toBe(0);
  });

  it("recognizes float32 stereo and rejects unsupported formats", () => {
    const stereo = wavWithChunks({ format: 3, bits: 32, channels: 2, samples: Buffer.alloc(0) });
    const parser = new WavStreamParser();
    parser.feed(stereo);
    expect(parser.format).toEqual({ sampleRate: 24_000, channels: 2, encoding: "f32le" });

    const eightBit = wavWithChunks({ format: 1, bits: 16, samples: Buffer.alloc(0) });
    eightBit.writeUInt16LE(8, 34);
    expect(() => new WavStreamParser().feed(eightBit)).toThrow(WavParseError);
    expect(() => new WavStreamParser().feed(Buffer.from("ID3 not a wav file at all!!"))).toThrow(WavParseError);
  });
});

describe("decodePcmToMonoInt16", () => {
  it("averages channels and clamps float input", () => {
    const stereo = Buffer.alloc(8);
    stereo.writeInt16LE(1000, 0);
    stereo.writeInt16LE(3000, 2);
    stereo.writeInt16LE(-2000, 4);
    stereo.writeInt16LE(-2000, 6);
    expect(decodePcmToMonoInt16(stereo, { sampleRate: 1, channels: 2, encoding: "s16le" }))
      .toEqual(Int16Array.from([2000, -2000]));
    const floats = Buffer.alloc(8);
    floats.writeFloatLE(0.5, 0);
    floats.writeFloatLE(2.0, 4);
    expect(decodePcmToMonoInt16(floats, { sampleRate: 1, channels: 1, encoding: "f32le" }))
      .toEqual(Int16Array.from([16384, 32767]));
  });
});

describe("Int16Resampler", () => {
  it("is a passthrough at equal rates and preserves length ratio otherwise across chunk boundaries", () => {
    expect(new Int16Resampler(24_000, 24_000).process(Int16Array.from([1, 2, 3]))).toEqual(Int16Array.from([1, 2, 3]));
    const r = new Int16Resampler(48_000, 24_000);
    const ramp = Int16Array.from({ length: 480 }, (_, i) => i * 10);
    const a = r.process(ramp.subarray(0, 100));
    const b = r.process(ramp.subarray(100));
    const total = a.length + b.length;
    expect(total).toBeGreaterThanOrEqual(238);
    expect(total).toBeLessThanOrEqual(240);
    const joined = Int16Array.from([...a, ...b]);
    for (let i = 1; i < joined.length; i++) expect(joined[i]).toBeGreaterThanOrEqual(joined[i - 1]);
  });
});

describe("encodeWav", () => {
  it("round-trips through the stream parser", () => {
    const wav = encodeWav(Int16Array.from([7, -7, 42]), 16_000);
    const parser = new WavStreamParser();
    const bytes = parser.feed(wav);
    expect(parser.format).toEqual({ sampleRate: 16_000, channels: 1, encoding: "s16le" });
    expect(bufferToInt16(bytes)).toEqual(Int16Array.from([7, -7, 42]));
  });
});
