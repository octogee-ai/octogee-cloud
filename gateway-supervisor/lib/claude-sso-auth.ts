import { randomUUID } from "crypto";

export interface ClaudeSsoPrompt {
  verificationUrl: string;
  expiresInMinutes: number | null;
}

export interface ClaudeSsoChild {
  onStdout(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
  writeStdin(value: string): void;
  kill(): void;
}

export interface ClaudeSsoDeps {
  spawnClaudeSso: (agentId: string) => ClaudeSsoChild;
  readCredentials: (agentId: string) => Promise<string | null>;
  postCapture: (
    flowId: string,
    credential: string,
  ) => Promise<{ ok: boolean; reason?: string }>;
  discardStaged: (agentId: string) => Promise<void>;
  now: () => number;
  spawnTimeoutMs?: number;
  defaultExpiryMinutes?: number;
  terminalGraceMs?: number;
  log?: (m: string) => void;
}

export interface ClaudeSsoStartResult {
  flowId: string;
  verificationUrl: string;
  expiresInMinutes: number | null;
  state: ClaudeSsoPhase;
}

export interface ClaudeSsoStatusResult {
  state: ClaudeSsoPhase;
  expiresInMinutes?: number;
  reason?: string;
}

export interface ClaudeSsoManager {
  start(agentId: string): Promise<ClaudeSsoStartResult>;
  submit(flowId: string, code: string): ClaudeSsoStatusResult | null;
  status(flowId: string): ClaudeSsoStatusResult | null;
}

export type ClaudeSsoPhase =
  | "awaiting_user"
  | "submitting"
  | "capturing"
  | "connected"
  | "expired"
  | "failed";

interface FlowRecord {
  flowId: string;
  agentId: string;
  child: ClaudeSsoChild;
  verificationUrl: string;
  expiresAt: number;
  expiresInMinutes: number | null;
  phase: ClaudeSsoPhase;
  reason?: string;
  killed: boolean;
  terminalAt: number | null;
}

const DEFAULT_SPAWN_TIMEOUT_MS = 30_000;
const DEFAULT_EXPIRY_MINUTES = 15;
const DEFAULT_TERMINAL_GRACE_MS = 5 * 60_000;
const TERMINAL: ReadonlySet<ClaudeSsoPhase> = new Set([
  "connected",
  "expired",
  "failed",
]);

export function parseClaudeSsoPrompt(output: string): ClaudeSsoPrompt | null {
  if (!/Paste code here if prompted\s*>/i.test(output)) return null;
  const match = output.match(/https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s]+/);
  if (!match) return null;
  return { verificationUrl: match[0], expiresInMinutes: null };
}

