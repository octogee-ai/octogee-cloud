

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { parseDocument } from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CHART_PATH = path.join(REPO_ROOT, "helm/octogee-gateway");

beforeAll(() => {
  if (!fs.existsSync(CHART_PATH)) {
    throw new Error(`octogee-gateway chart not found at ${CHART_PATH}`);
  }

spawnSync("helm", ["template", "warmup", CHART_PATH, "--set", "gatewayId=warmup", "--set", "imageTag=warmup", "--set", "image.repository=registry.example/octogee-gateway", "--set", "gatewayEdge.image.repository=registry.example/gateway-edge", "--set", "env.mmSiteUrl=https://example.com", "--set", "env.mmInternalUrl=http://example", "--set", "gatewayEdge.publicAppOrigins[0]=https://app-test.octogee.com"], { encoding: "utf-8" });
}, 60_000);

const REQUIRED_VALUES: Record<string, string> = {
  gatewayId: "default",
  imageTag: "abc1234",
  "image.repository": "registry.example/octogee-gateway",
  "gatewayEdge.image.repository": "registry.example/gateway-edge",
  "env.mmSiteUrl": "https://mm-test.example.com",
  "env.mmInternalUrl": "http://mattermost.octogee-test.svc.cluster.local:8065",
  "gatewayEdge.publicAppOrigins[0]": "https://app-test.octogee.com",
};

function helmTemplate(
  releaseName = "octogee-gw-default",
  setValues: Record<string, string> = {},
  namespace = "octogee-test",
): string {
  const args = [
    "template",
    releaseName,
    CHART_PATH,
    `--namespace=${namespace}`,
  ];
  const merged = { ...REQUIRED_VALUES, ...setValues };
  const dedicated = setValues.gatewayClass === "isolated" ||
    setValues.profile === "isolated" ||
    setValues.imageProfile === "isolated";
  if (dedicated && !Object.prototype.hasOwnProperty.call(setValues, "gatewayClass")) {
    merged.gatewayClass = "isolated";
  }
  if (dedicated && !Object.prototype.hasOwnProperty.call(setValues, "imageProfile")) {
    merged.imageProfile = "isolated";
  }
  if (dedicated && !Object.prototype.hasOwnProperty.call(setValues, "runtimeKind")) merged.runtimeKind = "gce-vm";
  for (const [k, v] of Object.entries(merged)) {
    args.push("--set", `${k}=${v}`);
  }
  const result = spawnSync("helm", args, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `helm template failed (status=${result.status}):\n--- stderr ---\n${result.stderr}\n--- stdout ---\n${result.stdout}`,
    );
  }
  return result.stdout;
}

describe("octogee-gateway chart — isolated class dual read", () => {
  function isolatedRender(value: string, extra: Record<string, string> = {}): string {
    return helmTemplate("octogee-gw-walter", {
      gatewayId: "walter", gatewayClass: value, imageProfile: value, runtimeKind: "gce-vm", ...extra,
    });
  }

  it.each<Record<string, string>>([{}, { computerDesktop: "x11" }, { "builderAccess.controlUiEnabled": "true", "builderAccess.controlIdentity": "per-user" }])(
    "renders the builder class and image profile a previous controller passes the same as isolated, apart from the values it passes through (%o)",
    (extra) => {
      const passedThrough = (out: string) => out
        .replace(/(gateway-(?:class|profile): )"builder"/g, '$1"isolated"')
        .replace(/(name: GATEWAY_(?:CLASS|PROFILE)\n\s+value: )"builder"/g, '$1"isolated"');
      const isolated = isolatedRender("isolated", extra);
      expect(isolated).toContain('gateway-class: "isolated"');
      expect(passedThrough(isolatedRender("builder", extra))).toBe(isolated);
    },
  );

  it("still rejects an unknown class", () => {
    expect(() => helmTemplate("octogee-gw-walter", { gatewayId: "walter", gatewayClass: "operator" })).toThrow(/gatewayClass/);
  });
});

