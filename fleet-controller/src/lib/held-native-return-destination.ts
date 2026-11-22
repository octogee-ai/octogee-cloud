import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { gatewayScopedJobId, signFleetRequest } from "@octogee/core/fleet-signature";
import { SIGNATURE_HEADER } from "@octogee/shared/types/fleet-controller";
import { listSurgePods, type SurgeKubectl } from "../surge-user-handoff-runtime.js";
import type { VerifyHeldNativeReturnCustody } from "./held-native-return-worker.js";

export function createHeldNativeReturnDestinationVerifier(deps: {
  namespace: string;
  privateKey: string;
  runKubectl: SurgeKubectl;
}): VerifyHeldNativeReturnCustody {
  async function readExactPod(gatewayId: string) {
    const { pods, observedPodUids } = await listSurgePods(deps.runKubectl, deps.namespace, gatewayId);
    const [pod] = pods;
    if (observedPodUids.length !== 1 || !pod?.ready || pod.terminating || isIP(pod.podIP) !== 4) {
      throw new Error("Held Native return destination must have exactly one ready pod");
    }
    return pod;
  }

  return async (authority, assertCurrent) => {
    const gatewayId = authority.targetGatewayId;
    await assertCurrent();
    const pod = await readExactPod(gatewayId);
    const expected = { migrationId: authority.schedulerMigrationId, slug: authority.slug, nonce: randomBytes(16).toString("hex") };
    const body = JSON.stringify(expected);
    const response = await fetch(`http://${pod.podIP}:3003/target-import-hold/${encodeURIComponent(gatewayId)}`, {
      method: "POST", body, redirect: "error", signal: AbortSignal.timeout(5_000),
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signFleetRequest(deps.privateKey, gatewayScopedJobId(expected.migrationId, gatewayId), body),
      },
    });
    if (response.status !== 200) throw new Error(`Held Native return destination cannot attest import exclusion (${response.status})`);
    const proof = await response.json() as typeof expected & { held?: boolean };
    if (proof.held !== true || proof.migrationId !== expected.migrationId || proof.slug !== expected.slug || proof.nonce !== expected.nonce) {
      throw new Error("Held Native return destination attestation did not match the live claim");
    }
    const latest = await readExactPod(gatewayId);
    if (latest.uid !== pod.uid || latest.podIP !== pod.podIP) throw new Error("Held Native return destination pod changed");
    await assertCurrent();
  };
}
