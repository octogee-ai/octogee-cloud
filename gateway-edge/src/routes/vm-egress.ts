import type { IncomingMessage } from "node:http";
import { Router, type Request, type Response } from "express";
import type { WebSocket } from "ws";
import { WsUpgradeAuthorizationError, type WsUpgradeRouter } from "@octogee/core/ws/upgrade-router";
import { isGatewayEgressMode } from "@octogee/shared/types/glm";
import { requireAuthenticatedUid } from "../middleware/auth.js";
import { authenticatedRequestLimit, authenticationFailureLimit } from "../middleware/authenticated-request-limit.js";
import { logger } from "../middleware/logging.js";
import { resolveNativeAdminAccess, type NativeAdminAccessOutcome } from "../lib/native-admin-access.js";
import { createWsTicketStore, wsTicketFromPath, type WsTicketStore } from "../lib/ws-ticket-store.js";
import { authorizeSession, monitorSessionAuthorization } from "../lib/ws-session-authorization.js";
import { EGRESS_MAX_FRAME_BYTES } from "../egress/protocol.js";
import type { VmEgressService, EgressStatus } from "../egress/service.js";

export const EGRESS_WS_PREFIX = "/computer/egress/";

export interface EgressSession {
  uid: string;
  gatewayId: string;
  reauthorize(): Promise<boolean>;
}

export interface VmEgressRouterOptions {
  service: VmEgressService;
  env?: NodeJS.ProcessEnv;
  resolveAccess?: typeof resolveNativeAdminAccess;
  tickets?: WsTicketStore<EgressSession>;
  authorizationIntervalMs?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

function accessDeniedStatus(kind: string): number {
  if (kind === "unauthenticated") return 401;
  return kind === "not_found" ? 404 : 403;
}

function controllingAccess(access: NativeAdminAccessOutcome): access is Extract<NativeAdminAccessOutcome, { kind: "allowed" }> {
  return access.kind === "allowed" && access.canControl;
}

export function createVmEgressRouter(options: VmEgressRouterOptions) {
  const env = options.env ?? process.env;
  const resolveAccess = options.resolveAccess ?? resolveNativeAdminAccess;
  const tickets = options.tickets ?? createWsTicketStore<EgressSession>();
  const log = options.log ?? ((message, meta) => logger.warn(message, meta));
  const { service } = options;
  const router: Router = Router({ mergeParams: true });

  async function authorize(req: Request, res: Response): Promise<{ gatewayId: string; authorization: string | undefined } | null> {
    const gatewayId = (req.params as { gatewayId?: string }).gatewayId;
    if (typeof gatewayId !== "string" || gatewayId !== env.GATEWAY_ID || service.status().listener === "off") {
      res.status(404).json({ error: "computer_unavailable" });
      return null;
    }
    const authorization = req.headers.authorization;
    const access = await resolveAccess({ gatewayId, authorization, env });
    if (!controllingAccess(access)) {
      res.status(accessDeniedStatus(access.kind)).json({ error: "forbidden" });
      return null;
    }
    return { gatewayId, authorization };
  }

  const respond = (res: Response, status: EgressStatus) => { res.set("cache-control", "no-store").json(status); };

  router.get("/egress", authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(180), async (req, res) => {
    try {
      if (!(await authorize(req, res))) return;
      respond(res, service.status());
    } catch (error) {
      log("VM egress status failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(503).json({ error: "egress_unavailable" });
    }
  });

  router.post("/egress/mode", authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(60), async (req, res) => {
    try {
      if (!(await authorize(req, res))) return;
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || Object.keys(body).join(",") !== "mode" || !isGatewayEgressMode(body.mode)) { res.status(400).json({ error: "invalid_mode" }); return; }
      respond(res, await service.setMode(body.mode));
    } catch (error) {
      log("VM egress mode change failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(503).json({ error: "egress_unavailable" });
    }
  });

  router.post("/egress/ticket", authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(60), async (req, res) => {
    try {
      const granted = await authorize(req, res);
      if (!granted) return;
      const uid = req.uid!;
      const ticket = tickets.issue({ uid, gatewayId: granted.gatewayId, reauthorize: async () => controllingAccess(await resolveAccess({ gatewayId: granted.gatewayId, authorization: granted.authorization, env })) });
      res.set("cache-control", "no-store").json({ ticket: ticket.ticket, expiresAt: new Date(ticket.expiresAt).toISOString() });
    } catch (error) {
      log("VM egress ticket failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(503).json({ error: "egress_unavailable" });
    }
  });

  function attachWs(upgradeRouter: WsUpgradeRouter, isAllowedOrigin: (origin: string | undefined) => boolean): void {
    const redeemed = new WeakMap<IncomingMessage, EgressSession>();
    upgradeRouter.add({
      match: (path) => path.startsWith(EGRESS_WS_PREFIX),
      extractTicket: (path) => wsTicketFromPath(path, EGRESS_WS_PREFIX),
      allowedOrigins: isAllowedOrigin,
      maxPayloadBytes: EGRESS_MAX_FRAME_BYTES,
      authorize: async (req) => {
        const ticket = wsTicketFromPath((req.url ?? "").split("?")[0], EGRESS_WS_PREFIX);
        const session = ticket ? tickets.redeem(ticket) : null;
        if (!session || service.status().listener === "off" || await authorizeSession(session, 5000) !== "allowed") {
          throw new WsUpgradeAuthorizationError(401, "EGRESS_ACCESS_DENIED");
        }
        redeemed.set(req, session);
        return true;
      },
      onUpgrade: ({ req, ws }) => {
        const session = redeemed.get(req);
        redeemed.delete(req);
        if (!session) { ws.close(1008, "Egress session missing"); return; }
        bridge(ws, session);
      },
    });
  }

  function bridge(ws: WebSocket, session: EgressSession): void {
    const stop = monitorSessionAuthorization(session, {
      intervalMs: options.authorizationIntervalMs ?? 10_000,
      timeoutMs: 5000,
      onEnded: (result) => { log("VM egress authorization ended", { uid: session.uid, result }); ws.close(result === "revoked" ? 1008 : 1011, "Egress authorization ended"); },
    });
    ws.on("close", stop);
    service.attachShell(ws);
    log("VM egress desktop connected", { uid: session.uid });
  }

  return { router, attachWs };
}