function findDoc(out: string, kind: string, name: string): string | null {
  const docs = out.split(/^---\s*$/m);
  return (
    docs.find((d) => {
      if (!new RegExp(`^kind:\\s*${kind}\\s*$`, "m").test(d)) return false;
      return new RegExp(`^  name:\\s*"?${name}"?\\s*$`, "m").test(d);
    }) ?? null
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containerBlock(dep: string, name: string): string {
  const escaped = escapeRegex(name);
  return (
    dep.match(
      new RegExp(
        `^ {8}- name:\\s*${escaped}\\s*(?:\\n|$)[\\s\\S]*?(?=\\n {8}- name:|\\n {6}volumes:)`,
        "m",
      ),
    )?.[0] ??
    ""
  );
}

function selectorBlock(doc: string): string {
  return doc.match(/^\s*selector:\s*\n([\s\S]*?)(?=^\s*(?:ports|type):)/m)?.[0] ?? "";
}

function gatewayImageLabel(dep: string): string {
  const match = dep.match(/^ {8}gateway-image:\s*"?([^"\n]+)"?\s*$/m);
  if (!match) throw new Error("gateway-image label not found");
  return match[1];
}

describe("helm/octogee-gateway/ — single-instance rendering", () => {
  it.each([
    ["shared", "/home/node/.openclaw/openclaw.json"],
    ["isolated", "/home/node/.openclaw/system_config/openclaw.json"],
  ])("declares the active %s config for direct gateway exec operations", (gatewayClass, configPath) => {
    const deployment = findDoc(helmTemplate("octogee-gw-config", {
      gatewayId: "config", gatewayClass,
    }), "Deployment", "octogee-gateway-config") ?? "";
    const pod = parseDocument(deployment).toJS().spec.template.spec;
    const gateway = pod.containers.find((container: { name: string }) => container.name === "gateway");
    const env = Object.fromEntries(gateway.env.map((entry: { name: string; value?: string }) => [entry.name, entry.value]));
    expect(env.OPENCLAW_DIR).toBe("/home/node/.openclaw");
    expect(env.OPENCLAW_CONFIG_PATH).toBe(configPath);
  });

  it("does not configure an Artifact Registry URL in isolated pods", () => {
    const values = parseDocument(fs.readFileSync(path.join(CHART_PATH, "values.yaml"), "utf8")).toJS() as {
      env?: { userNpmProxyRegistry?: string };
    };
    expect(values.env?.userNpmProxyRegistry).toBeUndefined();
  });

  it("renders only the explicit direct fallback into isolated gateways", () => {
    const user = findDoc(helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      profile: "isolated",
      "env.isolatedNpmFallbackRegistry": "https://registry.npmjs.org/",
    }), "Deployment", "octogee-gateway-walter") ?? "";
    const shared = findDoc(helmTemplate("octogee-gw-shared", {
      gatewayId: "shared",
      "env.isolatedNpmFallbackRegistry": "https://registry.npmjs.org/",
    }), "Deployment", "octogee-gateway-shared") ?? "";

    expect(containerBlock(user, "gateway")).toContain("OCTOGEE_BUILDER_NPM_FALLBACK_REGISTRY");
    expect(containerBlock(user, "gateway")).not.toContain("OCTOGEE_BUILDER_NPM_PROXY_REGISTRY");
    expect(containerBlock(shared, "gateway")).not.toContain(
      "OCTOGEE_BUILDER_NPM_FALLBACK_REGISTRY",
    );
  });

  it("provides the durable agent and workspace roots required by OpenClaw config", () => {
    const deployment = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const gateway = containerBlock(deployment, "gateway");
    expect(gateway).toMatch(
      /name:\s*CUSTOMERS_DIR[\s\S]*?value:\s*"\/home\/node\/\.openclaw\/customers"/,
    );
    expect(gateway).toMatch(
      /name:\s*AGENTS_DIR[\s\S]*?value:\s*"\/home\/node\/\.openclaw\/agents"/,
    );
  });

  it("allows OpenClaw main preview builds to cross non-monotonic build hashes only where the environment opts in", () => {
    const mainBuild = "515369d-oc2026.8.1-main.16c097b2@sha256:abc123";
    const optedInPreview = findDoc(helmTemplate("octogee-gw-preview", {
      gatewayId: "preview",
      "image.tag": mainBuild,
      allowOlderOpenclawMainBuilds: "true",
    }, "any-namespace"), "Deployment", "octogee-gateway-preview") ?? "";
    const optedInStable = findDoc(helmTemplate("octogee-gw-stable", {
      gatewayId: "stable",
      "image.tag": "515369d-oc2026.8.1@sha256:def456",
      allowOlderOpenclawMainBuilds: "true",
    }), "Deployment", "octogee-gateway-stable") ?? "";
    const defaultPreview = findDoc(helmTemplate("octogee-gw-default-preview", {
      gatewayId: "default-preview",
      "image.tag": mainBuild,
    }), "Deployment", "octogee-gateway-default-preview") ?? "";

    expect(containerBlock(optedInPreview, "gateway")).toMatch(
      /name:\s*OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS[\s\S]*?value:\s*"1"/,
    );
    expect(containerBlock(optedInStable, "gateway")).not.toContain(
      "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS",
    );
    expect(containerBlock(defaultPreview, "gateway")).not.toContain(
      "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS",
    );
  });

  it("keeps older OpenClaw main builds off by default", () => {
    const values = parseDocument(fs.readFileSync(path.join(CHART_PATH, "values.yaml"), "utf-8")).toJSON() as Record<string, unknown>;
    expect(values.allowOlderOpenclawMainBuilds).toBe(false);
  });

  it("mounts sidecar-only broker capabilities without adding gateway credentials", () => {
    const deployment = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const gateway = containerBlock(deployment, "gateway");
    const edge = containerBlock(deployment, "gateway-edge");

    expect(gateway).not.toContain("sidecar-broker-sa-token");
    expect(edge).toMatch(
      /name:\s*OCTOGEE_SIDECAR_BROKER_TOKEN_PATH[\s\S]*?value:\s*"\/var\/run\/secrets\/octogee-sidecar-broker\/token"/,
    );
    expect(edge).toMatch(
      /name:\s*sidecar-broker-sa-token[\s\S]*?mountPath:\s*\/var\/run\/secrets\/octogee-sidecar-broker/,
    );
    expect(gateway).not.toContain("WORKSPACE_COMMIT_PROOF_BROKER_URL");
    expect(edge).toMatch(
      /name:\s*WORKSPACE_COMMIT_PROOF_BROKER_URL[\s\S]*?value:\s*"http:\/\/octogee-api\.octogee-test\.svc\.cluster\.local:3001"/,
    );
    expect(deployment).toMatch(
      /name:\s*sidecar-broker-sa-token[\s\S]*?audience:\s*octogee-api-sidecar-broker/,
    );
  });

  it("does not inject OpenClaw Doctor into gateway boot", () => {
    const deployment = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    expect(containerBlock(deployment, "gateway")).not.toMatch(/OPENCLAW_DOCTOR_MODE/);
    expect(containerBlock(deployment, "gateway-edge")).not.toMatch(/OPENCLAW_DOCTOR_MODE/);
  });

  it("does not set legacy Activity bridge or broad broadcast controls", () => {
    const defaultDeployment =
      findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const defaultGateway = containerBlock(defaultDeployment, "gateway");
    const defaultEdge = containerBlock(defaultDeployment, "gateway-edge");
    for (const container of [defaultGateway, defaultEdge]) {
      expect(container).not.toContain("OCTOGEE_ACTIVITY_BRIDGE_MODE");
      expect(container).not.toContain("OPENCLAW_BROADCAST_ALL_AGENT_RUNS");
      expect(container).not.toContain("OPENCLAW_BROADCAST_DIAGNOSTIC_EVENTS");
    }
  });

  it("renders one Deployment named octogee-gateway-<gatewayId>", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default");
    expect(dep).not.toBeNull();
  });

  it("uses the platform lane for shared gateways and the Spot-first class for owner-bound gateways", () => {
    const shared = findDoc(helmTemplate("octogee-gw-default", {
      computeClass: "octogee-gateway-test",
      gatewayClass: "shared",
    }), "Deployment", "octogee-gateway-default") ?? "";
    const user = findDoc(helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      computeClass: "octogee-gateway-test",
      gatewayClass: "isolated",
    }), "Deployment", "octogee-gateway-walter") ?? "";

    expect(shared).not.toContain("cloud.google.com/compute-class");
    expect(user).toMatch(/cloud\.google\.com\/compute-class:\s*"octogee-gateway-test"/);
  });

  it("keeps shared slots on different nodes and spread across Central zones", () => {
    const shared = findDoc(helmTemplate("octogee-gw-shared-a", {
      gatewayId: "shared-a",
      gatewayClass: "shared",
    }), "Deployment", "octogee-gateway-shared-a") ?? "";
    const ownerBound = findDoc(helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      gatewayClass: "isolated",
    }), "Deployment", "octogee-gateway-walter") ?? "";
    const ownerRequired = ownerBound.match(
      /requiredDuringSchedulingIgnoredDuringExecution:[\s\S]*?(?=\n\s*preferredDuringSchedulingIgnoredDuringExecution:)/,
    )?.[0] ?? "";

    expect(shared).toMatch(/requiredDuringSchedulingIgnoredDuringExecution:[\s\S]*topologyKey: kubernetes\.io\/hostname/);
    expect(shared).toMatch(/topologySpreadConstraints:[\s\S]*topologyKey: topology\.kubernetes\.io\/zone[\s\S]*whenUnsatisfiable: DoNotSchedule[\s\S]*gateway-class: shared/);
    expect(shared).not.toContain("matchLabelKeys");
    expect(shared).not.toMatch(/operator: NotIn/);
    expect(ownerBound).not.toContain("topologySpreadConstraints:");
    expect(ownerRequired).not.toContain("topologyKey: topology.kubernetes.io/zone");
  });

  it("lets an install prefer, rather than require, one gateway per node", () => {
    const hostnameTerm = /podAffinityTerm:\s*\n\s*labelSelector:\s*\n\s*matchLabels:\s*\n\s*app: octogee-gateway\s*\n\s*namespaceSelector: \{\}\s*\n\s*topologyKey: kubernetes\.io\/hostname/;
    const render = (podAntiAffinity: string) => findDoc(helmTemplate("octogee-gw-shared-a", {
      gatewayId: "shared-a",
      gatewayClass: "shared",
      podAntiAffinity,
    }), "Deployment", "octogee-gateway-shared-a") ?? "";
    const preferred = render("preferred");
    const defaulted = findDoc(helmTemplate("octogee-gw-shared-a", {
      gatewayId: "shared-a",
      gatewayClass: "shared",
    }), "Deployment", "octogee-gateway-shared-a") ?? "";

    expect(defaulted).toMatch(/requiredDuringSchedulingIgnoredDuringExecution:[\s\S]*topologyKey: kubernetes\.io\/hostname/);
    expect(render("required")).toEqual(defaulted);
    expect(preferred).not.toContain("requiredDuringSchedulingIgnoredDuringExecution");
    expect(preferred).toMatch(hostnameTerm);
    expect(preferred).toMatch(/topologyKey: topology\.kubernetes\.io\/zone/);
    expect(() => render("sometimes")).toThrow(/podAntiAffinity "sometimes"/);
  });

  it("renders isolated gateways with their durable config paths", () => {
    const owned = findDoc(helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      gatewayClass: "isolated",
      imageProfile: "isolated",
      "builderAccess.controlUiEnabled": "true",
    }), "Deployment", "octogee-gateway-walter") ?? "";
    expect(containerBlock(owned, "gateway")).not.toMatch(/GATEWAY_UNOWNED_OPERATOR_PREWARM/);
    expect(containerBlock(owned, "gateway-edge")).toMatch(
      /name:\s*OPENCLAW_CONFIG[\s\S]*?value:\s*"\/home\/node\/\.openclaw\/system_config\/openclaw\.json"/,
    );
    expect(containerBlock(owned, "gateway")).toMatch(
      /name:\s*OPENCLAW_DASHBOARD_BRIDGE_REQUIRED[\s\S]*?value:\s*"true"/,
    );
    expect(containerBlock(owned, "gateway-edge")).toMatch(
      /name:\s*OPENCLAW_DASHBOARD_BRIDGE_ENABLED[\s\S]*?value:\s*"true"/,
    );
    expect(containerBlock(owned, "gateway-edge")).toMatch(
      /name:\s*OPENCLAW_CONFIG_PATH[\s\S]*?value:\s*"\/home\/node\/\.openclaw\/system_config\/openclaw\.json"/,
    );
  });

  it("threads the user control identity to both containers and pins shared gateways to the operator identity", () => {
    const perUser = findDoc(helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      gatewayClass: "isolated",
      imageProfile: "isolated",
      "builderAccess.controlUiEnabled": "true",
      "builderAccess.controlIdentity": "per-user",
    }), "Deployment", "octogee-gateway-walter") ?? "";
    for (const container of ["gateway", "gateway-edge"]) {
      expect(containerBlock(perUser, container)).toMatch(
        /name:\s*OPENCLAW_CONTROL_IDENTITY[\s\S]*?value:\s*"per-user"/,
      );
    }

    const defaulted = findDoc(helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      gatewayClass: "isolated",
      imageProfile: "isolated",
    }), "Deployment", "octogee-gateway-walter") ?? "";
    expect(containerBlock(defaulted, "gateway")).toMatch(
      /name:\s*OPENCLAW_CONTROL_IDENTITY[\s\S]*?value:\s*"shared-operator"/,
    );

    const shared = findDoc(helmTemplate("octogee-gw-shared", {
      gatewayId: "shared",
      gatewayClass: "shared",
      "builderAccess.controlIdentity": "per-user",
    }), "Deployment", "octogee-gateway-shared") ?? "";
    expect(containerBlock(shared, "gateway")).toMatch(
      /name:\s*OPENCLAW_CONTROL_IDENTITY[\s\S]*?value:\s*"shared-operator"/,
    );
  });

  it("standard profile references the gateway-scoped KSA but never renders a ServiceAccount (the fleet controller owns it)", () => {
    // KSA creation moved OUT of the chart to the fleet controller: a gateway-scoped KSA
    // (octogee-gw-<gatewayId>) is created once and referenced by each revision
    // Helm release, so simultaneous revisions never race on ownership. The
    // Deployment still references it; the chart no longer creates it.
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";

    expect(findDoc(out, "ServiceAccount", "octogee-gw-default")).toBeNull();
    expect(dep).toMatch(/serviceAccountName:\s*octogee-gw-default/);
    expect(dep).not.toMatch(/serviceAccountName:\s*octogee-gateway\b/);
  });

  it("standard profile treats an explicit legacy shared ServiceAccount as unsafe and derives per-gateway identity", () => {
    const out = helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      profile: "standard",
      serviceAccountName: "octogee-gateway",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-walter") ?? "";

    expect(dep).toMatch(/serviceAccountName:\s*octogee-gw-walter/);
    expect(dep).not.toMatch(/serviceAccountName:\s*octogee-gateway\b/);
    // KSA is controller-owned now — the chart renders no ServiceAccount object.
    expect(findDoc(out, "ServiceAccount", "octogee-gw-walter")).toBeNull();
  });

  it("User profile references its per-gateway KSA and renders no ServiceAccount object", () => {
    const out = helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      profile: "isolated",
      "serviceAccount.create": "true",
    });
    // Even with serviceAccount.create=true (a legacy value), the chart no
    // longer owns the KSA — the fleet controller creates it with any Workload Identity
    // annotation. The Deployment still references the gateway-scoped name.
    expect(findDoc(out, "ServiceAccount", "octogee-gw-walter")).toBeNull();
    const dep = findDoc(out, "Deployment", "octogee-gateway-walter") ?? "";
    expect(dep).toMatch(/serviceAccountName:\s*octogee-gw-walter/);
  });

  it("User profile does not inherit the shared platform ServiceAccount when the fleet controller omits an override", () => {
    const out = helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      profile: "isolated",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-walter") ?? "";

    expect(dep).toMatch(/serviceAccountName:\s*octogee-gw-walter/);
    expect(dep).not.toMatch(/serviceAccountName:\s*octogee-gateway\b/);
    expect(findDoc(out, "ServiceAccount", "octogee-gw-walter")).toBeNull();
  });

  it("hands /home/node to the runtime user before seeding it as that user", () => {
    const profiles: Record<string, string>[] = [{}, { profile: "isolated" }, { gatewayClass: "isolated", imageProfile: "isolated", sizingTier: "s", computerDesktop: "x11" }];
    for (const values of profiles) {
      const dep = findDoc(helmTemplate("octogee-gw-default", values), "Deployment", "octogee-gateway-default")!;
      const init = containerBlock(dep, "fix-perms");
      expect(init).toMatch(/runAsUser: 0\b/);
      expect(init).toMatch(/runAsNonRoot: false/);
      expect(init).toMatch(/allowPrivilegeEscalation: false/);
      expect(init).toMatch(/drop: \[ALL\]/);
      expect(init).toMatch(/add: \[CHOWN, FOWNER, SETUID, SETGID\]/);
      const handOff = init.indexOf("chown 1000:1000 /home/node");
      const mode = init.indexOf("chmod 0755 /home/node");
      const drop = init.indexOf("exec setpriv --reuid=1000 --regid=1000 --keep-groups");
      const seed = init.indexOf("cp -rn /etc/skel/. /home/node/");
      expect(handOff).toBeGreaterThan(-1);
      expect(mode).toBeGreaterThan(handOff);
      expect(drop).toBeGreaterThan(mode);
      expect(seed).toBeGreaterThan(drop);
      expect(containerBlock(dep, "gateway")).not.toMatch(/runAsUser: 0\b/);
    }
  });

  it("disables the default Kubernetes ServiceAccount token automount", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(/automountServiceAccountToken:\s*false/);
  });

  it("stamps gateway-profile labels so alias Services can exclude isolated pods after rollout", () => {
    const standardDep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    expect(standardDep).toMatch(/gateway-profile:\s*"standard"/);

    const userDep =
      findDoc(
        helmTemplate("octogee-gw-default", { profile: "isolated" }),
        "Deployment",
        "octogee-gateway-default",
      ) ?? "";
    expect(userDep).toMatch(/gateway-profile:\s*"isolated"/);
  });

  it("stamps the gateway-image label (build tag) on pods so a roll is legible via `kubectl get pods -L gateway-image`", () => {
    const dep = findDoc(helmTemplate("octogee-gw-default", { imageTag: "7637d1a" }), "Deployment", "octogee-gateway-default") ?? "";
    // On the pod-template labels...
    expect(dep).toMatch(/gateway-image:\s*"?7637d1a"?/);
    // ...but NOT on the selector — selectors must stay stable across rolls, else
    // every image bump would orphan the prior ReplicaSet's pods.
    const selectorBlock = dep.slice(dep.indexOf("selector:"), dep.indexOf("template:"));
    expect(selectorBlock).not.toMatch(/gateway-image/);
  });

  it("stamps gateway-image on isolated pods too", () => {
    const dep = findDoc(
      helmTemplate("octogee-gw-walter", { gatewayId: "walter", profile: "isolated", imageTag: "deadbee1" }),
      "Deployment",
      "octogee-gateway-walter",
    ) ?? "";
    expect(dep).toMatch(/gateway-image:\s*"?deadbee"?/);
  });

  it("keeps a digest-pinned image intact while labeling the pod with its short build SHA", () => {
    const candidateTag = `8c356bb-oc2026.7.1@sha256:${"a".repeat(64)}`;
    const dep = findDoc(
      helmTemplate("octogee-gw-default", { imageTag: candidateTag }),
      "Deployment",
      "octogee-gateway-default",
    ) ?? "";
    const label = gatewayImageLabel(dep);

    expect(dep).toContain(
      `image: "registry.example/octogee-gateway:${candidateTag}"`,
    );
    expect(label).toBe("8c356bb");
    expect(label).toMatch(/^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$/);
  });

  it("standard profile mounts tenant-bound projected tokens for broker calls without exposing platform secrets", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const gw = containerBlock(dep, "gateway");
    const edge = containerBlock(dep, "gateway-edge");

    expect(gw).not.toMatch(/mountPath:\s*\/var\/run\/secrets\/octogee-api/);
    expect(gw).toMatch(/name:\s*GITEA_ADMIN_BROKER_URL\s*\n\s*value:\s*"http:\/\/octogee-api\.octogee-test\.svc\.cluster\.local:3001"/);
    expect(gw).toMatch(/name:\s*FLEET_BROKER_URL\s*\n\s*value:\s*"http:\/\/octogee-api\.octogee-test\.svc\.cluster\.local:3001"/);
    expect(gw).toMatch(/name:\s*OCTOGEE_API_SA_TOKEN_PATH\s*\n\s*value:\s*"\/var\/run\/secrets\/octogee-gateway-broker\/token"/);
    expect(gw).toMatch(/name:\s*gateway-broker-sa-token\s*\n\s*mountPath:\s*\/var\/run\/secrets\/octogee-gateway-broker\s*\n\s*readOnly:\s*true/);
    expect(gw).toMatch(/name:\s*OCTOGEE_GATEWAY_CREDENTIAL_TOKEN_PATH\s*\n\s*value:\s*"\/var\/run\/secrets\/octogee-gateway-credentials\/token"/);
    expect(gw).toMatch(/name:\s*gateway-credential-sa-token\s*\n\s*mountPath:\s*\/var\/run\/secrets\/octogee-gateway-credentials\s*\n\s*readOnly:\s*true/);
    expect(edge).toMatch(/name:\s*OPENCLAW_RUNTIME_BROKER_URL\s*\n\s*value:\s*"http:\/\/octogee-api\.octogee-test\.svc\.cluster\.local:3001"/);
    expect(edge).toMatch(/name:\s*CONNECTOR_TOKEN_BROKER_URL\s*\n\s*value:\s*"http:\/\/octogee-api\.octogee-test\.svc\.cluster\.local:3001"/);
    expect(edge).toMatch(/name:\s*FLEET_BROKER_URL\s*\n\s*value:\s*"http:\/\/octogee-api\.octogee-test\.svc\.cluster\.local:3001"/);
    expect(edge).toMatch(/name:\s*OCTOGEE_API_SA_TOKEN_PATH\s*\n\s*value:\s*"\/var\/run\/secrets\/octogee-api\/token"/);
    expect(edge).toMatch(/name:\s*octogee-api-sa-token\s*\n\s*mountPath:\s*\/var\/run\/secrets\/octogee-api\s*\n\s*readOnly:\s*true/);
    expect(edge).toMatch(/name:\s*OCTOGEE_GATEWAY_CREDENTIAL_TOKEN_PATH\s*\n\s*value:\s*"\/var\/run\/secrets\/octogee-gateway-credentials\/token"/);
    expect(edge).toMatch(/name:\s*gateway-credential-sa-token\s*\n\s*mountPath:\s*\/var\/run\/secrets\/octogee-gateway-credentials\s*\n\s*readOnly:\s*true/);
    expect(dep).toMatch(/name:\s*octogee-api-sa-token\s*\n\s*projected:\s*\n\s*sources:\s*\n\s*-\s*serviceAccountToken:\s*\n\s*path:\s*token\s*\n\s*audience:\s*octogee-api\s*\n\s*expirationSeconds:\s*3600/);
    expect(dep).toMatch(/name:\s*gateway-broker-sa-token\s*\n\s*projected:\s*\n\s*sources:\s*\n\s*-\s*serviceAccountToken:\s*\n\s*path:\s*token\s*\n\s*audience:\s*octogee-api\s*\n\s*expirationSeconds:\s*3600/);
    expect(dep).toMatch(/name:\s*gateway-credential-sa-token\s*\n\s*projected:\s*\n\s*sources:\s*\n\s*-\s*serviceAccountToken:\s*\n\s*path:\s*token\s*\n\s*audience:\s*octogee-api-gateway-credentials\s*\n\s*expirationSeconds:\s*3600/);
  });

  it("enables OpenAI-compatible memory search embeddings for agents", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const gw = containerBlock(dep, "gateway");

    expect(gw).toMatch(/name:\s*OPENAI_EMBEDDINGS_ENABLED\s*\n\s*value:\s*"true"/);
    expect(gw).toMatch(/name:\s*OPENAI_EMBEDDINGS_MODEL\s*\n\s*value:\s*"text-embedding-3-small"/);
  });

  it("respects an explicit OpenAI-compatible embeddings disable override", () => {
    const dep = findDoc(
      helmTemplate("octogee-gw-no-embeddings", {
        "env.openaiEmbeddingsEnabled": "false",
      }),
      "Deployment",
      "octogee-gateway-default",
    ) ?? "";
    const gw = containerBlock(dep, "gateway");

    expect(gw).toMatch(/name:\s*OPENAI_EMBEDDINGS_ENABLED\s*\n\s*value:\s*"false"/);
  });

  it("User profile uses the same tenant-bound broker token without mounting the sidecar token path", () => {
    const dep =
      findDoc(
        helmTemplate("octogee-gw-walter", {
          gatewayId: "walter",
          profile: "isolated",
        }),
        "Deployment",
        "octogee-gateway-walter",
      ) ?? "";
    const gw = containerBlock(dep, "gateway");
    const edge = containerBlock(dep, "gateway-edge");

    expect(gw).not.toMatch(/mountPath:\s*\/var\/run\/secrets\/octogee-api/);
    expect(gw).toMatch(/name:\s*GITEA_ADMIN_BROKER_URL\s*\n\s*value:\s*"http:\/\/octogee-api\.octogee-test\.svc\.cluster\.local:3001"/);
    expect(gw).toMatch(/name:\s*gateway-broker-sa-token\s*\n\s*mountPath:\s*\/var\/run\/secrets\/octogee-gateway-broker\s*\n\s*readOnly:\s*true/);
    expect(gw).toMatch(/name:\s*gateway-credential-sa-token\s*\n\s*mountPath:\s*\/var\/run\/secrets\/octogee-gateway-credentials\s*\n\s*readOnly:\s*true/);
    expect(edge).toMatch(/name:\s*OPENCLAW_RUNTIME_BROKER_URL\s*\n\s*value:\s*"http:\/\/octogee-api\.octogee-test\.svc\.cluster\.local:3001"/);
    expect(edge).toMatch(/name:\s*CONNECTOR_TOKEN_BROKER_URL\s*\n\s*value:\s*"http:\/\/octogee-api\.octogee-test\.svc\.cluster\.local:3001"/);
    expect(edge).toMatch(/name:\s*FLEET_BROKER_URL\s*\n\s*value:\s*"http:\/\/octogee-api\.octogee-test\.svc\.cluster\.local:3001"/);
    expect(edge).toMatch(/name:\s*OCTOGEE_API_SA_TOKEN_PATH\s*\n\s*value:\s*"\/var\/run\/secrets\/octogee-api\/token"/);
    expect(edge).toMatch(/name:\s*octogee-api-sa-token\s*\n\s*mountPath:\s*\/var\/run\/secrets\/octogee-api\s*\n\s*readOnly:\s*true/);
    expect(edge).toMatch(/name:\s*gateway-credential-sa-token\s*\n\s*mountPath:\s*\/var\/run\/secrets\/octogee-gateway-credentials\s*\n\s*readOnly:\s*true/);
  });

  it("mounts the Kubernetes API reviewer token only on gateway-edge", () => {
    const dep =
      findDoc(
        helmTemplate("octogee-gw-walter", {
          gatewayId: "walter",
          profile: "isolated",
        }),
        "Deployment",
        "octogee-gateway-walter",
      ) ?? "";
    const gw = containerBlock(dep, "gateway");
    const edge = containerBlock(dep, "gateway-edge");

    expect(gw).not.toMatch(/k8s-api-token/);
    expect(edge).toMatch(/name:\s*K8S_SERVICE_ACCOUNT_NAME\s*\n\s*value:\s*"octogee-gw-walter"/);
    expect(edge).toMatch(/name:\s*k8s-api-token\s*\n\s*mountPath:\s*\/var\/run\/secrets\/kubernetes\.io\/serviceaccount\s*\n\s*readOnly:\s*true/);
    expect(dep).toMatch(/name:\s*k8s-api-token\s*\n\s*projected:\s*\n\s*sources:\s*\n\s*-\s*serviceAccountToken:\s*\n\s*path:\s*token\s*\n\s*expirationSeconds:\s*3600/);
    expect(dep).toMatch(/name:\s*kube-root-ca\.crt/);
  });

  it("User profile does not render cluster-scoped TokenReview RBAC in controller-owned gateway releases", () => {
    const out = helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      profile: "isolated",
    });
    expect(out).not.toMatch(/^kind:\s*ClusterRoleBinding\s*$/m);
    expect(findDoc(helmTemplate(), "ClusterRoleBinding", "octogee-gateway-tokenreview-octogee-test-default")).toBeNull();
  });

  it("routes user sidecar asset edits through the canonical project mount", () => {
    const dep = findDoc(helmTemplate("octogee-gw-walter", { gatewayId: "walter", profile: "isolated", computerDesktop: "omarchy" }), "Deployment", "octogee-gateway-walter") ?? "";
    const pod = parseDocument(dep).toJSON().spec.template.spec;
    for (const name of ["gateway", "gateway-edge"]) {
      const container = pod.containers.find((entry: any) => entry.name === name);
      expect(container.env).toContainEqual({ name: "OCTOGEE_PROJECTS_MOUNT", value: "/work/materialized" });
      expect(container.volumeMounts).toContainEqual(expect.objectContaining({ mountPath: "/work/materialized" }));
    }
  });

  it("mounts the OpenClaw device-token cache only on gateway-edge", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const gw = containerBlock(dep, "gateway");
    const edge = containerBlock(dep, "gateway-edge");

    expect(gw).not.toMatch(/openclaw-device-auth/);
    expect(edge).toMatch(/name:\s*OPENCLAW_GATEWAY_DEVICE_TOKEN_PATH\s*\n\s*value:\s*"\/var\/run\/octogee\/openclaw-device-auth\/token"/);
    expect(edge).toMatch(/name:\s*openclaw-device-auth\s*\n\s*mountPath:\s*\/var\/run\/octogee\/openclaw-device-auth/);
    expect(dep).toMatch(/name:\s*openclaw-device-auth\s*\n\s*emptyDir:\s*\n\s*medium:\s*Memory\s*\n\s*sizeLimit:\s*16Mi/);
  });

  it("User profile does not wire the SiteAPI deploy-broker hop", () => {
    const dep =
      findDoc(
        helmTemplate("octogee-gw-walter", { gatewayId: "walter", profile: "isolated" }),
        "Deployment",
        "octogee-gateway-walter",
      ) ?? "";
    const gw = containerBlock(dep, "gateway");
    const edge = containerBlock(dep, "gateway-edge");

    // The OpenClaw gateway container may know the localhost sidecar URL,
    // but it does not get the platform internal-service key needed for
    // privileged sidecar paths. Gitea admin lifecycle goes through octogee-api
    // with the projected gateway KSA token instead.
    expect(gw).toMatch(/name:\s*GATEWAY_EDGE_INTERNAL_URL\b/);
    expect(gw).toMatch(/name:\s*GITEA_ADMIN_BROKER_URL\b/);
    expect(gw).not.toMatch(/name:\s*INTERNAL_SERVICE_KEY\b/);
    // gateway-edge gets no octogee-api deploy-broker target for operator SiteAPI.
    expect(edge).not.toMatch(/name:\s*OCTOGEE_API_URL\b/);
  });

  it("User profile wires callback verification on gateway-edge without legacy approval or admin secrets", () => {
    const dep =
      findDoc(
        helmTemplate("octogee-gw-walter", {
          gatewayId: "walter",
          profile: "isolated",
        }),
        "Deployment",
        "octogee-gateway-walter",
      ) ?? "";
    const edge = containerBlock(dep, "gateway-edge");
    expect(edge).toMatch(
      /name:\s*AGENT_CONTROL_ROUTER_PUBLIC_KEY\s*\n\s*valueFrom:\s*\n\s*secretKeyRef:\s*\n\s*name:\s*agent-control-router\s*\n\s*key:\s*public-key/,
    );
    expect(edge).not.toMatch(/name:\s*OCTOGEE_APPROVAL_SIGNING_SECRET/);
    // The platform admin PAT is not rendered into gateway pods.
    expect(edge).not.toMatch(/name:\s*MM_ADMIN_PAT/);
  });

  it("standard profile omits legacy approval and admin secrets while wiring callback verification", () => {
    const edge = containerBlock(
      findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "",
      "gateway-edge",
    );
    expect(edge).not.toMatch(/name:\s*MM_ADMIN_PAT/);
    expect(edge).toMatch(/name:\s*AGENT_CONTROL_ROUTER_PUBLIC_KEY/);
    expect(edge).not.toMatch(/name:\s*OCTOGEE_APPROVAL_SIGNING_SECRET/);
  });

  it("does not wire legacy broad Activity broadcasts on the gateway container", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default");
    expect(dep).not.toBeNull();
    expect(dep).not.toMatch(/name:\s*OPENCLAW_BROADCAST_ALL_AGENT_RUNS/);
    expect(dep).not.toMatch(/name:\s*OPENCLAW_BROADCAST_DIAGNOSTIC_EVENTS/);
    expect(dep).not.toMatch(/name:\s*OCTOGEE_BROADCAST_ALL_AGENT_RUNS/);
    expect(dep).not.toMatch(/name:\s*OCTOGEE_BROADCAST_DIAGNOSTIC_EVENTS/);
  });

  it("every doc starts with `apiVersion:` (regression: requireIdentity helper used to leak its values onto the first line)", () => {

const out = helmTemplate();
    const docs = out.split(/^---\s*$/m).map((d) => d.trim()).filter(Boolean);
    for (const doc of docs) {
      
      const firstNonComment = doc
        .split("\n")
        .find((line) => line.trim() && !line.trim().startsWith("#"));
      if (!firstNonComment) continue;
      expect(firstNonComment).toMatch(/^apiVersion:/);
    }
  });

  it("renders the per-instance Service octogee-gateway-<gatewayId>", () => {
    const out = helmTemplate();
    const svc = findDoc(out, "Service", "octogee-gateway-default") ?? "";
    expect(svc).not.toBe("");
    expect(selectorBlock(svc)).toMatch(/gateway-instance:\s*default/);
  });

  it("locks the gateway-edge sidecar to a read-only root filesystem with an explicit writable /tmp", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const edge = containerBlock(dep, "gateway-edge");

    expect(edge).toMatch(/securityContext:[\s\S]*?readOnlyRootFilesystem:\s*true/);
    expect(edge).toMatch(/name:\s*tmp\s*\n\s*mountPath:\s*\/tmp/);
    expect(dep).toMatch(/name:\s*tmp\s*\n\s*emptyDir:\s*\n\s*sizeLimit:\s*1Gi/);
  });

  it("keeps the OpenClaw gateway runtime writable", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const gateway = containerBlock(dep, "gateway");

    expect(gateway).toMatch(/securityContext:[\s\S]*?readOnlyRootFilesystem:\s*false/);
  });

  it("renders the gateway-edge-<gatewayId> alias Service", () => {
    const out = helmTemplate();
    const svc = findDoc(out, "Service", "gateway-edge-default") ?? "";
    expect(svc).not.toBe("");
    expect(selectorBlock(svc)).toMatch(/gateway-instance:\s*default/);
  });

  it("exposes the runner-metrics port (9092) on the gateway container + Service (scraped by the octogee-gateway ClusterPodMonitoring)", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(/containerPort:\s*9092\s*\n\s*name:\s*runner-metrics/);
    const svc = findDoc(out, "Service", "octogee-gateway-default") ?? "";
    expect(svc).toMatch(/name:\s*runner-metrics\s*\n\s*port:\s*9092\s*\n\s*targetPort:\s*9092/);
  });

  it("does not expose retired gateway-local preview or site-build surfaces", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const gateway = containerBlock(dep, "gateway");
    const svc = findDoc(out, "Service", "octogee-gateway-default") ?? "";
    const ingressPolicy = findDoc(
      out,
      "NetworkPolicy",
      "octogee-gateway-ingress-default",
    ) ?? "";

    expect(gateway).not.toMatch(/containerPort:\s*9080/);
    expect(gateway).not.toMatch(/name:\s*(?:SITE_BUILD_API_PORT|PREVIEW_HOST|PREVIEW_REQUIRE_GATEWAY_ID)/);
    expect(svc).not.toMatch(/(?:port|targetPort):\s*9080/);
    expect(ingressPolicy).not.toMatch(/port:\s*9080/);
  });

  it("exposes the migration rsync port only on the gateway container", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const gw = containerBlock(dep, "gateway");
    expect(gw).toMatch(/containerPort:\s*30873\s*\n\s*name:\s*migration-rsync/);
    expect(gw).toMatch(/name:\s*MIGRATION_RSYNC_PORT\s*\n\s*value:\s*"30873"/);

    const svc = findDoc(out, "Service", "octogee-gateway-default") ?? "";
    expect(svc).not.toMatch(/migration-rsync/);
  });

  it("runs user and shared gateways in the registered gVisor RuntimeClass", () => {
    const user = findDoc(helmTemplate("octogee-gw-user", {
      gatewayId: "builder",
      gatewayClass: "isolated",
    }), "Deployment", "octogee-gateway-builder") ?? "";
    const shared = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";

    expect(user).toMatch(/^ {6}runtimeClassName:\s*gvisor\s*$/m);
    expect(shared).toMatch(/^ {6}runtimeClassName:\s*gvisor\s*$/m);
  });

  it("runs a gateway on the node's default runtime when the installation has no sandbox runtime", () => {
    const shared = findDoc(helmTemplate("octogee-gw-default", { runtimeClassName: "" }), "Deployment", "octogee-gateway-default") ?? "";

    expect(shared).not.toMatch(/runtimeClassName/);
  });

  it("renders Restricted-compliant runtime containers and bounded home initialization capabilities", () => {
    const output = helmTemplate("octogee-gw-user", {
      gatewayId: "builder",
      gatewayClass: "isolated",
    });
    const deployment = parseAllDocuments(output)
      .map((document) => document.toJSON() as { kind?: string; metadata?: { name?: string }; spec?: { template?: { spec?: { securityContext?: Record<string, unknown>; containers?: Array<{ securityContext?: Record<string, unknown> }>; initContainers?: Array<{ name: string; securityContext?: Record<string, unknown> }> } } } })
      .find((document) => document.kind === "Deployment" && document.metadata?.name === "octogee-gateway-builder");
    const pod = deployment?.spec?.template?.spec;

    expect(pod?.securityContext?.runAsNonRoot).toBe(true);
    expect(pod?.securityContext?.seccompProfile).toEqual({ type: "RuntimeDefault" });
    for (const container of pod?.containers ?? []) {
      expect(container.securityContext?.allowPrivilegeEscalation).toBe(false);
      expect(container.securityContext?.capabilities).toEqual({ drop: ["ALL"] });
    }
    expect(pod?.initContainers?.map(({ name, securityContext }) => ({ name, securityContext }))).toEqual([
      {
        name: "fix-perms",
        securityContext: {
          runAsUser: 0,
          runAsNonRoot: false,
          allowPrivilegeEscalation: false,
          capabilities: { drop: ["ALL"], add: ["CHOWN", "FOWNER", "SETUID", "SETGID"] },
        },
      },
    ]);
  });

  it("renders a PodDisruptionBudget keyed by gateway-instance for an isolated gateway", () => {
    const out = helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      gatewayClass: "isolated",
    });
    const pdb = findDoc(out, "PodDisruptionBudget", "octogee-gateway-walter");
    expect(pdb).not.toBeNull();
    expect(pdb).toMatch(/gateway-instance:\s*walter/);
  });

  it("renders a shared slot's own PodDisruptionBudget keyed by gateway-instance", () => {
    const out = helmTemplate();
    const pdb = findDoc(out, "PodDisruptionBudget", "octogee-gateway-default");
    expect(pdb).not.toBeNull();
    expect(pdb).toMatch(/gateway-instance:\s*default/);
    expect(pdb).toMatch(/^\s*minAvailable:\s*1\s*$/m);
  });

  it("protects a healthy isolated gateway from voluntary eviction", () => {
    const pdb =
      findDoc(
        helmTemplate("octogee-gw-walter", { gatewayId: "walter", profile: "isolated" }),
        "PodDisruptionBudget",
        "octogee-gateway-walter",
      ) ?? "";
    expect(pdb).toMatch(/^\s*minAvailable:\s*1\s*$/m);
    expect(pdb).not.toMatch(/^\s*maxUnavailable:/m);
    expect(pdb).toMatch(/^\s*unhealthyPodEvictionPolicy:\s*AlwaysAllow\s*$/m);
  });

  it("pdb.enabled=false renders no PodDisruptionBudget", () => {
    const out = helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      gatewayClass: "isolated",
      "pdb.enabled": "false",
    });
    expect(findDoc(out, "PodDisruptionBudget", "octogee-gateway-walter")).toBeNull();
  });

  it("does NOT render the umbrella's spanning resources (alias Service, Ingress, NetworkPolicy)", () => {
    const out = helmTemplate();
    expect(findDoc(out, "Service", "octogee-gateway")).toBeNull();
    expect(findDoc(out, "Ingress", "octogee-gateway-fleet-control-ingress")).toBeNull();
    expect(findDoc(out, "Ingress", "preview-ingress")).toBeNull();
    expect(findDoc(out, "NetworkPolicy", "gateway-egress")).toBeNull();
  });

  it("emits a different deployment name for a second instance", () => {
    const out = helmTemplate("octogee-gw-canary", {
      gatewayId: "canary",
    });
    expect(findDoc(out, "Deployment", "octogee-gateway-canary")).not.toBeNull();
    expect(findDoc(out, "Service", "octogee-gateway-canary")).not.toBeNull();
    expect(findDoc(out, "Service", "gateway-edge-canary")).not.toBeNull();
  });
});