export function createClaudeSsoManager(deps: ClaudeSsoDeps): ClaudeSsoManager {
  const log = deps.log ?? (() => {});
  const spawnTimeoutMs = deps.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
  const defaultExpiryMinutes = deps.defaultExpiryMinutes ?? DEFAULT_EXPIRY_MINUTES;
  const terminalGraceMs = deps.terminalGraceMs ?? DEFAULT_TERMINAL_GRACE_MS;
  const byFlow = new Map<string, FlowRecord>();
  const flowByAgent = new Map<string, string>();
  const inFlight = new Map<string, Promise<ClaudeSsoStartResult>>();

  function evictExpiredTerminals(): void {
    const now = deps.now();
    for (const [flowId, rec] of byFlow) {
      if (rec.terminalAt !== null && now - rec.terminalAt >= terminalGraceMs) {
        byFlow.delete(flowId);
        if (flowByAgent.get(rec.agentId) === flowId) flowByAgent.delete(rec.agentId);
      }
    }
  }

  function markTerminal(rec: FlowRecord, phase: ClaudeSsoPhase, reason?: string): void {
    rec.phase = phase;
    rec.reason = reason;
    if (!TERMINAL.has(phase)) return;
    if (rec.terminalAt === null) rec.terminalAt = deps.now();
    if (!rec.killed) {
      rec.killed = true;
      try {
        rec.child.kill();
      } catch (e) {
        log(
          `claude-sso: kill failed for ${rec.agentId} flow=${rec.flowId} — ${(e as Error).message}`,
        );
      }
    }
    deps.discardStaged(rec.agentId).catch((e: unknown) => {
      log(
        `claude-sso: staging cleanup failed for ${rec.agentId} flow=${rec.flowId} — ${(e as Error).message}`,
      );
    });
    if (flowByAgent.get(rec.agentId) === rec.flowId) flowByAgent.delete(rec.agentId);
  }

  function tick(rec: FlowRecord): void {
    if (rec.phase === "awaiting_user" && deps.now() >= rec.expiresAt) {
      markTerminal(rec, "expired");
    }
  }

  function statusFor(rec: FlowRecord): ClaudeSsoStatusResult {
    if (rec.phase === "awaiting_user") {
      return {
        state: rec.phase,
        expiresInMinutes: Math.max(0, Math.ceil((rec.expiresAt - deps.now()) / 60_000)),
      };
    }
    if (rec.phase === "failed") return { state: "failed", reason: rec.reason };
    return { state: rec.phase };
  }

  async function onChildExit(rec: FlowRecord, code: number): Promise<void> {
    if (TERMINAL.has(rec.phase)) return;
    if (code !== 0) {
      markTerminal(rec, "failed", `claude exited ${code}`);
      return;
    }
    rec.phase = "capturing";
    let credential: string | null;
    try {
      credential = await deps.readCredentials(rec.agentId);
    } catch (e) {
      markTerminal(rec, "failed", `claude SSO credential read failed: ${(e as Error).message}`);
      return;
    }
    if (credential === null) {
      markTerminal(rec, "failed", "claude SSO completed without .credentials.json");
      return;
    }
    let result: { ok: boolean; reason?: string };
    try {
      result = await deps.postCapture(rec.flowId, credential);
    } catch (e) {
      result = { ok: false, reason: (e as Error).message };
    }
    if (!result.ok) {
      markTerminal(rec, "failed", result.reason ?? "capture failed");
      return;
    }
    markTerminal(rec, "connected");
    log(`claude-sso: ${rec.agentId} flow=${rec.flowId} → connected`);
  }

  function liveFlowFor(agentId: string): FlowRecord | null {
    const flowId = flowByAgent.get(agentId);
    if (!flowId) return null;
    const rec = byFlow.get(flowId);
    if (!rec) return null;
    tick(rec);
    return rec.phase === "awaiting_user" || rec.phase === "submitting" ? rec : null;
  }

  async function beginFlow(agentId: string): Promise<ClaudeSsoStartResult> {
    const child = deps.spawnClaudeSso(agentId);
    let rec: FlowRecord | null = null;
    let settled = false;
    let buffer = "";
    let parsed: ClaudeSsoPrompt;
    try {
      parsed = await new Promise<ClaudeSsoPrompt>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            child.kill();
          } catch (e) {
            log(`claude-sso: spawn timeout kill failed for ${agentId} — ${(e as Error).message}`);
          }
          reject(new Error("claude SSO spawn timeout"));
        }, spawnTimeoutMs);
        child.onStdout((chunk) => {
          if (settled) return;
          buffer += chunk;
          const prompt = parseClaudeSsoPrompt(buffer);
          if (!prompt) return;
          settled = true;
          clearTimeout(timer);
          resolve(prompt);
        });
        child.onExit((code) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(`claude exited ${code} before an SSO prompt`));
            return;
          }
          if (rec) void onChildExit(rec, code);
        });
      });
    } catch (e) {
      await deps.discardStaged(agentId).catch((cleanupError: unknown) => {
        log(
          `claude-sso: staging cleanup failed after start error for ${agentId} — ${(cleanupError as Error).message}`,
        );
      });
      throw e;
    }
    const flowId = randomUUID();
    const expiresInMinutes = parsed.expiresInMinutes ?? defaultExpiryMinutes;
    rec = {
      flowId,
      agentId,
      child,
      verificationUrl: parsed.verificationUrl,
      expiresInMinutes: parsed.expiresInMinutes,
      expiresAt: deps.now() + expiresInMinutes * 60_000,
      phase: "awaiting_user",
      killed: false,
      terminalAt: null,
    };
    byFlow.set(flowId, rec);
    flowByAgent.set(agentId, flowId);
    log(`claude-sso: ${agentId} flow=${flowId} → awaiting_user`);
    return {
      flowId,
      verificationUrl: rec.verificationUrl,
      expiresInMinutes: rec.expiresInMinutes,
      state: "awaiting_user",
    };
  }

  function start(agentId: string): Promise<ClaudeSsoStartResult> {
    evictExpiredTerminals();
    const existing = liveFlowFor(agentId);
    if (existing) {
      return Promise.resolve({
        flowId: existing.flowId,
        verificationUrl: existing.verificationUrl,
        expiresInMinutes: existing.expiresInMinutes,
        state: existing.phase,
      });
    }
    const pending = inFlight.get(agentId);
    if (pending) return pending;
    const created = beginFlow(agentId).finally(() => inFlight.delete(agentId));
    inFlight.set(agentId, created);
    return created;
  }

  function submit(flowId: string, code: string): ClaudeSsoStatusResult | null {
    const rec = byFlow.get(flowId);
    if (!rec) return null;
    tick(rec);
    if (rec.phase !== "awaiting_user") return statusFor(rec);
    if (!code.trim()) {
      markTerminal(rec, "failed", "empty Claude SSO code");
      return statusFor(rec);
    }
    rec.phase = "submitting";
    rec.child.writeStdin(`${code.trim()}\n`);
    return statusFor(rec);
  }

  function status(flowId: string): ClaudeSsoStatusResult | null {
    evictExpiredTerminals();
    const rec = byFlow.get(flowId);
    if (!rec) return null;
    tick(rec);
    return statusFor(rec);
  }

  return { start, submit, status };
}
