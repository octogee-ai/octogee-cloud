import { setTimeout as delay } from "node:timers/promises";
import { internalFetch } from "./internal-fetch.js";

async function consumeAssignmentChanges(body: ReadableStream<Uint8Array>, signal: AbortSignal, wake: () => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const events = pending.split("\n\n");
      pending = events.pop() ?? "";
      if (pending.length > 4096) throw new Error("assignment watch frame exceeded limit");
      if (events.some((event) => event === "data: changed")) wake();
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export function watchFleetAssignments(input: {
  url: string;
  gatewayId: string;
  revisionId: string;
  headers: () => Promise<Record<string, string>>;
  wake: () => void;
  log: (message: string) => void;
}): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  const run = async () => {
    while (!signal.aborted) {
      try {
        const response = await internalFetch(input.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...await input.headers() },
          body: JSON.stringify({ gatewayId: input.gatewayId, revisionId: input.revisionId }),
          signal,
        });
        if (!response.ok || !response.body) throw new Error(`assignment watch returned ${response.status}`);
        await consumeAssignmentChanges(response.body, signal, input.wake);
        if (!signal.aborted) input.log("[fleet] assignment watch ended; reconnecting");
      } catch (error) {
        if (!signal.aborted) input.log(`[fleet] assignment watch failed: ${String(error)}`);
      }
      if (!signal.aborted) await delay(1000, undefined, { signal }).catch(() => undefined);
    }
  };
  void run();
  return () => controller.abort();
}
