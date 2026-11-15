import type { WebSocket } from "ws";
import type { BridgeLog } from "@octogee/core/http/bridge-log";

interface ChatActivityBase {
  defaultAgentMmUserId: string;
  channelId: string;
  postId: string;
  mmUserId: string;
}

export type ChatActivityPayload =
  | (ChatActivityBase & { kind: "post" })
  | (ChatActivityBase & { kind: "reaction"; emojiName: string; createdAt: number });

export interface DefaultAgentWsSubject {
  defaultAgentMmUserId: string;
  coachToken: string;
}

export interface MmChatActivityListenerDeps {
  log: BridgeLog;
  openWebSocket: () => WebSocket;
  onChatActivity: (payload: ChatActivityPayload) => void;
  backoffSchedule?: ReadonlyArray<number>;
}

export interface MmChatActivityListenerManager {
  addDefaultAgent(subject: DefaultAgentWsSubject): void;
  removeDefaultAgent(defaultAgentMmUserId: string): void;
  stop(): void;
}

const DEFAULT_BACKOFF = [1_000, 5_000, 15_000, 30_000] as const;

interface DefaultAgentConnection {
  token: string;
  stopped: boolean;
  attempt: number;
  currentWs: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

function parseMattermostPost(data: unknown): Record<string, unknown> | null {
  const envelope = data as Record<string, unknown> | undefined;
  if (!envelope || typeof envelope.post !== "string") return null;
  try {
    const parsed = JSON.parse(envelope.post) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringField(post: Record<string, unknown>, field: string): string {
  const value = post[field];
  return typeof value === "string" ? value : "";
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function postedChatActivity(
  data: unknown,
  defaultAgentMmUserId: string,
): ChatActivityPayload | null {
  const post = parseMattermostPost(data);
  if (!post) return null;
  const type = post.type;
  if (type !== undefined && type !== "") return null;
  const props = post.props as Record<string, unknown> | null | undefined;
  if (props && typeof props === "object" && props.from_bot === "true") return null;
  const mmUserId = stringField(post, "user_id");
  const channelId = stringField(post, "channel_id");
  const postId = stringField(post, "id");
  if (!mmUserId || !channelId || !postId || mmUserId === defaultAgentMmUserId) return null;
  return { defaultAgentMmUserId, kind: "post", channelId, postId, mmUserId };
}

function reactionChatActivity(
  envelope: { data?: unknown; broadcast?: unknown },
  defaultAgentMmUserId: string,
): ChatActivityPayload | null {
  const reaction = parseJsonRecord((envelope.data as Record<string, unknown> | undefined)?.reaction);
  const broadcast = envelope.broadcast as Record<string, unknown> | undefined;
  const channelId = typeof broadcast?.channel_id === "string" ? broadcast.channel_id : "";
  if (!reaction || !channelId) return null;
  const mmUserId = stringField(reaction, "user_id");
  const postId = stringField(reaction, "post_id");
  const emojiName = stringField(reaction, "emoji_name");
  const createdAt = reaction.create_at;
  if (!mmUserId || !postId || !emojiName || mmUserId === defaultAgentMmUserId) return null;
  if (typeof createdAt !== "number") return null;
  return { defaultAgentMmUserId, kind: "reaction", channelId, postId, mmUserId, emojiName, createdAt };
}

function safeToString(data: unknown): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  return typeof data === "string" ? data : "";
}

export function startMmChatActivityListeners(
  deps: MmChatActivityListenerDeps,
): MmChatActivityListenerManager {
  const backoff = deps.backoffSchedule ?? DEFAULT_BACKOFF;
  const connections = new Map<string, DefaultAgentConnection>();
  let managerStopped = false;

  const reportChatActivity = (activity: ChatActivityPayload | null): void => {
    if (!activity) return;
    try {
      deps.onChatActivity(activity);
    } catch (error) {
      deps.log(
        `[mm-event-listener] onChatActivity handler threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warn",
      );
    }
  };

  const scheduleReconnect = (defaultAgentMmUserId: string, conn: DefaultAgentConnection): void => {
    if (conn.stopped || managerStopped || conn.reconnectTimer) return;
    const delayMs = backoff[Math.min(conn.attempt, backoff.length - 1)] ?? 30_000;
    conn.attempt += 1;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      connect(defaultAgentMmUserId, conn);
    }, delayMs);
    conn.reconnectTimer.unref?.();
  };

  const connect = (defaultAgentMmUserId: string, conn: DefaultAgentConnection): void => {
    if (conn.stopped || managerStopped) return;
    let ws: WebSocket;
    try {
      ws = deps.openWebSocket();
    } catch (error) {
      deps.log(
        `[mm-event-listener] openWebSocket threw for agent ${defaultAgentMmUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warn",
      );
      scheduleReconnect(defaultAgentMmUserId, conn);
      return;
    }
    conn.currentWs = ws;
    ws.on("open", () => {
      try {
        ws.send(JSON.stringify({
          seq: 1,
          action: "authentication_challenge",
          data: { token: conn.token },
        }));
      } catch (error) {
        deps.log(
          `[mm-event-listener] auth send failed for agent ${defaultAgentMmUserId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "warn",
        );
      }
    });
    ws.on("message", (data: unknown) => {
      const raw = safeToString(data);
      if (!raw) return;
      try {
        const envelope = JSON.parse(raw) as { event?: unknown; data?: unknown; broadcast?: unknown };
        if (envelope.event === "posted") {
          reportChatActivity(postedChatActivity(envelope.data, defaultAgentMmUserId));
        }
        if (envelope.event === "reaction_added") {
          reportChatActivity(reactionChatActivity(envelope, defaultAgentMmUserId));
        }
      } catch {
        return;
      }
    });
    ws.on("close", () => {
      conn.currentWs = null;
      scheduleReconnect(defaultAgentMmUserId, conn);
    });
    ws.on("error", () => undefined);
  };

  const teardown = (conn: DefaultAgentConnection): void => {
    conn.stopped = true;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
    try {
      conn.currentWs?.close();
    } catch {
      return;
    }
  };

  return {
    addDefaultAgent(subject) {
      if (managerStopped || !subject.defaultAgentMmUserId || !subject.coachToken) return;
      const existing = connections.get(subject.defaultAgentMmUserId);
      if (existing?.token === subject.coachToken) return;
      if (existing) teardown(existing);
      const conn: DefaultAgentConnection = {
        token: subject.coachToken,
        stopped: false,
        attempt: 0,
        currentWs: null,
        reconnectTimer: null,
      };
      connections.set(subject.defaultAgentMmUserId, conn);
      connect(subject.defaultAgentMmUserId, conn);
    },
    removeDefaultAgent(defaultAgentMmUserId) {
      const conn = connections.get(defaultAgentMmUserId);
      if (!conn) return;
      teardown(conn);
      connections.delete(defaultAgentMmUserId);
    },
    stop() {
      managerStopped = true;
      for (const conn of connections.values()) teardown(conn);
      connections.clear();
    },
  };
}