describe("helm/octogee-gateway/ — bundle image-tag inheritance", () => {
  it("inherits gateway + gateway-edge images from one imageTag field by default", () => {
    const out = helmTemplate("octogee-gw-default", { imageTag: "cafef00d" });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";

    const gatewayBlock = containerBlock(dep, "gateway");
    const wsApiBlock = containerBlock(dep, "gateway-edge");
    expect(gatewayBlock).toMatch(/image:\s*"[^"]*octogee-gateway:cafef00d"/);
    expect(wsApiBlock).toMatch(/image:\s*"[^"]*gateway-edge:cafef00d"/);
    expect(dep).not.toMatch(/octogee-chat-proxy/);
  });

  it("per-image override beats imageTag (escape hatch for hotfix)", () => {
    const out = helmTemplate("octogee-gw-default", {
      imageTag: "abc1234",
      "gatewayEdge.image.tag": "hotfix-ge-99",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const ge = containerBlock(dep, "gateway-edge");
    expect(ge).toMatch(/image:\s*"[^"]*gateway-edge:hotfix-ge-99"/);
    
    const gw = containerBlock(dep, "gateway");
    expect(gw).toMatch(/image:\s*"[^"]*octogee-gateway:abc1234"/);
  });

  it("uses a separately digest-bound gateway-edge image when explicitly set", () => {
    const gatewayTag = `8c356bb-oc2026.7.1@sha256:${"a".repeat(64)}`;
    const edgeTag = `8c356bb-oc2026.7.1@sha256:${"d".repeat(64)}`;
    const out = helmTemplate("octogee-gw-default", {
      imageTag: gatewayTag,
      "gatewayEdge.image.tag": edgeTag,
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const ge = containerBlock(dep, "gateway-edge");
    expect(ge).toMatch(new RegExp(`gateway-edge:${edgeTag.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`));
    expect(ge).not.toContain(gatewayTag);
  });
});

describe("helm/octogee-gateway/ — gateway-edge sidecar (chat-proxy folded in)", () => {
  it("renders gateway + gateway-edge containers; no separate chat-proxy container", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(/^ {8}- name:\s*gateway\s*$/m);
    expect(dep).toMatch(/^ {8}- name:\s*gateway-edge\s*$/m);
    expect(dep).not.toMatch(/- name:\s*chat-proxy\b/);
  });

  it("gateway-edge container exposes one port (chat-proxy folded onto 3001) — no separate chat/metrics ports", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const ge = containerBlock(dep, "gateway-edge");
    expect(ge).toMatch(/name:\s*gateway-edge/);

    expect(ge).not.toMatch(/name:\s*chat-proxy/);
    expect(ge).not.toMatch(/name:\s*cp-metrics/);
  });

  it("gateway-edge sidecar exposes port 3001 and probes /health", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const wsBlock = containerBlock(dep, "gateway-edge");
    expect(wsBlock).toMatch(/containerPort:\s*3001/);
    expect(wsBlock).toMatch(
      /startupProbe:[\s\S]*?path:\s*\/health[\s\S]*?periodSeconds:\s*10[\s\S]*?failureThreshold:\s*60/,
    );
    expect(wsBlock).toMatch(/livenessProbe:[\s\S]*?path:\s*\/health/);
  });

  it("cattle gateway-edge sidecar does not wire platform secrets from the chart's secrets list", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const wsBlock = containerBlock(dep, "gateway-edge");

    expect(wsBlock).not.toMatch(/INTERNAL_SERVICE_KEY/);
    expect(wsBlock).not.toMatch(/STRIPE_SECRET_KEY/);
    expect(wsBlock).not.toMatch(/MM_ADMIN_TOKEN/);
    expect(wsBlock).not.toMatch(/GITEA_TOKEN/);
    // GITHUB_TOKEN intentionally NOT in the platform chart — it comes
    // from per-user client secrets, not from a shared K8s secret.
  });

  it("gateway-edge sidecar mounts the model sync public verification key", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const wsBlock = containerBlock(dep, "gateway-edge");

    expect(wsBlock).toMatch(
      /name:\s*BYOT_SYNC_INTERNAL_PUBLIC_KEY\s*\n\s*valueFrom:\s*\n\s*secretKeyRef:\s*\n\s*name:\s*byot-sync-internal\s*\n\s*key:\s*public-key/,
    );
  });

  it("Isolated gateway-edge sidecar omits platform secret refs but keeps the per-gateway token", () => {
    const out = helmTemplate("octogee-gw-default", {
      profile: "isolated",
      "gatewayEdge.env.OCTOGEE_KMS_KEY_NAME": "projects/octogee/locations/us/keyRings/r/cryptoKeys/k",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const wsBlock = containerBlock(dep, "gateway-edge");

    for (const name of [
      "INTERNAL_SERVICE_KEY",
      "STRIPE_SECRET_KEY",
      "MM_ADMIN_TOKEN",
      "GITEA_TOKEN",
      "MM_ADMIN_PAT",
      "OCTOGEE_KMS_KEY_NAME",
    ]) {
      expect(wsBlock).not.toMatch(new RegExp(`name:\\s*${name}\\b`));
    }
    expect(wsBlock).toMatch(/name:\s*OPENCLAW_GATEWAY_TOKEN\b/);
  });

  it("cattle gateway-edge omits KMS key config even when set", () => {
    const out = helmTemplate("octogee-gw-default", {
      "gatewayEdge.env.OCTOGEE_KMS_KEY_NAME": "projects/octogee/locations/us/keyRings/r/cryptoKeys/k",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const wsBlock = containerBlock(dep, "gateway-edge");
    expect(wsBlock).not.toMatch(/name:\s*OCTOGEE_KMS_KEY_NAME/);
  });
});

describe("helm/octogee-gateway/ — gateway container required env", () => {
  it("threads APP_URL into the gateway container for environment-correct app links", () => {
    const out = helmTemplate("octogee-gw-default", {
      "gatewayEdge.env.APP_URL": "https://app-test.octogee.com",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const gw = containerBlock(dep, "gateway");
    expect(gw).toMatch(/- name:\s*APP_URL[\s\S]*?value:\s*"https:\/\/app-test\.octogee\.com"/);
  });

  it("emits MM_INTERACTIONS_CALLBACK_BASE_URL pointing at the stable private router", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(
      /- name:\s*MM_INTERACTIONS_CALLBACK_BASE_URL[\s\S]*?value:[^\n]*mattermost-callback-router\.octogee-test\.svc\.cluster\.local:3001\/internal\/openclaw\/mattermost\/default/,
    );
  });

  it("allows only the loopback interaction proxy into OpenClaw", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(/- name:\s*MM_INTERACTIONS_ALLOWED_SOURCE_IPS[\s\S]*?value:\s*"127\.0\.0\.1"/);
  });

  it("sets CLOUDSDK_CORE_PROJECT on the gateway container so gcloud cannot inherit the cluster host project", () => {
    const out = helmTemplate("octogee-gw-default", {
      "env.gcloudProject": "octogee-test",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const gw = containerBlock(dep, "gateway");
    expect(gw).toMatch(
      /- name:\s*CLOUDSDK_CORE_PROJECT[\s\S]*?value:\s*"octogee-test"/,
    );
  });

  it("keeps MM_ADMIN_PAT out of the runtime gateway container", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const gw = containerBlock(dep, "gateway");
    expect(gw).not.toMatch(/- name:\s*MM_ADMIN_PAT\b/);
  });

  it("does not provision a permanent gateway persona or Mattermost PAT", () => {
    const dep = findDoc(
      helmTemplate("octogee-gw-default-r5", { revisionId: "default-r5" }),
      "Deployment",
      "octogee-gateway-default-r5",
    ) ?? "";
    expect(dep).not.toMatch(/mac-ops-bootstrap|bootstrap-mac-ops|MM_BOT_USERNAME|MAC_OPS/);
    expect(dep).not.toMatch(/name:\s*MM_ADMIN_PAT\b/);
    expect(dep).not.toMatch(/name:\s*mattermost-gateway[\s\S]*?key:\s*admin_token/);
  });

  it("binds the gateway process to its exact rendered image tag without rollout context by default", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const gw = containerBlock(dep, "gateway");
    expect(gw).toMatch(/name:\s*GATEWAY_IMAGE_TAG[\s\S]*?value:\s*"abc1234"/);
    expect(gw).not.toMatch(/name:\s*SYSTEM_CONFIG_MIGRATION_ID/);
  });

  it("accepts no roll-context values — the target-candidate boot plane is retired", () => {
    const dep = findDoc(helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      gatewayClass: "isolated",
    }), "Deployment", "octogee-gateway-walter") ?? "";
    expect(dep).not.toMatch(/SYSTEM_CONFIG_MIGRATION_ID/);
    expect(dep).not.toMatch(/systemConfigRollContext/);
  });

  it("points the sidecar agent reconciler at the tracked config on isolated gateways", () => {
    const isolated = findDoc(
      helmTemplate("octogee-gw-walter", {
        gatewayId: "walter",
        gatewayClass: "isolated",
      }),
      "Deployment",
      "octogee-gateway-walter",
    ) ?? "";
    const isolatedEdge = containerBlock(isolated, "gateway-edge");
    expect(isolatedEdge).toMatch(
      /name:\s*OPENCLAW_CONFIG[\s\S]*?value:\s*"\/home\/node\/\.openclaw\/system_config\/openclaw\.json"/,
    );

    const shared = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const sharedEdge = containerBlock(shared, "gateway-edge");
    expect(sharedEdge).toMatch(
      /name:\s*OPENCLAW_CONFIG[\s\S]*?value:\s*"\/home\/node\/\.openclaw\/openclaw\.json"/,
    );
  });

  it("requires and publishes the native Dashboard bridge for every control-enabled isolated gateway", () => {
    const enabled = findDoc(
      helmTemplate("octogee-gw-user", {
        gatewayId: "builder",
        gatewayClass: "isolated",
        "builderAccess.controlUiEnabled": "true",
      }),
      "Deployment",
      "octogee-gateway-builder",
    ) ?? "";
    const enabledGateway = containerBlock(enabled, "gateway");
    const enabledEdge = containerBlock(enabled, "gateway-edge");
    expect(enabledGateway).toMatch(
      /name:\s*OPENCLAW_DASHBOARD_BRIDGE_REQUIRED[\s\S]*?value:\s*"true"/,
    );
    expect(enabledEdge).toMatch(
      /name:\s*OPENCLAW_DASHBOARD_BRIDGE_ENABLED[\s\S]*?value:\s*"true"/,
    );
    expect(enabledEdge).toMatch(
      /name:\s*OPENCLAW_DIR[\s\S]*?value:\s*"\/home\/node\/\.openclaw"/,
    );
    expect(enabledEdge).toMatch(
      /name:\s*OPENCLAW_CONFIG_PATH[\s\S]*?value:\s*"\/home\/node\/\.openclaw\/system_config\/openclaw\.json"/,
    );
    expect(enabledEdge).toMatch(
      /name:\s*OPENCLAW_CONTROL_BROKER_URL[\s\S]*?value:\s*"http:\/\/octogee-api\.octogee-test\.svc\.cluster\.local:3001"/,
    );
    expect(enabledEdge).not.toContain("OPENCLAW_CONTROL_RPC_POLICY_MODE");
    expect(enabledEdge).toMatch(/name:\s*API_PUBLIC_URL\b/);

    const disabledValueSets: Array<Record<string, string>> = [
      { gatewayId: "shared", gatewayClass: "shared", "builderAccess.controlUiEnabled": "true" },
      {
        gatewayId: "user-disabled",
        gatewayClass: "isolated",
        "builderAccess.controlUiEnabled": "false",
      },
      {
        gatewayId: "user-default",
        gatewayClass: "isolated",
      },
    ];
    for (const values of disabledValueSets) {
      const disabled = findDoc(
        helmTemplate(`octogee-gw-${values.gatewayId}`, values),
        "Deployment",
        `octogee-gateway-${values.gatewayId}`,
      ) ?? "";
      expect(containerBlock(disabled, "gateway")).not.toContain("OPENCLAW_DASHBOARD_BRIDGE_REQUIRED");
      expect(containerBlock(disabled, "gateway-edge")).not.toContain("OPENCLAW_DASHBOARD_BRIDGE_ENABLED");
    }
  });

  it("omits the Mattermost admin-PAT bootstrap init container on isolated gateways", () => {
    const dep =
      findDoc(
        helmTemplate("octogee-gw-default", { profile: "isolated" }),
        "Deployment",
        "octogee-gateway-default",
      ) ?? "";
    expect(dep).not.toMatch(/name:\s*mac-ops-bootstrap/);
    const init = dep.match(/initContainers:[\s\S]*?(?=\n {6}containers:)/)?.[0] ?? "";
    expect(init).not.toMatch(/name:\s*MM_ADMIN_PAT\b/);
    expect(init).not.toMatch(/name:\s*MM_BOT_TOKEN\b/);
  });

  it("seeds /home/node without masking a failed step", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(/initContainers:[\s\S]*?- name:\s*fix-perms/);
    const init = containerBlock(dep, "fix-perms");
    expect(init).toMatch(/cp -rn \/etc\/skel\/\. \/home\/node\//);
    expect(init).not.toContain("|| true");
    expect(init.match(/chown\s/g)).toHaveLength(1);
  });

  it("does not preserve source ownership/timestamps on the fix-perms copy (#2812: cp -a fails 'preserving times' — fsGroup already owns /home/node under restricted PSA)", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    const init = dep.match(/- name:\s*fix-perms\s*[\s\S]*?(?=\n {8}- name:|\n {6}containers:)/)?.[0] ?? "";
    expect(init).not.toMatch(/cp\s+-\w*a\w*\s/);
    expect(init).not.toMatch(/cp\s+-\w*p\w*\s/);
    expect(init).not.toMatch(/--preserve/);
    expect(init).not.toMatch(/--archive/);
  });

  it.each(["standard", "isolated"])(
    "stages the secret resolver in the init container and mounts it read-only for the runtime user (%s)",
    (profile) => {
      const dep =
        findDoc(
          helmTemplate("octogee-gw-default", { profile }),
          "Deployment",
          "octogee-gateway-default",
        ) ?? "";
      const podSpec = parseDocument(dep).toJS().spec.template.spec as {
        initContainers: Array<{ name: string; command?: string[]; volumeMounts?: Array<Record<string, unknown>> }>;
        containers: Array<{ name: string; volumeMounts?: Array<Record<string, unknown>> }>;
        volumes: Array<{ name: string; emptyDir?: Record<string, unknown> }>;
      };

      const init = podSpec.initContainers.find((c) => c.name === "fix-perms");
      expect(init?.command?.join("\n")).toMatch(
        /install -m 0500 \/octogee\/scripts\/secret-resolver\.mjs \/octogee-secret-resolver\/secret-resolver\.mjs/,
      );
      expect(init?.volumeMounts).toContainEqual({
        name: "secret-resolver",
        mountPath: "/octogee-secret-resolver",
      });

      const gateway = podSpec.containers.find((c) => c.name === "gateway");
      expect(gateway?.volumeMounts).toContainEqual({
        name: "secret-resolver",
        mountPath: "/octogee/scripts/secret-resolver.mjs",
        subPath: "secret-resolver.mjs",
        readOnly: true,
      });

      for (const container of podSpec.containers.filter((c) => c.name !== "gateway")) {
        expect(container.volumeMounts?.some((m) => m.name === "secret-resolver")).toBe(false);
      }
      expect(podSpec.volumes).toContainEqual({ name: "secret-resolver", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } });
    },
  );

  it("mounts the data volume at /home/node (whole home, not just .openclaw)", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";

    const dataMounts = dep.match(/- name:\s*data\s+mountPath:\s*\/home\/node\b/g) ?? [];
    expect(dataMounts.length).toBe(3);
    expect(dep).not.toMatch(/mountPath:\s*\/home\/node\/\.openclaw\b/);
  });

  it("Isolated gateways mount the data volume only on fix-perms, gateway, and gateway-edge", () => {
    const dep =
      findDoc(
        helmTemplate("octogee-gw-default", { profile: "isolated" }),
        "Deployment",
        "octogee-gateway-default",
      ) ?? "";
    const dataMounts = dep.match(/- name:\s*data\s+mountPath:\s*\/home\/node\b/g) ?? [];
    expect(dataMounts.length).toBe(3);
  });

  it("NPM_CONFIG_CACHE points at /home/node/.npm-cache (conventional home location)", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(
      /- name:\s*NPM_CONFIG_CACHE[\s\S]*?value:\s*"\/home\/node\/\.npm-cache"/,
    );
  });

  it("keeps shared startup/liveness on OpenClaw and gates readiness on surge handoff", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const gw = containerBlock(dep, "gateway");

    expect(gw).toMatch(/startupProbe:\s+httpGet:\s+path:\s*\/healthz\s+port:\s*18789/);
    expect(gw).toMatch(/livenessProbe:\s+tcpSocket:\s+port:\s*18789/);
    expect(gw).toMatch(/readinessProbe:\s+httpGet:\s+path:\s*\/surge-ready\s+port:\s*3003/);
  });

  it("probes isolated gateways identity-pure and gates readiness on surge handoff", () => {
    const dep = findDoc(
      helmTemplate("octogee-gw-walter", { gatewayId: "walter", gatewayClass: "isolated" }),
      "Deployment",
      "octogee-gateway-walter",
    ) ?? "";
    const gw = containerBlock(dep, "gateway");

    expect(gw).toMatch(/startupProbe:[\s\S]*?httpGet:\s+path:\s*\/startup-ready\s+port:\s*3003/);
    expect(gw).toMatch(/livenessProbe:\s+httpGet:\s+path:\s*\/health\s+port:\s*3003/);
    expect(gw).toMatch(/readinessProbe:\s+httpGet:\s+path:\s*\/surge-ready\s+port:\s*3003/);
    expect(gw).toMatch(/timeout\s+10s/);
    expect(gw).not.toContain("config-status-v2");
    expect(gw).not.toContain("18790");
    expect(dep).not.toMatch(/__openclaw__/);
  });

  it("keeps NotReady surge targets out of every per-instance Service", () => {
    const out = helmTemplate("octogee-gw-default", { gatewayClass: "isolated" });
    const gateway = findDoc(out, "Service", "octogee-gateway-default") ?? "";
    const edge = findDoc(out, "Service", "gateway-edge-default") ?? "";

    expect(gateway).not.toMatch(/publishNotReadyAddresses/);
    expect(edge).not.toMatch(/publishNotReadyAddresses/);
    expect(findDoc(helmTemplate(), "Service", "gateway-edge-default") ?? "").not.toMatch(
      /publishNotReadyAddresses/,
    );
  });

  it("does not suppress a failed durable pre-stop checkpoint", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const lifecycle = containerBlock(dep, "gateway").match(/lifecycle:[\s\S]*?(?=\n\s+env:)/)?.[0] ?? "";
    expect(lifecycle).toContain("prestop-flush.ts");
    expect(lifecycle).not.toContain("|| true");
  });
});

