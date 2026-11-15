import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acquireSystemConfigSyncLeaseSync } from "@octogee/core/system-config-mutation-lease";

export const MATTERMOST_ACCOUNT_SECRET_PROVIDER = "octogee-mattermost";

export interface MattermostAccountSecretRef {
  source: "file";
  provider: typeof MATTERMOST_ACCOUNT_SECRET_PROVIDER;
  id: string;
}

const updates = new Map<string, Promise<void>>();
const MATTERMOST_ACCOUNT_SECRETS_LOCK = ".mattermost-accounts.lock";
const MATTERMOST_ACCOUNT_SECRETS_LOCK_TIMEOUT_MS = 30_000;
const MATTERMOST_ACCOUNT_SECRETS_LOCK_RETRY_MS = 10;
let tempSequence = 0;

function jsonPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function assertAccountId(accountId: string): void {
  if (accountId.trim().length === 0 || accountId.includes("\0")) {
    throw new Error("Mattermost account id must be non-empty and contain no NUL bytes");
  }
}

export function mattermostAccountSecretRef(accountId: string): MattermostAccountSecretRef {
  assertAccountId(accountId);
  return {
    source: "file",
    provider: MATTERMOST_ACCOUNT_SECRET_PROVIDER,
    id: `/${jsonPointerSegment(accountId)}`,
  };
}

export function mattermostAccountSecretsPath(openclawDir: string): string {
  return path.join(openclawDir, "secrets", "mattermost-accounts.json");
}

export function mattermostProjectAccountSecretChange(
  slug: string,
  projects: ReadonlyArray<{ projectId: string; enabled: boolean; token?: string | null }>,
): { set: Record<string, string>; remove: string[] } {
  const set: Record<string, string> = {};
  const remove: string[] = [];
  for (const project of projects) {
    const accountId = `${slug}-proj-${project.projectId}`;
    if (project.enabled && project.token) set[accountId] = project.token;
    else remove.push(accountId);
  }
  return { set, remove };
}

async function readSecrets(filePath: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  const entries = Object.entries(parsed);
  if (!entries.every(([key, value]) => key.length > 0 && typeof value === "string" && value.length > 0)) {
    throw new Error(`${filePath} contains an invalid Mattermost account secret`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

async function writeSecrets(filePath: string, secrets: Record<string, string>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(filePath), 0o700);
  const tempPath = `${filePath}.${process.pid}.${tempSequence++}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600);
}

async function acquireMattermostAccountSecretsLease(filePath: string) {
  const secretsDir = path.dirname(filePath);
  const deadline = Date.now() + MATTERMOST_ACCOUNT_SECRETS_LOCK_TIMEOUT_MS;
  while (true) {
    const lease = acquireSystemConfigSyncLeaseSync({
      openclawDir: secretsDir,
      lockName: MATTERMOST_ACCOUNT_SECRETS_LOCK,
    });
    if (lease) return lease;
    if (Date.now() >= deadline) {
      throw new Error(`timed out acquiring Mattermost account secrets lock for ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, MATTERMOST_ACCOUNT_SECRETS_LOCK_RETRY_MS));
  }
}

async function withMattermostAccountSecretsLease(
  filePath: string,
  action: () => Promise<void>,
): Promise<void> {
  const lease = await acquireMattermostAccountSecretsLease(filePath);
  try {
    await action();
  } catch (error) {
    try {
      lease.release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `Mattermost account secrets update and lock release failed for ${filePath}`,
      );
    }
    throw error;
  }
  lease.release();
}

function secretsSnapshot(secrets: Record<string, string>): string {
  return JSON.stringify(Object.keys(secrets).sort().map((accountId) => [accountId, secrets[accountId]]));
}

export async function updateMattermostAccountSecrets(
  openclawDir: string,
  change: {
    set?: Readonly<Record<string, string>>;
    remove?: readonly string[];
    removePrefixes?: readonly string[];
  },
): Promise<{ changed: boolean }> {
  const filePath = mattermostAccountSecretsPath(openclawDir);
  const prior = updates.get(filePath) ?? Promise.resolve();
  let changed = false;
  const current = prior.catch(() => undefined).then(() => withMattermostAccountSecretsLease(
    filePath,
    async () => {
      const secrets = await readSecrets(filePath);
      const before = secretsSnapshot(secrets);
      for (const accountId of change.remove ?? []) {
        assertAccountId(accountId);
        delete secrets[accountId];
      }
      for (const prefix of change.removePrefixes ?? []) {
        if (prefix.length === 0) throw new Error("Mattermost account removal prefix must be non-empty");
        for (const accountId of Object.keys(secrets)) {
          if (accountId.startsWith(prefix)) delete secrets[accountId];
        }
      }
      for (const [accountId, token] of Object.entries(change.set ?? {})) {
        assertAccountId(accountId);
        if (token.length === 0) throw new Error(`Mattermost account ${accountId} has an empty token`);
        secrets[accountId] = token;
      }
      changed = secretsSnapshot(secrets) !== before;
      await writeSecrets(filePath, secrets);
    },
  ));
  updates.set(filePath, current);
  try {
    await current;
  } finally {
    if (updates.get(filePath) === current) updates.delete(filePath);
  }
  return { changed };
}

export async function readMattermostAccountSecret(
  openclawDir: string,
  accountId: string,
): Promise<string | null> {
  assertAccountId(accountId);
  return (await readSecrets(mattermostAccountSecretsPath(openclawDir)))[accountId] ?? null;
}
