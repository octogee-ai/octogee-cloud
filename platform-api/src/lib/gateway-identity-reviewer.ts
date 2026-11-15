import {
  createGceIdentityReviewer,
  createIssuerDispatchingReviewer,
  parseGatewayVmIdentity,
} from "./gce-identity-review.js";
import {
  createKubernetesTokenReviewer,
  TENANT_BINDING_AUDIENCE,
  type KubernetesTokenReviewerOptions,
  type Reviewer,
} from "./token-review.js";

export function createGatewayIdentityReviewer(
  kubernetes: KubernetesTokenReviewerOptions,
  input: { namespace: string; env?: Record<string, string | undefined> },
): Reviewer {
  const k8s = createKubernetesTokenReviewer(kubernetes);
  const vm = parseGatewayVmIdentity(input.env ?? process.env);
  if (!vm) return k8s;
  return createIssuerDispatchingReviewer({
    kubernetes: k8s,
    gce: createGceIdentityReviewer({
      ...vm,
      audience: kubernetes.audience ?? TENANT_BINDING_AUDIENCE,
      namespace: input.namespace,
    }),
  });
}
