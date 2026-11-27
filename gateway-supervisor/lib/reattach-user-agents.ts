import * as path from "node:path";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import type { LogContext } from "@octogee/shared/server/service-logger";
import { parseAgentId } from "@octogee/shared/types/identity";
import type { PreparedAgentStore } from "./agent-store-snapshot.js";
import { runOpenClaw, type OpenClawCommand, type OpenClawCommandResult } from "./openclaw-cli.js";
import { captureCarriedAgentRosterFailure, type CarriedAgentDiagnosticIdentity } from "./carried-agent-diagnostics.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nativeJson(stdout: string): unknown {
  try { return JSON.parse(stdout) as unknown; }
  catch { throw new Error("Native agent reattachment returned invalid JSON"); }
}

function restorationOutcome(
  result: OpenClawCommandResult,
  expected: { agentId: string; workspace: string; agentDir: string },
): "restored" | "already-configured" {
  const payload = nativeJson(result.stdout);
  if (result.code === 0 && record(payload) && payload.agentId === expected.agentId &&
      payload.workspace === expected.workspace && payload.agentDir === expected.agentDir) return "restored";
  if (result.code === 1 && record(payload) && payload.ok === false && record(payload.error) &&
      payload.error.type === "cli_error" && payload.error.message === `agent "${expected.agentId}" already exists`) {
    return "already-configured";
  }
  throw new Error(`Native carried-agent restoration failed for ${expected.agentId} (exit ${result.code})`);
}

type CarriedAgentStore = Pick<PreparedAgentStore, "agentId" | "destinationPath">;
type CarriedWorkspaceResolver = (agentId: string) => Promise<string | null>;
type CarriedAgentRegistration = { agentId: string; workspace: string; agentDir: string; configured: boolean };

function requiresWorkspaceAuthority(registration: CarriedAgentRegistration): boolean {
  return !registration.configured || parseAgentId(registration.agentId).kind === "project";
}

async function assertWorkspaceAuthority(registration: CarriedAgentRegistration, resolveWorkspace?: CarriedWorkspaceResolver): Promise<void> {
  if (!requiresWorkspaceAuthority(registration)) return;
  if (await resolveWorkspace?.(registration.agentId) !== registration.workspace) {
    throw new Error(`Carried user workspace authority changed for ${registration.agentId}`);
  }
}

async function carriedAgentRegistration(store: CarriedAgentStore, roster: unknown[], resolveWorkspace?: CarriedWorkspaceResolver): Promise<CarriedAgentRegistration> {
  const matches = roster.filter((row: unknown) => record(row) && row.id === store.agentId);
  const row: unknown = matches[0];
  const agentDir = path.dirname(store.destinationPath);
  if (matches.length > 1) throw new Error(`Native roster has duplicate carried user agent ${store.agentId}`);
  if (matches.length === 1) {
    if (!record(row) || typeof row.workspace !== "string" || !path.isAbsolute(row.workspace) || row.agentDir !== agentDir) {
      throw new Error(`Native roster does not match the carried user agent ${store.agentId}`);
    }
    const registration = { agentId: store.agentId, workspace: row.workspace, agentDir, configured: true };
    await assertWorkspaceAuthority(registration, resolveWorkspace);
    return registration;
  }
  const workspace = await resolveWorkspace?.(store.agentId);
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) {
    throw new Error(`Native roster does not match the carried user agent ${store.agentId}`);
  }
  return { agentId: store.agentId, workspace, agentDir, configured: false };
}

async function keptUnregistered(agentId: string, roster: readonly unknown[], retainsUnregistered?: (agentId: string) => Promise<boolean>): Promise<boolean> {
  if (!retainsUnregistered || roster.some(row => record(row) && row.id === agentId)) return false;
  return retainsUnregistered(agentId);
}

