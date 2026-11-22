import { isDeepStrictEqual } from "node:util";
import type { UntypedRecord } from "@octogee/core/platform-state";
import { computeChartFingerprint } from "../chart-fingerprint.js";
import type { HelmSubprocess } from "../helm-runner.js";
import type { SourceRecoveryWorkload } from "./shared-source-images.js";
import { json, type SharedPodRecoveryDeps } from "./shared-restore-runtime.js";

type Images = Record<"gateway" | "gateway-edge", string>;
type Dependencies = Pick<SharedPodRecoveryDeps, "namespace" | "runKubectl"> & { environment: "test" | "prod"; runHelm: HelmSubprocess };

function tag(image: string) {
  const match = /^([^@]+):([a-f0-9]{7}[a-zA-Z0-9.-]*@sha256:[a-f0-9]{64})$/.exec(image);
  if (!match) throw new Error("Shared maintenance needs a tagged immutable role image");
  return match[2]!;
}

function named(items: UntypedRecord[], name: string): UntypedRecord {
  const rows = items?.filter(row => row.name === name);
  if (rows?.length !== 1) throw new Error("Unexpected Shared maintenance template roster");
  return rows[0]!;
}

function projected(template: UntypedRecord, from: Images, to: Images) {
  const expected = structuredClone(template);
  function set(row: UntypedRecord, key: string, old: string, next: string) {
    if (row[key] !== old && row[key] !== next) throw new Error("Unexpected value in Shared maintenance template");
    row[key] = next;
  }
  const gateway = named(expected.spec.containers, "gateway");
  set(gateway, "image", from.gateway, to.gateway);
  set(named(expected.spec.containers, "gateway-edge"), "image", from["gateway-edge"], to["gateway-edge"]);
  set(named(expected.spec.initContainers, "fix-perms"), "image", from.gateway, to.gateway);
  set(named(gateway.env, "GATEWAY_IMAGE_TAG"), "value", tag(from.gateway), tag(to.gateway));
  set(expected.metadata.labels, "gateway-image", tag(from.gateway).slice(0,7), tag(to.gateway).slice(0,7));
  return expected;
}

export function alignMaintenanceTemplate(replicaSet: UntypedRecord, deployment: UntypedRecord, from: Images, to: Images) {
  const aligned = projected(replicaSet, from, to);
  const comparable = structuredClone(aligned);
  delete comparable.metadata.labels["pod-template-hash"];
  if (!isDeepStrictEqual(comparable, deployment)) throw new Error("Unexpected retained Deployment or ReplicaSet template drift");
  return aligned;
}

export function verifyMaintenanceManifest(before: UntypedRecord[], after: UntypedRecord[], deployment: string, from: Images, to: Images) {
  const expected = structuredClone(before);
  const targets = expected.filter(row => row.kind === "Deployment" && row.metadata?.name === deployment);
  if (targets.length !== 1) throw new Error("Shared maintenance Helm manifest is missing its exact Deployment");
  targets[0]!.spec.template = projected(targets[0]!.spec.template, from, to);
  if (!isDeepStrictEqual(expected, after)) throw new Error("Unexpected change in Shared maintenance Helm manifest");
}

interface Adoption {
  gatewayId: string;
  chart: string;
  installedChartFingerprint: string;
  from: Images;
  to: Images;
}

function checkInstallation(installed: UntypedRecord, release: string, gatewayId: string, namespace: string, fingerprint: string) {
  if (installed.name !== release || installed.namespace !== namespace || installed.info?.status !== "deployed" ||
      installed.config?.gatewayId !== gatewayId || installed.config?.gatewayClass !== "shared" ||
      installed.config?.chartFingerprint !== fingerprint || !Number.isSafeInteger(installed.version)) {
    throw new Error("Unexpected installed Shared Helm release");
  }
}

