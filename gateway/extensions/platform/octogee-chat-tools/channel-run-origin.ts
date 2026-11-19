import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { SessionContextError, type SessionContextClient } from "./session-context-client.js";

const METHOD = "octogee.activity.channelRunOrigin";
const CHANNEL_SESSION = /^agent:[^:]+:mattermost:(?:channel|group):([a-z0-9]{26})$/u;
const MATTERMOST_USER = /^[a-z0-9]{26}$/u;
const TERMINAL = new Set(["end", "error", "abort"]);

function validRunId(runId: unknown): runId is string {
  return typeof runId === "string" && runId.length > 0 && runId.length <= 256;
}

function parseRunInput(params: Record<string, unknown>) {
  const { sessionKey, runId, senderId, mode } = params;
  if (typeof sessionKey !== "string" || !validRunId(runId) ||
    typeof senderId !== "string" || !MATTERMOST_USER.test(senderId) || (mode !== "queue" && mode !== "steer")) {
    return null;
  }
  const channelId = CHANNEL_SESSION.exec(sessionKey)?.[1];
  return channelId ? { sessionKey, channelId, runId, senderId, mode } : null;
}

export function registerChannelRunOrigin(
  api: Pick<OpenClawPluginApi, "registrationMode" | "registerService" | "registerGatewayMethod"> & {
    runtime: Pick<OpenClawPluginApi["runtime"], "events">;
  },
  sessionContext: Pick<SessionContextClient, "readRunControl">,
) {
  if (api.registrationMode && api.registrationMode !== "full" && api.registrationMode !== "setup-runtime") return;
  const origins = new Map<string, Map<string, string>>();

  let unsubscribe: (() => void) | undefined;
  api.registerService({
    id: "octogee-channel-run-origin",
    start() {
      unsubscribe = api.runtime.events.onAgentEvent(({ runId, sessionKey, stream, data }) => {
        if (stream !== "lifecycle" || !sessionKey || typeof data.phase !== "string" || !TERMINAL.has(data.phase)) return;
        const session = origins.get(sessionKey);
        session?.delete(runId);
        if (session?.size === 0) origins.delete(sessionKey);
      });
    },
    stop() {
      unsubscribe?.();
      origins.clear();
    },
  });

  api.registerGatewayMethod(METHOD, ({ params, respond }) => {
    const { sessionKey, runId } = params;
    if (typeof sessionKey !== "string" || !CHANNEL_SESSION.test(sessionKey) ||
      (runId !== undefined && !validRunId(runId))) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "A valid channel session and run are required" });
      return;
    }
    const runs = origins.get(sessionKey);
    const onlyRunId = runs?.size === 1 ? runs.keys().next().value : undefined;
    const selected = runId ?? onlyRunId;
    const starterMmUserId = selected ? runs?.get(selected) : undefined;
    respond(true, starterMmUserId ? { runId: selected, starterMmUserId } : { starterMmUserId: null });
  }, { scope: "operator.admin" });

  api.registerGatewayMethod("octogee.activity.authorizeChannelRunInput", async ({ client, params, respond }) => {
    if (client?.internal?.pluginRuntimeOwnerId !== "mattermost") {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "Run input authorization is only available to the Mattermost connector" });
      return;
    }
    const input = parseRunInput(params);
    if (!input) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "A channel run, sender and action are required" });
      return;
    }
    const { sessionKey, channelId, senderId, runId, mode } = input;
    try {
      const scope = await sessionContext.readRunControl({ senderId, channelId });
      const allowed = scope.sessionKey === sessionKey &&
        (scope.isOwner || origins.get(sessionKey)?.get(runId) === senderId);
      respond(true, allowed
        ? { allowed: true, allowCollaborativeSteering: mode === "steer" && scope.isOwner }
        : { allowed: false });
    } catch (error) {
      if (error instanceof SessionContextError && error.code === "control-error") {
        respond(true, { allowed: false });
        return;
      }
      respond(false, undefined, { code: "UNAVAILABLE", message: "Could not verify channel run control" });
    }
  }, { scope: "operator.admin" });

  return ({ runId, sessionKey, senderId }: { runId?: unknown; sessionKey?: unknown; senderId?: unknown }) => {
    if (typeof runId !== "string" || !runId || typeof sessionKey !== "string" || !CHANNEL_SESSION.test(sessionKey)
      || typeof senderId !== "string" || !MATTERMOST_USER.test(senderId)) return;
    const session = origins.get(sessionKey) ?? new Map<string, string>();
    if (!origins.has(sessionKey)) origins.set(sessionKey, session);
    if (!session.has(runId)) session.set(runId, senderId);
  };
}
