import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";

export const SURGE_OPENCLAW_PROCESS_GATE_FILE = ".surge-openclaw-process-gate.json";
export const SURGE_OPENCLAW_PROCESS_SOCKET_FILE = ".surge-openclaw-process-gate.sock";

export type SurgeOpenClawProcessRole = "normal" | "source" | "target";
export type SurgeOpenClawProcessMode = "held" | "permitted";
export type SurgeOpenClawProcessPhase = "held" | "stopping" | "completing" | "cancelling" | "starting" | "running";

export interface SurgeOpenClawProcessGateState {
  version: 1;
  podUid: string;
  role: SurgeOpenClawProcessRole;
  mode: SurgeOpenClawProcessMode;
  phase: SurgeOpenClawProcessPhase;
  migrationId?: string;
  slug?: string;
  targetPodUid?: string;
  completionStarted?: boolean;
  terminalTarget?: SurgeOpenClawProcessRequest & { completionStarted?: boolean };
}

export interface SurgeOpenClawProcessRequest {
  migrationId: string;
  slug: string;
  targetPodUid: string;
}

export interface SurgeOpenClawProcessGate {
  ensure: (input: { podUid: string; readinessReleased: boolean }) => Promise<SurgeOpenClawProcessGateState>;
  read: () => Promise<SurgeOpenClawProcessGateState | null>;
  holdPrelaunch: (input: { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  hold: (input: SurgeOpenClawProcessRequest & { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  reholdTarget: (input: SurgeOpenClawProcessRequest & { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  reholdReleasedTarget: (input: SurgeOpenClawProcessRequest & { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  claimTargetCompletion: (input: SurgeOpenClawProcessRequest & { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  finalizeTargetCancellation: (input: SurgeOpenClawProcessRequest & { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  holdNormal: (input: { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  permitNormal: (input: { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  hydrateTarget: (input: SurgeOpenClawProcessRequest & { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  permitTarget: (input: SurgeOpenClawProcessRequest & { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  resumeSource: (input: SurgeOpenClawProcessRequest & { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  unreserveTarget: (input: SurgeOpenClawProcessRequest & { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  settleTargetCompletion: (input: SurgeOpenClawProcessRequest & { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  settle: (input: { podUid: string }) => Promise<SurgeOpenClawProcessGateState>;
  markHeld: (input: { podUid: string; migrationId?: string }) => Promise<SurgeOpenClawProcessGateState>;
  markStarting: (input: { podUid: string; migrationId?: string }) => Promise<SurgeOpenClawProcessGateState>;
  markRunning: (input: { podUid: string; migrationId?: string }) => Promise<SurgeOpenClawProcessGateState>;
}

export const SURGE_OPENCLAW_PROCESS_SUPERVISOR_ACTIONS = [
  "status",
  "hold",
  "rehold",
  "rehold-released-target",
  "claim",
  "finalize-cancellation",
  "release-target",
  "hold-normal",
  "migrate-builder-stores",
  "hydrate",
  "permit",
  "permit-normal",
  "resume",
  "unreserve",
  "settle",
] as const;

export type SurgeOpenClawProcessSupervisorAction =
  typeof SURGE_OPENCLAW_PROCESS_SUPERVISOR_ACTIONS[number];

export interface SurgeOpenClawProcessSupervisorRequest {
  action: SurgeOpenClawProcessSupervisorAction;
  expectedPodUid?: string;
  migrationId?: string;
  slug?: string;
  targetPodUid?: string;
}

export function isSurgeOpenClawProcessSupervisorAction(
  value: unknown,
): value is SurgeOpenClawProcessSupervisorAction {
  return typeof value === "string" &&
    (SURGE_OPENCLAW_PROCESS_SUPERVISOR_ACTIONS as readonly string[]).includes(value);
}

export function surgeOpenClawProcessActionNamesMigration(
  action: SurgeOpenClawProcessSupervisorAction,
): action is "hold" | "rehold" | "rehold-released-target" | "claim" | "finalize-cancellation" | "release-target" | "hydrate" | "permit" | "resume" | "unreserve" {
  return action === "hold" || action === "rehold" || action === "claim" ||
    action === "rehold-released-target" ||
    action === "finalize-cancellation" || action === "release-target" || action === "hydrate" || action === "permit" ||
    action === "resume" || action === "unreserve";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonemptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new Error(`surge OpenClaw process gate has invalid ${name}`);
  }
  return value;
}

function validateOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireNonemptyString(value, name);
}

const ROLES: readonly SurgeOpenClawProcessRole[] = ["normal", "source", "target"];
const MODES: readonly SurgeOpenClawProcessMode[] = ["held", "permitted"];
const PHASES: readonly SurgeOpenClawProcessPhase[] = [
  "held",
  "stopping",
  "completing",
  "cancelling",
  "starting",
  "running",
];
const TARGET_MIGRATION_NOT_RESERVED = "surge OpenClaw process gate does not reserve this target migration";

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (!(allowed as readonly unknown[]).includes(value)) {
    throw new Error(`surge OpenClaw process gate has invalid ${name}`);
  }
  return value as T;
}

function parseMigrationIdentity(
  value: Record<string, unknown>,
  role: SurgeOpenClawProcessRole,
): Partial<SurgeOpenClawProcessRequest> {
  const migrationId = validateOptionalString(value.migrationId, "migrationId");
  const slug = validateOptionalString(value.slug, "slug");
  const targetPodUid = validateOptionalString(value.targetPodUid, "targetPodUid");
  const named = migrationId !== undefined || slug !== undefined || targetPodUid !== undefined;
  if (role === "normal" && named) {
    throw new Error("normal surge OpenClaw process gate cannot name a migration");
  }
  if (role !== "normal" && (!migrationId || !slug || !targetPodUid)) {
    throw new Error("migration surge OpenClaw process gate is missing migration identity");
  }
  return {
    ...(migrationId ? { migrationId } : {}),
    ...(slug ? { slug } : {}),
    ...(targetPodUid ? { targetPodUid } : {}),
  };
}

function parseTerminalTarget(
  value: Record<string, unknown>,
  role: SurgeOpenClawProcessRole,
): (SurgeOpenClawProcessRequest & { completionStarted?: boolean }) | undefined {
  if (value.terminalTarget === undefined) return undefined;
  if (role !== "normal" || !isRecord(value.terminalTarget)) {
    throw new Error("surge OpenClaw process gate has invalid terminal target");
  }
  if (value.terminalTarget.completionStarted !== undefined && typeof value.terminalTarget.completionStarted !== "boolean") {
    throw new Error("surge OpenClaw process gate has invalid terminal completion state");
  }
  return {
    migrationId: requireNonemptyString(value.terminalTarget.migrationId, "terminalTarget.migrationId"),
    slug: requireNonemptyString(value.terminalTarget.slug, "terminalTarget.slug"),
    targetPodUid: requireNonemptyString(value.terminalTarget.targetPodUid, "terminalTarget.targetPodUid"),
    ...(value.terminalTarget.completionStarted !== undefined ? { completionStarted: value.terminalTarget.completionStarted } : {}),
  };
}

function assertModePhaseCoherent(mode: SurgeOpenClawProcessMode, phase: SurgeOpenClawProcessPhase): void {
  if (mode === "held" && phase === "running") {
    throw new Error("held surge OpenClaw process gate cannot be running");
  }
  if (mode === "permitted" && (
    phase === "held" ||
    phase === "stopping" ||
    phase === "completing" ||
    phase === "cancelling"
  )) {
    throw new Error("permitted surge OpenClaw process gate has invalid phase");
  }
}

function parseState(value: unknown): SurgeOpenClawProcessGateState {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("surge OpenClaw process gate is malformed");
  }
  const podUid = requireNonemptyString(value.podUid, "podUid");
  const role = parseEnum(value.role, ROLES, "role");
  const mode = parseEnum(value.mode, MODES, "mode");
  const phase = parseEnum(value.phase, PHASES, "phase");
  const terminalTarget = parseTerminalTarget(value, role);
  if (value.completionStarted !== undefined && (role !== "target" || typeof value.completionStarted !== "boolean")) {
    throw new Error("surge OpenClaw process gate has invalid completion state");
  }
  assertModePhaseCoherent(mode, phase);
  return {
    version: 1,
    podUid,
    role,
    mode,
    phase,
    ...parseMigrationIdentity(value, role),
    ...(typeof value.completionStarted === "boolean" ? { completionStarted: value.completionStarted } : {}),
    ...(terminalTarget ? { terminalTarget } : {}),
  };
}

function assertRequest(input: SurgeOpenClawProcessRequest & { podUid: string }): void {
  requireNonemptyString(input.podUid, "podUid");
  requireNonemptyString(input.migrationId, "migrationId");
  requireNonemptyString(input.slug, "slug");
  requireNonemptyString(input.targetPodUid, "targetPodUid");
}

function sameMigration(
  state: SurgeOpenClawProcessGateState,
  input: SurgeOpenClawProcessRequest,
): boolean {
  return state.migrationId === input.migrationId &&
    state.slug === input.slug &&
    state.targetPodUid === input.targetPodUid;
}

function ownedByAnotherMigration(
  state: SurgeOpenClawProcessGateState,
  input: SurgeOpenClawProcessRequest,
): boolean {
  return state.role !== "normal" && !sameMigration(state, input);
}

function migrationIdentity(input: SurgeOpenClawProcessRequest): Pick<
  SurgeOpenClawProcessGateState,
  "migrationId" | "slug" | "targetPodUid"
> {
  return {
    migrationId: input.migrationId,
    slug: input.slug,
    targetPodUid: input.targetPodUid,
  };
}

function normalState(state: SurgeOpenClawProcessGateState): SurgeOpenClawProcessGateState {
  return {
    version: 1,
    podUid: state.podUid,
    role: "normal",
    mode: state.mode,
    phase: state.phase,
    ...(state.terminalTarget ? { terminalTarget: state.terminalTarget } : {}),
  };
}

function terminalTargetMatches(
  state: SurgeOpenClawProcessGateState,
  input: SurgeOpenClawProcessRequest,
): boolean {
  const terminal = state.terminalTarget;
  return terminal !== undefined && terminal.migrationId === input.migrationId &&
    terminal.slug === input.slug && terminal.targetPodUid === input.targetPodUid;
}

function targetCancellationRequested(
  state: SurgeOpenClawProcessGateState,
  input: SurgeOpenClawProcessRequest,
): boolean {
  return state.role === "target" && sameMigration(state, input) && (
    state.mode === "permitted" ||
    (state.mode === "held" && (state.phase === "held" || state.phase === "completing"))
  );
}

function completedMigrationCanBeReplaced(
  state: SurgeOpenClawProcessGateState,
  isCancellation: boolean,
): boolean {
  return !isCancellation && state.role !== "normal" &&
    state.mode === "permitted" && state.phase === "running";
}

function heldStateForRequest(input: {
  state: SurgeOpenClawProcessGateState;
  request: SurgeOpenClawProcessRequest & { podUid: string };
  requireMigrationOwner: (state: SurgeOpenClawProcessGateState, request: SurgeOpenClawProcessRequest) => void;
}): SurgeOpenClawProcessGateState {
  const { state, request, requireMigrationOwner } = input;
  if (state.role === "normal" && terminalTargetMatches(state, request)) {
    throw new Error("surge OpenClaw process gate target migration already released");
  }
  const isCancellation = targetCancellationRequested(state, request);
  if (state.mode === "held" && !isCancellation && sameMigration(state, request)) return state;
  const completedMigration = completedMigrationCanBeReplaced(state, isCancellation);
  if (!completedMigration) requireMigrationOwner(state, request);
  const heldRole: SurgeOpenClawProcessRole = request.targetPodUid === request.podUid ? "target" : "source";
  let completionStarted: boolean | undefined;
  if (heldRole === "target") completionStarted = sameMigration(state, request) ? state.completionStarted : false;
  return {
    version: 1,
    podUid: request.podUid,
    role: completedMigration || state.role === "normal" ? heldRole : state.role,
    mode: "held",
    phase: isCancellation ? "cancelling" : "stopping",
    ...migrationIdentity(request),
    ...(completionStarted !== undefined ? { completionStarted } : {}),
  };
}

interface TargetGateOperationDependencies {
  current: (podUid: string) => Promise<SurgeOpenClawProcessGateState>;
  requireMigrationOwner: (state: SurgeOpenClawProcessGateState, input: SurgeOpenClawProcessRequest) => void;
  write: (next: SurgeOpenClawProcessGateState) => Promise<SurgeOpenClawProcessGateState>;
}

function createTargetGateOperations(
  deps: TargetGateOperationDependencies,
): Pick<SurgeOpenClawProcessGate,
  "reholdTarget" | "reholdReleasedTarget" | "claimTargetCompletion" | "finalizeTargetCancellation" |
  "permitTarget" | "hydrateTarget" | "unreserveTarget" | "settleTargetCompletion"
> {
  const { current, requireMigrationOwner, write } = deps;
  const requireReservedTarget = (
    state: SurgeOpenClawProcessGateState,
    input: SurgeOpenClawProcessRequest,
  ): void => {
    if (state.role !== "target" || !sameMigration(state, input)) {
      throw new Error(TARGET_MIGRATION_NOT_RESERVED);
    }
  };

  return {
    async reholdReleasedTarget(input) {
      assertRequest(input);
      const state = await current(input.podUid);
      if (state.role !== "normal" || !terminalTargetMatches(state, input)) {
        throw new Error("surge OpenClaw process gate released target does not match this migration");
      }
      return write({
        version: 1, podUid: input.podUid, role: "target", mode: "held", phase: "cancelling",
        ...migrationIdentity(input),
        ...(state.terminalTarget?.completionStarted !== undefined ? { completionStarted: state.terminalTarget.completionStarted } : {}),
      });
    },
    async reholdTarget(input) {
      assertRequest(input);
      const state = await current(input.podUid);
      requireReservedTarget(state, input);
      if (state.mode === "held" && state.phase === "cancelling") return state;
      const phase = targetCancellationRequested(state, input) ? "cancelling" : "stopping";
      return write({ ...state, mode: "held", phase });
    },
    async claimTargetCompletion(input) {
      assertRequest(input);
      const state = await current(input.podUid);
      requireReservedTarget(state, input);
      if (state.mode !== "held" || (state.phase !== "held" && state.phase !== "completing")) {
        throw new Error("surge OpenClaw process gate target completion is not held");
      }
      if (state.phase === "completing" && state.completionStarted) return state;
      return write({ ...state, phase: "completing", completionStarted: true });
    },
    async finalizeTargetCancellation(input) {
      assertRequest(input);
      const state = await current(input.podUid);
      if (state.role === "normal") return state;
      requireReservedTarget(state, input);
      if (state.mode !== "held") {
        throw new Error("surge OpenClaw process gate target cancellation is not held");
      }
      if (state.phase !== "cancelling") {
        throw new Error("surge OpenClaw process gate target cancellation is not pending");
      }
      return write({ ...normalState(state), mode: "held", phase: "held", terminalTarget: { migrationId: input.migrationId, slug: input.slug, targetPodUid: input.targetPodUid, ...(state.completionStarted !== undefined ? { completionStarted: state.completionStarted } : {}) } });
    },
    async permitTarget(input) {
      assertRequest(input);
      const state = await current(input.podUid);
      if (state.role === "target" && state.mode === "permitted" && sameMigration(state, input)) {
        return state;
      }
      requireReservedTarget(state, input);
      if (state.mode !== "held" || state.phase !== "completing") {
        throw new Error("surge OpenClaw process gate target completion is not claimed");
      }
      return write({
        version: 1,
        podUid: input.podUid,
        role: "target",
        mode: "permitted",
        phase: "starting",
        ...migrationIdentity(input),
        completionStarted: true,
      });
    },
    async hydrateTarget(input) {
      assertRequest(input);
      const state = await current(input.podUid);
      if (state.role === "target" && state.mode === "held" && sameMigration(state, input)) {
        return state;
      }
      requireMigrationOwner(state, input);
      if (state.role === "normal" && terminalTargetMatches(state, input)) {
        throw new Error("surge OpenClaw process gate target migration already released");
      }
      if (state.mode === "permitted" || state.phase !== "held") {
        throw new Error("cannot hydrate a surge OpenClaw process gate that is not held");
      }
      return write({
        version: 1,
        podUid: input.podUid,
        role: "target",
        mode: "held",
        phase: "held",
        ...migrationIdentity(input),
        completionStarted: false,
      });
    },
    async unreserveTarget(input) {
      assertRequest(input);
      const state = await current(input.podUid);
      if (state.role === "normal") return state;
      requireReservedTarget(state, input);
      if (state.mode !== "held") {
        throw new Error("cannot unreserve a permitted surge OpenClaw process gate");
      }
      if (state.phase !== "held") {
        throw new Error("cannot unreserve a claimed surge OpenClaw process gate");
      }
      return write({ ...normalState(state), mode: "held", phase: "held", terminalTarget: { migrationId: input.migrationId, slug: input.slug, targetPodUid: input.targetPodUid, ...(state.completionStarted !== undefined ? { completionStarted: state.completionStarted } : {}) } });
    },
    async settleTargetCompletion(input) {
      assertRequest(input);
      const state = await current(input.podUid);
      if (state.role === "normal" && terminalTargetMatches(state, input)) return state;
      if (state.role !== "target" || state.mode !== "permitted" || !sameMigration(state, input)) {
        throw new Error("surge OpenClaw process gate does not permit this target migration");
      }
      return write({
        ...normalState(state),
        terminalTarget: {
          migrationId: input.migrationId,
          slug: input.slug,
          targetPodUid: input.targetPodUid,
          completionStarted: true,
        },
      });
    },
  };
}

async function readState(filePath: string): Promise<SurgeOpenClawProcessGateState | null> {
  try {
    return parseState(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(filePath: string, state: SurgeOpenClawProcessGateState): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

function initialState(podUid: string, readinessReleased: boolean): SurgeOpenClawProcessGateState {
  return readinessReleased
    ? {
      version: 1,
      podUid,
      role: "normal",
      mode: "permitted",
      phase: "starting",
    }
    : {
      version: 1,
      podUid,
      role: "normal",
      mode: "held",
      phase: "held",
    };
}

// A supervisor restart never inherits a running child. A permit is only valid
// inside the process lifetime that verified it, so an unreleased pod returns to
// held; a released pod restarts its child under a normal identity because its
// migration finished the moment readiness opened. A held NORMAL record on a
// released pod is wedge residue (deliberate holds either precede release or
// carry a migration identity), so restart heals it back to serving.
function restartedState(
  state: SurgeOpenClawProcessGateState,
  readinessReleased: boolean,
): SurgeOpenClawProcessGateState {
  if (
    state.role === "target" &&
    state.mode === "held" &&
    (state.phase === "completing" || state.phase === "cancelling")
  ) {
    return state;
  }
  if (state.mode === "held") {
    return readinessReleased && state.role === "normal"
      ? { ...state, mode: "permitted", phase: "starting" }
      : { ...state, phase: "held" };
  }
  if (!readinessReleased) return { ...state, mode: "held", phase: "held" };
  if (
    state.role === "target" &&
    state.migrationId !== undefined &&
    state.slug !== undefined &&
    state.targetPodUid !== undefined
  ) {
    return {
      ...normalState(state),
      phase: "starting",
      terminalTarget: {
        migrationId: state.migrationId,
        slug: state.slug,
        targetPodUid: state.targetPodUid,
        ...(state.completionStarted !== undefined ? { completionStarted: state.completionStarted } : {}),
      },
    };
  }
  return { ...normalState(state), phase: "starting" };
}

export function surgeOpenClawProcessSocketPath(openclawDir: string): string {
  return path.join(openclawDir, SURGE_OPENCLAW_PROCESS_SOCKET_FILE);
}

export function surgeOpenClawGatePhase(state: Pick<SurgeOpenClawProcessGateState, "role" | "mode" | "phase">): string {
  return `${state.role}/${state.mode}/${state.phase}`;
}

function describeGateChange(prior: SurgeOpenClawProcessGateState | null, next: SurgeOpenClawProcessGateState): string | null {
  const from = prior ? surgeOpenClawGatePhase(prior) : "none";
  const to = surgeOpenClawGatePhase(next);
  if (from === to && prior?.migrationId === next.migrationId) return null;
  const owner = next.migrationId ? ` migration=${next.migrationId} slug=${next.slug ?? "none"}` : "";
  return `[surge-openclaw] process gate ${from} -> ${to} pod=${next.podUid}${owner}`;
}

export function createSurgeOpenClawProcessGate(openclawDir: string, log: (message: string) => void = () => {}): SurgeOpenClawProcessGate {
  const gatePath = path.join(openclawDir, SURGE_OPENCLAW_PROCESS_GATE_FILE);

  const current = async (podUid: string): Promise<SurgeOpenClawProcessGateState> => {
    const state = await readState(gatePath);
    if (!state) throw new Error("surge OpenClaw process gate is not initialized");
    if (state.podUid !== podUid) {
      throw new Error(
        `surge OpenClaw process gate belongs to pod ${state.podUid}, not current pod ${podUid}`,
      );
    }
    return state;
  };

  const requireMigrationOwner = (
    state: SurgeOpenClawProcessGateState,
    input: SurgeOpenClawProcessRequest,
  ): void => {
    if (ownedByAnotherMigration(state, input)) {
      throw new Error(`surge OpenClaw process gate belongs to ${state.migrationId}/${state.slug}`);
    }
  };

  const requireNormal = (state: SurgeOpenClawProcessGateState): void => {
    if (state.role !== "normal") {
      throw new Error("surge OpenClaw process gate is owned by a migration");
    }
  };

  const requireMigrationMatch = (
    state: SurgeOpenClawProcessGateState,
    migrationId: string | undefined,
  ): void => {
    if (migrationId && state.migrationId !== migrationId) {
      throw new Error(`surge OpenClaw process gate belongs to ${state.migrationId ?? "normal"}`);
    }
  };

  const write = async (next: SurgeOpenClawProcessGateState): Promise<SurgeOpenClawProcessGateState> => {
    const prior = await readState(gatePath);
    await writeState(gatePath, next);
    const change = describeGateChange(prior, next);
    if (change) log(change);
    return next;
  };
  const targetOperations = createTargetGateOperations({ current, requireMigrationOwner, write });

  return {
    async ensure({ podUid, readinessReleased }) {
      requireNonemptyString(podUid, "podUid");
      const state = await readState(gatePath);
      return write(
        state?.podUid === podUid
          ? restartedState(state, readinessReleased)
          : initialState(podUid, readinessReleased),
      );
    },
    read: () => readState(gatePath),
    async holdPrelaunch({ podUid }) {
      const state = await current(podUid);
      const terminalTarget = state.role === "target" && state.migrationId && state.slug && state.targetPodUid
        ? { migrationId: state.migrationId, slug: state.slug, targetPodUid: state.targetPodUid,
            ...(state.completionStarted !== undefined ? { completionStarted: state.completionStarted } : {}) }
        : state.terminalTarget;
      return write({ version: 1, podUid, role: "normal", mode: "held", phase: "held", ...(terminalTarget ? { terminalTarget } : {}) });
    },
    async hold(input) {
      assertRequest(input);
      const state = await current(input.podUid);
      return write(heldStateForRequest({ state, request: input, requireMigrationOwner }));
    },
    ...targetOperations,
    async holdNormal(input) {
      requireNonemptyString(input.podUid, "podUid");
      const state = await current(input.podUid);
      requireNormal(state);
      if (state.mode === "held" && state.phase === "held") return state;
      return write({ ...state, mode: "held", phase: "stopping" });
    },
    async permitNormal(input) {
      requireNonemptyString(input.podUid, "podUid");
      const state = await current(input.podUid);
      requireNormal(state);
      if (state.mode === "permitted") return state;
      return write({ ...state, mode: "permitted", phase: "starting" });
    },
    // Resume accepts any held source, not only the holding migration: the fleet
    // controller is the single serialized driver, and a source stranded by a
    // replaced target names a migration no future request can repeat. Copies
    // stay safe because every transfer digest-verifies against the source.
    async resumeSource(input) {
      assertRequest(input);
      const state = await current(input.podUid);
      if (state.role !== "source") {
        throw new Error("surge OpenClaw process gate does not hold a source migration");
      }
      if (state.mode === "permitted") return state;
      return write({ ...state, mode: "permitted", phase: "starting" });
    },
    async settle(input) {
      requireNonemptyString(input.podUid, "podUid");
      const state = await current(input.podUid);
      if (state.mode !== "permitted") {
        throw new Error("cannot settle a held surge OpenClaw process gate");
      }
      if (state.role === "normal") return state;
      return write(normalState(state));
    },
    async markHeld(input) {
      requireNonemptyString(input.podUid, "podUid");
      const state = await current(input.podUid);
      requireMigrationMatch(state, input.migrationId);
      return write({ ...state, mode: "held", phase: "held" });
    },
    async markRunning(input) {
      requireNonemptyString(input.podUid, "podUid");
      const state = await current(input.podUid);
      requireMigrationMatch(state, input.migrationId);
      if (state.mode !== "permitted") {
        throw new Error("cannot mark a held surge OpenClaw process gate running");
      }
      return write({ ...state, phase: "running" });
    },
    async markStarting(input) {
      requireNonemptyString(input.podUid, "podUid");
      const state = await current(input.podUid);
      requireMigrationMatch(state, input.migrationId);
      if (state.mode !== "permitted") {
        throw new Error("cannot mark a held surge OpenClaw process gate starting");
      }
      return write({ ...state, phase: "starting" });
    },
  };
}

export interface SurgeOpenClawProcessSupervisorClient {
  migrateUserStores: (expectedPodUid: string) => Promise<SurgeOpenClawProcessGateState>;
  status: (options?: { timeoutMs?: number }) => Promise<SurgeOpenClawProcessGateState>;
  hold: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  rehold: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  reholdReleasedTarget: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  claimTargetCompletion: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  finalizeTargetCancellation: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  releaseTarget: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  holdNormal: () => Promise<SurgeOpenClawProcessGateState>;
  hydrate: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  permitNormal: () => Promise<SurgeOpenClawProcessGateState>;
  permit: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  resume: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  unreserve: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  settle: () => Promise<SurgeOpenClawProcessGateState>;
}

function parseSupervisorResponse(statusCode: number | undefined, response: string): SurgeOpenClawProcessGateState {
  let parsed: unknown;
  try {
    parsed = response ? JSON.parse(response) : null;
  } catch {
    throw new Error("surge OpenClaw process supervisor returned invalid JSON");
  }
  if (statusCode !== 200) {
    throw new Error(
      isRecord(parsed) && typeof parsed.error === "string"
        ? parsed.error
        : `surge OpenClaw process supervisor returned HTTP ${statusCode ?? 0}`,
    );
  }
  return parseState(parsed);
}

function collectSupervisorResponse(
  res: http.IncomingMessage,
  resolve: (state: SurgeOpenClawProcessGateState) => void,
  reject: (error: unknown) => void,
): void {
  let response = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { response += chunk; });
  res.on("end", () => {
    try {
      resolve(parseSupervisorResponse(res.statusCode, response));
    } catch (error) {
      reject(error);
    }
  });
}

// Mutations take no deadline: abandoning one loses the transition it applies.
export const SURGE_OPENCLAW_PROCESS_READ_TIMEOUT_MS = 5_000;

export function createSurgeOpenClawProcessSupervisorClient(
  openclawDir: string,
  deps: { request?: typeof http.request; socketPath?: string } = {},
): SurgeOpenClawProcessSupervisorClient {
  const socketPath = deps.socketPath ?? surgeOpenClawProcessSocketPath(openclawDir);
  const call = (
    input: SurgeOpenClawProcessSupervisorRequest,
    timeoutMs?: number,
  ): Promise<SurgeOpenClawProcessGateState> => {
    if (!isSurgeOpenClawProcessSupervisorAction(input.action)) {
      return Promise.reject(new Error("invalid surge OpenClaw process supervisor action"));
    }
    const body = JSON.stringify(input);
    const request = deps.request ?? http.request;
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath,
        agent: false,
        path: "/",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      }, (res) => collectSupervisorResponse(res, resolve, reject));
      if (timeoutMs !== undefined) {
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(
            `surge OpenClaw process supervisor ${input.action} timed out after ${timeoutMs}ms`,
          ));
        });
      }
      req.once("error", reject);
      req.end(body);
    });
  };
  return {
    status: (options) => call({ action: "status" }, options?.timeoutMs ?? SURGE_OPENCLAW_PROCESS_READ_TIMEOUT_MS),
    migrateUserStores: (expectedPodUid) => call({ action: "migrate-builder-stores", expectedPodUid }),
    hold: (input) => call({ action: "hold", ...input }),
    rehold: (input) => call({ action: "rehold", ...input }),
    reholdReleasedTarget: (input) => call({ action: "rehold-released-target", ...input }),
    claimTargetCompletion: (input) => call({ action: "claim", ...input }),
    finalizeTargetCancellation: (input) => call({ action: "finalize-cancellation", ...input }),
    releaseTarget: (input) => call({ action: "release-target", ...input }),
    holdNormal: () => call({ action: "hold-normal" }),
    hydrate: (input) => call({ action: "hydrate", ...input }),
    permitNormal: () => call({ action: "permit-normal" }),
    permit: (input) => call({ action: "permit", ...input }),
    resume: (input) => call({ action: "resume", ...input }),
    unreserve: (input) => call({ action: "unreserve", ...input }),
    settle: () => call({ action: "settle" }),
  };
}
