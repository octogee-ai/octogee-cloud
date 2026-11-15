import { readFile } from "node:fs/promises";

export interface VmContext {
  gatewayId: string;
  ownerUid: string;
  computerInstanceId: string;
  agentAccountId: string;
  ownerMattermostUserId: string | null;
}

export interface VmBrokerOptions {
  agentId: string;
  signal: AbortSignal;
  brokerUrl?: string;
  tokenPath?: string;
  fetchImpl?: typeof fetch;
  readTokenImpl?: (path: string) => Promise<string>;
}

const INVALID_VM_CONTEXT = "Invalid VM context";

function resolveRuntimeInstanceId(data: Record<string, unknown>): string {
  const legacyId = data.vmInstanceId;
  if (legacyId !== undefined && (typeof legacyId !== "string" || !/^\d+$/u.test(legacyId))) throw new Error(INVALID_VM_CONTEXT);
  const computerInstanceId = data.computerInstanceId ?? (legacyId ? `gce-vm:${legacyId}` : undefined);
  if (legacyId !== undefined && computerInstanceId !== `gce-vm:${legacyId}`) throw new Error(INVALID_VM_CONTEXT);
  if (typeof computerInstanceId !== "string" || !/^(gce-vm:\d+|cluster:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.test(computerInstanceId)) throw new Error(INVALID_VM_CONTEXT);
  return computerInstanceId;
}

function parseVmContext(body: unknown): VmContext {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(INVALID_VM_CONTEXT);
  const data = body as Record<string, unknown>;
  const computerInstanceId = resolveRuntimeInstanceId(data);
  if (typeof data.gatewayId !== "string" || !data.gatewayId ||
    typeof data.ownerUid !== "string" || !data.ownerUid ||
    typeof data.agentAccountId !== "string" || !data.agentAccountId ||
    (data.ownerMattermostUserId !== null && (typeof data.ownerMattermostUserId !== "string" || !/^[a-z0-9]{26}$/u.test(data.ownerMattermostUserId)))) {
    throw new Error(INVALID_VM_CONTEXT);
  }
  return { gatewayId: data.gatewayId, ownerUid: data.ownerUid, computerInstanceId,
    agentAccountId: data.agentAccountId, ownerMattermostUserId: data.ownerMattermostUserId };
}

async function vmContextFailure(response: Response): Promise<Error> {
  const failure = new Error(`VM context request failed (${response.status})`);
  if (response.status !== 409) return failure;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failure;
  }
  if (body && typeof body === "object" && "error" in body && body.error === "computer-unavailable") {
    return new Error("VM is unavailable (computer-unavailable): the gateway VM is not ready. Retry when the VM is running.");
  }
  return failure;
}

export async function vmContext(options: VmBrokerOptions): Promise<VmContext> {
  const readToken = options.readTokenImpl ?? ((path: string) => readFile(path, "utf8"));
  const token = (await readToken(options.tokenPath ?? "/var/run/octogee/api-token/token")).trim();
  const baseUrl = options.brokerUrl ?? process.env.FLEET_BROKER_URL ?? process.env.OCTOGEE_API_URL ??
    `http://octogee-api.${process.env.K8S_NAMESPACE ?? "octogee"}.svc.cluster.local:3001`;
  const response = await (options.fetchImpl ?? fetch)(`${baseUrl.replace(/\/$/u, "")}/internal/computer/agent-context`, {
    method: "POST",
    headers: { "x-k8s-sa-token": token, "content-type": "application/json" },
    body: JSON.stringify({ agentId: options.agentId }),
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(5_000)]),
  });
  if (!response.ok) throw await vmContextFailure(response);
  return parseVmContext(await response.json());
}
