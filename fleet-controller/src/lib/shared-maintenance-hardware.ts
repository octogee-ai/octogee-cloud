import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { SharedHeldReturnMaintenancePlan } from "@octogee/core/fleet-state";
import type { SurgeKubectl } from "../surge-user-handoff-runtime.js";
import { assertLegacySharedTransferIdle } from "./shared-maintenance-ingress.js";
import type { observeSharedGuest } from "./shared-maintenance-guest-probe.js";

type Metadata = {
  uid: string;
  name: string;
  resourceVersion: string;
  namespace: string;
  labels: Record<string, string>;
  deletionTimestamp?: string;
  generation?: number;
  ownerReferences?: { controller?: boolean; kind: string; uid: string; name: string }[];
};
type Container = {
  name: string;
  image: string;
  env?: { name: string; value?: string }[];
  volumeMounts?: {
    name: string;
    mountPath: string;
    readOnly?: boolean;
    subPath?: string;
    subPathExpr?: string;
  }[];
};
type Template = {
  metadata: { labels: Record<string, string> };
  spec: { containers: Container[]; initContainers: Container[] };
};
type Controller = {
  metadata: Metadata;
  spec: { replicas: number; paused?: boolean; template: Template };
  status: { observedGeneration: number };
};
type Status = {
  name: string;
  containerID: string;
  imageID: string;
  ready: boolean;
  state: { running?: unknown; terminated?: { exitCode: number } };
};
type Pod = {
  metadata: Metadata;
  spec: Template["spec"] & {
    runtimeClassName: string;
    volumes: { name: string; emptyDir?: unknown }[];
  };
  status: {
    podIP: string;
    conditions: { type: string; status: string }[];
    containerStatuses: Status[];
    initContainerStatuses: Status[];
  };
};
type Workload = SharedHeldReturnMaintenancePlan["workload"];
type Owners = Pick<SharedHeldReturnMaintenancePlan["owners"][number], "uid" | "slug" | "epoch">[];
type Guest = Awaited<ReturnType<typeof observeSharedGuest>>;
const imageRoles = ["gateway", "gateway-edge"] as const;

function requireHardware(ok: unknown): asserts ok {
  if (!ok) throw new Error("Shared maintenance retained workload changed");
}
export function matchSharedHardware(
  pod: Pod,
  rs: Controller,
  deploy: Controller,
  expected: Workload,
) {
  requireHardware(
    ![pod, rs, deploy].some((x) => x.metadata.deletionTimestamp) &&
      [rs, deploy].every((x) => x.spec.replicas === 1 && x.metadata.namespace === pod.metadata.namespace),
  );
  requireHardware(
    pod.metadata.uid === expected.podUid &&
      pod.metadata.name === expected.podName &&
      rs.metadata.uid === expected.replicaSetUid &&
      deploy.metadata.uid === expected.deploymentUid,
  );
  requireHardware(
    [pod, rs].every((child, i) => {
      const parent = i === 0 ? rs : deploy,
        kind = i === 0 ? "ReplicaSet" : "Deployment";
      const refs = child.metadata.ownerReferences?.filter((r) => r.controller === true);
      return (
        refs?.length === 1 &&
        refs[0]!.name === parent.metadata.name &&
        refs[0]!.uid === parent.metadata.uid &&
        refs[0]!.kind === kind
      );
    }),
  );
  requireHardware(pod.spec.runtimeClassName === "gvisor" && pod.spec.containers.length === 2);
  const scoped = imageRoles.map((role) => {
    const container = pod.spec.containers.find((c) => c.name === role),
      status = pod.status.containerStatuses.find((c) => c.name === role);
    requireHardware(container && status);
    const home = container.volumeMounts?.filter((v) => v.mountPath === "/home/node");
    requireHardware(
      home?.length === 1 &&
        !home[0]!.subPath &&
        !home[0]!.subPathExpr &&
        !home[0]!.readOnly &&
        pod.spec.volumes.some((v) => v.name === home[0]!.name && v.emptyDir != null),
    );
    return { role, home: home[0]!.name, container, status };
  });
  requireHardware(scoped[0]!.home === scoped[1]!.home);
  const init = pod.status.initContainerStatuses.filter((x) => x.name === "fix-perms");
  const tag = scoped[0]!.container.env?.find((e) => e.name === "GATEWAY_IMAGE_TAG")?.value;
  requireHardware(
    init.length === 1 && init[0]!.state.terminated?.exitCode === 0 && init[0]!.imageID && tag,
  );
  return {
    pod,
    rs,
    deploy,
    workload: expected,
    ready:
      pod.status.conditions.some((c) => c.type === "Ready" && c.status === "True") &&
      scoped.every(({ container, status }) => {
        const digest = /@(sha256:[a-f0-9]{64})$/.exec(container.image)?.[1];
        return !!digest && status.ready && !!status.state.running && !!status.containerID &&
          status.imageID?.split("@").at(-1) === digest;
      }),
    images: { gateway: scoped[0]!.container.image, "gateway-edge": scoped[1]!.container.image },
    runningImageIds: {
      gateway: scoped[0]!.status.imageID,
      "gateway-edge": scoped[1]!.status.imageID,
    },
    containers: {
      gateway: scoped[0]!.status.containerID,
      "gateway-edge": scoped[1]!.status.containerID,
    },
    retainedBoot: { completedInitImageId: init[0]!.imageID, gatewayImageTag: tag },
  };
}

