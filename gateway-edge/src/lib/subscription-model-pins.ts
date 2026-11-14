import type { UserRepositories } from "@octogee/core/platform-state";

type AgentModels = Pick<UserRepositories, "agentModels">;

export class SubscriptionModelPinError extends Error {
  override readonly name = "SubscriptionModelPinError";

  constructor(
    readonly uid: string,
    readonly agentIds: readonly string[],
    cause: unknown,
    message = `Subscription credential is active but its model pick for ${agentIds.join(", ")} was not saved; reconnecting saves it`,
  ) {
    super(message, { cause });
  }
}

export async function pinSubscriptionModel(
  users: AgentModels,
  args: { uid: string; agentIds: readonly string[]; model: string | null },
): Promise<void> {
  const model = args.model;
  if (model === null || args.agentIds.length === 0) return;
  try {
    await Promise.all(args.agentIds.map((agentId) => users.agentModels.put({
      uid: args.uid,
      agentId,
      primary: model,
      fallbacks: [],
      updatedAt: { serverNow: true },
    })));
  } catch (error) {
    throw new SubscriptionModelPinError(args.uid, args.agentIds, error);
  }
}

export async function pinUnpickedSubscriptionModel(
  users: AgentModels,
  args: { uid: string; agentIds: readonly string[]; model: string | null },
): Promise<void> {
  if (args.model === null || args.agentIds.length === 0) return;
  let picked: ReadonlySet<string>;
  try {
    picked = new Set((await users.agentModels.list(args.uid)).map((selection) => selection.agentId));
  } catch (error) {
    throw new SubscriptionModelPinError(args.uid, args.agentIds, error);
  }
  await pinSubscriptionModel(users, { ...args, agentIds: args.agentIds.filter((agentId) => !picked.has(agentId)) });
}

export async function retargetSubscriptionModelPicks(
  users: AgentModels,
  args: { uid: string; fromModel: string; toModel: string | null },
): Promise<void> {
  const stale = (agentIds: readonly string[], cause: unknown) => new SubscriptionModelPinError(
    args.uid,
    agentIds,
    cause,
    `Subscription model pick for ${agentIds.join(", ") || "this user's agents"} still names ${args.fromModel}; disconnecting again moves it`,
  );
  let pinned: string[];
  try {
    pinned = (await users.agentModels.list(args.uid))
      .filter((selection) => selection.primary === args.fromModel)
      .map((selection) => selection.agentId);
  } catch (error) {
    throw stale([], error);
  }
  const toModel = args.toModel;
  const results = await Promise.allSettled(pinned.map((agentId) => toModel === null
    ? users.agentModels.delete(args.uid, agentId)
    : users.agentModels.put({ uid: args.uid, agentId, primary: toModel, fallbacks: [], updatedAt: { serverNow: true } })));
  const failed = pinned.filter((_, index) => results[index]?.status === "rejected");
  if (failed.length === 0) return;
  const reasons = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  throw stale(failed, reasons.length === 1 ? reasons[0] : new AggregateError(reasons));
}
