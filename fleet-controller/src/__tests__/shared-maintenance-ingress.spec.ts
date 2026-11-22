import { expect, it } from "vitest";
import {
  planSharedMigrationIngress,
  assertSharedMigrationIngressHeld,
  changeSharedMigrationIngress,
} from "../lib/shared-maintenance-ingress.js";
const gatewayId = "shared-fixture",
  namespace = "fixture-test",
  uid = "aa000000-0000-4000-8000-000000000001";
const scope = {
  gatewayId,
  namespace,
  policyUid: uid,
  labels: { app: "octogee-gateway", "gateway-instance": gatewayId },
};
const peers = (app: string) => [{ podSelector: { matchLabels: { app } } }];
const ports = (...ports: number[]) => ports.map((port) => ({ protocol: "TCP", port }));
const owner = {
  metadata: { name: "octogee-gateway-ingress-" + gatewayId, namespace, uid, resourceVersion: "1" },
  spec: {
    podSelector: { matchLabels: scope.labels },
    policyTypes: ["Ingress"],
    ingress: [
      { from: peers("gateway-router"), ports: ports(3001) },
      { from: peers("glm-controller"), ports: ports(3003) },
      { from: peers("octogee-gateway"), ports: ports(3003, 30873) },
    ],
  },
};
const vm = {
  metadata: { name: "gateway-vm-migration-ingress", namespace, uid: "222", resourceVersion: "3" },
  spec: {
    podSelector: { matchLabels: { app: "octogee-gateway" } },
    policyTypes: ["Ingress"],
    ingress: [{ from: [{ ipBlock: { cidr: "10.128.0.0/20" } }], ports: ports(30873) }],
  },
};
it("holds only original per-member transfer ingress and restores with UID, version and spec compare-and-set", () => {
  const saved = planSharedMigrationIngress([owner, vm], scope);
  expect(saved.held.ingress).toEqual([owner.spec.ingress[0]]);
  const patch = changeSharedMigrationIngress(owner, saved, "hold");
  expect(patch.slice(0, 3).map((x) => x.path)).toEqual([
    "/metadata/uid",
    "/metadata/resourceVersion",
    "/spec",
  ]);
  const held = {
    ...owner,
    metadata: { ...owner.metadata, resourceVersion: "2" },
    spec: saved.held,
  };
  assertSharedMigrationIngressHeld([held, vm], scope, saved);
  expect(changeSharedMigrationIngress(held, saved, "restore").at(-1)?.value).toEqual(owner.spec);
  expect(() =>
    assertSharedMigrationIngressHeld(
      [held, { ...vm, spec: { ...vm.spec, ingress: [{ ports: ports(3003) }] } }],
      scope,
      saved,
    ),
  ).toThrow();
  expect(() =>
    changeSharedMigrationIngress(
      { ...held, metadata: { ...held.metadata, uid: "another" } },
      saved,
      "restore",
    ),
  ).toThrow();
});
it.each(["named", "all", "range", "duplicate", "blank"])(
  "refuses ambiguous existing ingress %s",
  (kind) => {
    const override = structuredClone(owner);
    if (kind === "duplicate")
      return expect(() => planSharedMigrationIngress([owner, owner, vm], scope)).toThrow();
    if (kind === "blank") override.spec.ingress = [];
    else
      Object.assign(override.spec.ingress[2]!, {
        ports:
          kind === "all"
            ? []
            : kind === "range"
              ? [{ port: 2999, endPort: 31000 }]
              : [{ port: "provisioner" }],
      });
    expect(() => planSharedMigrationIngress([override, vm], scope)).toThrow();
  },
);

import { assertLegacySharedTransferIdle } from "../lib/shared-maintenance-ingress.js";
it("reads the old member's actual socket, daemon and staging evidence before allowing migration exclusion", () => {
  const podUid = "01234567-8901-4000-8000-000000000001";
  const idle = {
    podUid,
    gatewayId,
    rsyncProcesses: 0,
    temporaryEntries: 0,
    controlSockets: ["0A"],
    transferSockets: [],
  };
  expect(() => assertLegacySharedTransferIdle(idle, { podUid, gatewayId })).not.toThrow();
  for (const altered of [
    { podUid: "foreign" },
    { temporaryEntries: 1 },
    { rsyncProcesses: 1 },
    { controlSockets: ["0A", "01"] },
    { transferSockets: ["0A"] },
    { controlSockets: [] },
  ]) {
    expect(() =>
      assertLegacySharedTransferIdle({ ...idle, ...altered }, { podUid, gatewayId }),
    ).toThrow();
  }
});
