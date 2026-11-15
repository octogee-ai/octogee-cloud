import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { brokerPost } from "../../lib/vm-gateway-agent/broker";
import { createMetadataClient } from "../../lib/vm-gateway-agent/metadata";
import { checkpointHome } from "../../lib/vm-gateway-agent/home-checkpoint";

const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
afterEach(() => vi.restoreAllMocks());

it("aborts an unresponsive broker so a checkpoint handoff can resume polling controller intent", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(30));
  try {
    const fetchImpl: typeof fetch = async (input, init) => {
      if (!init?.signal) throw new Error("unbounded broker request");
      return fetch(input, init);
    };
    await expect(brokerPost({ gatewayId: "b-x", apiUrl: `http://127.0.0.1:${address.port}`, metadata: { identityToken: async () => "fixture" }, fetchImpl }, "vm-runtime", {})).rejects.toMatchObject({ name: "TimeoutError" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 1_000);

it("gives metadata and signed checkpoint uploads their own finite deadlines", async () => {
  const abortingFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (!init?.signal) throw new Error("unbounded fetch");
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
  }) as typeof fetch;
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(10));
  await expect(createMetadataClient(abortingFetch).accessToken()).rejects.toMatchObject({ name: "TimeoutError" });
  const fs = { exists: async (path: string) => path === "/tmp/.home-checkpoint/snapshot/desktop-home", mkdtemp: async () => "/tmp/archive", fileSize: async () => 1, sha256: async () => "a".repeat(64), uploadBody: async () => "x", rm: async () => {} };
  const fetchImpl: typeof fetch = async (url, init) => String(url).endsWith("/checkpoint-url")
    ? Response.json({ name: "20260905T101500Z.tar.gz", upload: { url: "https://storage.invalid/upload", method: "PUT" } })
    : abortingFetch(url, init);
  await expect(checkpointHome({ gatewayId: "b-x", apiUrl: "https://api.invalid", metadata: { identityToken: async () => "fixture" }, stateRoot: "/tmp", fs, fetchImpl, now: Date.now, log: vi.fn(), logError: vi.fn(), snapshot: async (work: () => Promise<void>) => work(), captureSnapshot: async () => {}, discardSnapshot: async () => {}, shell: { run: async () => ({ code: 0, stdout: "", stderr: "" }) } } as never,
    { slug: "bob", dataDir: "/tmp/data", desktopDir: "/tmp/desktop", marker: "/tmp/marker", restorePending: "/tmp/pending" }, { force: true })).rejects.toMatchObject({ name: "TimeoutError" });
  expect(abortingFetch).toHaveBeenLastCalledWith("https://storage.invalid/upload", expect.objectContaining({ method: "PUT", signal: expect.any(AbortSignal) }));
  expect(AbortSignal.timeout).toHaveBeenCalledWith(10 * 60_000);
});
