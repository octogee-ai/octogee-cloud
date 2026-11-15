import type { Request, RequestHandler, Response } from "express";

import { isValidUsername } from "@octogee/shared/types/identity";
import { SIGNATURE_HEADER } from "@octogee/shared/types/fleet-controller";
import { gatewayScopedJobId, verifyFleetRequest } from "./fleet-signature.js";
import { rejectMisaddressedGateway } from "./fleet-gateway-path.js";
import type {
  SurgeOpenClawProcessGateState,
  SurgeOpenClawProcessRequest,
  SurgeOpenClawProcessSupervisorClient,
} from "./surge-openclaw-process-gate.js";

type SurgeOpenClawProcessOperation = "hold" | "resume" | "unreserve";
type SurgeOpenClawProcessHandlerGate = Pick<
  SurgeOpenClawProcessSupervisorClient,
  SurgeOpenClawProcessOperation | "finalizeTargetCancellation"
>;

export interface SurgeOpenClawProcessHandlerDeps {
  publicKey: string;
  gatewayId: string;
  configuredBuilder: (slug: string) => boolean;
  processGate?: SurgeOpenClawProcessHandlerGate & Partial<Pick<SurgeOpenClawProcessSupervisorClient, "status" | "hydrate">>;
  unreserveConfiguredIsolatedTarget?: (request: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  waitForActiveProvisioningDrain?: () => Promise<void>;
  log?: (message: string) => void;
}

function validProcessPodUid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function validTargetFlags(inspect: unknown, reserve: unknown): boolean {
  return (inspect === undefined || typeof inspect === "boolean") &&
    (reserve === undefined || typeof reserve === "boolean") && !(inspect && reserve);
}

function parseProcessRequestBody(rawBody: string): (SurgeOpenClawProcessRequest & { receivingPodUid: string; inspectTarget?: boolean; reserveTarget?: boolean }) | null {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const { migrationId, slug, targetPodUid, receivingPodUid, inspectTarget, reserveTarget } = body;
  if (!validTargetFlags(inspectTarget, reserveTarget)) return null;
  if (typeof migrationId !== "string" || !migrationId || migrationId.length > 512) return null;
  if (typeof slug !== "string" || !isValidUsername(slug)) return null;
  if (!validProcessPodUid(targetPodUid)) return null;
  if (!validProcessPodUid(receivingPodUid)) return null;
  return { migrationId, slug, targetPodUid, receivingPodUid, ...(inspectTarget ? { inspectTarget: true } : {}), ...(reserveTarget ? { reserveTarget: true } : {}) };
}

function parseAndVerify(
  req: Request,
  res: Response,
  deps: SurgeOpenClawProcessHandlerDeps,
): (SurgeOpenClawProcessRequest & { inspectTarget?: boolean; reserveTarget?: boolean }) | null {
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? "";
  const request = parseProcessRequestBody(rawBody);
  if (!request) {
    res.status(400).json({ error: "missing or invalid migrationId/slug/targetPodUid/receivingPodUid" });
    return null;
  }
  const signature = req.header(SIGNATURE_HEADER);
  if (!verifyFleetRequest(
    deps.publicKey,
    gatewayScopedJobId(request.migrationId, deps.gatewayId),
    rawBody,
    signature ?? undefined,
  )) {
    deps.log?.(`[surge-handoff] bad OpenClaw process control signature migrationId=${request.migrationId}`);
    res.status(401).json({ error: "invalid signature" });
    return null;
  }
  if (rejectMisaddressedGateway(req, res, deps.gatewayId, deps.log ?? (() => undefined))) {
    return null;
  }
  const ownPodUid = process.env.POD_UID?.trim();
  if (!ownPodUid || request.receivingPodUid !== ownPodUid) {
    res.status(409).json({ error: "OpenClaw process request receiving pod UID does not match this allocation" });
    return null;
  }
  return { migrationId: request.migrationId, slug: request.slug, targetPodUid: request.targetPodUid, ...(request.inspectTarget ? { inspectTarget: true } : {}), ...(request.reserveTarget ? { reserveTarget: true } : {}) };
}

function requireConfiguredUser(
  request: SurgeOpenClawProcessRequest,
  res: Response,
  deps: SurgeOpenClawProcessHandlerDeps,
): (SurgeOpenClawProcessHandlerGate & Partial<Pick<SurgeOpenClawProcessSupervisorClient, "status" | "hydrate">>) | null {
  if (!deps.processGate || !deps.configuredBuilder(request.slug)) {
    res.status(409).json({ error: "configured user OpenClaw process control is unavailable" });
    return null;
  }
  return deps.processGate;
}

function assertHeldReservation(state: SurgeOpenClawProcessGateState, request: SurgeOpenClawProcessRequest): void {
  if (state.role !== "target" || state.mode !== "held" || state.phase !== "held" ||
      state.podUid !== request.targetPodUid || state.migrationId !== request.migrationId ||
      state.slug !== request.slug || state.targetPodUid !== request.targetPodUid) {
    throw new Error("target reservation identity is not held");
  }
}

function assertTargetAddress(operation: SurgeOpenClawProcessOperation, targetPodUid: string): void {
  if (operation !== "hold" || targetPodUid !== process.env.POD_UID?.trim()) {
    throw new Error("target reservation addresses another allocation or operation");
  }
}

async function processRequest(
  operation: SurgeOpenClawProcessOperation,
  request: SurgeOpenClawProcessRequest & { inspectTarget?: boolean; reserveTarget?: boolean },
  gate: SurgeOpenClawProcessHandlerGate & Partial<Pick<SurgeOpenClawProcessSupervisorClient, "status" | "hydrate">>,
  deps: SurgeOpenClawProcessHandlerDeps,
): Promise<SurgeOpenClawProcessGateState> {
  const { inspectTarget, reserveTarget, ...gateRequest } = request;
  if (inspectTarget || reserveTarget) {
    assertTargetAddress(operation, request.targetPodUid);
    const action = inspectTarget ? gate.status : gate.hydrate;
    if (!action) throw new Error("target reservation inspection unavailable");
    const state = inspectTarget ? await gate.status!() : await gate.hydrate!(gateRequest);
    assertHeldReservation(state, request);
    if (reserveTarget) await deps.waitForActiveProvisioningDrain?.();
    return state;
  }
  let state = operation === "unreserve" && deps.unreserveConfiguredIsolatedTarget
    ? await deps.unreserveConfiguredIsolatedTarget(gateRequest)
    : await gate[operation](gateRequest);
  if (operation === "hold") {
    await deps.waitForActiveProvisioningDrain?.();
    if (state.phase === "cancelling") state = await gate.finalizeTargetCancellation(gateRequest);
  }
  return state;
}

function createHandler(
  operation: SurgeOpenClawProcessOperation,
  deps: SurgeOpenClawProcessHandlerDeps,
): RequestHandler {
  return async (req, res) => {
    const request = parseAndVerify(req, res, deps);
    if (!request) return;
    const gate = requireConfiguredUser(request, res, deps);
    if (!gate) return;
    try {
      const state = await processRequest(operation, request, gate, deps);
      res.status(200).json({
        migrationId: request.migrationId,
        slug: request.slug,
        targetPodUid: request.targetPodUid,
        operation,
        role: state.role,
        mode: state.mode,
        phase: state.phase,
        ...(state.role === "target" && typeof state.completionStarted === "boolean" ? { completionStarted: state.completionStarted } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log?.(`[surge-handoff] OpenClaw process ${operation} failed migrationId=${request.migrationId} slug=${request.slug}: ${message}`);
      res.status(409).json({ error: `OpenClaw process ${operation} failed`, message });
    }
  };
}

export function createHoldSurgeOpenClawHandler(
  deps: SurgeOpenClawProcessHandlerDeps,
): RequestHandler {
  return createHandler("hold", deps);
}

export function createResumeSurgeOpenClawHandler(
  deps: SurgeOpenClawProcessHandlerDeps,
): RequestHandler {
  return createHandler("resume", deps);
}

export function createUnreserveSurgeOpenClawHandler(
  deps: SurgeOpenClawProcessHandlerDeps,
): RequestHandler {
  return createHandler("unreserve", deps);
}
