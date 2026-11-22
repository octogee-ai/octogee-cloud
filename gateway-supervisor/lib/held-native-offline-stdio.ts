import { verifyOfflineNativeRequest, type OfflineNativeRequest } from "@octogee/core/held-native-offline-protocol";
import { createHeldNativeOfflineWorkspaceActor } from "./held-native-offline-workspace.js";

type ActorOptions = Parameters<typeof createHeldNativeOfflineWorkspaceActor>[0];
type RequestInput = { raw: string; signature: string };

export interface HeldNativeOfflineStdioOptions extends Omit<ActorOptions, "expected" | "assertCurrent" | "compose"> {
  expected: Omit<ActorOptions["expected"], "claimStartedAt">;
  earliestClaimStartedAt: number;
  prepareProjection(request: OfflineNativeRequest): Promise<ActorOptions["compose"]>;
}

export async function readHeldNativeStdioEnvelope(input: AsyncIterable<Uint8Array | string>): Promise<RequestInput> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 24_576) throw new Error("Held Native stdio envelope is too large");
    chunks.push(buffer);
  }
  const signed = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as RequestInput | null;
  if (!signed || typeof signed.raw !== "string" || Buffer.byteLength(signed.raw) > 8192 ||
      typeof signed.signature !== "string" || !/^[a-zA-Z0-9_-]{86}$/.test(signed.signature)) {
    throw new Error("Held Native stdio envelope is malformed");
  }
  return { raw: signed.raw, signature: signed.signature };
}

export async function runHeldNativeOfflineStdio(
  options: HeldNativeOfflineStdioOptions, input: AsyncIterable<Uint8Array | string>,
): Promise<RequestInput> {
  const signed = await readHeldNativeStdioEnvelope(input);
  const { earliestClaimStartedAt, prepareProjection, ...runtime } = options;
  const now = runtime.now ?? Date.now;
  const { identity } = JSON.parse(signed.raw) as { identity?: { claimStartedAt?: unknown } };
  const claimStartedAt = identity?.claimStartedAt;
  if (typeof claimStartedAt !== "number" || !Number.isSafeInteger(claimStartedAt) ||
      claimStartedAt < earliestClaimStartedAt || claimStartedAt > now()) {
    throw new Error("Held Native stdio request has no enrolled claim");
  }
  const expected = { ...runtime.expected, claimStartedAt };
  const request = verifyOfflineNativeRequest({ ...signed, expected, fleetPublicKey: runtime.fleetPublicKey, now: now() });
  await runtime.workspace.assertIsolatedRuntime();
  await runtime.workspace.assertReadOnlyOriginal();
  const compose: ActorOptions["compose"] = request.action === "reconcile"
    ? await prepareProjection(request)
    : () => { throw new Error("Held Native rollback cannot compose desired config"); };
  return createHeldNativeOfflineWorkspaceActor({
    ...runtime,
    expected, compose,
    async assertCurrent(request) {
      if (request.identity.claimStartedAt !== claimStartedAt || request.expiresAt <= now()) {
        throw new Error("Held Native local staged claim expired");
      }
    },
  })(signed);
}
