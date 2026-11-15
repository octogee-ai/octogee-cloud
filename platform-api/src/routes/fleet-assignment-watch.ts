import type { Request, Response } from "express";
import type { PlatformStateStore, WatchAggregate, WatchRequest, WatchSubscription } from "@octogee/core/platform-state";

export function streamAssignmentChanges(
  req: Request,
  res: Response,
  store: Pick<PlatformStateStore, "watch">,
  gatewayId: string,
  log: (message: string) => void,
): void {
  const subscriptions: WatchSubscription[] = [];
  let closed = false;
  let pending = false;
  res.status(200).set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const flush = () => {
    if (closed || !pending || res.writableNeedDrain) return;
    pending = false;
    res.write("data: changed\n\n");
  };
  const notify = () => {
    pending = true;
    flush();
  };
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableNeedDrain) res.write(": keepalive\n\n");
  }, 15_000);
  const expiry = setTimeout(() => { stop(); res.end(); }, 5 * 60_000);
  const closeSubscription = (subscription: WatchSubscription) => {
    subscription.close().catch((error: unknown) => {
      log(`[fleet-broker] assignment watch ${gatewayId} closed with an error: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(expiry);
    res.off("drain", flush);
    for (const subscription of subscriptions) closeSubscription(subscription);
  };
  const failed = (error: Error) => {
    log(`[fleet-broker] assignment watch ${gatewayId} failed: ${error.message}`);
    stop();
    res.end();
  };
  res.once("close", stop);
  res.on("drain", flush);
  req.once("aborted", stop);
  const watched: Array<WatchRequest<WatchAggregate>> = [
    { aggregate: "assignments", filter: { gatewayId } },
    { aggregate: "builders", filter: { gatewayId } },
    { aggregate: "gateways", filter: { gatewayId } },
  ];
  try {
    for (const request of watched) {
      const subscription = store.watch(request, { onEvent: notify, onError: failed });
      if (closed) closeSubscription(subscription);
      else subscriptions.push(subscription);
    }
  } catch (error) {
    failed(error instanceof Error ? error : new Error(String(error)));
  }
}
