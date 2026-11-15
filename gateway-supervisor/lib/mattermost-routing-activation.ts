import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { CONFIG_PATCH_DEADLINE_MS } from "@octogee/shared/types/fleet-controller";
import type { GatewayRpcClient } from "./gateway-rpc.js";

const MARKER_FILE = ".mattermost-routing-restart-required.json";
const ACTIVATION_TIMEOUT_MS = CONFIG_PATCH_DEADLINE_MS + 30_000;
const POLL_MS = 250;
const ACCOUNT_ABSENCE_GRACE_MS = CONFIG_PATCH_DEADLINE_MS + ACTIVATION_TIMEOUT_MS;

interface PendingActivation {
  token: string;
  reason: string;
  accountIds: string[];
  baselineLastStartAt: Record<string, number>;
  createdAt: number;
}

interface PendingActivationClaim {
  filePath: string;
  activation: PendingActivation;
}

interface PendingActivationBatch {
  claims: PendingActivationClaim[];
  reason: string;
  accountIds: string[];
  baselineLastStartAt: Map<string, number>;
}

function markerPath(openclawDir: string): string {
  return path.join(openclawDir, MARKER_FILE);
}

function writePendingActivationFile(filePath: string, pending: PendingActivation): void {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(pending)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function readPendingActivationFile(filePath: string): PendingActivation | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PendingActivation>;
    if (
      typeof value.token !== "string" ||
      typeof value.reason !== "string" ||
      !Array.isArray(value.accountIds) ||
      !value.accountIds.every((accountId) => typeof accountId === "string" && accountId.length > 0) ||
      !isRecord(value.baselineLastStartAt) ||
      !value.accountIds.every((accountId) => {
        const lastStartAt = value.baselineLastStartAt?.[accountId];
        return typeof lastStartAt === "number" && Number.isFinite(lastStartAt) && lastStartAt >= 0;
      })
    ) {
      throw new Error("Mattermost routing activation marker is malformed");
    }
    if (
      value.createdAt !== undefined &&
      (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || value.createdAt < 0)
    ) {
      throw new Error("Mattermost routing activation marker has invalid createdAt");
    }
    return {
      token: value.token,
      reason: value.reason,
      accountIds: [...new Set(value.accountIds)],
      baselineLastStartAt: Object.fromEntries(
        [...new Set(value.accountIds)].map((accountId) => [
          accountId,
          value.baselineLastStartAt![accountId] as number,
        ]),
      ),
      createdAt: value.createdAt ?? fs.statSync(filePath).mtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function pendingActivationFilePaths(openclawDir: string): string[] {
  try {
    return fs.readdirSync(openclawDir)
      .filter((entry) =>
        entry === MARKER_FILE ||
        (entry.startsWith(`${MARKER_FILE}.`) &&
          (entry.endsWith(".pending") || entry.endsWith(".confirmed")))
      )
      .sort()
      .map((entry) => path.join(openclawDir, entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function readPendingActivation(openclawDir: string): PendingActivationBatch | null {
  const claims = pendingActivationFilePaths(openclawDir).flatMap((filePath) => {
    const activation = readPendingActivationFile(filePath);
    return activation ? [{ filePath, activation }] : [];
  });
  if (claims.length === 0) return null;
  return {
    claims,
    reason: claims[0]!.activation.reason,
    accountIds: [...new Set(claims.flatMap((claim) => claim.activation.accountIds))].sort(),
    baselineLastStartAt: new Map(
      [...new Set(claims.flatMap((claim) => claim.activation.accountIds))]
        .sort()
        .map((accountId) => [
          accountId,
          Math.max(...claims.flatMap((claim) =>
            claim.activation.accountIds.includes(accountId)
              ? [claim.activation.baselineLastStartAt[accountId] ?? 0]
              : []
          )),
        ]),
    ),
  };
}

export function mattermostRoutingActivationPending(openclawDir: string): boolean {
  return readPendingActivation(openclawDir) !== null;
}

export function markMattermostRoutingActivationPending(
  openclawDir: string,
  reason: string,
  accountIds: readonly string[],
  baselineLastStartAt: Readonly<Record<string, number>>,
): string {
  const token = randomUUID();
  const existing = readPendingActivation(openclawDir);
  const pending = {
    token,
    reason: existing?.reason ?? reason,
    accountIds: [...new Set(accountIds)].sort(),
    baselineLastStartAt: Object.fromEntries(
      [...new Set(accountIds)].sort().map((accountId) => {
        const lastStartAt = baselineLastStartAt[accountId];
        if (typeof lastStartAt !== "number" || !Number.isFinite(lastStartAt) || lastStartAt < 0) {
          throw new Error(`Mattermost routing activation baseline is missing for ${accountId}`);
        }
        return [accountId, lastStartAt];
      }),
    ),
    createdAt: Date.now(),
  };
  if (pending.accountIds.length === 0) {
    throw new Error("Mattermost routing activation requires at least one account");
  }
  const target = `${markerPath(openclawDir)}.${token}.pending`;
  fs.mkdirSync(openclawDir, { recursive: true });
  writePendingActivationFile(target, pending);
  return pending.token;
}

function accountBelongsToUser(accountId: string, slugs: ReadonlySet<string>): boolean {
  return [...slugs].some((slug) =>
    accountId === `${slug}-coach` || accountId.startsWith(`${slug}-proj-`)
  );
}

export function discardMattermostRoutingActivationForUsers(
  openclawDir: string,
  slugs: readonly string[],
): void {
  const managedSlugs = new Set(slugs);
  if (managedSlugs.size === 0) return;
  for (const filePath of pendingActivationFilePaths(openclawDir)) {
    const pending = readPendingActivationFile(filePath);
    if (!pending) continue;
    const retainedAccountIds = pending.accountIds.filter((accountId) =>
      !accountBelongsToUser(accountId, managedSlugs)
    );
    if (retainedAccountIds.length === pending.accountIds.length) continue;
    if (retainedAccountIds.length === 0) {
      try {
        fs.rmSync(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    writePendingActivationFile(filePath, {
      ...pending,
      token: randomUUID(),
      accountIds: retainedAccountIds,
      baselineLastStartAt: Object.fromEntries(
        retainedAccountIds.map((accountId) => [accountId, pending.baselineLastStartAt[accountId]!]),
      ),
    });
  }
}

function clearPendingActivation(openclawDir: string, batch: PendingActivationBatch): boolean {
  for (const claim of batch.claims) {
    const current = readPendingActivationFile(claim.filePath);
    if (current?.token !== claim.activation.token) continue;
    try {
      fs.rmSync(claim.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return readPendingActivation(openclawDir) === null;
}

interface MattermostAccountStatus {
  accountId?: string;
  lastStartAt?: number | null;
  running?: boolean;
  connected?: boolean;
}

async function mattermostAccountStatuses(
  rpc: GatewayRpcClient,
): Promise<Map<string, MattermostAccountStatus>> {
  const snapshot = (await rpc.channelsStatus()) as {
    channelAccounts?: { mattermost?: MattermostAccountStatus[] };
  };
  return new Map(
    (snapshot.channelAccounts?.mattermost ?? [])
      .filter((entry): entry is MattermostAccountStatus & { accountId: string } =>
        typeof entry.accountId === "string")
      .map((entry) => [entry.accountId, entry]),
  );
}

export async function captureMattermostRoutingActivationBaseline(
  rpc: GatewayRpcClient,
  accountIds: readonly string[],
): Promise<Record<string, number>> {
  const statuses = await mattermostAccountStatuses(rpc);
  return Object.fromEntries(
    [...new Set(accountIds)].sort().map((accountId) => {
      const account = statuses.get(accountId);
      if (!account) return [accountId, 0];
      const lastStartAt = account.lastStartAt;
      if (lastStartAt === null) return [accountId, 0];
      if (typeof lastStartAt !== "number" || !Number.isFinite(lastStartAt) || lastStartAt < 0) {
        throw new Error(`Mattermost account ${accountId} has an invalid lastStartAt`);
      }
      return [accountId, lastStartAt];
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function configuredMattermostAccountIds(
  rpc: GatewayRpcClient,
): Promise<Set<string>> {
  const snapshot = await rpc.configGet();
  const config = snapshot.config;
  if (!isRecord(config)) {
    throw new Error("Mattermost routing activation requires an object config snapshot");
  }
  const channels = config.channels;
  if (channels === undefined) return new Set();
  if (!isRecord(channels)) {
    throw new Error("Mattermost routing activation requires channels to be an object");
  }
  const mattermost = channels.mattermost;
  if (mattermost === undefined) return new Set();
  if (!isRecord(mattermost)) {
    throw new Error("Mattermost routing activation requires channels.mattermost to be an object");
  }
  const accounts = mattermost.accounts;
  if (accounts === undefined) return new Set();
  if (!isRecord(accounts)) {
    throw new Error("Mattermost routing activation requires Mattermost accounts to be an object");
  }
  return new Set(
    Object.entries(accounts)
      .filter(([, account]) => account !== null)
      .map(([accountId]) => accountId),
  );
}

function latestClaimCreatedAt(batch: PendingActivationBatch, accountId: string): number {
  return Math.max(
    ...batch.claims.flatMap((claim) =>
      claim.activation.accountIds.includes(accountId) ? [claim.activation.createdAt] : []
    ),
  );
}

async function activePendingAccountIds(
  rpc: GatewayRpcClient,
  batch: PendingActivationBatch,
  now: () => number,
  accountAbsenceGraceMs: number,
  log: (message: string) => void,
): Promise<string[]> {
  const configured = await configuredMattermostAccountIds(rpc);
  const retired = batch.accountIds.filter((accountId) =>
    !configured.has(accountId) &&
    now() - latestClaimCreatedAt(batch, accountId) >= accountAbsenceGraceMs
  );
  if (retired.length > 0) {
    log(`${batch.reason}; discarded retired Mattermost accounts: ${retired.join(", ")}`);
  }
  const retiredSet = new Set(retired);
  return batch.accountIds.filter((accountId) => !retiredSet.has(accountId));
}

interface RoutingActivationBaseline {
  accounts: Map<string, number>;
}

interface RoutingActivationRuntime {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  phaseTimeoutMs: number;
  log: (message: string) => void;
}

function accountsActivated(
  after: ReadonlyMap<string, MattermostAccountStatus>,
  accountIds: readonly string[],
  baseline: RoutingActivationBaseline,
): boolean {
  return accountIds.every((accountId) => {
    const account = after.get(accountId);
    if (account?.running !== true || account.connected !== true) return false;
    if (
      typeof account.lastStartAt !== "number" ||
      !Number.isFinite(account.lastStartAt) ||
      account.lastStartAt < 0
    ) return false;
    return account.lastStartAt > (baseline.accounts.get(accountId) ?? 0);
  });
}

async function confirmRoutingActivation(
  rpc: GatewayRpcClient,
  pending: PendingActivationBatch,
  accountIds: readonly string[],
  baseline: RoutingActivationBaseline,
  runtime: RoutingActivationRuntime,
): Promise<void> {
  const deadline = runtime.now() + runtime.phaseTimeoutMs;
  let lastPollError = "";
  while (runtime.now() < deadline) {
    await runtime.sleep(POLL_MS);
    try {
      const after = await mattermostAccountStatuses(rpc);
      if (accountsActivated(after, accountIds, baseline)) return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastPollError) {
        runtime.log(`${pending.reason}; waiting for restarted Mattermost accounts: ${message}`);
        lastPollError = message;
      }
    }
  }
  throw new Error(`${pending.reason}; Mattermost routing activation was not observed`);
}

async function restartMattermostAccounts(
  rpc: GatewayRpcClient,
  pending: PendingActivationBatch,
  accountIds: readonly string[],
  log: (message: string) => void,
): Promise<void> {
  const failures: Error[] = [];
  for (const accountId of accountIds) {
    const before = failures.length;
    try {
      await rpc.channelsStop({ channel: "mattermost", accountId });
    } catch (error) {
      failures.push(new Error(`${accountId} stop failed`, { cause: error }));
    }
    try {
      await rpc.channelsStart({ channel: "mattermost", accountId });
    } catch (error) {
      failures.push(new Error(`${accountId} start failed`, { cause: error }));
    }
    if (failures.length === before) {
      log(`${pending.reason}; restarted Mattermost account ${accountId} after config no-op`);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${pending.reason}; Mattermost account restart failed`);
  }
}

async function pendingAccountsToRestart(
  rpc: GatewayRpcClient,
  pending: PendingActivationBatch,
  accountIds: readonly string[],
  restartAccountIds: readonly string[],
  restartConfiguredPending: boolean,
): Promise<string[]> {
  const requested = new Set(restartAccountIds);
  if (restartConfiguredPending) {
    const configured = await configuredMattermostAccountIds(rpc);
    const statuses = await mattermostAccountStatuses(rpc);
    for (const accountId of accountIds) {
      if (configured.has(accountId) && !accountsActivated(statuses, [accountId], { accounts: pending.baselineLastStartAt })) requested.add(accountId);
    }
  }
  return accountIds.filter((accountId) => requested.has(accountId));
}

export async function stopStaleMattermostRoutingAccounts(
  rpc: GatewayRpcClient,
  params: {
    currentSlug: string;
    desiredAccountIds: readonly string[];
    evictionSlugs: readonly string[];
  },
  log: (message: string) => void,
): Promise<void> {
  const desired = new Set(params.desiredAccountIds);
  const managedSlugs = new Set([params.currentSlug, ...params.evictionSlugs]);
  const statuses = await mattermostAccountStatuses(rpc);
  const staleAccountIds = [...statuses.entries()].flatMap(([accountId, status]) => {
    if (desired.has(accountId) || status.running !== true) return [];
    return [...managedSlugs].some((slug) =>
      accountId === `${slug}-coach` || accountId.startsWith(`${slug}-proj-`)
    ) ? [accountId] : [];
  });
  const failures: Error[] = [];
  for (const accountId of staleAccountIds) {
    try {
      await rpc.channelsStop({ channel: "mattermost", accountId });
      log(`stopped stale Mattermost account ${accountId} after config no-op`);
    } catch (error) {
      failures.push(new Error(`${accountId} stop failed`, { cause: error }));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Stale Mattermost account stop failed");
  }
}

export async function activateMattermostRoutingAfterConfigPatch(
  rpc: GatewayRpcClient,
  openclawDir: string,
  log: (message: string) => void,
  params: {
    accountIds: readonly string[];
    baseline: Readonly<Record<string, number>>;
    configNoop: boolean;
    required: boolean;
    reason: string;
    currentSlug: string;
    evictionSlugs: readonly string[];
    restartAccountIds?: readonly string[];
  },
): Promise<void> {
  if (params.configNoop) {
    await stopStaleMattermostRoutingAccounts(rpc, {
      currentSlug: params.currentSlug,
      desiredAccountIds: params.accountIds,
      evictionSlugs: params.evictionSlugs,
    }, log);
  }
  if (!params.required && !mattermostRoutingActivationPending(openclawDir)) return;
  await activatePendingMattermostRouting(rpc, openclawDir, log, {
    restartAccountIds: params.restartAccountIds ?? [],
    restartConfiguredPending: true,
  });
}

export async function activatePendingMattermostRouting(
  rpc: GatewayRpcClient,
  openclawDir: string,
  log: (message: string) => void,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
    accountAbsenceGraceMs?: number;
    restartAccountIds?: readonly string[];
    restartConfiguredPending?: boolean;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const accountAbsenceGraceMs = options.accountAbsenceGraceMs ?? ACCOUNT_ABSENCE_GRACE_MS;
  if (!Number.isFinite(accountAbsenceGraceMs) || accountAbsenceGraceMs < 0) {
    throw new Error("Mattermost routing activation account absence grace must be non-negative");
  }
  const runtime = {
    now,
    sleep,
    phaseTimeoutMs: options.timeoutMs ?? ACTIVATION_TIMEOUT_MS,
    log,
  };

  while (true) {
    const pending = readPendingActivation(openclawDir);
    if (!pending) return;
    const accountIds = await activePendingAccountIds(
      rpc,
      pending,
      now,
      accountAbsenceGraceMs,
      log,
    );
    if (accountIds.length === 0) {
      if (clearPendingActivation(openclawDir, pending)) return;
      continue;
    }
    const accountsToRestart = await pendingAccountsToRestart(
      rpc,
      pending,
      accountIds,
      options.restartAccountIds ?? [],
      options.restartConfiguredPending === true,
    );
    if (accountsToRestart.length > 0) {
      await restartMattermostAccounts(rpc, pending, accountsToRestart, log);
    }
    await confirmRoutingActivation(
      rpc,
      pending,
      accountIds,
      { accounts: pending.baselineLastStartAt },
      runtime,
    );
    if (clearPendingActivation(openclawDir, pending)) return;
  }
}