export async function adoptRetainedSharedHelm(
  deps: Dependencies, workload: SourceRecoveryWorkload, selection: Adoption, assertCurrent: () => Promise<void>,
) {
  const { gatewayId, chart, installedChartFingerprint, from, to } = selection;
  if (![deps.environment === "test", workload.deploymentName === `octogee-gateway-${gatewayId}`,
    computeChartFingerprint(chart) === installedChartFingerprint].every(Boolean)) {
    throw new Error("Unexpected Shared maintenance installation");
  }
  const release = `octogee-gw-${gatewayId}`;
  const helm = async (args: string[]) => {
    const result = await deps.runHelm([...args, "-n", deps.namespace, "-o", "json"]);
    if (result.code !== 0) throw new Error("Shared maintenance Helm operation did not succeed");
    return JSON.parse(result.stdout) as UntypedRecord;
  };
  const parse = async (manifest: string): Promise<UntypedRecord[]> => {
    const result = await deps.runKubectl(["-n", deps.namespace, "create", "--dry-run=client", "--validate=false", "-f", "-", "-o", 'jsonpath={@}{"\\n"}'], {stdin:manifest});
    if (result.code !== 0) throw new Error("Invalid Shared Helm manifest");
    const rows = result.stdout.trim().split("\n").map(row => JSON.parse(row) as UntypedRecord);
    if (!rows.length || rows.some(row => !row.kind || !row.metadata?.name)) throw new Error("Invalid Shared release resource list");
    return rows;
  };
  async function currentWorkload() {
    await assertCurrent();
    const [deployment, rs] = await Promise.all([json(deps, ["get","deployment",workload.deploymentName]), json(deps, ["get","replicaset",workload.replicaSetName])]);
    if (deployment.metadata.uid !== workload.deploymentUid || rs.metadata.uid !== workload.replicaSetUid || deployment.spec.paused !== true ||
      rs.metadata.ownerReferences?.filter((r: UntypedRecord) => r.controller && r.uid === workload.deploymentUid).length !== 1) {
      throw new Error("Shared workload lost its pause or owner before Helm adoption");
    }
    return {deployment,rs};
  }
  await currentWorkload();
  const statusArgs = ["status",release];
  const installed = await helm(statusArgs);
  checkInstallation(installed,release,gatewayId,deps.namespace,installedChartFingerprint);
  const upgrade = ["upgrade", release, chart, "--reuse-values", "--no-hooks", "--server-side=false",
    "--set-string", `imageTag=${tag(to.gateway)}`,
    "--set-string", `gatewayEdge.image.tag=${tag(to["gateway-edge"])}`];
  const dry = await helm([...upgrade, "--dry-run=server"]);
  const [original, candidate] = await Promise.all([parse(installed.manifest),parse(dry.manifest)]);
  verifyMaintenanceManifest(original,candidate,workload.deploymentName,from,to);
  if (dry.hooks?.length || installed.hooks?.length) throw new Error("Shared maintenance requires a hook-free chart");
  if (!isDeepStrictEqual(original, candidate)) {
    await currentWorkload();
    const latest = await helm(statusArgs);
    if (![latest.version === installed.version, latest.manifest === installed.manifest, latest.info.status === "deployed"].every(Boolean)) {
      throw new Error("Shared Helm release changed during maintenance");
    }
    await assertCurrent();
    await helm(upgrade);
  }
  const observed = await helm(statusArgs);
  checkInstallation(observed,release,gatewayId,deps.namespace,installedChartFingerprint);
  if (![observed.config?.imageTag === tag(to.gateway), observed.config?.gatewayEdge?.image?.tag === tag(to["gateway-edge"]),
    isDeepStrictEqual(await parse(observed.manifest), candidate)].every(Boolean)) {
    throw new Error("Installed Shared Helm release differs from its accepted render");
  }
  const {deployment,rs} = await currentWorkload();
  const aligned = alignMaintenanceTemplate(rs.spec.template,deployment.spec.template,from,to);
  if (!isDeepStrictEqual(rs.spec.template,aligned)) {
    await assertCurrent();
    await json(deps,["patch","replicaset",workload.replicaSetName,"--type=json","-p",JSON.stringify([
      {op:"test",path:"/metadata/uid",value:workload.replicaSetUid},
      {op:"test",path:"/metadata/resourceVersion",value:rs.metadata.resourceVersion},
      {op:"test",path:"/spec/template",value:rs.spec.template},
      {op:"replace",path:"/spec/template",value:aligned},
    ])]);
  }
  const end=await currentWorkload();
  if (!isDeepStrictEqual(alignMaintenanceTemplate(end.rs.spec.template,end.deployment.spec.template,to,to),end.rs.spec.template)) throw new Error("Shared Helm adoption did not retain its ReplicaSet");
  await assertCurrent();
}
