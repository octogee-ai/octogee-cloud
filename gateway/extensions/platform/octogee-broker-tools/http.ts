export class BrokerMetadataUnavailable extends Error {
  constructor(readonly reason: "unauthorized" | "unavailable" = "unavailable") {
    super(`Octogee broker metadata ${reason}`);
  }
}

export function brokerOrigin(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new BrokerMetadataUnavailable();
  return url;
}

async function readBoundedBody(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<unknown> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      length += part.value.length;
      if (length > 2 * 1024 * 1024) throw new BrokerMetadataUnavailable();
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export async function readBrokerJson(url: URL, init: RequestInit, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const deadline = AbortSignal.timeout(8_000);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  let response: Response;
  try { response = await fetchImpl(url, { ...init, signal, redirect: "error", cache: "no-store" }); }
  catch (error) {
    if (signal.aborted) throw error;
    throw new BrokerMetadataUnavailable();
  }
  try {
    if (response.status === 401 || response.status === 403) throw new BrokerMetadataUnavailable("unauthorized");
    if (!response.ok || !response.body) throw new BrokerMetadataUnavailable();
    return await readBoundedBody(response.body, signal);
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    if (error instanceof BrokerMetadataUnavailable || signal.aborted) throw error;
    throw new BrokerMetadataUnavailable();
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BrokerMetadataUnavailable();
  return value as Record<string, unknown>;
}