describe("helm/octogee-gateway/ — profile-aware credential injection", () => {
  it("routes the shared (default) gateway's anthropic through the broker with NO pod-level platform key", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default");
    expect(dep).not.toBeNull();
    const gw = containerBlock(dep ?? "", "gateway");
    // per-user broker tokens live in the auth-profile store, not the pod env
    expect(gw).not.toMatch(/name:\s*ANTHROPIC_API_KEY\b/);
    expect(gw).not.toMatch(/name:\s*octogee-anthropic/);
    expect(gw).toMatch(
      /name:\s*ANTHROPIC_BASE_URL[\s\S]*?value:\s*"http:\/\/llm-broker\.octogee-test\.svc\.cluster\.local:3010"/,
    );
  });

  it("renders no pod-level ANTHROPIC_API_KEY when profile is explicitly standard (shared → per-user broker tokens)", () => {
    const dep = findDoc(
      helmTemplate("octogee-gw-default", { profile: "standard" }),
      "Deployment",
      "octogee-gateway-default",
    );
    expect(dep).not.toBeNull();
    const gw = containerBlock(dep ?? "", "gateway");
    expect(gw).not.toMatch(/name:\s*ANTHROPIC_API_KEY\b/);
    expect(gw).toMatch(/name:\s*ANTHROPIC_BASE_URL\b/);
  });

  it("renders user fallback through the broker URL without provider-standard API key env", () => {
    const dep =
      findDoc(
        helmTemplate("octogee-gw-jack", {
          gatewayId: "jack",
          gatewayClass: "isolated",
        }),
        "Deployment",
        "octogee-gateway-jack",
      ) ?? "";
    const gw = containerBlock(dep, "gateway");
    expect(gw).not.toMatch(/name:\s*ANTHROPIC_API_KEY\b/);
    expect(gw).not.toMatch(/secretKeyRef:\s*\n\s*name:\s*gateway-model-key-jack\s*\n\s*key:\s*anthropic_api_key/);
    expect(gw).toMatch(/name:\s*ANTHROPIC_BASE_URL[\s\S]*?value:\s*"http:\/\/llm-broker\.octogee-test\.svc\.cluster\.local:3010"/);
    expect(gw).not.toMatch(/name:\s*octogee-anthropic/);
  });

  it("routes shared fallback traffic through the broker (base URL set, no direct platform key)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const gw = containerBlock(dep, "gateway");
    expect(gw).toMatch(/name:\s*ANTHROPIC_BASE_URL\b/);
    expect(gw).not.toMatch(/name:\s*octogee-anthropic/);
  });

  it("renders user model access through the broker URL without provider-standard API key env", () => {
    const dep = findDoc(
      helmTemplate("octogee-gw-default", {
        profile: "isolated",
        "gatewayEdge.env.OCTOGEE_KMS_KEY_NAME": "projects/octogee/locations/us/keyRings/r/cryptoKeys/k",
      }),
      "Deployment",
      "octogee-gateway-default",
    );
    expect(dep).not.toBeNull();
    const gw = containerBlock(dep ?? "", "gateway");
    expect(gw).not.toMatch(/name:\s*ANTHROPIC_API_KEY\b/);
    expect(gw).not.toMatch(/secretKeyRef:\s*\n\s*name:\s*gateway-model-key-default\s*\n\s*key:\s*anthropic_api_key/);
    expect(gw).toMatch(/name:\s*ANTHROPIC_BASE_URL[\s\S]*?value:\s*"http:\/\/llm-broker\.octogee-test\.svc\.cluster\.local:3010"/);
    expect(gw).not.toMatch(/name:\s*octogee-anthropic/);
  });

  it("omits shared platform credentials from the standard gateway and gateway-edge containers", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default");
    expect(dep).not.toBeNull();
    const gw = containerBlock(dep ?? "", "gateway");
    const edge = containerBlock(dep ?? "", "gateway-edge");

    for (const name of [
      "FLEET_CONTROLLER_SECRET",
      "FLEET_CONTROLLER_PRIVATE_KEY",
      "GIT_API_TOKEN",
      "BRAVE_API_KEY",
      "TAVILY_API_KEY",
      "MM_BOT_TOKEN",
      "MM_ADMIN_USER",
      "MM_ADMIN_PASS",
      "MM_BOT_USER_ID",
      "MM_ADMIN_USER_ID",
      "DISCORD_OPS_WEBHOOK_URL",
      "INTERNAL_SERVICE_KEY",
      // Gateway pods never carry provider-standard API key env names; the LLM broker
      // owns provider keys, while gateways receive broker-scoped credentials only.
      "ANTHROPIC_API_KEY",
    ]) {
      expect(gw).not.toMatch(new RegExp(`name:\\s*${name}\\b`));
    }
    expect(gw).toMatch(
      /name:\s*FLEET_CONTROLLER_PUBLIC_KEY[\s\S]*?secretKeyRef:[\s\S]*?name:\s*octogee-fleet-controller[\s\S]*?key:\s*public-key/,
    );
    for (const name of [
      "FLEET_CONTROLLER_PUBLIC_KEY",
      "FLEET_CONTROLLER_PRIVATE_KEY",
      "MM_ADMIN_PAT",
      "STRIPE_SECRET_KEY",
      "MM_ADMIN_TOKEN",
      "GITEA_TOKEN",
      "INTERNAL_SERVICE_KEY",
      "RESEND_API_KEY",
      "EMAIL_UNSUBSCRIBE_SECRET",
      "OCTOGEE_KMS_KEY_NAME",
    ]) {
      expect(edge).not.toMatch(new RegExp(`name:\\s*${name}\\b`));
    }
    expect(gw).toMatch(/name:\s*OPENCLAW_GATEWAY_TOKEN\b/);
    expect(edge).toMatch(/name:\s*OPENCLAW_GATEWAY_TOKEN\b/);
  });

  it("pins GATEWAY_EDGE_INTERNAL_URL on the gateway container to the gateway-edge port (survives a port override)", () => {
    const dep = findDoc(
      helmTemplate("octogee-gw-default", { "gatewayEdge.port": "9090" }),
      "Deployment",
      "octogee-gateway-default",
    );
    expect(dep).not.toBeNull();
    const gw = containerBlock(dep ?? "", "gateway");
    expect(gw).toMatch(/name:\s*GATEWAY_EDGE_INTERNAL_URL/);
    expect(gw).toMatch(/value:\s*["']?http:\/\/127\.0\.0\.1:9090["']?/);
  });

  it("omits platform tokens from isolated gateway + gateway-edge containers", () => {
    const dep = findDoc(
      helmTemplate("octogee-gw-default", { profile: "isolated" }),
      "Deployment",
      "octogee-gateway-default",
    );
    expect(dep).not.toBeNull();
    const gw = containerBlock(dep ?? "", "gateway");
    for (const name of [
      "FLEET_CONTROLLER_SECRET",
      "FLEET_CONTROLLER_PRIVATE_KEY",
      "GIT_API_TOKEN",
      "BRAVE_API_KEY",
      "TAVILY_API_KEY",
      "MM_BOT_TOKEN",
      "MM_ADMIN_USER",
      "MM_ADMIN_PASS",
      "MM_BOT_USER_ID",
      "MM_ADMIN_USER_ID",
      "DISCORD_OPS_WEBHOOK_URL",
      "INTERNAL_SERVICE_KEY",
    ]) {
      expect(gw).not.toMatch(new RegExp(`name:\\s*${name}\\b`));
    }
    expect(gw).not.toMatch(/name:\s*ANTHROPIC_API_KEY\b/);
    expect(gw).not.toMatch(/secretKeyRef:\s*\n\s*name:\s*gateway-model-key-default\s*\n\s*key:\s*anthropic_api_key/);
    expect(gw).toMatch(/name:\s*ANTHROPIC_BASE_URL\b/);
    expect(gw).not.toMatch(/name:\s*octogee-anthropic/);
    expect(gw).toMatch(
      /name:\s*FLEET_CONTROLLER_PUBLIC_KEY[\s\S]*?secretKeyRef:[\s\S]*?name:\s*octogee-fleet-controller[\s\S]*?key:\s*public-key/,
    );
    const edge = containerBlock(dep ?? "", "gateway-edge");
    for (const name of [
      "FLEET_CONTROLLER_PUBLIC_KEY",
      "FLEET_CONTROLLER_PRIVATE_KEY",
      "MM_ADMIN_PAT",
      "STRIPE_SECRET_KEY",
      "MM_ADMIN_TOKEN",
      "GITEA_TOKEN",
      "INTERNAL_SERVICE_KEY",
      "RESEND_API_KEY",
      "EMAIL_UNSUBSCRIBE_SECRET",
      "OCTOGEE_KMS_KEY_NAME",
    ]) {
      expect(edge).not.toMatch(new RegExp(`name:\\s*${name}\\b`));
    }
    expect(edge).toMatch(/name:\s*OPENCLAW_GATEWAY_TOKEN\b/);
  });

  it("threads the chart's profile through to gateway and gateway-edge containers", () => {
    const operatorDep =
      findDoc(
        helmTemplate("octogee-gw-default", { profile: "isolated" }),
        "Deployment",
        "octogee-gateway-default",
      ) ?? "";
    const operatorGateway = containerBlock(operatorDep, "gateway");
    const operatorEdge = containerBlock(operatorDep, "gateway-edge");
    expect(operatorGateway).toMatch(
      /- name:\s*GATEWAY_PROFILE[\s\S]*?value:\s*"isolated"/,
    );
    expect(operatorEdge).toMatch(
      /- name:\s*GATEWAY_PROFILE[\s\S]*?value:\s*"isolated"/,
    );

const cattleDep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const cattleGateway = containerBlock(cattleDep, "gateway");
    const cattleEdge = containerBlock(cattleDep, "gateway-edge");
    expect(cattleGateway).toMatch(/- name:\s*GATEWAY_PROFILE[\s\S]*?value:\s*"standard"/);
    expect(cattleGateway).toMatch(/- name:\s*GATEWAY_CLASS[\s\S]*?value:\s*"shared"/);
    expect(cattleEdge).toMatch(/- name:\s*GATEWAY_PROFILE[\s\S]*?value:\s*"standard"/);
    expect(cattleEdge).toMatch(/- name:\s*GATEWAY_CLASS[\s\S]*?value:\s*"shared"/);
  });
});

