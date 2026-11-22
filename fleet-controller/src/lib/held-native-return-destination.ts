import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { gatewayScopedJobId, signFleetRequest } from "@octogee/core/fleet-signature";
import { SIGNATURE_HEADER } from "@octogee/shared/types/fleet-controller";
import { listSurgePods, type SurgeKubectl } from "../surge-user-handoff-runtime.js";
import type { VerifyHeldNativeReturnCustody } from "./held-native-return-worker.js";

type Authority = Pick<Parameters<VerifyHeldNativeReturnCustody>[0], "targetGatewayId" | "schedulerMigrationId" | "slug">;
const loopbackWitness = `
  import { readFileSync } from "node:fs";
  const { path, signature, header, body } = JSON.parse(readFileSync(0, "utf8"));
  if (!path.startsWith("/target-import-hold/")) throw new Error("Unexpected Shared import witness route");
  const response = await fetch("http://127.0.0.1:3003" + path, {
    method: "POST", body, redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/json", connection: "close", [header]: signature },
  });
  process.stdout.write(JSON.stringify({ status: response.status, proof: response.status === 200 ? await response.json() : null }));
`;

export function createHeldNativeReturnDestinationVerifier(deps: {
  namespace: string;
  privateKey: string;
  runKubectl: SurgeKubectl;
  loopbackPodUid?: string;
}): (authority: Authority, assertCurrent: () => Promise<void>) => Promise<void> {
  async function readExactPod(gatewayId: string) {
    const { pods, observedPodUids } = await listSurgePods(deps.runKubectl, deps.namespace, gatewayId);
    const [pod] = pods;
    if (observedPodUids.length !== 1 || !pod?.ready || pod.terminating || isIP(pod.podIP) !== 4 ||
        deps.loopbackPodUid && pod.uid !== deps.loopbackPodUid) {
      throw new Error("Held Native return destination must have exactly one ready pod");
    }
    return pod;
  }

  async function requestWitness(pod: Awaited<ReturnType<typeof readExactPod>>, gatewayId: string, body: string, signature: string) {
    const path = `/target-import-hold/${encodeURIComponent(gatewayId)}`;
    if (deps.loopbackPodUid) {
      const result = await deps.runKubectl([
        "-n", deps.namespace, "exec", "-i", pod.name, "-c", "gateway", "--", "node", "--input-type=module", "-e", loopbackWitness,
      ], { stdin: JSON.stringify({ path, signature, header: SIGNATURE_HEADER, body }), timeoutMs: 10_000 });
      if (result.code !== 0) throw new Error("Cannot observe import exclusion on the retained Shared Pod");
      return JSON.parse(result.stdout) as { status: number; proof: unknown };
    }
    const response = await fetch(`http://${pod.podIP}:3003${path}`, {
      method: "POST", body, redirect: "error", signal: AbortSignal.timeout(5_000),
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature },
    });
    return { status: response.status, proof: response.status === 200 ? await response.json() as unknown : null };
  }

  return async (authority, assertCurrent) => {
    const gatewayId = authority.targetGatewayId;
    await assertCurrent();
    const pod = await readExactPod(gatewayId);
    const expected = { migrationId: authority.schedulerMigrationId, slug: authority.slug, nonce: randomBytes(16).toString("hex") };
    const body = JSON.stringify(expected);
    const signature = signFleetRequest(deps.privateKey, gatewayScopedJobId(expected.migrationId, gatewayId), body);
    const { status, proof: witness } = await requestWitness(pod, gatewayId, body, signature);
    if (status !== 200) throw new Error(`Held Native return destination cannot attest import exclusion (${status})`);
    const proof = witness as (typeof expected & { held?: boolean }) | null;
    if (proof?.held !== true || proof.migrationId !== expected.migrationId || proof.slug !== expected.slug || proof.nonce !== expected.nonce) {
      throw new Error("Held Native return destination attestation did not match the live claim");
    }
    const latest = await readExactPod(gatewayId);
    if (latest.uid !== pod.uid || latest.podIP !== pod.podIP) throw new Error("Held Native return destination pod changed");
    await assertCurrent();
  };
}