export async function reattachUserAgents(input: {
  stores: readonly CarriedAgentStore[];
  env: NodeJS.ProcessEnv;
  assertHeld: () => Promise<void>;
  signal?: AbortSignal;
  run?: OpenClawCommand;
  resolveCarriedWorkspace?: CarriedWorkspaceResolver;
  retainsUnregistered?: (agentId: string) => Promise<boolean>;
  diagnosticIdentity?: CarriedAgentDiagnosticIdentity;
  log: (message: string, fields?: LogContext) => void;
}): Promise<void> {
  if (input.stores.length === 0) return;
  const assertCurrent = async () => {
    input.signal?.throwIfAborted();
    await input.assertHeld();
    input.signal?.throwIfAborted();
  };
  await assertCurrent();
  const stores = input.stores.map(store => {
    const anchor = readPostgresAgentAnchor(store.destinationPath);
    if (!anchor) throw new Error(`Carried user anchor is missing for ${store.agentId}`);
    return { ...store, anchor };
  });
  const assertAnchors = (selected: typeof stores) => {
    for (const store of selected) {
      const current = readPostgresAgentAnchor(store.destinationPath);
      if (current?.storeId !== store.anchor.storeId || current.schema !== store.anchor.schema) {
        throw new Error(`Native agent reattachment changed the carried anchor for ${store.agentId}`);
      }
    }
  };
  const run = input.run ?? runOpenClaw;
  const listed = await run(["agents", "list", "--json"], { env: input.env, signal: input.signal });
  await assertCurrent();
  assertAnchors(stores);
  if (listed.code !== 0) {
    try {
      const captured = await captureCarriedAgentRosterFailure({ env: input.env, identity: input.diagnosticIdentity, result: listed });
      input.log(`[migration-rsync] carried-agent roster diagnostics retained slot=${captured.slot} identity=${captured.identity}`);
    } catch { input.log("[migration-rsync] carried-agent roster diagnostics unavailable"); }
    throw new Error(`Native carried-agent roster inspection failed (exit ${listed.code})`);
  }
  const roster = nativeJson(listed.stdout);
  if (!Array.isArray(roster)) throw new Error("Native carried-agent roster is not an array");
  const registrations = [];
  for (const store of stores) {
    if (await keptUnregistered(store.agentId, roster, input.retainsUnregistered)) {
      input.log(`[migration-rsync] kept archived project agent store unregistered agentId=${store.agentId}`);
      continue;
    }
    const registration = await carriedAgentRegistration(store, roster, input.resolveCarriedWorkspace);
    if (requiresWorkspaceAuthority(registration) && (!input.env.OPENCLAW_STATE_DIR || registration.agentDir !==
        path.join(input.env.OPENCLAW_STATE_DIR, "agents", store.agentId, "agent"))) {
      throw new Error(`Native carried agentDir is not canonical for ${store.agentId}`);
    }
    await assertCurrent();
    assertAnchors(stores);
    registrations.push({ store, registration });
  }
  for (const { store, registration } of registrations) {
    await assertWorkspaceAuthority(registration, input.resolveCarriedWorkspace);
    await assertCurrent();
    assertAnchors(stores);
    const addStartedAt = Date.now();
    const result = await run([
      "agents", "add", store.agentId, "--workspace", registration.workspace,
      "--agent-dir", registration.agentDir, "--non-interactive", "--json",
    ], { env: input.env, signal: input.signal });
    const durationMs = Date.now() - addStartedAt;
    await assertWorkspaceAuthority(registration, input.resolveCarriedWorkspace);
    await assertCurrent();
    assertAnchors([store]);
    const outcome = restorationOutcome(result, registration);
    if (outcome === "already-configured" && !registration.configured) {
      throw new Error(`Native carried-agent roster changed during restoration for ${store.agentId}`);
    }
    input.log(outcome === "restored"
      ? `[migration-rsync] Native restored carried user agent ${store.agentId}`
      : `[migration-rsync] Native reports ${store.agentId} already configured; startup admission remains required`, { durationMs });
  }
  assertAnchors(stores);
}
