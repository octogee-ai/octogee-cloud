import { isDeepStrictEqual } from "node:util";
type Labels = Record<string, string>;
type Selector = {
  matchLabels?: Labels;
  matchExpressions?: { key: string; operator: string; values?: string[] }[];
};
type Port = { protocol?: string; port?: number | string; endPort?: number };
type Peer = {
  ipBlock?: { cidr: string; except?: string[] };
  podSelector?: Selector;
  namespaceSelector?: Selector;
};
type Rule = { from?: Peer[]; ports?: Port[] };
interface PolicySpec {
  podSelector: Selector;
  policyTypes?: string[];
  ingress?: Rule[];
  egress?: unknown[];
}
export interface ObservedNetworkPolicy {
  metadata: { name: string; namespace: string; uid: string; resourceVersion: string };
  spec: PolicySpec;
}
export interface SharedIngressScope {
  namespace: string;
  gatewayId: string;
  policyUid: string;
  labels: Labels;
}
type Saved = {
  uid: string;
  namespace: string;
  name: string;
  original: PolicySpec;
  held: PolicySpec;
};
function ensure(value: unknown, msg: string): asserts value {
  if (!value) throw new Error("Shared maintenance ingress " + msg);
}
function applies(selector: Selector, labels: Labels) {
  const { matchLabels = {}, matchExpressions = [] } = selector;
  return (
    Object.entries(matchLabels).every(([key, value]) => labels[key] === value) &&
    matchExpressions.every(({ key, operator, values = [] }) => {
      switch (operator) {
        case "Exists":
          return key in labels;
        case "DoesNotExist":
          return !(key in labels);
        case "In":
          return values.includes(labels[key]);
        case "NotIn":
          return !values.includes(labels[key]);
        default:
          throw new Error("Unsupported network policy selector");
      }
    })
  );
}
function protectedPorts(rule: Rule): number[] {
  ensure(rule.ports?.length, "requires explicit ports on every selected ingress rule");
  return rule.ports.flatMap((p) => {
    if (p.protocol && p.protocol !== "TCP") return [];
    ensure(
      typeof p.port === "number" &&
        Number.isInteger(p.port) &&
        p.port >= 1 &&
        p.port <= 65535 &&
        !p.endPort,
      "requires finite numeric TCP ports",
    );
    return [p.port].filter((n) => n === 3003 || n === 30873);
  });
}
function intendedPeer(rule: Rule, app: string) {
  return isDeepStrictEqual(rule.from, [{ podSelector: { matchLabels: { app } } }]);
}
function tracked(policies: ObservedNetworkPolicy[], scope: SharedIngressScope) {
  ensure(
    scope.labels.app === "octogee-gateway" && scope.labels["gateway-instance"] === scope.gatewayId,
    "requires the observed labels on the exact member",
  );
  const selected = policies.filter(
    (p) =>
      p.metadata.namespace === scope.namespace &&
      applies(p.spec.podSelector, scope.labels) &&
      (!p.spec.policyTypes || p.spec.policyTypes.includes("Ingress")),
  );
  const [member, ...other] = selected.filter((p) => p.metadata.uid === scope.policyUid);
  ensure(
    member &&
      !other.length &&
      member.metadata.name === "octogee-gateway-ingress-" + scope.gatewayId,
    "member policy identity changed",
  );
  ensure(
    isDeepStrictEqual(member.spec.podSelector, {
      matchLabels: { app: "octogee-gateway", "gateway-instance": scope.gatewayId },
    }),
    "member policy selector changed",
  );
  for (const policy of selected.filter((p) => p !== member)) {
    for (const rule of policy.spec.ingress ?? []) {
      const control = protectedPorts(rule);
      if (!control.length) continue;
      ensure(
        policy.metadata.name === "gateway-vm-migration-ingress" &&
          isDeepStrictEqual(control, [30873]) &&
          rule.from?.length === 1 &&
          Object.keys(rule.from[0]!).length === 1 &&
          typeof rule.from[0]!.ipBlock?.cidr === "string",
        "another policy admits transfer traffic outside the verified VM data port",
      );
    }
  }
  return member;
}
export function planSharedMigrationIngress(
  policies: ObservedNetworkPolicy[],
  scope: SharedIngressScope,
): Saved {
  const member = tracked(policies, scope);
  const remaining: Rule[] = [],
    observed: string[] = [];
  for (const rule of member.spec.ingress ?? []) {
    const p = protectedPorts(rule);
    if (!p.length) {
      remaining.push(rule);
      continue;
    }
    ensure(p.length === rule.ports!.length, "transfer rule also carries an unrelated port");
    if (intendedPeer(rule, "glm-controller") && isDeepStrictEqual(p, [3003]))
      observed.push("controller");
    else if (
      intendedPeer(rule, "octogee-gateway") &&
      isDeepStrictEqual(
        p.sort((a, b) => a - b),
        [3003, 30873],
      )
    )
      observed.push("gateway");
    else throw new Error("Shared maintenance ingress transfer peers or ports changed");
  }
  ensure(
    isDeepStrictEqual(observed.sort(), ["controller", "gateway"]),
    "original transfer rules changed",
  );
  return {
    uid: member.metadata.uid,
    name: member.metadata.name,
    namespace: scope.namespace,
    original: structuredClone(member.spec),
    held: { ...structuredClone(member.spec), ingress: structuredClone(remaining) },
  };
}
export function assertSharedMigrationIngressHeld(
  policies: ObservedNetworkPolicy[],
  scope: SharedIngressScope,
  saved: Saved,
) {
  const member = tracked(policies, scope);
  ensure(
    member.metadata.uid === saved.uid && isDeepStrictEqual(member.spec, saved.held),
    "hold is unavailable",
  );
  ensure(
    (member.spec.ingress ?? []).every((rule) => protectedPorts(rule).length === 0),
    "still allows a control or transfer peer",
  );
}
export function changeSharedMigrationIngress(
  member: ObservedNetworkPolicy,
  saved: Saved,
  action: "hold" | "restore",
) {
  ensure(
    member.metadata.uid === saved.uid &&
      member.metadata.name === saved.name &&
      member.metadata.namespace === saved.namespace &&
      !!member.metadata.resourceVersion,
    "original policy was replaced",
  );
  const expected = action === "hold" ? saved.original : saved.held,
    desired = action === "hold" ? saved.held : saved.original;
  if (isDeepStrictEqual(member.spec, desired)) return [];
  ensure(isDeepStrictEqual(member.spec, expected), "policy changed before compare-and-set");
  return [
    { op: "test", path: "/metadata/uid", value: saved.uid },
    { op: "test", path: "/metadata/resourceVersion", value: member.metadata.resourceVersion },
    { op: "test", path: "/spec", value: expected },
    { op: "replace", path: "/spec", value: desired },
  ];
}

type RuntimeIdentity = { podUid: string; gatewayId: string };
type LegacyTransferObservation = RuntimeIdentity & {
  rsyncProcesses: number;
  temporaryEntries: number;
  controlSockets: string[];
  transferSockets: string[];
};
export function assertLegacySharedTransferIdle(
  value: LegacyTransferObservation,
  expected: RuntimeIdentity,
) {
  ensure(
    value.podUid === expected.podUid && value.gatewayId === expected.gatewayId,
    "observed another runtime",
  );
  ensure(
    value.rsyncProcesses === 0 &&
      value.temporaryEntries === 0 &&
      isDeepStrictEqual(value.controlSockets, ["0A"]) &&
      isDeepStrictEqual(value.transferSockets, []),
    "cannot prove an idle original migration listener",
  );
}
