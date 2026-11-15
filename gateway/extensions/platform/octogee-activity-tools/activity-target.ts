import type { ActivityKeyedStore } from "./durable-outbox.js";
import type { ActivityRunTarget, SourceAgentEvent } from "./activity-types.js";

export interface InboundMessageEvent {
  sessionKey?: unknown;
  messageId?: unknown;
  threadId?: unknown;
  replyToId?: unknown;
  nativeChannelId?: unknown;
}

export interface InboundMessageContext {
  channelId?: unknown;
  sessionKey?: unknown;
  messageId?: unknown;
  replyToId?: unknown;
  nativeChannelId?: unknown;
}

export interface SubagentProgressEvent {
  phase?: unknown;
  runId?: unknown;
  childSessionKey?: unknown;
  requester?: {
    channel?: unknown;
    accountId?: unknown;
    channelId?: unknown;
    threadId?: unknown;
    messageId?: unknown;
  };
}

export interface SubagentProgressContext {
  childSessionKey?: unknown;
  requesterSessionKey?: unknown;
}

export interface ProvisionalSubagentActivityTarget {
  target: ActivityRunTarget;
  requesterSessionKey: string;
}

export interface AcceptedSubagentSpawn {
  childRunId: string;
  childSessionKey: string;
  parentRunId: string;
  parentSessionKey?: string;
  parentAgentId: string;
}

export interface DirectMattermostSessionTarget {
  sessionKey: string;
  agentId: string;
  conversationId: string;
  rootPostId: string;
}

export interface DirectMattermostSessionCandidate {
  sessionKey: string;
  agentId: string;
  ownerUserId: string;
  rootPostId: string;
  inboundPostId: string;
  nativeChannelId?: string;
}

type MattermostSessionRoute = {
  sessionKey: string;
  agentId: string;
  peerKind: "channel" | "group" | "direct";
  primaryChannelId: string;
  threadRootPostId: string;
};

type ChannelScopedMattermostSessionRoute = {
  sessionKey: string;
  agentId: string;
  peerKind: "channel" | "group";
  primaryChannelId: string;
};

type MattermostTurnBindingIdentity = {
  runId: string;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  turnId: string;
  mainChannelId: string;
  mainRootPostId: string;
  inputPostId: string;
};

