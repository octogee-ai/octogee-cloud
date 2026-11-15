const GENERATED_POD_SUFFIX = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/u;

// Under the simple-roll model a gateway's single stable-name Deployment
// generates pods named octogee-gateway-<id>-<rs>-<pod>; the pod's revision
// identity IS the bare gateway id (GATEWAY-SIMPLE-ROLL-SPEC).
export function revisionIdFromGatewayPodName(
  gatewayId: string,
  podName: string | undefined,
): string | null {
  if (!podName) return null;
  const prefix = `octogee-gateway-${gatewayId}-`;
  if (!podName.startsWith(prefix)) return null;
  const suffix = podName.slice(prefix.length);
  if (!GENERATED_POD_SUFFIX.test(suffix)) return null;
  return gatewayId;
}
