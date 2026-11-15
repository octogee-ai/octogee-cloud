import {
  USER_IDENTITY_ROUTE,
  parseUserIdentity,
  type UserIdentity,
  type ClaimedUserIdentity,
} from "@octogee/shared/types/builder-identity";
import { gatewayCredentialHeaders, internalFetch } from "../internal-fetch.js";

type Schedule = (callback: () => void, delayMs: number) => () => void;

export interface UserIdentityStore {
  current(): UserIdentity | null;
  start(): () => void;
}

export const USER_IDENTITY_POLL_MS = 1_000;
export const USER_IDENTITY_RETRY_MS = 5_000;

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearTimeout(timer);
}

function settled(identity: UserIdentity): boolean {
  return identity.state === "claimed" || (identity.state === "unavailable" && identity.reason === "retired");
}

export function createUserIdentityStore(input: {
  read: () => Promise<UserIdentity>;
  log: (message: string) => void;
  schedule?: Schedule;
}): UserIdentityStore {
  const schedule = input.schedule ?? defaultSchedule;
  let identity: UserIdentity | null = null;
  return {
    current: () => identity,
    start() {
      let stopped = false;
      let cancel: (() => void) | null = null;
      const poll = async (): Promise<void> => {
        let delay = USER_IDENTITY_POLL_MS;
        try {
          const next = await input.read();
          if (stopped) return;
          identity = next;
          if (settled(next)) return;
        } catch (error) {
          if (stopped) return;
          input.log(`[builder-identity] broker read failed: ${error instanceof Error ? error.message : String(error)}`);
          delay = USER_IDENTITY_RETRY_MS;
        }
        cancel = schedule(() => { void poll(); }, delay);
      };
      void poll();
      return () => {
        stopped = true;
        cancel?.();
      };
    },
  };
}

export function brokerUserIdentityReader(env: NodeJS.ProcessEnv = process.env): () => Promise<UserIdentity> {
  const gatewayId = env.GATEWAY_ID?.trim();
  const base = (env.FLEET_BROKER_URL || env.OCTOGEE_API_URL)?.replace(/\/$/u, "");
  if (!gatewayId || !base) throw new Error("User identity requires GATEWAY_ID and FLEET_BROKER_URL");
  return async () => {
    const response = await internalFetch(`${base}${USER_IDENTITY_ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...await gatewayCredentialHeaders() },
      body: JSON.stringify({ gatewayId }),
    });
    if (!response.ok) throw new Error(`fleet broker user identity returned ${response.status}`);
    const body = await response.json() as { identity?: unknown };
    const identity = parseUserIdentity(body.identity, gatewayId);
    if (!identity) throw new Error("fleet broker returned a malformed user identity");
    return identity;
  };
}

let activeStore: UserIdentityStore | null = null;

export function installUserIdentityStore(store: UserIdentityStore): void {
  activeStore = store;
}

export function builderIdentity(): UserIdentity | null {
  return activeStore?.current() ?? null;
}

export function claimedUserIdentity(): ClaimedUserIdentity | null {
  const identity = builderIdentity();
  return identity?.state === "claimed" ? identity : null;
}
