import type { KubectlSubprocess, KubectlSubprocessResult } from "./fleet-ingress.js";

export interface PrepullImage {
  repository: string;
  tag: string;
}

export type ImagePrepuller = (input: {
  namespace: string;
  images: readonly PrepullImage[];
}) => Promise<void>;

interface ImagePrepullerDeps {
  runKubectl: KubectlSubprocess;
  log: (message: string) => void;
}

const DAEMONSET_NAME = "octogee-gateway-image-prepull";

function imageReference(image: PrepullImage): string {
  return `${image.repository}:${image.tag}`;
}

function uniqueImages(images: readonly PrepullImage[]): PrepullImage[] {
  return [...new Map(images.map((image) => [imageReference(image), image])).values()];
}

function manifest(namespace: string, images: readonly PrepullImage[]): string {
  const refs = uniqueImages(images).map(imageReference);
  if (refs.length === 0) throw new Error("image prepull requires at least one target image");
  return JSON.stringify({
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: { name: DAEMONSET_NAME, namespace },
    spec: {
      selector: { matchLabels: { app: DAEMONSET_NAME } },
      template: {
        metadata: { labels: { app: DAEMONSET_NAME } },
        spec: {
          terminationGracePeriodSeconds: 0,
          tolerations: [{ operator: "Exists" }],
          initContainers: refs.map((image, index) => ({
            name: `pull-${index}`,
            image,
            imagePullPolicy: "IfNotPresent",
            command: ["sh", "-c", "true"],
          })),
          containers: [{
            name: "hold",
            image: refs[0],
            imagePullPolicy: "IfNotPresent",
            command: ["sh", "-c", "sleep 3600"],
          }],
        },
      },
    },
  });
}

function commandError(action: string, result: KubectlSubprocessResult): Error {
  return new Error(
    `${action} failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
  );
}

export function createImagePrepuller(deps: ImagePrepullerDeps): ImagePrepuller {
  return async ({ namespace, images }) => {
    let primaryError: Error | null = null;
    try {
      const apply = await deps.runKubectl(["apply", "-n", namespace, "-f", "-"], {
        stdin: manifest(namespace, images),
      });
      if (apply.code !== 0) throw commandError("image prepull apply", apply);
      const rollout = await deps.runKubectl([
        "rollout",
        "status",
        `daemonset/${DAEMONSET_NAME}`,
        "-n",
        namespace,
        "--timeout=10m",
      ]);
      if (rollout.code !== 0) throw commandError("image prepull rollout", rollout);
      deps.log(`[image-prepull] target images are present on every node in ${namespace}`);
    } catch (error) {
      primaryError = error instanceof Error ? error : new Error(String(error));
    }

    const cleanup = await deps.runKubectl([
      "delete",
      "daemonset",
      DAEMONSET_NAME,
      "-n",
      namespace,
      "--ignore-not-found",
    ]);
    if (cleanup.code !== 0) {
      const cleanupError = commandError("image prepull cleanup", cleanup);
      if (primaryError) throw new Error(`${primaryError.message}; ${cleanupError.message}`);
      throw cleanupError;
    }
    if (primaryError) throw primaryError;
  };
}
