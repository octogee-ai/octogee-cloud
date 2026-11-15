import { isDeepStrictEqual } from "node:util";
import type { PlatformUserRecord, PlatformStateStore } from "../platform-state/index.js";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { platformStateStore } from "./platform-state-store.js";

type UserDocument = Record<string, unknown>;

function isMap(value: unknown): value is UserDocument {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasMillis(value: unknown): value is { toMillis(): number } {
  return value !== null && typeof value === "object" && typeof (value as { toMillis?: unknown }).toMillis === "function";
}

export function storedForm(value: unknown): unknown {
  if (value === undefined) return null;
  if (hasMillis(value)) return value.toMillis();
  if (Array.isArray(value)) return value.map(storedForm);
  if (isMap(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, storedForm(item)]));
  return value;
}

function valueAt(document: UserDocument, path: readonly string[]): unknown {
  return path.reduce<unknown>((value, segment) => (isMap(value) ? value[segment] : undefined), document);
}

function withValueAt(document: UserDocument, path: readonly string[], value: unknown): UserDocument {
  const [head, ...rest] = path;
  if (rest.length === 0) return { ...document, [head]: value };
  const child = document[head];
  return { ...document, [head]: withValueAt(isMap(child) ? child : {}, rest, value) };
}

function withStoredValue(document: UserDocument, path: readonly string[], stored: unknown, current = valueAt(document, path)): UserDocument {
  const normalized = stored ?? null;
  return isDeepStrictEqual(storedForm(current), normalized) ? document : withValueAt(document, path, normalized);
}

const SLUG_PATH = ["provisioning", "openclaw", "slug"];
const AGENT_IDS_PATH = ["provisioning", "openclaw", "agentIds"];

export function userDataWithUserState(userData: UserDocument, user: PlatformUserRecord | null): UserDocument {
  const fields: readonly (readonly [readonly string[], unknown])[] = [
    [["workspaceId"], user?.workspaceId],
    [["accountLifecycle"], user?.accountLifecycle],
    [["mattermost", "userId"], user?.mattermostUserId],
    [["provisioning", "openclaw", "gatewayId"], user?.gateway?.gatewayId],
  ];
  const projected = fields.reduce<UserDocument>((document, [path, stored]) => withStoredValue(document, path, stored), userData);
  const withAgents = withStoredValue(projected, AGENT_IDS_PATH, user?.agents.agentIds ?? [], valueAt(userData, AGENT_IDS_PATH) ?? []);
  return withStoredValue(withAgents, SLUG_PATH, user?.slug, valueAt(userData, SLUG_PATH) ?? userData.username);
}

export async function accountActiveInStore(
  uid: string,
  store: Pick<PlatformStateStore, "users"> = platformStateStore,
): Promise<boolean> {
  const user = await store.users.records.get(uid);
  return accountAllowsInteractiveAccess(user ? { accountLifecycle: user.accountLifecycle ?? undefined } : undefined);
}
