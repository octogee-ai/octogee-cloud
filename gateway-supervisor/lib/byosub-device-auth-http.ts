

import { timingSafeEqual } from "crypto";
import type { Express, Request, RequestHandler, Response } from "express";
import type { DeviceAuthManager } from "./byosub-device-auth.js";
import { isSafeAgentId } from "./byosub-restore.js";

export interface DeviceAuthHttpDeps {
  manager: DeviceAuthManager;
  internalServiceKey: string;
  log?: (m: string) => void;
}

function internalKeyEquals(presented: string, key: string): boolean {
  if (presented.length !== key.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(presented, "utf8"),
      Buffer.from(key, "utf8"),
    );
  } catch {
    return false;
  }
}

function denied(
  req: Request,
  res: Response,
  key: string,
): boolean {

if (!key) {
    return false;
  }
  const presented = req.header("X-Internal-Service-Key") ?? "";
  if (!internalKeyEquals(presented, key)) {
    res.status(401).json({ error: "unauthorized" });
    return true;
  }
  return false;
}

export function createDeviceAuthStartHandler(
  deps: DeviceAuthHttpDeps,
): RequestHandler {
  const log = deps.log ?? (() => {});
  return async (req, res) => {
    if (denied(req, res, deps.internalServiceKey)) return;
    const agentId = (req.body as { agentId?: unknown } | undefined)?.agentId;
    if (typeof agentId !== "string" || !agentId) {
      res.status(400).json({ error: "agentId required" });
      return;
    }
    if (!isSafeAgentId(agentId)) {
      res.status(400).json({ error: "agentId is not path-safe" });
      return;
    }
    try {
      res.json(await deps.manager.start(agentId));
    } catch (e) {
      const message = (e as Error).message;
      log(`byosub device-auth: start failed for ${agentId} — ${message}`);
      res.status(503).json({ error: `device-auth unavailable: ${message}` });
    }
  };
}

export function createDeviceAuthStatusHandler(
  deps: DeviceAuthHttpDeps,
): RequestHandler {
  return (req, res) => {
    if (denied(req, res, deps.internalServiceKey)) return;
    const out = deps.manager.status(req.params.flowId as string);
    if (!out) {
      res.status(404).json({ error: "flow not found" });
      return;
    }
    res.json(out);
  };
}

export function mountByosubDeviceAuth(
  app: Express,
  deps: DeviceAuthHttpDeps,
): void {
  app.post(
    "/internal/byosub/device-auth/start",
    createDeviceAuthStartHandler(deps),
  );
  app.get(
    "/internal/byosub/device-auth/status/:flowId",
    createDeviceAuthStatusHandler(deps),
  );
}
