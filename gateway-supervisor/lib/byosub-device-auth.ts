

import { randomUUID } from "crypto";
import {
  type FlowState,
  startFlow,
  nextFlowState,
} from "./byosub-onboarding.js";
import { parseCodexDeviceAuth } from "./codex-device-auth.js";

export interface DeviceAuthChild {
  onStdout(cb: (chunk: string) => void): void;
  
  onExit(cb: (code: number) => void): void;
  kill(): void;
}

export interface DeviceAuthDeps {
  spawnDeviceAuth: (agentId: string) => DeviceAuthChild;
  
  readAuthJson: (agentId: string) => Promise<string | null>;
  
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

export interface StartResult {
  flowId: string;
  verificationUrl: string;
  userCode: string;
  expiresInMinutes: number | null;
  state: FlowState["phase"];
}

export interface StatusResult {
  state: FlowState["phase"];
  expiresInMinutes?: number;
  reason?: string;
}

export interface DeviceAuthManager {
  start(agentId: string): Promise<StartResult>;
  status(flowId: string): StatusResult | null;
}

interface FlowRecord {
  flowId: string;
  agentId: string;
  state: FlowState;
  verificationUrl: string;
  userCode: string;
  expiresInMinutes: number | null;
  kill: () => void;
  killed: boolean;
  terminalAt: number | null;
}

const DEFAULT_SPAWN_TIMEOUT_MS = 30_000;
const DEFAULT_EXPIRY_MINUTES = 15;
const MAX_EXPIRY_MINUTES = 30;
const DEFAULT_TERMINAL_GRACE_MS = 5 * 60_000;

const TERMINAL: ReadonlySet<FlowState["phase"]> = new Set([
  "connected",
  "expired",
  "failed",
]);

export function createDeviceAuthManager(
  deps: DeviceAuthDeps,
): DeviceAuthManager {
  const log = deps.log ?? (() => {});
  const spawnTimeoutMs = deps.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
  const defaultExpiryMin = deps.defaultExpiryMinutes ?? DEFAULT_EXPIRY_MINUTES;
  const terminalGraceMs = deps.terminalGraceMs ?? DEFAULT_TERMINAL_GRACE_MS;
  const byFlow = new Map<string, FlowRecord>();
  const flowByAgent = new Map<string, string>();
  const inFlight = new Map<string, Promise<StartResult>>();

  function evictExpiredTerminals(): void {
    const now = deps.now();
    for (const [fid, rec] of byFlow) {
      if (rec.terminalAt !== null && now - rec.terminalAt >= terminalGraceMs) {
        byFlow.delete(fid);
        if (flowByAgent.get(rec.agentId) === fid) {
          flowByAgent.delete(rec.agentId);
        }
      }
    }
  }

  function reapIfTerminal(rec: FlowRecord): void {
    if (!TERMINAL.has(rec.state.phase)) return;
    if (rec.terminalAt === null) rec.terminalAt = deps.now();
    if (!rec.killed) {
      rec.killed = true;
      try {
        rec.kill();
      } catch (e) {
        log(
          `byosub device-auth: kill failed for ${rec.agentId} flow=${rec.flowId} — ${(e as Error).message}`,
        );
      }

deps.discardStaged(rec.agentId).catch(() => {});
    }
    
    if (flowByAgent.get(rec.agentId) === rec.flowId) {
      flowByAgent.delete(rec.agentId);
    }
  }

  function liveFlowFor(agentId: string): FlowRecord | null {
    const fid = flowByAgent.get(agentId);
    if (!fid) return null;
    const rec = byFlow.get(fid);
    if (!rec) return null;
    if (rec.state.phase === "awaiting_user" && deps.now() < rec.state.expiresAt) {
      return rec;
    }
    return null;
  }

  function reuse(rec: FlowRecord): StartResult {
    return {
      flowId: rec.flowId,
      verificationUrl: rec.verificationUrl,
      userCode: rec.userCode,
      expiresInMinutes: rec.expiresInMinutes,
      state: rec.state.phase,
    };
  }

  async function onChildExit(rec: FlowRecord, code: number): Promise<void> {
    const auth = await deps.readAuthJson(rec.agentId);
    rec.state = nextFlowState(rec.state, {
      type: "childExit",
      code,
      authPresent: auth !== null,
    });

if (code === 0 && auth !== null && rec.state.phase !== "capturing") {
      log(
        `byosub device-auth: WARN ${rec.agentId} flow=${rec.flowId} codex completed post-terminal (phase=${rec.state.phase}); credential on disk uncaptured — recover via re-Connect / sync-back`,
      );
    }
    if (rec.state.phase === "capturing") {
      let result: { ok: boolean; reason?: string };
      try {
        result = await deps.postCapture(rec.flowId, auth as string);
      } catch (e) {
        result = { ok: false, reason: (e as Error).message };
      }
      rec.state = nextFlowState(rec.state, {
        type: "captureResult",
        ok: result.ok,
        reason: result.reason,
      });
    }
    log(
      `byosub device-auth: ${rec.agentId} flow=${rec.flowId} → ${rec.state.phase}`,
    );
    reapIfTerminal(rec);
  }

  async function beginFlow(agentId: string): Promise<StartResult> {
    const child = deps.spawnDeviceAuth(agentId);
    let rec: FlowRecord | null = null;
    let promptSettled = false;
    let buf = "";
    const scrape = new Promise<ReturnType<typeof parseCodexDeviceAuth>>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          if (promptSettled) return;
          promptSettled = true;
          child.kill();
          reject(new Error("codex device-auth spawn timeout"));
        }, spawnTimeoutMs);
        child.onStdout((chunk) => {
          if (promptSettled) return;
          buf += chunk;
          const parsed = parseCodexDeviceAuth(buf);
          if (parsed) {
            promptSettled = true;
            clearTimeout(timer);
            resolve(parsed);
          }
        });
        
