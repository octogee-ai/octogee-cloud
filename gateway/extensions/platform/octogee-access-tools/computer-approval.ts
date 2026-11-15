// @ts-expect-error resolved by the OpenClaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { vmContext, type VmBrokerOptions, type VmContext } from "./vm-client.js";

type VmConfig = Pick<VmBrokerOptions, "brokerUrl" | "tokenPath">;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Ambient generic instantiation emits no unused runtime binding.
declare const registerHook: OpenClawPluginApi["on"];
type BeforeToolCallHook = Parameters<typeof registerHook<"before_tool_call">>[1];
type PluginHookToolContext = Parameters<BeforeToolCallHook>[1];
type PluginHookBeforeToolCallResult = Exclude<Awaited<ReturnType<BeforeToolCallHook>>, void>;
type ApprovalReviewer = Parameters<
  NonNullable<NonNullable<PluginHookBeforeToolCallResult["requireApproval"]>["reviewerGuard"]>["prepare"]
>[0];

function channelOwner(identity: { channel?: string; accountId?: string; senderId?: string } | undefined, facts: VmContext): boolean {
  return Boolean(identity && identity.channel === "mattermost" && identity.accountId === facts.agentAccountId &&
    facts.ownerMattermostUserId && identity.senderId === facts.ownerMattermostUserId);
}

function sameVm(before: VmContext, after: VmContext): boolean {
  return before.gatewayId === after.gatewayId && before.ownerUid === after.ownerUid &&
    before.computerInstanceId === after.computerInstanceId && before.agentAccountId === after.agentAccountId &&
    before.ownerMattermostUserId === after.ownerMattermostUserId;
}

function requesterAuthority(context: PluginHookToolContext, facts: VmContext, signal: AbortSignal) {
  const requester = context.requester;
  const browserIdentity = requester?.getAuthenticatedIdentity?.();
  const channelIdentity = requester?.channel === "mattermost" && requester.accountId === facts.agentAccountId &&
    typeof requester.senderId === "string" && /^[a-z0-9]{26}$/u.test(requester.senderId);
  if (requester?.getAuthenticatedIdentity ? !browserIdentity?.userId : !channelIdentity) {
    throw new Error("Computer control requires a verified requester");
  }
  const assertActive = () => {
    signal.throwIfAborted();
    if (browserIdentity) {
      const current = requester?.getAuthenticatedIdentity?.();
      if (current?.profileId !== browserIdentity.profileId || current?.userId !== browserIdentity.userId) {
        throw new Error("VM requester authority changed");
      }
    }
  };
  assertActive();
  return {
    isOwner: browserIdentity ? browserIdentity.userId === facts.ownerUid : channelOwner(requester, facts),
    assertActive,
  };
}

export function computerApprovalHook(config: VmConfig) {
  return async (event: { toolName: string }, context: PluginHookToolContext): Promise<PluginHookBeforeToolCallResult | undefined> => {
    if (event.toolName !== "computer" && event.toolName !== "browser" && event.toolName !== "nodes") return;
    try {
      if (!context.agentId || !context.runId || !context.abortSignal) throw new Error("Computer control requires an active agent task");
      const options = { ...config, agentId: context.agentId, signal: context.abortSignal };
      const facts = await vmContext(options);
      const { isOwner, assertActive } = requesterAuthority(context, facts, options.signal);
      if (isOwner) return;
      return {
        requireApproval: {
          title: "Allow computer control?",
          description: `Another user's agent is requesting a ${event.toolName} action on your gateway computer. This can use a terminal and install software. Approve this action only if you trust the task.`,
          severity: "warning" as const,
          allowedDecisions: ["allow-once", "deny"],
          timeoutMs: 5 * 60_000,
          reviewerGuard: {
            signal: options.signal,
            assertActive,
            async prepare(reviewer: ApprovalReviewer) {
              assertActive();
              if (reviewer.userId ? reviewer.userId !== facts.ownerUid : !channelOwner(reviewer.channel, facts)) return null;
              const current = await vmContext(options);
              assertActive();
              if (!sameVm(facts, current)) throw new Error("VM owner or instance changed; request approval again");
              return assertActive;
            },
          },
        },
      };
    } catch (error) {
      return { block: true, blockReason: error instanceof Error ? error.message : "VM authorization failed" };
    }
  };
}
