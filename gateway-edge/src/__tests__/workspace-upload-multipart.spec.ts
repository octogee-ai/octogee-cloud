import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';

// upload.ts pulls in lib/db (firebase admin) transitively; mock it so the
// module imports without initializing Firebase. parseMultipart itself touches
// none of it.
vi.mock('../lib/db', () => ({
  db: {},
  auth: {},
  FieldValue: { serverTimestamp: () => null, delete: () => null },
}));

import { parseMultipart } from '../routes/workspace/upload.js';

const BOUNDARY = 'TESTBOUNDARY';

function multipartBody(fileBytes: number): Buffer {
  const head = Buffer.from(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="slug"\r\n\r\n` +
      `alice\r\n` +
      `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="path"\r\n\r\n` +
      `assets/x.bin\r\n` +
      `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="x.bin"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    'utf8',
  );
  const file = Buffer.alloc(fileBytes, 0x41);
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8');
  return Buffer.concat([head, file, tail]);
}

function fakeReq(body: Buffer): Request {
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    rawBody: body,
  } as unknown as Request;
}

describe('parseMultipart — bounded upload size (no unbounded in-memory buffering)', () => {
  it('rejects a file that exceeds the byte limit', async () => {
    const req = fakeReq(multipartBody(200));
    await expect(parseMultipart(req, 50)).rejects.toThrow(/too large/i);
  });

  it('accepts a file within the limit', async () => {
    const req = fakeReq(multipartBody(20));
    const parsed = await parseMultipart(req, 50);
    expect(parsed.slug).toBe('alice');
    expect(parsed.path).toBe('assets/x.bin');
    expect(parsed.fileBuffer.length).toBe(20);
  });
});
