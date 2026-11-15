import { isolatedGatewayServiceAccountName } from "@octogee/shared/types/glm";

// A minimal authed-requester seam over the IAM v1 REST API. Production wires
// this to a google-auth-library client (ADC via the pod's Workload Identity);
// tests inject a fake. We deliberately avoid bundling gcloud or the full
// googleapis client — the gateway image is already large and image-pull
// latency is a live cost (see SPOT-GATEWAY-BLUEGREEN-SPEC D10).
export interface IamRequest {
  (opts: { url: string; method: string }): Promise<{ status: number }>;
}

export function isolatedGatewayServiceAccountEmail(gatewayId: string, projectId: string): string {
  return `${isolatedGatewayServiceAccountName(gatewayId)}@${projectId}.iam.gserviceaccount.com`;
}

export function gatewaysHaveGoogleServiceAccounts(workloadIdentityProject: string | undefined): boolean {
  return workloadIdentityProject?.trim() !== "none";
}

function statusOf(err: unknown): number | undefined {
  const e = err as { response?: { status?: number }; code?: number } | null;
  return e?.response?.status ?? e?.code;
}

// Best-effort, idempotent teardown of a gateway's optional per-gateway GSA.
// Deleting the service account also removes its own IAM policy — i.e. the
// KSA↔GSA Workload-Identity binding — so a single DELETE covers both. A 404
// (no GSA for this gateway: a cattle gateway, or one never granted a GSA) is a
// clean no-op. Project-level role bindings granted TO the GSA are NOT stripped
// here — that would require project setIamPolicy, too broad a grant for the
// control plane; future user GSAs should use resource-scoped roles so
// nothing is left behind. Terraform-managed GSAs are decommissioned
// via terraform, not this path.
export function createGatewayServiceAccountTeardown(deps: {
  request: IamRequest;
  projectId: string;
  log: (msg: string) => void;
}): (gatewayId: string) => Promise<void> {
  return async (gatewayId: string): Promise<void> => {
    const email = isolatedGatewayServiceAccountEmail(gatewayId, deps.projectId);
    const url = `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}`;
    try {
      await deps.request({ url, method: "DELETE" });
      deps.log(`[gsa-teardown] deleted GSA ${email} (and its Workload-Identity binding)`);
    } catch (err) {
      if (statusOf(err) === 404) {
        deps.log(`[gsa-teardown] no GSA ${email} — no-op (idempotent)`);
        return;
      }
      throw err;
    }
  };
}