        child.onExit((code) => {
          if (!promptSettled) {
            promptSettled = true;
            clearTimeout(timer);
            reject(new Error(`codex exited ${code} before a device prompt`));
            return;
          }
          if (rec) void onChildExit(rec, code);
        });
      },
    );
    const parsed = await scrape;
    const minutes = Math.min(
      parsed!.expiresInMinutes ?? defaultExpiryMin,
      MAX_EXPIRY_MINUTES,
    );
    const flowId = randomUUID();
    rec = {
      flowId,
      agentId,
      verificationUrl: parsed!.verificationUrl,
      userCode: parsed!.userCode,
      expiresInMinutes: parsed!.expiresInMinutes,
      kill: () => child.kill(),
      killed: false,
      terminalAt: null,
      state: startFlow({
        url: parsed!.verificationUrl,
        code: parsed!.userCode,
        expiresAt: deps.now() + minutes * 60_000,
      }),
    };
    byFlow.set(flowId, rec);
    flowByAgent.set(agentId, flowId);
    log(`byosub device-auth: ${agentId} flow=${flowId} → awaiting_user`);
    return {
      flowId,
      verificationUrl: rec.verificationUrl,
      userCode: rec.userCode,
      expiresInMinutes: rec.expiresInMinutes,
      state: "awaiting_user",
    };
  }

  function start(agentId: string): Promise<StartResult> {
    evictExpiredTerminals();
    const existing = liveFlowFor(agentId);
    if (existing) return Promise.resolve(reuse(existing));
    const pending = inFlight.get(agentId);
    if (pending) return pending;
    const p = beginFlow(agentId).finally(() => {
      inFlight.delete(agentId);
    });
    inFlight.set(agentId, p);
    return p;
  }

  function status(flowId: string): StatusResult | null {
    evictExpiredTerminals();
    const rec = byFlow.get(flowId);
    if (!rec) return null;
    rec.state = nextFlowState(rec.state, { type: "tick", now: deps.now() });
    reapIfTerminal(rec);
    if (rec.state.phase === "awaiting_user") {
      return {
        state: "awaiting_user",
        expiresInMinutes: Math.max(
          0,
          Math.ceil((rec.state.expiresAt - deps.now()) / 60_000),
        ),
      };
    }
    if (rec.state.phase === "failed") {
      return { state: "failed", reason: rec.state.reason };
    }
    return { state: rec.state.phase };
  }

  return { start, status };
}
