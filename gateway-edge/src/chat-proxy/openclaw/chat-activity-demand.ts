import type { BridgeLog } from "@octogee/core/http/bridge-log";
import type { ChatActivityPayload } from "./mm-chat-activity-listener.js";
import { CHAT_DEMAND_UNAVAILABLE, type ChatActivityReport, type OpenClawRuntimeBroker } from "./runtime-broker.js";

const DEFAULT_WINDOW_MS = 5 * 60_000;

function chatActivityReport(activity: ChatActivityPayload): ChatActivityReport {
  const { channelId, postId, mmUserId } = activity;
  return activity.kind === "reaction"
    ? {
        kind: "reaction",
        channelId,
        postId,
        mmUserId,
        emojiName: activity.emojiName,
        createdAt: activity.createdAt,
      }
    : { kind: "post", channelId, postId, mmUserId };
}

export function makeChatActivityDemandHandler(deps: {
  broker: Pick<OpenClawRuntimeBroker, "requestChatActivityDemand">;
  log: BridgeLog;
  windowMs?: number;
  now?: () => number;
}): (activity: ChatActivityPayload) => Promise<void> {
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const now = deps.now ?? Date.now;
  const quietUntil = new Map<string, number>();
  let unavailableLogged = false;

  const pruneExpired = (at: number): void => {
    for (const [channelId, until] of quietUntil) {
      if (until <= at) quietUntil.delete(channelId);
    }
  };

  return async (activity) => {
    const report = chatActivityReport(activity);
    const { kind, channelId, postId } = report;
    const at = now();
    if ((quietUntil.get(channelId) ?? 0) > at) return;
    if (quietUntil.size >= 1_000) pruneExpired(at);
    quietUntil.set(channelId, at + windowMs);
    try {
      const result = await deps.broker.requestChatActivityDemand(report);
      if (result.reason === "actor-not-human") quietUntil.delete(channelId);
      if (result.reason === CHAT_DEMAND_UNAVAILABLE && !unavailableLogged) {
        unavailableLogged = true;
        deps.log("[chat-activity-demand] the API's chat demand route is absent; chat does not wake isolated gateways", "info");
      }
    } catch (error) {
      quietUntil.delete(channelId);
      deps.log(
        `[chat-activity-demand] ${kind} ${postId} in ${channelId} not recorded: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warn",
      );
    }
  };
}
