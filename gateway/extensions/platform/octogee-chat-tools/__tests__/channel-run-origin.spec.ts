import { expect, it, vi } from "vitest";
import { registerChannelRunOrigin } from "../channel-run-origin.js";

it("reports only the original Mattermost sender for the exact active channel run", () => {
  const events: Array<(event: unknown) => void> = [];
  const registerGatewayMethod = vi.fn();
  const registerService = vi.fn();
  const record = registerChannelRunOrigin({
    runtime: { events: { onAgentEvent: (callback: (event: unknown) => void) => { events.push(callback); return () => undefined; } } },
    registerGatewayMethod, registerService,
  } as never, { readRunControl: vi.fn() });
  const service = registerService.mock.calls.find(([service]) => service.id === "octogee-channel-run-origin")?.[0];
  expect(service).toBeDefined();
  service.start();
  const origin = registerGatewayMethod.mock.calls[0]?.[1];
  const ctx = {
    runId: "run-1", sessionKey: `agent:octogee-alice-coach:mattermost:channel:${"c".repeat(26)}`,
    messageProvider: "mattermost", senderId: "a".repeat(26),
  };
  expect(record).toBeDefined();
  record?.(ctx);
  record?.({ ...ctx, senderId: "b".repeat(26) });
  const lookup = (runId?: string, sessionKey = ctx.sessionKey) => {
    const respond = vi.fn();
    origin({ params: { sessionKey, runId }, respond });
    return respond;
  };
  const activeOrigin = { runId: ctx.runId, starterMmUserId: ctx.senderId };
  expect(lookup(ctx.runId)).toHaveBeenCalledExactlyOnceWith(true, activeOrigin);
  expect(lookup()).toHaveBeenCalledExactlyOnceWith(true, activeOrigin);
  expect(lookup(ctx.runId, ctx.sessionKey.replace(/c{26}$/, "d".repeat(26)))).toHaveBeenCalledExactlyOnceWith(true, { starterMmUserId: null });
  events[0]?.({ ...ctx, stream: "lifecycle", data: { phase: "end" } });
  expect(lookup(ctx.runId)).toHaveBeenCalledExactlyOnceWith(true, { starterMmUserId: null });
  expect(lookup()).toHaveBeenCalledExactlyOnceWith(true, { starterMmUserId: null });
  service.stop();
});

it("issues run controls only to the same-channel owner or verified starter", async () => {
  type AuthorizationRequest = { params: unknown; respond: unknown; client?: unknown };
  const methods = new Map<string, (args: AuthorizationRequest) => Promise<void>>();
  const sessionKey = `agent:octogee-alice-coach:mattermost:channel:${"c".repeat(26)}`;
  const starter = "a".repeat(26);
  const owner = "b".repeat(26);
  const other = "d".repeat(26);
  const readRunControl = vi.fn(async ({ senderId }: { senderId: string }) => ({ sessionKey, isOwner: senderId === owner }));
  const record = registerChannelRunOrigin({
    runtime: { events: { onAgentEvent: vi.fn() } },
    registerGatewayMethod: (name: string, method: (args: AuthorizationRequest) => Promise<void>, options: unknown) => {
      expect(options).toEqual({ scope: "operator.admin" });
      methods.set(name, method);
    },
    registerService: vi.fn(),
  } as never, { readRunControl });
  record?.({ sessionKey, runId: "run-1", senderId: starter });
  const authorize = methods.get("octogee.activity.authorizeChannelRunInput")!;
  const outcome = async (senderId: string, mode: "queue" | "steer", target = sessionKey, runId = "run-1") => {
    const respond = vi.fn();
    await authorize({
      client: { internal: { pluginRuntimeOwnerId: "mattermost" } },
      params: { sessionKey: target, runId, mode, senderId },
      respond,
    });
    return respond.mock.calls[0];
  };
  const direct = vi.fn();
  await authorize({
    client: { connect: { scopes: ["operator.admin"] } },
    params: { sessionKey, runId: "run-1", mode: "steer", senderId: owner },
    respond: direct,
  });
  expect(direct).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
  expect(readRunControl).not.toHaveBeenCalled();
  expect(await outcome(owner, "steer")).toEqual([true, { allowed: true, allowCollaborativeSteering: true }]);
  expect(await outcome(owner, "queue")).toEqual([true, { allowed: true, allowCollaborativeSteering: false }]);
  expect(await outcome(starter, "steer")).toEqual([true, { allowed: true, allowCollaborativeSteering: false }]);
  expect(await outcome(starter, "queue", sessionKey, "run-2")).toEqual([true, { allowed: false }]);
  expect(await outcome(other, "queue")).toEqual([true, { allowed: false }]);
  expect(await outcome(other, "steer")).toEqual([true, { allowed: false }]);
  expect(await outcome(owner, "steer", sessionKey.replace(/c{26}$/, "f".repeat(26)))).toEqual([true, { allowed: false }]);
});
