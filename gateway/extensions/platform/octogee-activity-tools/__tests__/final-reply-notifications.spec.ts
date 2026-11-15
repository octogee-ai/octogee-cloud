import { describe, expect, it, vi } from "vitest";
import { registerFinalReplyNotifications } from "../final-reply-notifications.js";

const channelId = "c".repeat(26);
const messageId = "m".repeat(26);
const sessionKey = `agent:octogee-alice-coach:mattermost:channel:${channelId}`;
const event = { to: `channel:${channelId}`, content: "Do not trust hook text", success: true,
  isFinalReply: true, messageId, sessionKey };
const context = { channelId: "mattermost", accountId: "alice-coach", sessionKey,
  conversationId: `channel:${channelId}` };

function setup() {
  let hook: (event: any, context: any) => Promise<void>;
  const relay = { publishFinalReply: vi.fn(async () => undefined) };
  const logger = { error: vi.fn(), info: vi.fn() };
  const api = { on: vi.fn((name, handler) => { expect(name).toBe("message_sent"); hook = handler; }), logger };
  registerFinalReplyNotifications(api as never, () => relay);
  return { relay, logger, emit: async (e = event, c = context) => hook(e, c) };
}

describe("native final reply hook", () => {
  it("does not open runtime transports during plugin discovery", () => {
    const createRelay = vi.fn();
    const on = vi.fn();
    registerFinalReplyNotifications({ registrationMode: "discovery", on, logger: { info: vi.fn() } } as never, createRelay);
    expect(createRelay).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
  });
  it("relays only delivered IDs and routing from the native final reply hook", async () => {
    const h = setup();
    await h.emit();
    expect(h.relay.publishFinalReply).toHaveBeenCalledExactlyOnceWith({
      schemaVersion: 1, accountId: "alice-coach", sessionKey, to: event.to, messageId,
    });
  });

  it.each([
    { isFinalReply: false }, { isFinalReply: undefined }, { success: false },
    { messageId: undefined }, { sessionKey: "foreign-session" },
  ])("ignores nonfinal, failed, unclassified or unbound deliveries %j", async patch => {
    const h = setup();
    await h.emit({ ...event, ...patch } as typeof event);
    expect(h.relay.publishFinalReply).not.toHaveBeenCalled();
  });

  it.each([
    { channelId: "slack" }, { accountId: undefined }, { sessionKey: "other-session" },
    { conversationId: "channel:foreign" },
  ])("does not relay a mismatched native hook context %j", async patch => {
    const h = setup();
    await h.emit(event, { ...context, ...patch } as typeof context);
    expect(h.relay.publishFinalReply).not.toHaveBeenCalled();
  });

  it("logs a relay failure without logging message content", async () => {
    const h = setup();
    h.relay.publishFinalReply.mockRejectedValueOnce(new Error("reply relay returned 503"));
    await h.emit();
    expect(h.logger.error).toHaveBeenCalledExactlyOnceWith(
      '[final-reply] {"phase":"relay","result":"failed","code":"relay_http","status":503}',
    );
    expect(h.logger.error).not.toHaveBeenCalledWith(expect.stringContaining(event.content));
  });
});

function diagnostics(h: ReturnType<typeof setup>) {
  return h.logger.info.mock.calls.map(([line]) => JSON.parse(line.slice("[final-reply] ".length)));
}

