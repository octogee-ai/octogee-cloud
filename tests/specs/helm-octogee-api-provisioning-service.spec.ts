import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { findDoc, useUmbrellaChart } from "./helpers/umbrella-chart";

const chart = useUmbrellaChart("octogee-api-provisioning-service-");

interface ApiPod {
  containers: { env: { name: string; value?: string }[]; volumeMounts: unknown[] }[];
  volumes: { name: string }[];
}

function apiPod(extraValues?: string): ApiPod {
  const deployment = findDoc(chart.helmTemplate({ extraValues }), "Deployment", "octogee-api");
  expect(deployment, "the kind values render the octogee-api Deployment").not.toBeNull();
  return (parse(deployment!) as { spec: { template: { spec: ApiPod } } }).spec.template.spec;
}

describe("octogee-api provisioning service settings", () => {
  it("passes no provisioning service settings when no URL is set", () => {
    const pod = apiPod();

    expect(pod.containers[0].env.map((entry) => entry.name)).not.toContain("PROVISIONING_SERVICE_URL");
    expect(pod.volumes.map((volume) => volume.name)).not.toContain("provisioning-service-token");
  });

  it("passes the URL and a projected token for the provisioning-service audience when a URL is set", () => {
    const pod = apiPod([
      "octogee-api:",
      "  provisioningService:",
      "    url: http://provisioning-service.octogee-test.svc.cluster.local:8080",
    ].join("\n"));
    const env = Object.fromEntries(pod.containers[0].env.map((entry) => [entry.name, entry.value]));

    expect(env.PROVISIONING_SERVICE_URL).toBe("http://provisioning-service.octogee-test.svc.cluster.local:8080");
    expect(env.PROVISIONING_SERVICE_TOKEN_PATH).toBe("/var/run/secrets/provisioning-service/token");
    expect(pod.containers[0].volumeMounts).toContainEqual({
      name: "provisioning-service-token",
      mountPath: "/var/run/secrets/provisioning-service",
      readOnly: true,
    });
    expect(pod.volumes).toContainEqual({
      name: "provisioning-service-token",
      projected: { sources: [{ serviceAccountToken: { path: "token", audience: "provisioning-service", expirationSeconds: 3600 } }] },
    });
  });
});