describe("helm/octogee-gateway/ — per-instance Service annotations", () => {
  it("does not attach public NEG or BackendConfig annotations to per-instance Services", () => {
    const out = helmTemplate();
    const gatewaySvc = findDoc(out, "Service", "octogee-gateway-default") ?? "";
    const edgeSvc = findDoc(out, "Service", "gateway-edge-default") ?? "";
    for (const svc of [gatewaySvc, edgeSvc]) {
      const annotations = parseDocument(svc).toJSON().metadata.annotations ?? {};
      expect(annotations).not.toHaveProperty(["cloud.google.com/neg"]);
      expect(annotations).not.toHaveProperty(["cloud.google.com/backend-config"]);
      expect(svc).not.toMatch(/octogee-gateway-fleet-control/);
      expect(svc).not.toMatch(/"3003":/);
    }
  });

  it("still exposes the fleet-control port on the Service for in-cluster callers", () => {
    const out = helmTemplate();
    const svc = findDoc(out, "Service", "octogee-gateway-default") ?? "";
    expect(svc).toMatch(/port:\s*3003/);
  });
});

describe("helm/octogee-gateway/ — per-instance persistence + security knobs", () => {
  it("renders the Omarchy VM runtime without disks or a desktop in the pod", () => {
    const out = helmTemplate("octogee-gw-omarchy", { gatewayId: "omarchy", gatewayClass: "isolated", sizingTier: "s", computerDesktop: "omarchy" });
    const pod = parseDocument(findDoc(out, "Deployment", "octogee-gateway-omarchy")!).toJSON().spec.template.spec;
    expect(findDoc(out, "PersistentVolumeClaim", "octogee-gateway-omarchy-data")).toBeNull();
    expect(pod.volumes).toContainEqual({ name: "data", emptyDir: { sizeLimit: "4Gi" } });
    expect(pod.volumes.map((entry: any) => entry.name)).not.toContain("desktop-runtime");
  });

  it("renders an X11 VM user with its desktop in the gateway and the VM home layout", () => {
    const out = helmTemplate("octogee-gw-x11", { gatewayId: "x11", gatewayClass: "isolated", sizingTier: "s", computerDesktop: "x11", runtimeKind: "gce-vm" });
    const pod = parseDocument(findDoc(out, "Deployment", "octogee-gateway-x11")!).toJSON().spec.template.spec;
    expect(pod.initContainers.map((entry: any) => entry.name)).toEqual(["fix-perms"]);
    expect(pod.volumes.map((entry: any) => entry.name)).toEqual(expect.arrayContaining(["project-materializations", "desktop-node-identity", "desktop-runtime", "desktop-shm"]));
    for (const name of ["gateway", "gateway-edge"]) {
      const container = pod.containers.find((entry: any) => entry.name === name);
      expect(container.env).toEqual(expect.arrayContaining([
        { name: "GATEWAY_RUNTIME_KIND", value: "gce-vm" }, { name: "GATEWAY_COMPUTER_DESKTOP", value: "x11" },
        { name: "OCTOGEE_PROJECTS_MOUNT", value: "/work/materialized" },
      ]));
      expect(container.volumeMounts.filter((mount: any) => mount.subPath === "volumes/data" || mount.subPath === "desktop-home")).toEqual([]);
      expect(container.volumeMounts).toContainEqual(expect.objectContaining({ name: "desktop-node-identity", mountPath: "/run/octogee/desktop-node-identity" }));
    }
  });

  it("shared gateways use emptyDir with no PVC and a locked-down securityContext", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).toMatch(/emptyDir:\s*\{\}/);
    expect(parseDocument(dep).toJSON().spec.template.metadata.annotations ?? {}).not.toHaveProperty(["cluster-autoscaler.kubernetes.io/safe-to-evict"]);
    expect(dep).toMatch(/allowPrivilegeEscalation:\s*false/);
    expect(dep).toMatch(/drop:\s*\n\s*-\s*ALL/);
    expect(
      findDoc(out, "PersistentVolumeClaim", "octogee-gateway-default-data"),
    ).toBeNull();
  });

  it("never renders a PVC even if a stale persistence.enabled value is passed", () => {
    const out = helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      "persistence.enabled": "true",
    });
    expect(findDoc(out, "PersistentVolumeClaim", "octogee-gateway-walter-data")).toBeNull();
    const dep = findDoc(out, "Deployment", "octogee-gateway-walter") ?? "";
    expect(dep).not.toMatch(/persistentVolumeClaim:/);
    expect(dep).toMatch(/emptyDir:\s*\{\}/);
  });

  it("Isolated gateway sets no safe-to-evict (extended-duration is unsupported on Spot)", () => {
    const out = helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      profile: "isolated",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-walter") ?? "";
    expect(parseDocument(dep).toJSON().spec.template.metadata.annotations ?? {}).not.toHaveProperty(["cluster-autoscaler.kubernetes.io/safe-to-evict"]);
  });

  it("shared gateway leaves voluntary disruption protection to its identity PDB", () => {
    const out = helmTemplate("octogee-gw-default", {
      gatewayId: "default",
      gatewayClass: "shared",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-default") ?? "";
    expect(parseDocument(dep).toJSON().spec.template.metadata.annotations ?? {}).not.toHaveProperty(["cluster-autoscaler.kubernetes.io/safe-to-evict"]);
  });

  it("gatewayContainerSecurityContext override elevates one instance without touching the default", () => {
    const out = helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      "gatewayContainerSecurityContext.allowPrivilegeEscalation": "true",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-walter") ?? "";
    expect(dep).toMatch(/allowPrivilegeEscalation:\s*true/);
  });
});

