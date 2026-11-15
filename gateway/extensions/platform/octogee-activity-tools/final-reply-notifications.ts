import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { createEdgeRelayClient } from "./edge-relay-client.js";

const REGISTRATION_MODES = ["full", "discovery", "tool-discovery", "setup-only", "setup-runtime", "cli-metadata"] as const;
const SKIPPED_MODES = new Set<string>(["discovery", "tool-discovery", "setup-only", "cli-metadata"]);

function registrationMode(value: unknown): string {
  return REGISTRATION_MODES.find(mode => mode === value) ?? (value === undefined ? "unspecified" : "unknown");
}

function replyClassification(value: unknown) {
  if (value === true) return "final";
  if (value === false) return "nonfinal";
  return "unclassified";
}

function replyDecision(input: {
  success: boolean;
  classification: ReturnType<typeof replyClassification>;
  hasBinding: boolean;
  matchingBinding: boolean;
}): string {
  if (!input.success) return "ignored_delivery";
  if (input.classification === "unclassified") return "ignored_unclassified";
  if (input.classification === "nonfinal") return "ignored_nonfinal";
  if (!input.hasBinding) return "missing_binding";
  if (!input.matchingBinding) return "binding_mismatch";
  return "relay_started";
}

function relayFailure(error: unknown) {
  const status = error instanceof Error ? /^reply relay returned ([1-5]\d{2})$/u.exec(error.message)?.[1] : undefined;
  return status
    ? { phase: "relay", result: "failed", code: "relay_http", status: Number(status) }
    : { phase: "relay", result: "failed", code: "relay_failed" };
}

export function registerFinalReplyNotifications(
  api: Pick<OpenClawPluginApi, "on" | "logger" | "registrationMode">,
  createRelay: () => Pick<ReturnType<typeof createEdgeRelayClient>, "publishFinalReply">,
): void {
  const mode = registrationMode(api.registrationMode);
  const log = (record: Record<string, string | boolean>) => api.logger.info(`[final-reply] ${JSON.stringify(record)}`);
  if (SKIPPED_MODES.has(mode)) {
    log({ phase: "registration", result: "skipped", mode });
    return;
  }
  const relay = createRelay();
  api.on("message_sent", async (event, context) => {
    if (context.channelId !== "mattermost") return;
    const classification = replyClassification(event.isFinalReply);
    const sessionKey = event.sessionKey ?? context.sessionKey;
    const sessionMatches = !(event.sessionKey && context.sessionKey && event.sessionKey !== context.sessionKey);
    const conversationMatches = !(context.conversationId && context.conversationId !== event.to);
    const decision = replyDecision({ success: event.success === true, classification,
      hasBinding: Boolean(sessionKey && context.accountId && event.messageId),
      matchingBinding: sessionMatches && conversationMatches });
    log({ phase: "decision", deliverySucceeded: event.success === true, classification,
      hasAccountId: Boolean(context.accountId), hasSessionKey: Boolean(sessionKey), hasMessageId: Boolean(event.messageId),
      sessionMatches, conversationMatches, decision });
    if (decision !== "relay_started" || !sessionKey || !context.accountId || !event.messageId) return;
    try {
      await relay.publishFinalReply({ schemaVersion: 1, accountId: context.accountId,
        sessionKey, to: event.to, messageId: event.messageId });
      log({ phase: "relay", result: "accepted" });
    } catch (error) {
      api.logger.error(`[final-reply] ${JSON.stringify(relayFailure(error))}`);
    }
  });
  log({ phase: "registration", result: "registered", mode });
}