function identifier(value: unknown): string | null {
  if (typeof value === "string" && value.trim() === value && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function exact(...values: unknown[]): string | null {
  const identities = [...new Set(values.map(identifier).filter((value): value is string => Boolean(value)))];
  return identities.length === 1 ? identities[0]! : null;
}

function mattermostSessionRoute(value: unknown): MattermostSessionRoute | null {
  const sessionKey = identifier(value);
  if (!sessionKey) return null;
  const parts = sessionKey.split(":");
  if (parts.length !== 7) return null;
  const [agentPrefix, agentId, provider, peerKind, primaryChannelId, threadMarker, threadRootPostId] = parts;
  if (
    agentPrefix !== "agent"
    || !agentId
    || provider !== "mattermost"
    || !["channel", "group", "direct"].includes(peerKind ?? "")
    || !primaryChannelId
    || threadMarker !== "thread"
    || !threadRootPostId
  ) {
    return null;
  }
  return {
    sessionKey,
    agentId,
    peerKind: peerKind as MattermostSessionRoute["peerKind"],
    primaryChannelId,
    threadRootPostId,
  };
}

function channelScopedMattermostSessionRoute(
  value: unknown,
): ChannelScopedMattermostSessionRoute | null {
  const sessionKey = identifier(value);
  if (!sessionKey) return null;
  const parts = sessionKey.split(":");
  if (parts.length !== 5) return null;
  const [agentPrefix, agentId, provider, peerKind, primaryChannelId] = parts;
  if (
    agentPrefix !== "agent"
    || !agentId
    || provider !== "mattermost"
    || (peerKind !== "channel" && peerKind !== "group")
    || !primaryChannelId
  ) return null;
  return { sessionKey, agentId, peerKind, primaryChannelId };
}

function exactBindingKeys(value: Record<string, unknown>): boolean {
  const expected = new Set([
    "schemaVersion",
    "kind",
    "conversationId",
    "turnId",
    "runId",
    "agentId",
    "sessionKey",
    "origin",
    "mainChannelId",
    "mainRootPostId",
    "inputPostId",
  ]);
  return Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function stringIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.trim() === value && value.length > 0
    ? value
    : null;
}

function isMattermostTurnBindingEvent(event: SourceAgentEvent): boolean {
  return event.stream === "delivery"
    && event.data.kind === "mattermost-turn-binding"
    && event.data.schemaVersion === 1
    && event.data.origin === "human"
    && exactBindingKeys(event.data);
}

function mattermostTurnBindingIdentity(
  data: Record<string, unknown>,
): MattermostTurnBindingIdentity | null {
  const binding = {
    runId: stringIdentifier(data.runId),
    agentId: stringIdentifier(data.agentId),
    sessionKey: stringIdentifier(data.sessionKey),
    conversationId: stringIdentifier(data.conversationId),
    turnId: stringIdentifier(data.turnId),
    mainChannelId: stringIdentifier(data.mainChannelId),
    mainRootPostId: stringIdentifier(data.mainRootPostId),
    inputPostId: stringIdentifier(data.inputPostId),
  };
  return Object.values(binding).some((value) => value === null)
    ? null
    : binding as MattermostTurnBindingIdentity;
}

function bindingMatchesEvent(
  event: SourceAgentEvent,
  binding: MattermostTurnBindingIdentity,
): boolean {
  return stringIdentifier(event.runId) === binding.runId
    && stringIdentifier(event.agentId) === binding.agentId
    && (
      event.sessionKey === undefined
      || stringIdentifier(event.sessionKey) === binding.sessionKey
    );
}

function bindingMatchesRoute(
  binding: MattermostTurnBindingIdentity,
  route: ChannelScopedMattermostSessionRoute,
): boolean {
  return route.agentId === binding.agentId
    && route.primaryChannelId === binding.conversationId
    && binding.conversationId === binding.mainChannelId
    && binding.turnId === binding.mainRootPostId;
}

export function mattermostTurnBindingActivityTarget(
  event: SourceAgentEvent,
): ActivityRunTarget | null {
  if (!isMattermostTurnBindingEvent(event)) return null;
  const binding = mattermostTurnBindingIdentity(event.data);
  if (!binding) return null;
  const route = channelScopedMattermostSessionRoute(binding.sessionKey);
  if (!route || !bindingMatchesEvent(event, binding) || !bindingMatchesRoute(binding, route)) {
    return null;
  }
  return {
    conversationId: binding.conversationId,
    turnId: binding.turnId,
    runId: binding.runId,
    agentId: binding.agentId,
    sessionKey: binding.sessionKey,
    origin: "human",
    mainChannelId: binding.mainChannelId,
    mainRootPostId: binding.mainRootPostId,
    inputPostId: binding.inputPostId,
  };
}

export function isUnresolvedChannelEvent(event: SourceAgentEvent): boolean {
  const route = channelScopedMattermostSessionRoute(event.sessionKey);
  const explicitAgentId = event.agentId === undefined ? undefined : identifier(event.agentId);
  return Boolean(
    identifier(event.runId)
    && route
    && (event.agentId === undefined || explicitAgentId === route.agentId),
  );
}

export function agentIdFromSessionKey(value: unknown): string | null {
  const sessionKey = identifier(value);
  const match = sessionKey ? /^agent:([^:]+):(mattermost|subagent):/u.exec(sessionKey) : null;
  return match?.[1] ?? null;
}

export function directMattermostSessionTarget(
  event: InboundMessageEvent,
  context: InboundMessageContext,
): DirectMattermostSessionTarget | null {
  const candidate = directMattermostSessionCandidate(event, context);
  if (!candidate?.nativeChannelId) return null;
  return {
    sessionKey: candidate.sessionKey,
    agentId: candidate.agentId,
    conversationId: candidate.nativeChannelId,
    rootPostId: candidate.rootPostId,
  };
}

export function directMattermostSessionCandidate(
  event: InboundMessageEvent,
  context: InboundMessageContext,
): DirectMattermostSessionCandidate | null {
  if (context.channelId !== "mattermost") return null;
  const sessionKey = exact(event.sessionKey, context.sessionKey);
  const route = mattermostSessionRoute(sessionKey);
  if (!route || route.peerKind !== "direct") return null;
  const inboundPostId = exact(event.messageId, context.messageId);
  if (!inboundPostId) return null;
  const nativeChannelValues = [event.nativeChannelId, context.nativeChannelId]
    .map(identifier)
    .filter((value): value is string => Boolean(value));
  const nativeChannelId = nativeChannelValues.length > 0
    ? exact(...nativeChannelValues)
    : null;
  if (nativeChannelValues.length > 0 && !nativeChannelId) return null;
  const explicitRoots = [...new Set(
    [event.threadId, event.replyToId, context.replyToId]
      .map(identifier)
      .filter((value): value is string => Boolean(value)),
  )];
  if (explicitRoots.some((root) => root !== route.threadRootPostId)) return null;
  return {
    sessionKey: route.sessionKey,
    agentId: route.agentId,
    ownerUserId: route.primaryChannelId,
    rootPostId: route.threadRootPostId,
    inboundPostId,
    ...(nativeChannelId ? { nativeChannelId } : {}),
  };
}

export function agentEventActivityTarget(
  event: SourceAgentEvent,
  directTarget?: DirectMattermostSessionTarget | null,
): ActivityRunTarget | null {
  const runId = identifier(event.runId);
  const route = mattermostSessionRoute(event.sessionKey);
  const explicitAgentId = identifier(event.agentId);
  if (!runId || !route || (explicitAgentId && explicitAgentId !== route.agentId)) return null;

  let conversationId = route.primaryChannelId;
  if (route.peerKind === "direct") {
    if (
      !directTarget
      || directTarget.sessionKey !== route.sessionKey
      || directTarget.agentId !== route.agentId
      || directTarget.rootPostId !== route.threadRootPostId
    ) {
      return null;
    }
    conversationId = directTarget.conversationId;
  }

  return {
    conversationId,
    turnId: route.threadRootPostId,
    runId,
    agentId: route.agentId,
    sessionKey: route.sessionKey,
    origin: "human",
    mainChannelId: conversationId,
    mainRootPostId: route.threadRootPostId,
  };
}

function subagentStartFacts(
  event: SubagentProgressEvent,
  context: SubagentProgressContext,
): {
  runId: string;
  sessionKey: string;
  conversationId: string;
  inputPostId: string;
  rootPostId: string;
  agentId: string;
} | null {
  if (event.phase !== "started" || event.requester?.channel !== "mattermost") return null;
  const runId = identifier(event.runId);
  const sessionKey = exact(event.childSessionKey, context.childSessionKey);
  const conversationId = identifier(event.requester.channelId);
  const inputPostId = identifier(event.requester.messageId);
  const rootPostId = identifier(event.requester.threadId) ?? inputPostId;
  const agentId = agentIdFromSessionKey(sessionKey);
  const facts = [runId, sessionKey, conversationId, inputPostId, rootPostId, agentId];
  if (facts.some((value) => !value) || !/^agent:[^:]+:subagent:/u.test(sessionKey ?? "")) return null;
  return {
    runId: runId!,
    sessionKey: sessionKey!,
    conversationId: conversationId!,
    inputPostId: inputPostId!,
    rootPostId: rootPostId!,
    agentId: agentId!,
  };
}

export function provisionalSubagentActivityTarget(
  event: SubagentProgressEvent,
  context: SubagentProgressContext = {},
): ProvisionalSubagentActivityTarget | null {
  const facts = subagentStartFacts(event, context);
  if (!facts) return null;
  const { runId, sessionKey, conversationId, inputPostId, rootPostId, agentId } = facts;

  const requesterSessionKey = identifier(context.requesterSessionKey);
  const requesterThreadRoute = mattermostSessionRoute(requesterSessionKey);
  const requesterRoute = requesterThreadRoute
    ?? channelScopedMattermostSessionRoute(requesterSessionKey);
  const requesterIsSubagent = Boolean(
    requesterSessionKey
    && /^agent:[^:]+:subagent:.+/u.test(requesterSessionKey),
  );
  if (!requesterSessionKey || (!requesterRoute && !requesterIsSubagent)) return null;
  if (
    requesterRoute
    && (
      (requesterThreadRoute && requesterThreadRoute.threadRootPostId !== rootPostId)
      || (requesterRoute.peerKind !== "direct" && requesterRoute.primaryChannelId !== conversationId)
    )
  ) {
    return null;
  }

  return {
    requesterSessionKey,
    target: {
      conversationId,
      turnId: rootPostId,
      runId,
      agentId,
      sessionKey,
      ...(requesterThreadRoute?.peerKind === "direct"
        ? { requesterSessionKey: requesterThreadRoute.sessionKey }
        : {}),
      origin: "subagent",
      mainChannelId: conversationId,
      mainRootPostId: rootPostId,
      inputPostId,
    },
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function acceptedSpawnResult(event: SourceAgentEvent): Record<string, unknown> | null {
  if (event.stream !== "tool") return null;
  if (event.data.phase !== "result") return null;
  if (event.data.name !== "sessions_spawn") return null;
  if (event.data.isError === true) return null;
  const result = objectRecord(event.data.result);
  return objectRecord(result?.details);
}

function optionalEventIdentity(value: unknown): string | null | undefined {
  return value === undefined ? undefined : identifier(value);
}

export function acceptedSubagentSpawn(event: SourceAgentEvent): AcceptedSubagentSpawn | null {
  const record = acceptedSpawnResult(event);
  if (!record || record.status !== "accepted") return null;
  const parentRunId = identifier(event.runId);
  const parentSessionKey = optionalEventIdentity(event.sessionKey);
  const parentAgentId = identifier(event.agentId);
  if (!parentRunId || parentSessionKey === null || !parentAgentId) return null;
  const childRunId = identifier(record.runId);
  const childSessionKey = identifier(record.childSessionKey);
  if (!childRunId || !childSessionKey) return null;
  if (!/^agent:[^:]+:subagent:.+/u.test(childSessionKey)) return null;
  if (childRunId === parentRunId || childSessionKey === parentSessionKey) return null;
  return {
    childRunId,
    childSessionKey,
    parentRunId,
    ...(parentSessionKey ? { parentSessionKey } : {}),
    parentAgentId,
  };
}

function directRequesterSessionKey(parentTarget: ActivityRunTarget): string | null {
  const parentRoute = mattermostSessionRoute(parentTarget.sessionKey);
  if (parentRoute?.peerKind === "direct") return parentRoute.sessionKey;
  if (parentTarget.requesterSessionKey === undefined) return null;
  const inheritedRoute = mattermostSessionRoute(parentTarget.requesterSessionKey);
  return inheritedRoute?.peerKind === "direct" ? inheritedRoute.sessionKey : null;
}

function sameParentRoute(
  provisional: ProvisionalSubagentActivityTarget,
  parentTarget: ActivityRunTarget,
): boolean {
  const target = provisional.target;
  return provisional.requesterSessionKey === parentTarget.sessionKey
    && target.conversationId === parentTarget.conversationId
    && target.mainChannelId === parentTarget.mainChannelId
    && target.turnId === parentTarget.turnId
    && target.mainRootPostId === parentTarget.mainRootPostId;
}

function acceptedParentMatches(
  accepted: AcceptedSubagentSpawn,
  parentTarget: ActivityRunTarget,
): boolean {
  return accepted.parentRunId === parentTarget.runId
    && (!accepted.parentSessionKey || accepted.parentSessionKey === parentTarget.sessionKey)
    && accepted.parentAgentId === parentTarget.agentId;
}

function validDirectDescendant(
  requesterSessionKey: string | null,
  provisional: ProvisionalSubagentActivityTarget,
): boolean {
  if (!requesterSessionKey) return provisional.target.requesterSessionKey === undefined;
  const route = mattermostSessionRoute(requesterSessionKey);
  if (!route || route.peerKind !== "direct") return false;
  if (route.threadRootPostId !== provisional.target.mainRootPostId) return false;
  const provisionalRequester = provisional.target.requesterSessionKey;
  return provisionalRequester === undefined || provisionalRequester === requesterSessionKey;
}

export function reconciledSubagentActivityTarget(
  provisional: ProvisionalSubagentActivityTarget,
  accepted: AcceptedSubagentSpawn,
  parentTarget: ActivityRunTarget,
): ActivityRunTarget | null {
  if (provisional.target.runId !== accepted.childRunId) return null;
  if (provisional.target.sessionKey !== accepted.childSessionKey) return null;
  if (accepted.childRunId === parentTarget.runId) return null;
  if (accepted.childSessionKey === parentTarget.sessionKey) return null;
  if (!acceptedParentMatches(accepted, parentTarget)) return null;
  if (!sameParentRoute(provisional, parentTarget)) return null;
  const requesterSessionKey = directRequesterSessionKey(parentTarget);
  if (!validDirectDescendant(requesterSessionKey, provisional)) return null;
  return {
    ...provisional.target,
    parentRunId: parentTarget.runId,
    ...(requesterSessionKey ? { requesterSessionKey } : {}),
  };
}

function targetMatchesEvent(target: ActivityRunTarget, event: SourceAgentEvent): boolean {
  return target.runId === event.runId
    && (!event.agentId || target.agentId === event.agentId)
    && (!event.sessionKey || target.sessionKey === event.sessionKey)
    && target.conversationId === target.mainChannelId
    && target.turnId === target.mainRootPostId;
}

function sameTarget(left: ActivityRunTarget, right: ActivityRunTarget): boolean {
  return JSON.stringify([
    left.conversationId,
    left.turnId,
    left.runId,
    left.parentRunId ?? null,
    left.retryOfRunId ?? null,
    left.agentId,
    left.sessionKey,
    left.requesterSessionKey ?? null,
    left.origin,
    left.mainChannelId,
    left.mainRootPostId,
    left.inputPostId ?? null,
  ]) === JSON.stringify([
    right.conversationId,
    right.turnId,
    right.runId,
    right.parentRunId ?? null,
    right.retryOfRunId ?? null,
    right.agentId,
    right.sessionKey,
    right.requesterSessionKey ?? null,
    right.origin,
    right.mainChannelId,
    right.mainRootPostId,
    right.inputPostId ?? null,
  ]);
}

function sameDirectTarget(left: DirectMattermostSessionTarget, right: DirectMattermostSessionTarget): boolean {
  return left.sessionKey === right.sessionKey
    && left.agentId === right.agentId
    && left.conversationId === right.conversationId
    && left.rootPostId === right.rootPostId;
}

function sameDirectCandidate(
  left: DirectMattermostSessionCandidate,
  right: DirectMattermostSessionCandidate,
): boolean {
  return left.sessionKey === right.sessionKey
    && left.agentId === right.agentId
    && left.ownerUserId === right.ownerUserId
    && left.rootPostId === right.rootPostId
    && left.inboundPostId === right.inboundPostId
    && left.nativeChannelId === right.nativeChannelId;
}

export function createActivityTargetRegistry(store: ActivityKeyedStore<ActivityRunTarget>) {
  const targets = new Map<string, ActivityRunTarget>();
  return {
    async start(): Promise<void> {
      for (const entry of await store.entries()) targets.set(entry.key, entry.value);
    },
    async remember(target: ActivityRunTarget): Promise<void> {
      const current = targets.get(target.runId);
      if (current) {
        if (!sameTarget(current, target)) {
          throw new Error(`activity target changed for run ${target.runId}`);
        }
        return;
      }
      if (await store.registerIfAbsent(target.runId, target)) {
        targets.set(target.runId, target);
        return;
      }
      const stored = await store.lookup(target.runId);
      if (!stored || !sameTarget(stored, target)) {
        throw new Error(`activity target changed for run ${target.runId}`);
      }
      targets.set(target.runId, stored);
    },
    async resolve(event: SourceAgentEvent): Promise<ActivityRunTarget | null> {
      const target = targets.get(event.runId) ?? await store.lookup(event.runId);
      if (!target || !targetMatchesEvent(target, event)) return null;
      targets.set(event.runId, target);
      return target;
    },
    async resolveRun(runId: string): Promise<ActivityRunTarget | null> {
      const target = targets.get(runId) ?? await store.lookup(runId);
      if (!target) return null;
      targets.set(runId, target);
      return target;
    },
    async forget(runId: string): Promise<void> {
      targets.delete(runId);
      await store.delete(runId);
    },
  };
}

export function createDirectMattermostSessionTargetRegistry(
  store: ActivityKeyedStore<DirectMattermostSessionTarget>,
) {
  const targets = new Map<string, DirectMattermostSessionTarget>();
  return {
    async start(): Promise<void> {
      for (const entry of await store.entries()) targets.set(entry.key, entry.value);
    },
    async remember(target: DirectMattermostSessionTarget): Promise<void> {
      const current = targets.get(target.sessionKey);
      if (current) {
        if (!sameDirectTarget(current, target)) {
          throw new Error(`direct Mattermost route changed for session ${target.sessionKey}`);
        }
        return;
      }
      if (await store.registerIfAbsent(target.sessionKey, target)) {
        targets.set(target.sessionKey, target);
        return;
      }
      const stored = await store.lookup(target.sessionKey);
      if (!stored || !sameDirectTarget(stored, target)) {
        throw new Error(`direct Mattermost route changed for session ${target.sessionKey}`);
      }
      targets.set(target.sessionKey, stored);
    },
    async resolve(sessionKey: string): Promise<DirectMattermostSessionTarget | null> {
      const target = targets.get(sessionKey) ?? await store.lookup(sessionKey);
      if (!target) return null;
      targets.set(sessionKey, target);
      return target;
    },
    async forget(sessionKey: string): Promise<void> {
      targets.delete(sessionKey);
      await store.delete(sessionKey);
    },
  };
}

export function createDirectMattermostSessionCandidateRegistry(
  store: ActivityKeyedStore<DirectMattermostSessionCandidate> & {
    register(key: string, value: DirectMattermostSessionCandidate): Promise<void>;
  },
) {
  const candidates = new Map<string, DirectMattermostSessionCandidate>();
  return {
    async start(): Promise<void> {
      for (const entry of await store.entries()) candidates.set(entry.key, entry.value);
    },
    async remember(candidate: DirectMattermostSessionCandidate): Promise<void> {
      const current = candidates.get(candidate.sessionKey);
      if (current && sameDirectCandidate(current, candidate)) return;
      await store.register(candidate.sessionKey, candidate);
      candidates.set(candidate.sessionKey, candidate);
    },
    async resolve(sessionKey: string): Promise<DirectMattermostSessionCandidate | null> {
      const candidate = candidates.get(sessionKey) ?? await store.lookup(sessionKey);
      if (!candidate) return null;
      candidates.set(sessionKey, candidate);
      return candidate;
    },
  };
}