function networkPolicyIngressRules(np: string): Array<Record<string, any>> {
  const parsed = parseDocument(np).toJSON() as { spec?: { ingress?: Array<Record<string, any>> } };
  return parsed.spec?.ingress ?? [];
}

describe("helm/octogee-gateway/ — gateway ingress policy", () => {
  function ingressPolicy(values: Record<string, string> = {}): string {
    return findDoc(
      helmTemplate("octogee-gw-default", values),
      "NetworkPolicy",
      "octogee-gateway-ingress-default",
    ) ?? "";
  }

  it("limits gateway-edge and fleet-control ingress to their explicit sources", () => {
    const rules = networkPolicyIngressRules(ingressPolicy());
    const sourcesForPort = (port: number) => rules
      .filter((rule) => rule.ports.some((candidate: any) => candidate.port === port))
      .flatMap((rule) => rule.from.map((source: any) => source.podSelector?.matchLabels?.app))
      .filter(Boolean)
      .sort();

    expect(sourcesForPort(3001)).toEqual([
      "gateway-router",
      "mattermost-callback-router",
      "octogee-api",
    ]);
    expect(sourcesForPort(3003)).toEqual(["glm-controller", "octogee-gateway"]);
    expect(rules.some((rule) =>
      rule.ports.some((candidate: any) => candidate.port === 18789))).toBe(false);
  });

  it("scopes runner metrics to GMP collectors", () => {
    const rule = networkPolicyIngressRules(ingressPolicy()).find((candidate) =>
      candidate.ports?.some((port: any) => port.port === 9092));
    expect(rule?.from).toEqual([{
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "gke-gmp-system" } },
    }]);
  });

  it("allows migration rsync ingress only from peer gateway pods", () => {
    const rule = networkPolicyIngressRules(ingressPolicy()).find((candidate) =>
      candidate.ports?.some((port: any) => port.port === 30873));
    expect(rule?.from).toEqual([{
      podSelector: { matchLabels: { app: "octogee-gateway" } },
    }]);
  });

  it("does not render when network policy is explicitly disabled", () => {
    expect(ingressPolicy({ "networkPolicy.enabled": "false" })).toBe("");
  });
});

