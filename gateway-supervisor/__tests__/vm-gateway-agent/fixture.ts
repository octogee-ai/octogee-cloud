import type { GatewayVmRuntimeBundle } from "@octogee/shared/types/glm";

export function bundleFixture(overrides: Partial<GatewayVmRuntimeBundle> = {}): GatewayVmRuntimeBundle {
  return {
    version: "v1",
    gatewayId: "b-x",
    namespace: "shared-test",
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
    imageTag: "main.abc",
    desktop: "omarchy",
    init: {
      name: "fix-perms",
      image: "us-central1-docker.pkg.dev/octogee/octogee/gateway:main.abc",
      env: { OPENCLAW_GATEWAY_TOKEN: "gwtoken" },
      command: ["sh", "-c", "cp -rn /etc/skel/. /home/node/"],
      args: null,
      mounts: [
        { volume: "data", mountPath: "/home/node", readOnly: false, subPath: null },
        { volume: "secret-resolver", mountPath: "/octogee-secret-resolver", readOnly: false, subPath: null },
      ],
    },
    containers: [
      {
        name: "gateway",
        image: "us-central1-docker.pkg.dev/octogee/octogee/gateway:main.abc",
        env: { GATEWAY_ID: "b-x", POD_UID: "", K8S_NAMESPACE: "shared-test" },
        command: null,
        args: null,
        mounts: [
          { volume: "data", mountPath: "/home/node", readOnly: false, subPath: null },
          { volume: "secret-resolver", mountPath: "/octogee/scripts/secret-resolver.mjs", readOnly: true, subPath: "secret-resolver.mjs" },
          { volume: "gateway-broker-sa-token", mountPath: "/var/run/secrets/octogee-gateway-broker", readOnly: true, subPath: null },
        ],
      },
      {
        name: "gateway-edge",
        image: "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge:main.abc",
        env: { GATEWAY_ID: "b-x", PORT: "3001" },
        command: null,
        args: null,
        mounts: [
          { volume: "data", mountPath: "/home/node", readOnly: false, subPath: null },
          { volume: "k8s-api-token", mountPath: "/var/run/secrets/kubernetes.io/serviceaccount", readOnly: true, subPath: null },
        ],
      },
    ],
    volumes: [
      { name: "data", kind: "emptyDir" },
      { name: "secret-resolver", kind: "emptyDir" },
      { name: "gateway-broker-sa-token", kind: "identityToken", audience: "octogee-api" },
      { name: "k8s-api-token", kind: "kubernetesApi" },
    ],
    hostAliases: { "octogee-api.shared-test.svc.cluster.local": "10.128.9.9" },
    kubernetes: { apiHost: "10.128.0.2", apiPort: "443", caCert: "CA-PEM" },
    renderedAt: 1,
    ...overrides,
  };
}
