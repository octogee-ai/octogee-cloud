import type { IncomingMessage } from "node:http";
import { Router, type Request, type Response } from "express";
import type { WebSocket } from "ws";
import { WsUpgradeAuthorizationError, type WsUpgradeRouter } from "@octogee/core/ws/upgrade-router";
import { requireAuthenticatedUid } from "../middleware/auth.js";
import { authenticatedRequestLimit, authenticationFailureLimit } from "../middleware/authenticated-request-limit.js";
import { logger } from "../middleware/logging.js";
import { resolveNativeAdminAccess, type NativeAdminAccessOutcome } from "../lib/native-admin-access.js";
import { createWsTicketStore, wsTicketFromPath, type WsTicketStore } from "../lib/ws-ticket-store.js";
import { authorizeSession, monitorSessionAuthorization } from "../lib/ws-session-authorization.js";
import type { PasskeyLinkHost } from "../webauthn/link-host.js";
import { PASSKEY_LINK_MAX_MESSAGE_BYTES } from "../webauthn/protocol.js";

export const PASSKEY_WS_PREFIX = "/computer/passkeys/";

interface PasskeySession {
  uid: string;
  gatewayId: string;
  reauthorize(): Promise<boolean>;
}

export interface VmPasskeysRouterOptions {
  host: PasskeyLinkHost;
  available: () => boolean;
  env?: NodeJS.ProcessEnv;
  resolveAccess?: typeof resolveNativeAdminAccess;
  tickets?: WsTicketStore<PasskeySession>;
  authorizationIntervalMs?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

function accessDeniedStatus(kind: string): number {
  if (kind === "unauthenticated") return 401;
  return kind === "not_found" ? 404 : 403;
}

function controllingAccess(access: NativeAdminAccessOutcome): boolean {
  return access.kind === "allowed" && access.canControl;
}

export function createVmPasskeysRouter(options: VmPasskeysRouterOptions) {
  const env = options.env ?? process.env;
  const resolveAccess = options.resolveAccess ?? resolveNativeAdminAccess;
  const tickets = options.tickets ?? createWsTicketStore<PasskeySession>();
  const log = options.log ?? ((message, meta) => logger.warn(message, meta));
  const router: Router = Router({ mergeParams: true });

  async function authorize(req: Request, res: Response): Promise<{ gatewayId: string; authorization: string | undefined } | null> {
    const gatewayId = (req.params as { gatewayId?: string }).gatewayId;
    if (typeof gatewayId !== "string" || gatewayId !== env.GATEWAY_ID || !options.available()) {
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

  router.post("/passkeys/ticket", authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(60), async (req, res) => {
    try {
      const granted = await authorize(req, res);
      if (!granted) return;
      const ticket = tickets.issue({
        uid: req.uid!,
        gatewayId: granted.gatewayId,
        reauthorize: async () => controllingAccess(await resolveAccess({ gatewayId: granted.gatewayId, authorization: granted.authorization, env })),
      });
      res.set("cache-control", "no-store").json({ ticket: ticket.ticket, expiresAt: new Date(ticket.expiresAt).toISOString() });
    } catch (error) {
      log("VM passkey ticket failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(503).json({ error: "passkeys_unavailable" });
    }
  });

  function attachWs(upgradeRouter: WsUpgradeRouter, isAllowedOrigin: (origin: string | undefined) => boolean): void {
    const redeemed = new WeakMap<IncomingMessage, PasskeySession>();
    upgradeRouter.add({
      match: (path) => path.startsWith(PASSKEY_WS_PREFIX),
      extractTicket: (path) => wsTicketFromPath(path, PASSKEY_WS_PREFIX),
      allowedOrigins: isAllowedOrigin,
      maxPayloadBytes: PASSKEY_LINK_MAX_MESSAGE_BYTES,
      authorize: async (req) => {
        const ticket = wsTicketFromPath((req.url ?? "").split("?")[0], PASSKEY_WS_PREFIX);
        const session = ticket ? tickets.redeem(ticket) : null;
        if (!session || !options.available() || await authorizeSession(session, 5000) !== "allowed") {
          throw new WsUpgradeAuthorizationError(401, "PASSKEY_ACCESS_DENIED");
        }
        redeemed.set(req, session);
        return true;
      },
      onUpgrade: ({ req, ws }) => {
        const session = redeemed.get(req);
        redeemed.delete(req);
        if (!session) { ws.close(1008, "Passkey session missing"); return; }
        link(ws, session);
      },
    });
  }

  function link(ws: WebSocket, session: PasskeySession): void {
    const stop = monitorSessionAuthorization(session, {
      intervalMs: options.authorizationIntervalMs ?? 10_000,
      timeoutMs: 5000,
      onEnded: (result) => { log("VM passkey authorization ended", { uid: session.uid, result }); ws.close(result === "revoked" ? 1008 : 1011, "Passkey authorization ended"); },
    });
    ws.on("close", stop);
    options.host.attach(ws);
    log("VM passkey desktop linked", { uid: session.uid });
  }

  return { router, attachWs };
}
