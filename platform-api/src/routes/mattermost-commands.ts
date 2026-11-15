import express, { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { CONTROL_UI_COMMAND_TRIGGER } from "@octogee/core/mattermost/control-ui-command";
import { OPENCLAW_CONTROL_TICKET_TTL_MS } from "@octogee/core/openclaw-control-tickets";
import {
  validAgentControlRouterPublicKey,
  verifyMattermostCommandRequest,
} from "../../../gateway-edge/src/agent-control-callback-router.js";
import {
  mintOwnerControlUiLaunch,
  type OwnerControlUiLaunch,
} from "../../../gateway-edge/src/routes/user/gateways.js";

const MAX_COMMAND_BYTES = 16 * 1024;
const MATTERMOST_ID = /^[a-z0-9]{26}$/;
const MAX_TOKEN_LENGTH = 128;
const MAX_UNSIGNED_REQUESTS_PER_CLIENT_PER_MINUTE = 300;
const MAX_COMMANDS_PER_USER_PER_MINUTE = 6;

export interface MattermostCommandRoutesDeps {
  store: PlatformStateStore;
  routerPublicKey: string;
  commandTokenMatches(input: { teamId: string; trigger: string; token: string }): Promise<boolean>;
  log(message: string, meta?: Record<string, unknown>): void;
  now?: () => number;
}

interface SlashCommand {
  token: string;
  teamId: string;
  userId: string;
}

function header(req: Request, name: string): string {
  const value = req.headers[name];
  return typeof value === "string" ? value : "";
}

function commandBody(req: Request): Buffer {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}

function parseSlashCommand(body: Buffer): SlashCommand | null {
  const form = new URLSearchParams(body.toString("utf8"));
  const token = form.get("token");
  const teamId = form.get("team_id");
  const userId = form.get("user_id");
  if (
    form.get("command") !== `/${CONTROL_UI_COMMAND_TRIGGER}` ||
    !token || token.length > MAX_TOKEN_LENGTH ||
    !teamId || !MATTERMOST_ID.test(teamId) ||
    !userId || !MATTERMOST_ID.test(userId)
  ) return null;
  return { token, teamId, userId };
}

function ephemeral(res: Response, text: string): void {
  res.json({ response_type: "ephemeral", text });
}

function launchReply(res: Response, launchUrl: string): void {
  const minutes = Math.round(OPENCLAW_CONTROL_TICKET_TTL_MS / 60_000);
  res.json({
    response_type: "ephemeral",
    text: "",
    attachments: [{
      fallback: "Your one-time Control UI link is ready.",
      text: `[Open your Control UI](${launchUrl})\n` +
        `This link works once and expires in ${minutes} minutes. Run /${CONTROL_UI_COMMAND_TRIGGER} again for a new one.`,
    }],
  });
}

function refusalText(launch: Exclude<OwnerControlUiLaunch, { kind: "launch" }>): string {
  switch (launch.kind) {
    case "shared-gateway":
      return "The Control UI is only for isolated gateways. Your agent runs on a shared gateway, so keep working with it here in Mattermost.";
    case "not-owner":
      return "The Control UI opens only for the owner of an isolated gateway.";
    case "no-gateway":
      return "Your agent is not on a gateway yet, so there is no Control UI to open.";
    case "capability-disabled":
      return "The Control UI is turned off for your isolated gateway.";
    case "not-ready":
      return `Your isolated gateway is not ready for the Control UI yet. Run /${CONTROL_UI_COMMAND_TRIGGER} again in a minute.`;
  }
}

export function createMattermostCommandRoutes(deps: MattermostCommandRoutesDeps): Router {
  const now = deps.now ?? Date.now;
  if (!validAgentControlRouterPublicKey(deps.routerPublicKey)) {
    deps.log("[mattermost-commands] AGENT_CONTROL_ROUTER_PUBLIC_KEY is not an Ed25519 public key; every /ui command is refused");
  }
  const routerSigned = (req: Request, res: Response): boolean => {
    if (typeof res.locals.routerSigned !== "boolean") {
      res.locals.routerSigned = verifyMattermostCommandRequest(commandBody(req), {
        command: header(req, "x-octogee-mattermost-command"),
        timestamp: header(req, "x-octogee-mattermost-command-timestamp"),
        signature: header(req, "x-octogee-mattermost-command-signature"),
      }, deps.routerPublicKey, now());
    }
    return res.locals.routerSigned as boolean;
  };
  const verified = (req: Request, res: Response, next: NextFunction): void => {
    if (!routerSigned(req, res)) {
      deps.log("[mattermost-commands] rejected a /ui command without a valid router proof");
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const command = parseSlashCommand(commandBody(req));
    if (!command) {
      res.status(400).json({ error: "invalid-command" });
      return;
    }
    res.locals.slashCommand = command;
    next();
  };
  const unsignedPerClient = rateLimit({
    windowMs: 60_000,
    limit: MAX_UNSIGNED_REQUESTS_PER_CLIENT_PER_MINUTE,
    skip: routerSigned,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
    handler: (_req, res) => {
      res.status(429).json({ error: "rate-limited" });
    },
  });
  const perUser = rateLimit({
    windowMs: 60_000,
    limit: MAX_COMMANDS_PER_USER_PER_MINUTE,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (_req, res) => (res.locals.slashCommand as SlashCommand).userId,
    handler: (_req, res) => ephemeral(res, `Too many /${CONTROL_UI_COMMAND_TRIGGER} requests. Try again in a minute.`),
  });
  const router = Router();
  router.post(
    "/control-ui",
    express.raw({ type: () => true, limit: MAX_COMMAND_BYTES }),
    unsignedPerClient,
    verified,
    perUser,
    async (_req: Request, res: Response, next: NextFunction) => {
      const command = res.locals.slashCommand as SlashCommand;
      try {
        if (!await deps.commandTokenMatches({ teamId: command.teamId, trigger: CONTROL_UI_COMMAND_TRIGGER, token: command.token })) {
          deps.log("[mattermost-commands] rejected a /ui command whose token is not the team's /ui command", { teamId: command.teamId });
          res.status(403).json({ error: "forbidden" });
          return;
        }
        const user = await deps.store.users.records.findByMattermostUserId(command.userId);
        const launch: OwnerControlUiLaunch = user
          ? await mintOwnerControlUiLaunch(deps.store, user.uid)
          : { kind: "not-owner" };
        if (launch.kind !== "launch") {
          deps.log("[mattermost-commands] /ui refused", {
            reason: launch.kind,
            ...(user ? { uid: user.uid } : { mattermostUserId: command.userId }),
          });
        }
        if (launch.kind === "launch") launchReply(res, launch.launchUrl);
        else ephemeral(res, refusalText(launch));
      } catch (error) {
        next(error);
      }
    },
  );
  return router;
}