function settled(candidate: ReturnType<typeof matchSharedHardware>) {
  return candidate.ready && !candidate.deploy.spec.paused &&
    [candidate.deploy, candidate.rs].every(({ metadata, spec, status }) =>
      metadata.generation === status.observedGeneration &&
      imageRoles.every(role =>
        spec.template.spec.containers.find(container => container.name === role)?.image === candidate.images[role],
      ),
    );
}

export function createSharedHardwareObserver(run: SurgeKubectl, namespace: string) {
  async function execute(args: string[], opts?: { stdin?: string; timeoutMs?: number }) {
    const result = await run(["-n", namespace, ...args], opts);
    if (result.code !== 0) throw new Error("Cannot read retained Shared maintenance evidence");
    return result.stdout;
  }
  async function read<T>(...args: string[]): Promise<T> {
    return JSON.parse(await execute(["get", ...args, "-o", "json"])) as T;
  }
  async function topology(gatewayId: string, expected: Workload) {
    requireHardware(/^[a-z0-9][a-z0-9-]*$/.test(gatewayId));
    const pods = (
      await read<{ items: Pod[] }>(
        "pods",
        "-l",
        "app=octogee-gateway,gateway-instance=" + gatewayId,
      )
    ).items;
    requireHardware(pods.length === 1);
    const pod = pods[0]!;
    requireHardware(
      pod.metadata.uid === expected.podUid &&
        pod.metadata.namespace === namespace &&
        pod.metadata.labels["gateway-instance"] === gatewayId,
    );
    const rsName = pod.metadata.ownerReferences?.find(
      (x) => x.controller && x.kind === "ReplicaSet",
    )?.name;
    requireHardware(rsName);
    const [rs, deploy] = await Promise.all([
      read<Controller>("replicaset", rsName),
      read<Controller>("deployment", "octogee-gateway-" + gatewayId),
    ]);
    return matchSharedHardware(pod, rs, deploy, expected);
  }
  async function physical(gatewayId: string, expected: Workload, owners: Owners) {
    const hardware = await topology(gatewayId, expected);
    requireHardware(settled(hardware));
    const script = await readFile(
      new URL("./shared-maintenance-guest-probe.js", import.meta.url),
      "utf8",
    );
    const scope = Buffer.from(
      JSON.stringify({ namespace, gatewayId, podUid: expected.podUid, owners }),
    ).toString("base64");
    const observation = JSON.parse(
      await execute(
        [
          "exec",
          "-i",
          expected.podName,
          "-c",
          "gateway",
          "--",
          "sh",
          "-c",
          'cd /octogee/scripts && exec node --input-type=module - "$@"',
          "observe-retained-shared",
          "observe-retained-shared-member",
          scope,
        ],
        { stdin: script, timeoutMs: 20_000 },
      ),
    ) as Guest;
    assertLegacySharedTransferIdle(observation, { podUid: expected.podUid, gatewayId });
    const confirmed = await topology(gatewayId, expected);
    requireHardware(
      isDeepStrictEqual(confirmed.containers, hardware.containers) && settled(confirmed),
    );
    return { hardware: confirmed, observation, observedAt: Date.now() };
  }
  return { topology, physical, read };
}
