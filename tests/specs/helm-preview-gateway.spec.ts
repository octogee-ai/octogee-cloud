import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

import { useUmbrellaChart } from "./helpers/umbrella-chart";

const chart = useUmbrellaChart("octogee-preview-gateway-");

interface Resource {
  apiVersion: string;
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec: Record<string, unknown>;
}

const PREVIEW_KINDS = ["Gateway", "HTTPRoute", "GCPBackendPolicy", "HealthCheckPolicy"];

const enabledValues = [
  "previewGateway:",
  "  enabled: true",
  "  domain: previews.example.com",
  "  certificateMapName: previews-example-map",
  "  staticIpName: previews-example-ip",
  "  securityPolicyName: previews-example-policy",
].join("\n");

function resources(out: string): Resource[] {
  return parseAllDocuments(out)
    .map((doc) => doc.toJS() as Resource | null)
    .filter((doc): doc is Resource => doc !== null);
}

function find(out: string, kind: string, name: string): Resource {
  const match = resources(out).find((doc) => doc.kind === kind && doc.metadata.name === name);
  expect(match, `${kind}/${name} renders`).toBeDefined();
  return match!;
}

describe("preview gateway", () => {
  it("renders nothing new while previewGateway is unset", () => {
    const out = chart.helmTemplate();

    expect(resources(out).filter((doc) => PREVIEW_KINDS.includes(doc.kind))).toEqual([]);
    expect(resources(out).find((doc) => doc.metadata.name === "preview-gateway-backend")).toBeUndefined();
  });

  it("renders the same chart when previewGateway is configured but disabled", () => {
    const disabled = enabledValues.replace("enabled: true", "enabled: false");

    expect(chart.helmTemplate({ extraValues: disabled })).toBe(chart.helmTemplate());
  });

  it("serves only the wildcard host under the configured domain over HTTPS", () => {
    const gateway = find(chart.helmTemplate({ extraValues: enabledValues }), "Gateway", "preview-gateway");

    expect(gateway.apiVersion).toBe("gateway.networking.k8s.io/v1");
    expect(gateway.spec).toEqual({
      gatewayClassName: "gke-l7-global-external-managed",
      addresses: [{ type: "NamedAddress", value: "previews-example-ip" }],
      listeners: [
        {
          name: "https",
          protocol: "HTTPS",
          port: 443,
          hostname: "*.previews.example.com",
          allowedRoutes: { namespaces: { from: "Same" } },
        },
      ],
    });
  });

  it("attaches the certificate map by name", () => {
    const gateway = find(chart.helmTemplate({ extraValues: enabledValues }), "Gateway", "preview-gateway");

    expect(gateway.metadata.annotations).toEqual({ "networking.gke.io/certmap": "previews-example-map" });
  });

  it("routes every path on the wildcard host to the preview backend Service", () => {
    const out = chart.helmTemplate({ extraValues: enabledValues });
    const route = find(out, "HTTPRoute", "preview-gateway");

    expect(route.apiVersion).toBe("gateway.networking.k8s.io/v1");
    expect(route.spec).toEqual({
      parentRefs: [{ name: "preview-gateway", sectionName: "https" }],
      hostnames: ["*.previews.example.com"],
      rules: [{ backendRefs: [{ name: "preview-gateway-backend", port: 80 }] }],
    });
  });

  it("gives the gateway its own Service in front of the platform API pods", () => {
    const service = find(chart.helmTemplate({ extraValues: enabledValues }), "Service", "preview-gateway-backend");

    expect(service.metadata.annotations).toBeUndefined();
    expect(service.spec).toEqual({
      type: "ClusterIP",
      selector: { app: "octogee-api" },
      ports: [{ name: "http", port: 80, targetPort: "http" }],
    });
  });

  it("puts the Cloud Armor policy and full request logging on the preview backend Service", () => {
    const policy = find(chart.helmTemplate({ extraValues: enabledValues }), "GCPBackendPolicy", "preview-gateway-backend");

    expect(policy.apiVersion).toBe("networking.gke.io/v1");
    expect(policy.spec).toEqual({
      default: {
        securityPolicy: "previews-example-policy",
        logging: { enabled: true, sampleRate: 1000000 },
      },
      targetRef: { group: "", kind: "Service", name: "preview-gateway-backend" },
    });
  });

  it("health checks the platform API's health path on its serving port", () => {
    const policy = find(chart.helmTemplate({ extraValues: enabledValues }), "HealthCheckPolicy", "preview-gateway-backend");

    expect(policy.apiVersion).toBe("networking.gke.io/v1");
    expect(policy.spec).toEqual({
      default: {
        config: {
          type: "HTTP",
          httpHealthCheck: { portSpecification: "USE_SERVING_PORT", requestPath: "/health" },
        },
      },
      targetRef: { group: "", kind: "Service", name: "preview-gateway-backend" },
    });
  });

  it("lets the load balancer's proxies and health checks reach the backend pods under default deny", () => {
    const out = chart.helmTemplate({
      extraValues: enabledValues,
      sets: {
        "networkPolicy.enforceDefaultDeny": "true",
        "networkPolicy.controlPlaneCidr": "172.16.0.0/28",
        "networkPolicy.privateServicesCidr": "10.10.0.0/16",
      },
    });
    const service = find(out, "Service", "preview-gateway-backend");
    const policy = find(out, "NetworkPolicy", "octogee-api-ingress");
    const rules = policy.spec.ingress as { from: { ipBlock?: { cidr: string } }[]; ports: { port: number }[] }[];
    const loadBalancerRule = rules.find((rule) => rule.from.some((peer) => peer.ipBlock));

    expect(policy.spec.podSelector).toEqual({ matchLabels: service.spec.selector });
    expect(loadBalancerRule).toEqual({
      from: [{ ipBlock: { cidr: "35.191.0.0/16" } }, { ipBlock: { cidr: "130.211.0.0/22" } }],
      ports: [{ protocol: "TCP", port: 3001 }],
    });
    expect(find(out, "Deployment", "octogee-api")).toMatchObject({
      spec: { template: { spec: { containers: [{ ports: [{ name: "http", containerPort: 3001 }] }] } } },
    });
  });

  it.each(["domain", "certificateMapName", "staticIpName", "securityPolicyName"])(
    "refuses to render when enabled without %s",
    (key) => {
      const missing = enabledValues.split("\n").filter((line) => !line.startsWith(`  ${key}:`)).join("\n");

      expect(() => chart.helmTemplate({ extraValues: missing })).toThrow(/previewGateway|schema|values don't meet/i);
    },
  );

  it.each(["*.previews.example.com", "https://previews.example.com", "Previews.Example.com", "previews.example.com."])(
    "refuses the domain %s, which is not a bare lower-case host name",
    (domain) => {
      const values = enabledValues.replace("domain: previews.example.com", `domain: ${JSON.stringify(domain)}`);

      expect(() => chart.helmTemplate({ extraValues: values })).toThrow(/domain|schema|values don't meet/i);
    },
  );
});