describe("native final reply diagnostics", () => {
  it("records registration after the native hook is installed", () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const on = vi.fn();
    registerFinalReplyNotifications({ registrationMode: "full", on, logger } as never,
      () => ({ publishFinalReply: vi.fn() }));
    expect(on.mock.invocationCallOrder[0]).toBeLessThan(logger.info.mock.invocationCallOrder[0]!);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      '[final-reply] {"phase":"registration","result":"registered","mode":"full"}',
    );
  });

  it.each(["discovery", "tool-discovery", "setup-only", "cli-metadata"])(
    "records skipped %s registration without creating a transport", registrationMode => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const on = vi.fn();
      const createRelay = vi.fn();
      registerFinalReplyNotifications({ registrationMode, on, logger } as never, createRelay);
      expect(createRelay).not.toHaveBeenCalled();
      expect(on).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledExactlyOnceWith(`[final-reply] ${JSON.stringify({
        phase: "registration", result: "skipped", mode: registrationMode,
      })}`);
    },
  );

  it.each([
    { eventPatch: { success: false }, contextPatch: {}, decision: "ignored_delivery", classification: "final" },
    { eventPatch: { isFinalReply: undefined }, contextPatch: {}, decision: "ignored_unclassified", classification: "unclassified" },
    { eventPatch: { isFinalReply: false }, contextPatch: {}, decision: "ignored_nonfinal", classification: "nonfinal" },
    { eventPatch: { messageId: undefined }, contextPatch: {}, decision: "missing_binding", classification: "final" },
    { eventPatch: { sessionKey: undefined }, contextPatch: { sessionKey: undefined }, decision: "missing_binding", classification: "final" },
    { eventPatch: {}, contextPatch: { accountId: undefined }, decision: "missing_binding", classification: "final" },
    { eventPatch: { sessionKey: "private-other-session" }, contextPatch: {}, decision: "binding_mismatch", classification: "final" },
    { eventPatch: {}, contextPatch: { conversationId: "private-other-channel" }, decision: "binding_mismatch", classification: "final" },
  ])("records $decision without relaying", async ({ eventPatch, contextPatch, decision, classification }) => {
    const h = setup();
    await h.emit({ ...event, ...eventPatch } as typeof event, { ...context, ...contextPatch } as typeof context);
    expect(h.relay.publishFinalReply).not.toHaveBeenCalled();
    const records = diagnostics(h);
    expect(records).toHaveLength(2);
    expect(records[1]).toEqual({
      phase: "decision", deliverySucceeded: eventPatch.success !== false, classification,
      hasAccountId: Boolean({ ...context, ...contextPatch }.accountId),
      hasSessionKey: Boolean({ ...event, ...eventPatch }.sessionKey ?? { ...context, ...contextPatch }.sessionKey),
      hasMessageId: Boolean({ ...event, ...eventPatch }.messageId),
      sessionMatches: !eventPatch.sessionKey,
      conversationMatches: !contextPatch.conversationId,
      decision,
    });
  });

  it("records a relay start and acceptance without content or binding values", async () => {
    const h = setup();
    await h.emit();
    expect(diagnostics(h)).toEqual([
      { phase: "registration", result: "registered", mode: "unspecified" },
      { phase: "decision", deliverySucceeded: true, classification: "final", hasAccountId: true,
        hasSessionKey: true, hasMessageId: true, sessionMatches: true, conversationMatches: true,
        decision: "relay_started" },
      { phase: "relay", result: "accepted" },
    ]);
    const output = JSON.stringify(h.logger.info.mock.calls);
    for (const value of [event.to, event.content, messageId, sessionKey, context.accountId]) {
      expect(output).not.toContain(value);
    }
  });

  it("records relay failure without serializing an unsafe exception", async () => {
    const h = setup();
    const secret = "token=private-token transcript=private-transcript";
    h.relay.publishFinalReply.mockRejectedValueOnce(new Error(secret));
    await h.emit();
    expect(h.logger.error).toHaveBeenCalledExactlyOnceWith(
      '[final-reply] {"phase":"relay","result":"failed","code":"relay_failed"}',
    );
    expect(JSON.stringify([h.logger.info.mock.calls, h.logger.error.mock.calls])).not.toContain(secret);
    expect(diagnostics(h)).not.toContainEqual({ phase: "relay", result: "accepted" });
  });

  it.each([
    new Error("reply relay returned 503 token=private-token"),
    new Error("reply relay returned 999"),
    "private-thrown-value",
    { message: "private-thrown-message", token: "private-token" },
  ])("does not expose unexpected relay errors %j", async error => {
    const h = setup();
    h.relay.publishFinalReply.mockRejectedValueOnce(error);
    await h.emit();
    expect(h.logger.error).toHaveBeenCalledExactlyOnceWith(
      '[final-reply] {"phase":"relay","result":"failed","code":"relay_failed"}',
    );
  });

  it("does not log unrelated channel deliveries", async () => {
    const h = setup();
    await h.emit(event, { ...context, channelId: "slack" });
    expect(diagnostics(h)).toEqual([{ phase: "registration", result: "registered", mode: "unspecified" }]);
  });

  it("normalizes unexpected registration modes instead of logging their values", () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    registerFinalReplyNotifications({ registrationMode: "private-unexpected-mode", on: vi.fn(), logger } as never,
      () => ({ publishFinalReply: vi.fn() }));
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      '[final-reply] {"phase":"registration","result":"registered","mode":"unknown"}',
    );
  });
});
