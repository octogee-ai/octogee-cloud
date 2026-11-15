import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import type { FinalReplyNotification } from "@octogee/core/native-final-reply";

export interface UserNotification {
  eventId: string;
  category: "system.security";
  title: string;
  body: string;
  action: { type: "navigate"; path: string };
}

export interface UserNotificationDelivery {
  failed: ReadonlyArray<{ uid: string; error: string }>;
}

export type UserNotifier = (
  notification: UserNotification,
  targetUserIds: string[],
) => Promise<UserNotificationDelivery>;

export type FinalReplyNotifier = (signal: FinalReplyNotification, uid: string) => Promise<void>;

export interface CapturedCreatedPost {
  status: number;
  body: string;
  authorization: string | undefined;
}

export interface CreatedPostObserver {
  handleCreatedPost(captured: CapturedCreatedPost): Promise<void>;
}

export interface ProductNotifications {
  notifyUsers: UserNotifier;
  notifyFinalReply: FinalReplyNotifier;
  createPostObserver(store: Pick<PlatformStateRepositories, "users" | "workspaces">): CreatedPostObserver;
}