describe("helm/octogee-gateway/ - personal gateway metadata boundary", () => {
  const policyName = "octogee-gateway-metadata-egress-walter";

  it("rejects the retired mutable user access flag", () => {
    expect(() => helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      profile: "isolated",
      "builderAccess.platformMetadataEgress": "true",
    })).toThrow(/platformMetadataEgress/u);
  });

  it("never exposes metadata to a personal isolated gateway", () => {
    const out = helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      profile: "isolated",
    });
    expect(findDoc(out, "NetworkPolicy", policyName)).toBeNull();
    expect(out).not.toContain("169.254.169.254");
  });
});

describe("helm/octogee-gateway/ - User Kubernetes API-server egress NetworkPolicy", () => {
  const policyName = "octogee-gateway-apiserver-egress-walter";
  const apiServerCidr = (lastOctet: number) =>
    ["10", "128", "0", String(lastOctet)].join(".") + "/32";
  const apiServerCidrPattern = (lastOctet: number) =>
    new RegExp(`cidr:\\s*"${escapeRegex(apiServerCidr(lastOctet))}"`);

  it("is NOT rendered by default for locked isolated gateways", () => {
    const out = helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      profile: "isolated",
    });
    expect(findDoc(out, "NetworkPolicy", policyName)).toBeNull();
  });

  it("is NOT rendered for standard-profile gateways even when API-server CIDRs are set", () => {
    const out = helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      "builderAccess.kubeApiServerEgressCidrs[0]": apiServerCidr(2),
    });
    expect(findDoc(out, "NetworkPolicy", policyName)).toBeNull();
  });

  it("is NOT rendered when NetworkPolicy is explicitly disabled", () => {
    const out = helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      profile: "isolated",
      "builderAccess.kubeApiServerEgressCidrs[0]": apiServerCidr(2),
      "networkPolicy.enabled": "false",
    });
    expect(findDoc(out, "NetworkPolicy", policyName)).toBeNull();
  });

  it("renders only explicit API-server /32 egress paths on :443 when enabled", () => {
    const np = findDoc(
      helmTemplate("octogee-gw-walter", {
        gatewayId: "walter",
        profile: "isolated",
        "builderAccess.kubeApiServerEgressCidrs[0]": apiServerCidr(2),
        "builderAccess.kubeApiServerEgressCidrs[1]": apiServerCidr(3),
      }),
      "NetworkPolicy",
      policyName,
    );
    expect(np).not.toBeNull();
    expect(np).toMatch(/policyTypes:\s*\n\s*-\s*Egress/);
    expect(np).toMatch(/podSelector:[\s\S]*?app:\s*octogee-gateway/);
    expect(np).toMatch(/podSelector:[\s\S]*?gateway-instance:\s*walter/);
    expect(np).toMatch(apiServerCidrPattern(2));
    expect(np).toMatch(apiServerCidrPattern(3));
    expect(np).toMatch(/protocol:\s*TCP/);
    expect(np).toMatch(/port:\s*443/);
    expect(np).not.toMatch(/0\.0\.0\.0\/0/);
    expect(np).not.toMatch(/169\.254\.169\.254\/32/);
    expect(np).not.toMatch(/port:\s*80/);
  });

  it("rejects link-local CIDRs so the API-server path cannot reopen metadata", () => {
    expect(() => helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      profile: "isolated",
      "builderAccess.kubeApiServerEgressCidrs[0]": "169.254.169.254/32",
    })).toThrow(/must not contain link-local CIDRs/u);
  });
});

describe("helm/octogee-gateway/ — required value validation", () => {
  it("fails to render when gatewayId is missing", () => {
    const args = [
      "template",
      "octogee-gw-broken",
      CHART_PATH,
      "--namespace=octogee-test",
      "--set",
      "imageTag=abc",
      "--set",
      "env.mmSiteUrl=https://x",
    ];
    const result = spawnSync("helm", args, { encoding: "utf-8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/gatewayId/);
  });

  describe("env dedup — gateway profiles omit INTERNAL_SERVICE_KEY from the pod", () => {
    it("standard and user profiles render no INTERNAL_SERVICE_KEY entries", () => {
      const operatorOut = helmTemplate("octogee-gw-walter", {
        gatewayId: "walter",
        profile: "isolated",
      });
      const baselineOut = helmTemplate();
      const operatorDep = findDoc(
        operatorOut,
        "Deployment",
        "octogee-gateway-walter",
      );
      const baselineDep = findDoc(
        baselineOut,
        "Deployment",
        "octogee-gateway-default",
      );
      expect(operatorDep).not.toBeNull();
      expect(baselineDep).not.toBeNull();
      const count = (s: string): number =>
        (s.match(/name:\s*INTERNAL_SERVICE_KEY/g) ?? []).length;
      expect(count(operatorDep!)).toBe(0);
      expect(count(baselineDep!)).toBe(0);
    });

    it("INTERNAL_SERVICE_KEY is absent from both user containers", () => {
      const out = helmTemplate("octogee-gw-walter", {
        gatewayId: "walter",
        profile: "isolated",
      });
      const dep = findDoc(out, "Deployment", "octogee-gateway-walter");
      expect(dep).not.toBeNull();
      const count = (dep!.match(/name:\s*INTERNAL_SERVICE_KEY/g) ?? []).length;
      expect(count).toBe(0);
      const gw = containerBlock(dep ?? "", "gateway");
      const edge = containerBlock(dep ?? "", "gateway-edge");
      expect(gw).not.toMatch(/name:\s*INTERNAL_SERVICE_KEY\b/);
      expect(edge).not.toMatch(/name:\s*INTERNAL_SERVICE_KEY\b/);
    });
  });
});

// ── Platform-owned OPENCLAW_GATEWAY_TOKEN ──────────────────────────────────
// Pre-#TBD the token was generated inside the pod by entrypoint.sh and
// mirrored to GCP Secret Manager. That left K8s/helm blind to it, so an
// agent's openclaw.json edit + a kubectl-set-env workaround for the gap on
// gateway-edge produced field-manager drift that silently dropped
// INTERNAL_SERVICE_KEY when #1159's dedup landed. New model: the fleet controller creates
// a per-gateway K8s secret `gateway-auth-token-{gatewayId}` with a random
// value; the chart threads it via secretKeyRef on every container that
// needs it. Token is stable across reboots, helm-owned end to end.
describe("helm/octogee-gateway/ — OPENCLAW_GATEWAY_TOKEN platform-owned", () => {
  const SECRET_NAME = "gateway-auth-token-default";

  function envBlock(dep: string, containerName: "gateway" | "gateway-edge"): string {
    return containerBlock(dep, containerName);
  }

  function initContainerBlock(dep: string): string {
    return dep.match(/initContainers:[\s\S]*?(?=\n {6}containers:)/)?.[0] ?? "";
  }

  function tokenEntry(block: string): string {
    // Slice the 8 lines starting at the OPENCLAW_GATEWAY_TOKEN env entry —
    // covers the entire `valueFrom: secretKeyRef: { name, key }` sub-block
    // without resorting to a wide-lookahead regex.
    const lines = block.split("\n");
    const idx = lines.findIndex((l) =>
      /- name:\s*OPENCLAW_GATEWAY_TOKEN\b/.test(l),
    );
    if (idx === -1) return "";
    return lines.slice(idx, idx + 8).join("\n");
  }

  it("renders OPENCLAW_GATEWAY_TOKEN via secretKeyRef on the gateway container (not a plain value)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const gw = envBlock(dep, "gateway");
    const entry = tokenEntry(gw);
    expect(entry).toMatch(/secretKeyRef:/);
    expect(entry).toMatch(new RegExp(`name:\\s*${SECRET_NAME}\\b`));
    expect(entry).toMatch(/key:\s*token\b/);
  });

  it("renders OPENCLAW_GATEWAY_TOKEN via secretKeyRef on the gateway-edge container (same secret — single source of truth)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const ge = envBlock(dep, "gateway-edge");
    const entry = tokenEntry(ge);
    expect(entry).toMatch(/secretKeyRef:/);
    expect(entry).toMatch(new RegExp(`name:\\s*${SECRET_NAME}\\b`));
    expect(entry).toMatch(/key:\s*token\b/);
  });

  it("renders OPENCLAW_GATEWAY_TOKEN via secretKeyRef on the fix-perms init container (so the PVC seed sees the same token the gateway will use)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const init = initContainerBlock(dep);
    const entry = tokenEntry(init);
    expect(entry).toMatch(/secretKeyRef:/);
    expect(entry).toMatch(new RegExp(`name:\\s*${SECRET_NAME}\\b`));
    expect(entry).toMatch(/key:\s*token\b/);
  });

  it("does NOT render OPENCLAW_GATEWAY_TOKEN as a plain `value:` anywhere (proves platform owns it via secretKeyRef, not entrypoint-generated)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    expect(dep).not.toMatch(/name:\s*OPENCLAW_GATEWAY_TOKEN[\s\S]{0,80}\n\s+value:\s*[^\n]+/);
  });

  it("derives the secret name from gatewayId so user and cattle gateways get distinct secrets", () => {
    const walterOut = helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      profile: "isolated",
    });
    const walterDep = findDoc(walterOut, "Deployment", "octogee-gateway-walter") ?? "";
    expect(walterDep).toMatch(/name:\s*gateway-auth-token-walter\b/);
    expect(walterDep).not.toMatch(/name:\s*gateway-auth-token-default\b/);
  });

  it("User profile threads the same secret on the same three containers (no profile-specific drift)", () => {
    const dep =
      findDoc(
        helmTemplate("octogee-gw-default", { profile: "isolated" }),
        "Deployment",
        "octogee-gateway-default",
      ) ?? "";
    const count = (dep.match(/name:\s*OPENCLAW_GATEWAY_TOKEN\b/g) ?? []).length;
    expect(count).toBe(3);
  });

  it("cattle profile threads the same secret on the same three containers (no profile-specific drift)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const count = (dep.match(/name:\s*OPENCLAW_GATEWAY_TOKEN\b/g) ?? []).length;
    expect(count).toBe(3);
  });
});

