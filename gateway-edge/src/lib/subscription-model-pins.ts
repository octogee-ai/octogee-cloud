import type { AgentModelSelectionRecord, UserRepositories } from "@octogee/core/platform-state";

type AgentModels = Pick<UserRepositories, "agentModels">;

export async function pinSubscriptionModelAround<T>(
  users: AgentModels,
  args: { uid: string; agentIds: readonly string[]; model: string | null },
  commit: () => Promise<T>,
): Promise<T> {
  if (args.model === null || args.agentIds.length === 0) return commit();
  const model = args.model;
  const previous = new Map(
    (await users.agentModels.list(args.uid))
      .filter((selection) => args.agentIds.includes(selection.agentId))
      .map((selection) => [selection.agentId, selection]),
  );
  try {
    await Promise.all(args.agentIds.map((agentId) => users.agentModels.put({
      uid: args.uid,
      agentId,
      primary: model,
      fallbacks: [],
      updatedAt: { serverNow: true },
    })));
    return await commit();
  } catch (error) {
    try {
      await restoreSelections(users, args.uid, args.agentIds, previous);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "Subscription commit and model pick restore failed");
    }
    throw error;
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

async function restoreSelections(
  users: AgentModels,
  uid: string,
  agentIds: readonly string[],
  previous: ReadonlyMap<string, AgentModelSelectionRecord>,
): Promise<void> {
  await Promise.all(agentIds.map((agentId) => {
    const selection = previous.get(agentId);
    return selection === undefined
      ? users.agentModels.delete(uid, agentId)
      : users.agentModels.put({
        uid,
        agentId,
        primary: selection.primary,
        fallbacks: selection.fallbacks,
        updatedAt: selection.updatedAt,
      });
  }));
}
