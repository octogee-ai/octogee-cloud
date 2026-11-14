import type { UserIdentity } from "@octogee/shared/types/builder-identity";
import type { RollRosterStore } from "../roll-roster.js";

export type WorkspaceServingState = "serving" | "not-serving" | "roster-loading";

export type WorkspaceServingResolver = () => WorkspaceServingState;

export type WorkspaceServingDenial = "workspace-not-serving" | "roster-loading";

export function workspaceServingDenial(state: WorkspaceServingState): WorkspaceServingDenial | null {
  if (state === "serving") return null;
  return state === "roster-loading" ? "roster-loading" : "workspace-not-serving";
}

export function workspaceServingResolver(input: {
  gatewayClass: "shared" | "isolated";
  identity: () => UserIdentity | null;
  store: Pick<RollRosterStore, "loaded" | "get"> | null;
}): WorkspaceServingResolver {
  if (input.gatewayClass === "shared") return () => "serving";
  const { store } = input;
  return () => {
    const identity = input.identity();
    if (identity?.state !== "claimed") return "not-serving";
    if (!store?.loaded()) return "roster-loading";
    return store.get(identity.ownerUid)?.state === "serving" ? "serving" : "not-serving";
  };
}