// ── GCP_PROJECT_ID on gateway-edge ─────────────────────────────────────────
// Pre-#TBD GCP_PROJECT_ID was only rendered on the `gateway` container; for
// gateway-edge an operator had to `kubectl set env` it in by hand, which
// created the kubectl-set field-manager ownership that broke #1159's dedup
// merge. The chart already has `gatewayEdge.env.GCP_PROJECT_ID` in
// defaults — pin that as a contract so a future trim doesn't silently
// remove it.
describe("helm/octogee-gateway/ — GCP_PROJECT_ID on gateway-edge", () => {
  it("renders GCP_PROJECT_ID on the gateway-edge container for cattle profile (no kubectl-set workaround needed)", () => {
    const dep = findDoc(
      helmTemplate("octogee-gw-default", { "gatewayEdge.env.GCP_PROJECT_ID": "example-project" }),
      "Deployment",
      "octogee-gateway-default",
    ) ?? "";
    const ge = containerBlock(dep, "gateway-edge");
    expect(ge).toMatch(/- name:\s*GCP_PROJECT_ID[\s\S]*?value:\s*"example-project"/);
  });

  it("renders GCP_PROJECT_ID on the gateway-edge container for user profile", () => {
    const dep =
      findDoc(
        helmTemplate("octogee-gw-default", { profile: "isolated", "gatewayEdge.env.GCP_PROJECT_ID": "example-project" }),
        "Deployment",
        "octogee-gateway-default",
      ) ?? "";
    const ge = containerBlock(dep, "gateway-edge");
    expect(ge).toMatch(/- name:\s*GCP_PROJECT_ID/);
  });
});

describe("helm/octogee-gateway/ — platform model catalog convergence", () => {
  it("gives gateway-edge the broker catalog endpoints used after a user is mounted", () => {
    const dep = findDoc(
      helmTemplate("octogee-gw-builder-alice", {
        gatewayId: "builder-alice",
        gatewayClass: "isolated",
        imageProfile: "isolated",
      }),
      "Deployment",
      "octogee-gateway-builder-alice",
    ) ?? "";
    const edge = containerBlock(dep, "gateway-edge");

    expect(edge).toMatch(
      /name:\s*OPENROUTER_BASE_URL[\s\S]*?value:\s*"http:\/\/llm-broker\.octogee-test\.svc\.cluster\.local:3010\/v1"/,
    );
    expect(edge).toMatch(
      /name:\s*PLATFORM_OPENAI_BASE_URL[\s\S]*?value:\s*"http:\/\/llm-broker\.octogee-test\.svc\.cluster\.local:3010\/v1"/,
    );
  });

  it("carries the Vertex rail base URL on both containers only when env.platformVertexEnabled is set", () => {
    const render = (enabled: boolean) => findDoc(
      helmTemplate("octogee-gw-builder-alice", {
        gatewayId: "builder-alice",
        gatewayClass: "isolated",
        imageProfile: "isolated",
        ...(enabled ? { "env.platformVertexEnabled": "true" } : {}),
      }),
      "Deployment",
      "octogee-gateway-builder-alice",
    ) ?? "";
    const off = render(false);
    expect(off).not.toMatch(/PLATFORM_VERTEX_BASE_URL/);
    const on = render(true);
    for (const name of ["gateway", "gateway-edge"] as const) {
      expect(containerBlock(on, name)).toMatch(
        /name:\s*PLATFORM_VERTEX_BASE_URL[\s\S]*?value:\s*"http:\/\/llm-broker\.octogee-test\.svc\.cluster\.local:3010"/,
      );
    }
  });
});

// ── Profile-aware render-time assertions ───────────────────────────────────
// Gateway-edge platform secrets are no longer render-required. Routes that still
// need platform authority fail closed until they move behind octogee-api/fleet controller.
describe("helm/octogee-gateway/ — platform secret render assertions", () => {
  function templateWithLegacyGatewayEdgeSecrets(extra: Record<string, string> = {}): {
    status: number | null;
    stderr: string;
  } {
    const args = [
      "template",
      "octogee-gw-default",
      CHART_PATH,
      "--namespace=octogee-test",
      "--set",
      "gatewayId=default",
      "--set",
      "imageTag=abc",
      "--set",
      "image.repository=registry.example/octogee-gateway",
      "--set",
      "gatewayEdge.image.repository=registry.example/gateway-edge",
      "--set",
      "env.mmInternalUrl=http://x",
      "--set",
      "gatewayEdge.publicAppOrigins[0]=https://app-test.octogee.com",
      "--set",
      "env.mmSiteUrl=https://x",
      // Legacy footgun: the chart no longer owns or renders gatewayEdge.secrets.
      "--set-json",
      'gatewayEdge.secrets=[{"envName":"STRIPE_SECRET_KEY","secretName":"stripe-secrets","secretKey":"secret_key","optional":true}]',
    ];
    for (const [k, v] of Object.entries(extra)) args.push("--set", `${k}=${v}`);
    const result = spawnSync("helm", args, { encoding: "utf-8" });
    return { status: result.status, stderr: result.stderr };
  }

  it("renders user profile when legacy gatewayEdge.secrets omits INTERNAL_SERVICE_KEY", () => {
    const result = templateWithLegacyGatewayEdgeSecrets({
      profile: "isolated",
    });
    expect(result.status).toBe(0);
  });

  it("renders cattle profile when legacy gatewayEdge.secrets omits INTERNAL_SERVICE_KEY", () => {
    const result = templateWithLegacyGatewayEdgeSecrets();
    expect(result.status).toBe(0);
  });
});

// ── values.schema.json defense-in-depth ────────────────────────────────────
// Helm validates values.schema.json before rendering — so structurally bad
// inputs (missing required top-level keys, wrong types) fail BEFORE template
// logic runs. The removed gatewayEdge.secrets block is intentionally not part
// of the schema; owned values such as gatewayEdge.env remain shape-checked.
describe("helm/octogee-gateway/ — values.schema.json", () => {
  it("rejects a values file with gatewayEdge.env as the wrong type", () => {
    const args = [
      "template",
      "octogee-gw-default",
      CHART_PATH,
      "--namespace=octogee-test",
      "--set",
      "gatewayId=default",
      "--set",
      "imageTag=abc",
      "--set",
      "env.mmInternalUrl=http://x",
      "--set",
      "gatewayEdge.publicAppOrigins[0]=https://app-test.octogee.com",
      "--set",
      "env.mmSiteUrl=https://x",
      "--set-json",
      'gatewayEdge.env="not-an-object"',
    ];
    const result = spawnSync("helm", args, { encoding: "utf-8" });
    expect(result.status).not.toBe(0);
    // helm's schema-validation error wording varies by version; tolerate either.
    expect(result.stderr).toMatch(/schema|values don't meet|validation/i);
  });

  it("rejects an empty profile when set to an unknown enum value (isolated gateways have an explicit set of profiles)", () => {
    const args = [
      "template",
      "octogee-gw-default",
      CHART_PATH,
      "--namespace=octogee-test",
      "--set",
      "gatewayId=default",
      "--set",
      "imageTag=abc",
      "--set",
      "env.mmInternalUrl=http://x",
      "--set",
      "gatewayEdge.publicAppOrigins[0]=https://app-test.octogee.com",
      "--set",
      "env.mmSiteUrl=https://x",
      "--set",
      "profile=bogus-profile-name",
    ];
    const result = spawnSync("helm", args, { encoding: "utf-8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/schema|profile|enum/i);
  });
});

// ── Class-wide K8s schema invariant: env entries are EITHER value OR valueFrom ─
// K8s rejects any env entry with both `value` and `valueFrom` set:
//   "valueFrom: Invalid value: ...: may not be specified when value is not empty"
// A live PROD apply on 2026-05-24 (octogee-gw-walter helm rev 33) was
// rejected by K8s because a chart-render-vs-live-state strategic-merge
// collision combined kubectl-set-managed `value:` with helm-managed
// `valueFrom:` for the same env name. The chart itself rendered clean
// — the collision was in the apply, not the manifest. But the failure
// mode is easy to recreate from the chart side too (e.g. a future `if`
// branch that adds `valueFrom:` without unconditionally suppressing a
// sibling `value:` line). This guard walks every env entry across every
// container in every profile and fails loud at chart-render time,
// before anything reaches a cluster.
//
// Parse via real YAML rather than regex — env blocks are deeply nested
// and regex-walking miscounts (the original reproduce attempt did).
import { parseAllDocuments } from "yaml";

interface ContainerEnv {
  name?: string;
  value?: unknown;
  valueFrom?: unknown;
}

function collectAllEnvEntries(
  dep: string,
): Array<{ container: string; index: number; entry: ContainerEnv }> {
  const docs = parseAllDocuments(dep);
  const deployment = docs[0]?.toJS() as
    | { spec?: { template?: { spec?: Record<string, unknown> } } }
    | undefined;
  const podSpec = deployment?.spec?.template?.spec;
  if (!podSpec) throw new Error("findDoc returned a non-Deployment doc");

  const out: Array<{ container: string; index: number; entry: ContainerEnv }> = [];
  const sections: Array<[string, unknown]> = [
    ["initContainers", podSpec.initContainers],
    ["containers", podSpec.containers],
  ];
  for (const [section, rawContainers] of sections) {
    const containers = Array.isArray(rawContainers) ? rawContainers : [];
    for (const c of containers) {
      const cont = c as { name?: string; env?: unknown };
      const env = Array.isArray(cont.env) ? (cont.env as ContainerEnv[]) : [];
      env.forEach((entry, index) => {
        out.push({ container: `${section}/${cont.name ?? "?"}`, index, entry });
      });
    }
  }
  return out;
}

function findDoubleSetEntries(
  entries: ReturnType<typeof collectAllEnvEntries>,
): typeof entries {
  return entries.filter(
    ({ entry }) =>
      entry.value !== undefined &&
      entry.value !== null &&
      entry.valueFrom !== undefined &&
      entry.valueFrom !== null,
  );
}

describe("helm/octogee-gateway/ — env entries pass K8s schema (no value+valueFrom)", () => {
  it("cattle profile: no env entry sets both `value` and `valueFrom` (K8s rejects with 'may not be specified when value is not empty')", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const bad = findDoubleSetEntries(collectAllEnvEntries(dep));
    if (bad.length > 0) {
      // Detailed diagnostic so a regression points at the exact entries.
      const summary = bad
        .map(
          (b) =>
            `  ${b.container}[${b.index}] name=${b.entry.name} value=${JSON.stringify(b.entry.value)} valueFrom=${JSON.stringify(b.entry.valueFrom)}`,
        )
        .join("\n");
      throw new Error(`Double-set env entries (K8s will reject):\n${summary}`);
    }
    expect(bad).toEqual([]);
  });

  it("User profile: no env entry sets both `value` and `valueFrom`", () => {
    const out = helmTemplate("octogee-gw-walter", {
      gatewayId: "walter",
      profile: "isolated",
    });
    const dep = findDoc(out, "Deployment", "octogee-gateway-walter") ?? "";
    const bad = findDoubleSetEntries(collectAllEnvEntries(dep));
    if (bad.length > 0) {
      const summary = bad
        .map(
          (b) =>
            `  ${b.container}[${b.index}] name=${b.entry.name} value=${JSON.stringify(b.entry.value)} valueFrom=${JSON.stringify(b.entry.valueFrom)}`,
        )
        .join("\n");
      throw new Error(`Double-set env entries (K8s will reject):\n${summary}`);
    }
    expect(bad).toEqual([]);
  });

  it("every env entry has a non-empty `name` (sanity guard: an entry without a name is silently dropped by K8s)", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "octogee-gateway-default") ?? "";
    const entries = collectAllEnvEntries(dep);
    const nameless = entries.filter(
      ({ entry }) => typeof entry.name !== "string" || entry.name.length === 0,
    );
    expect(nameless).toEqual([]);
  });

});
