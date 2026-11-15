export interface ChannelMemberResolver {
  getMembers: (channelId: string) => Promise<ReadonlySet<string>>;
  invalidate: (channelId: string) => void;
}

interface Entry {
  members: ReadonlySet<string>;
  at: number;
}

export function createChannelMemberResolver(deps: {
  fetchMembers: (channelId: string) => Promise<Set<string>>;
  ttlMs?: number;
  now?: () => number;

onError?: (channelId: string, err: unknown) => void;
}): ChannelMemberResolver {
  const ttlMs = deps.ttlMs ?? 60_000;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<Set<string>>>();

  return {
    async getMembers(channelId) {
      const cached = cache.get(channelId);
      if (cached && now() - cached.at < ttlMs) {
        return cached.members;
      }
      const pending = inflight.get(channelId);
      if (pending) {
        return pending;
      }
      const p = (async () => {
        try {
          const members = await deps.fetchMembers(channelId);
          cache.set(channelId, { members, at: now() });
          return members;
        } catch (err) {

deps.onError?.(channelId, err);
          return new Set<string>();
        } finally {
          inflight.delete(channelId);
        }
      })();
      inflight.set(channelId, p);
      return p;
    },
    invalidate(channelId) {
      cache.delete(channelId);
    },
  };
}
