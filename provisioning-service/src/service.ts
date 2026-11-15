import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProvisioningRole } from "@octogee/shared/types/provisioning-service";
import type { Reviewer } from "./auth/token-review.js";
import type { ChatHost } from "./hosts/chat-host.js";
import type { CredentialStore } from "./hosts/credential-store.js";
import type { GitHost } from "./hosts/git-host.js";
import { createApp } from "./http/app.js";
import type { Logger } from "./logger.js";
import { Metrics } from "./metrics.js";
import { ChangeNotifier } from "./store/change-notifier.js";
import { migrate, openDatabase, type Database } from "./store/database.js";
import { PostgresCredentialStore } from "./store/postgres-credential-store.js";
import { ProvisioningStore } from "./store/provisioning-store.js";
import { WorkQueue, type QueueOptions } from "./worker/queue.js";
import { Worker } from "./worker/worker.js";

export interface ServiceOptions {
  databaseUrl: string;
  databaseSchema: string;
  credentialKey: Buffer;
  reviewer: Reviewer;
  callerNamespace: string;
  roleTable: Readonly<Record<string, readonly ProvisioningRole[]>>;
  chat: ChatHost;
  git: GitHost;
  log: Logger;
  replicaId: string;
  port: number;
  host?: string;
  queue?: Omit<QueueOptions, "holder">;
  heartbeatMs?: number;
  concurrency?: number;
  runWorker?: boolean;
}

export interface RunningService {
  db: Database;
  store: ProvisioningStore;
  queue: WorkQueue;
  credentials: CredentialStore;
  worker: Worker;
  notifier: ChangeNotifier;
  metrics: Metrics;
  url: string;
  stop(): Promise<void>;
}

export async function startService(options: ServiceOptions): Promise<RunningService> {
  const db = openDatabase({ url: options.databaseUrl, schema: options.databaseSchema });
  await migrate(db);
  const store = new ProvisioningStore(db);
  const queue = new WorkQueue(db, { holder: options.replicaId, ...options.queue });
  const credentials = new PostgresCredentialStore(db, options.credentialKey);
  const notifier = new ChangeNotifier(db, options.databaseUrl, options.log);
  await notifier.start();
  const metrics = new Metrics();
  const worker = new Worker({
    db, queue, credentials, chat: options.chat, git: options.git, metrics, log: options.log, notifier, store,
    ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
  }, options.concurrency);
  const app = createApp({
    store, queue, credentials, notifier, reviewer: options.reviewer, callerNamespace: options.callerNamespace,
    roleTable: options.roleTable, metrics, log: options.log,
  });
  const server: Server = await new Promise((resolve, reject) => {
    const listening = app.listen(options.port, options.host ?? "0.0.0.0", (error?: Error) => (error ? reject(error) : resolve(listening)));
  });
  if (options.runWorker !== false) worker.start();
  const address = server.address() as AddressInfo;
  return {
    db, store, queue, credentials, worker, notifier, metrics,
    url: `http://127.0.0.1:${address.port}`,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await worker.stop();
      await notifier.stop();
      await db.close();
    },
  };
}
