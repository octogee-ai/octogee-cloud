import type { UserRepositories } from "@octogee/core/platform-state";

type AgentModels = Pick<UserRepositories, "agentModels">;

export class SubscriptionModelPinError extends Error {
  override readonly name = "SubscriptionModelPinError";

  constructor(readonly uid: string, readonly agentIds: readonly string[], cause: unknown) {
    super(`Subscription credential is active but its model pick for ${agentIds.join(", ")} was not saved; reconnecting saves it`, { cause });
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

export async function retargetSubscriptionModelPicks(
  users: AgentModels,
  args: { uid: string; fromModel: string; toModel: string | null },
): Promise<void> {
  const pinned = (await users.agentModels.list(args.uid))
    .filter((selection) => selection.primary === args.fromModel)
    .map((selection) => selection.agentId);
  const toModel = args.toModel;
  await Promise.all(pinned.map((agentId) => toModel === null
    ? users.agentModels.delete(args.uid, agentId)
    : users.agentModels.put({ uid: args.uid, agentId, primary: toModel, fallbacks: [], updatedAt: { serverNow: true } })));
}
