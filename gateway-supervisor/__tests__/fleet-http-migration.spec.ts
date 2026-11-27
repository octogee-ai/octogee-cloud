

import { afterEach, describe, it, expect, vi, beforeEach, onTestFinished } from "vitest";
import { pendingCloneAppliedFingerprint } from "../lib/pending-clone-fingerprint";
import { deferredProjectPlaceholder } from "../lib/deferred-project-workspace.js";
import type { Request, Response } from "express";
import { EventEmitter } from "node:events";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  createMigrationProgressHandler,
  createActivateImportHandler,
  createActivationManifestExportHandler,
  createSourceActivationReadinessHandler,
  createTargetImportHoldWitnessHandler,
  createAbortRsyncImportHandler,
  createCompleteSurgeHandoffHandler,
  migrationImportBusy,
  createExportPathsHandler,
  createFlushHandler,
  createFinishRsyncImportHandler,
  createPrepareImportHandler,
  createPrepareRsyncImportHandler,
  createPushRsyncStateHandler,
  createQuiesceHandler,
  createSchedulerMigrationHandler,
  createSchedulerReadyHandler,
  createScheduleTransferHandler,
  createResumeHandler,
  createRestoreHandler,
  createHeldNativeSourceReconcileHandler,
  createUnmountHandler,
  createVerifyHandler,
  findPathTraversalViolation,
  type MigrationHandlerDeps,
} from "../lib/fleet-http-migration.js";
import { heldNativeSourceReconcileJobId, gatewayScopedJobId, signFleetRequest, sourceActivationReadinessJobId } from "../lib/fleet-signature.js";
import { reserveLoopbackPort } from "../lib/migration-rsync-tls.js";
import { liveImportAdmissionPath } from "../lib/migration-staging.js";
import {
  MIGRATION_VERIFY_DEFAULT_AGENT_ATTACH_IN_PROGRESS,
  SIGNATURE_HEADER,
  type QuiesceRequestBody,
  type UnmountRequestBody,
  type ExportPathsRequestBody,
  type PrepareImportRequestBody,
  type ActivateImportRequestBody,
  type ActivationManifestExportRequestBody,
  type AbortRsyncImportRequestBody,
  type FinishRsyncImportRequestBody,
  type PrepareRsyncImportRequestBody,
  type PushRsyncStateRequestBody,
  type CompleteSurgeHandoffRequestBody,
} from "@octogee/shared/types/fleet-controller";
import type { UserLifecycleAdapter } from "../lib/user-lifecycle.js";
import type { ConfiguredUserPortableStatePlan } from "../lib/local-default-agent-wired.js";
import {
  hasMountedMarker,
  writeMigratingInPin,
  writeMountedMarker,
} from "../lib/local-default-agent-wired.js";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";
import { OpenclawWireError } from "../lib/gateway-rpc.js";
import { SchedulerRefusal } from "../lib/scheduler-failure.js";
import { OpenClawRuntimeUpdateGuard } from "../lib/openclaw-runtime-update-guard.js";
import { stubUserClaim } from "./helpers/user-claim.js";
import { exportCodexStoreSnapshots } from "../lib/codex-store-snapshot.js";
import { OPENCLAW_CONFIG, OPENCLAW_DIR } from "../lib/config.js";
import { readActivationManifest, writeActivationManifest, activationManifestTarPath } from "../lib/migration-activation-manifest.js";

import { createIsolatedSurgeGateWiring } from "../lib/fleet-provisioner.js";

const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

async function realMigrationSpawn() {
  const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const image = process.env.OCTOGEE_RSYNC_TEST_IMAGE;
  if (!image) return real.spawn;
  return ((command: string, args: string[], options: import("node:child_process").SpawnOptions) => {
    if (command !== "/usr/bin/rsync") return real.spawn(command, args, options);
    const mounts = [...new Set(args.slice(-2).map(directory => {
      let existing = path.resolve(directory);
      while (!fsSync.existsSync(existing)) existing = path.dirname(existing);
      return existing;
    }))];
    return real.spawn("docker", ["run", "--rm", "--network=none", "--user=0:0",
      ...mounts.flatMap(directory => ["--mount", `type=bind,src=${fsSync.realpathSync(directory)},dst=${directory}`]),
      "--entrypoint", command, image, ...args], options);
  }) as typeof real.spawn;
}

const migrationTempRoots: string[] = [];

const PRIVATE_KEY = FLEET_KEY_PAIR.privateKey;
const PUBLIC_KEY = FLEET_KEY_PAIR.publicKey;
const GATEWAY_ID = "gw-a";
const SOURCE_POD_IP = ["10", "1", "0", "10"].join(".");
const TARGET_POD_IP = ["10", "1", "0", "20"].join(".");
const SAMPLE_QUIESCE: QuiesceRequestBody = {
  migrationId: "mig-1",
  slug: "chris",
  timeoutMs: 5_000,
};

const SAMPLE_UNMOUNT: UnmountRequestBody = {
  migrationId: "mig-1",
  slug: "chris",
};

const SAMPLE_COMPLETE_SURGE: CompleteSurgeHandoffRequestBody = {
  migrationId: "surge-gw-a-pod-123",
  targetPodUid: "pod-123",
};

const HELD_USER_GATE_STATE = {
  version: 1, podUid: "builder-pod", role: "normal", mode: "held", phase: "held",
} as const;
const PRELAUNCH_USER_GATE_STATE = { ...HELD_USER_GATE_STATE, mode: "permitted", phase: "starting" } as const;

const RESTORE_SNAPSHOT = {
  uid: "uid-chris",
  slug: "chris",
  contextTemplateKey: "default",
  planInputs: { tier: "trial" },
  gatewayId: GATEWAY_ID,
  status: "complete",
  agentIds: ["octogee-chris-coach"],
  repoUrl: "git@gitea:octogee/chris.git",
  mattermostUserId: "mmuser-chris",
  customerMmUserId: "mmuser-chris",
  channels: [],
  projects: [],
  ownerName: "Chris",
  email: "chris@example.com",
  displayName: "Chris",
  lastName: "",
  photoURL: "",
  persona: { vibe: "garage" },
  coachToken: "coach-token",
  defaultAgentMmUserId: "mm-coach",
} as const;

// The fleet controller scopes every pod-addressed signature to the gateway it addresses; the
// handlers reject anything minted for a sibling.
function signForPod(jobId: string, rawBody: string, gatewayId: string = GATEWAY_ID): string {
  return signFleetRequest(PRIVATE_KEY, gatewayScopedJobId(jobId, gatewayId), rawBody);
}

function mkRequest<T>(
  body: T,
  opts: {
    signature?: string;
    rawBody?: string;
    localAddress?: string;
    pathGatewayId?: string;
  } = {},
): Request {
  const rawBody = opts.rawBody ?? JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (opts.signature !== undefined) headers[SIGNATURE_HEADER.toLowerCase()] = opts.signature;
  return {
    header: (name: string) => headers[name.toLowerCase()],
    params: { gatewayId: opts.pathGatewayId ?? GATEWAY_ID },
    rawBody,
    socket: {
      localAddress: opts.localAddress,
      address: () => ({ address: opts.localAddress ?? "127.0.0.1", family: "IPv4", port: 3003 }),
    },
  } as unknown as Request;
}

function mkResponse(): {
  res: Response;
  getStatus: () => number | undefined;
  getBody: () => unknown;
  getHeaders: () => Record<string, string>;
  destroyed: () => Error | null;
} {
  let status: number | undefined;
  let payload: unknown;
  const headers: Record<string, string> = {};
  let destroyError: Error | null = null;

const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  let headersSent = false;
  const res = Object.assign(sink, {
    headersSent: false,
    status(this: Response, code: number) {
      status = code;
      headersSent = true;
      Object.defineProperty(this, "headersSent", {
        get: () => headersSent,
        configurable: true,
      });
      return this;
    },
    json(this: Response, b: unknown) {
      payload = b;
      headersSent = true;
      return this;
    },
    setHeader(this: Response, name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return this;
    },
    destroy(this: Response, err?: Error) {
      destroyError = err ?? null;
      return this;
    },
  }) as unknown as Response;
  return {
    res,
    getStatus: () => status,
    getBody: () => payload,
    getHeaders: () => headers,
    destroyed: () => destroyError,
  };
}

it("transfers only the selected user's Git metadata", () => {
  expect(findPathTraversalViolation(["git-metadata/alice/projects/app.git/refs/heads/work", "git-metadata/alice/projects/app.git/index"], "alice", "final")).toBeNull();
  expect(findPathTraversalViolation(["git-metadata/bob/projects/app.git/index"], "alice", "final")).not.toBeNull();
  expect(findPathTraversalViolation(["git-metadata/alice/../../bob/index"], "alice", "final")).not.toBeNull();
});

function mkGitHost(
  overrides: Partial<UserLifecycleAdapter["gitHost"]> = {},
): UserLifecycleAdapter["gitHost"] {
  const unexpected = (name: string) => vi.fn(async () => {
    throw new Error(`unexpected call to gitHost.${name} in migration handler test`);
  });
  return {
    registerKey: vi.fn(async () => undefined),
    listKeys: unexpected("listKeys"),
    releaseKey: unexpected("releaseKey"),
    ensureOwner: unexpected("ensureOwner"),
    ensureRepo: unexpected("ensureRepo"),
    ...overrides,
  };
}

function mkAdapter(overrides: Partial<UserLifecycleAdapter> = {}): UserLifecycleAdapter {
  const everythingElseThrows = new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        vi.fn(() => {
          throw new Error(`unexpected call to adapter.${prop} in migration handler test`);
        }),
    },
  ) as UserLifecycleAdapter;

  return {
    ...everythingElseThrows,
    log: vi.fn(),
    reportProvisioned: vi.fn(async () => undefined),
    uidForSlug: vi.fn(async () => "uid-chris"),
    targetMigrationIdentityCustody: vi.fn(async (slug, migrationId) => sharedTargetAuthority(slug, migrationId)),
    resumeUser: vi.fn(async () => undefined),
    sourceMigrationIdentityCustody: vi.fn(async (_slug, migrationId) => ({ migrationId, uid: "uid-chris", gatewayId: GATEWAY_ID, podUid: "source-pod", epoch: 4 })),
    exportOpenClawActivationManifest: vi.fn(async () => ({ version: 2, slug: "chris", appliedFingerprint: "fp-chris", agentId: "octogee-chris-coach", accountId: "chris-coach", agent: { id: "octogee-chris-coach", workspace: path.join(process.env.OPENCLAW_STATE_DIR || OPENCLAW_DIR, "customers", "chris") }, projectAgents: [], mattermostAccount: { botToken: "synthetic-coach-token" }, bindings: [{ agentId: "octogee-chris-coach", match: { channel: "mattermost", accountId: "chris-coach" } }] })),
    quiesceUser: vi.fn(async () => ({ drained: true, runningCount: 0 })),
    listExportPaths: vi.fn(async () => [
      { cwd: "/tmp/state", path: "agents/octogee-chris-coach" },
    ]),
    prepareImportDir: vi.fn(async () => "/tmp/import"),
    prepareKeyImportDir: vi.fn(async () => "/tmp/import"),
    readLocalUserPubKey: vi.fn(() => "ssh-ed25519 LOCAL chris@gateway"),
    gitHost: mkGitHost(),
    activateImportedUser: vi.fn(async () => ({ appliedFingerprint: "fp-chris" })),
    projectCheckoutScope: vi.fn(() => "workspace-and-projects"),
    listProjectsNeedingClone: vi.fn(async () => []),
    cloneProjectRepo: vi.fn(async () => true),
    seedDeferredProjectWorkspace: vi.fn(async () => undefined),
    reassertByotForUser: vi.fn(async () => undefined),
    writeMountMarker: vi.fn(),
    onMounted: vi.fn(),
    isConfiguredUser: vi.fn(() => true),
    waitForAccountHealthy: vi.fn(async () => true),
    projectAgentsHealthy: vi.fn(async () => true),
    hasUserDir: vi.fn(() => true),
    userDefaultAgentWiredInOpenclawConfig: vi.fn(() => true),
    userMountMarked: vi.fn(() => true),
    applyRemoveUserConfigPatch: vi.fn(async () => {}),
    removePartialWorkspace: vi.fn(async () => {}),
    deleteDepartedUserState: vi.fn(async () => {}),
    loadUserSnapshot: vi.fn(async () => ({
      uid: "uid-chris",
      slug: "chris",
      contextTemplateKey: "default",
      planInputs: { tier: "trial" },
      gatewayId: GATEWAY_ID,
      status: "complete",
      agentIds: ["octogee-chris-coach"],
      repoUrl: "git@gitea:octogee/chris.git",
      mattermostUserId: "mmuser-chris",
      channels: [],
      ownerName: "Chris",
    })),
    onUnmounted: vi.fn(),
    ...overrides,
  };
}

const TARGET_CERTIFICATE_PEM = "-----BEGIN CERTIFICATE-----\nTUlHUkFUSU9O\n-----END CERTIFICATE-----\n";
const RSYNC_DAEMON_LOOPBACK_PORT = 41873;

function sharedTargetAuthority(slug: string, migrationId: string) {
  if (!process.env.POD_UID) vi.stubEnv("POD_UID", "shared-target-pod");
  return { custody: { uid: `uid-${slug}`, gatewayId: GATEWAY_ID, podUid: process.env.POD_UID!, migrationId },
    migration: { migrationId, claimStartedAt: 123, sourceGatewayId: "source-user", sourceEpoch: 4 }, anchors: [] };
}

async function writeSharedTargetManifest(root: string, workspaceRoot: string, migrationId?: string) {
  const authority = sharedTargetAuthority("chris", migrationId ?? "stage-only");
  await writeActivationManifest(root, { version: 2, slug: "chris", appliedFingerprint: "fp-chris", agentId: "octogee-chris-coach", accountId: "chris-coach", agent: { id: "octogee-chris-coach", workspace: path.join(workspaceRoot, "customers/chris") },
    mattermostAccount: { botToken: "synthetic-coach-token" }, bindings: [{ agentId: "octogee-chris-coach", match: { channel: "mattermost", accountId: "chris-coach" } }], projectAgents: [],
    ...(migrationId ? { targetWorkspaceIdentities: { ...authority.custody, files: [{ agentId: "octogee-chris-coach", content: null, sha256: null }] } } : {}),
  });
}

function mkDeps(overrides: Partial<MigrationHandlerDeps> = {}): MigrationHandlerDeps {
  return {
    publicKey: PUBLIC_KEY,
    gatewayId: GATEWAY_ID,
    adapter: mkAdapter(),
    voiceMigration: vi.fn(async () => ({ activeCalls: 0 })),
    voiceDrainWaitMs: 0,
    log: vi.fn(),
    reserveLoopbackPort: async () => RSYNC_DAEMON_LOOPBACK_PORT,
    openMigrationTlsEndpoint: vi.fn(async () => ({
      certificatePem: TARGET_CERTIFICATE_PEM,
      close: async () => undefined,
    })),
    surgeTargetLive: vi.fn(async () => false),
    admitLiveSurgeTarget: vi.fn(async () => {
      throw new Error("held isolated target was admitted as live");
    }),
    liveSurgeTargetAssigned: vi.fn(async () => false),
    ...overrides,
  };
}

beforeEach(() => {
  spawnMock.mockReset();
});

const liveAdmissionRecords: Array<{ migrationId: string; slug: string; instanceId: string }> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of migrationTempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
  for (const record of liveAdmissionRecords.splice(0)) {
    await fs.rm(liveImportAdmissionPath(os.tmpdir(), {
      gatewayId: GATEWAY_ID, instanceId: record.instanceId, migrationId: record.migrationId, slug: record.slug,
      configTransferMode: "activation-manifest",
    }), { force: true });
  }
});

describe("surge handoff control", () => {
  it("opens pod readiness only for a signed request", async () => {
    const releaseSurgeReadiness = vi.fn(async () => undefined);
    const handler = createCompleteSurgeHandoffHandler(mkDeps({ releaseSurgeReadiness }));
    const rawBody = JSON.stringify(SAMPLE_COMPLETE_SURGE);
    const signature = signForPod(SAMPLE_COMPLETE_SURGE.migrationId, rawBody);
    const { res, getStatus, getBody } = mkResponse();

    await handler(mkRequest(SAMPLE_COMPLETE_SURGE, { signature }), res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({ released: true, targetPodUid: "pod-123" });
    expect(releaseSurgeReadiness).toHaveBeenCalledWith({
      migrationId: SAMPLE_COMPLETE_SURGE.migrationId,
      targetPodUid: "pod-123",
    });
  });

  it("rejects an unsigned readiness release", async () => {
    const releaseSurgeReadiness = vi.fn(async () => undefined);
    const handler = createCompleteSurgeHandoffHandler(mkDeps({ releaseSurgeReadiness }));
    const { res, getStatus } = mkResponse();

    await handler(mkRequest(SAMPLE_COMPLETE_SURGE), res, vi.fn());

    expect(getStatus()).toBe(401);
    expect(releaseSurgeReadiness).not.toHaveBeenCalled();
  });
});

function mkFakeChild(opts: {
  stdout?: string[];
  stderr?: string[];
  exitCode?: number;
  holdExit?: boolean;
} = {}): EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: () => boolean;
} {
  const stdout = new Readable({ read() { /* noop; caller pushes + ends */ } });
  for (const chunk of opts.stdout ?? []) stdout.push(chunk);
  stdout.push(null);
  const stderr = new Readable({ read() { /* noop */ } });
  for (const chunk of opts.stderr ?? []) stderr.push(chunk);
  stderr.push(null);
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: new Writable({
      write(_chunk, _enc, cb) { cb(); },
    }),
    exitCode: opts.exitCode ?? null,
    signalCode: null,
    kill: vi.fn(() => {
      if (!opts.holdExit) {
        setImmediate(() => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.signalCode = "SIGTERM";
          child.emit("exit", null, "SIGTERM");
        });
      }
      return true;
    }),
  });
  if (opts.exitCode !== undefined) {
    const code = opts.exitCode;

const armOnClose = (event: string | symbol) => {
      if (event === "close") {
        child.removeListener("newListener", armOnClose);
        setImmediate(() => child.emit("close", code));
      }
    };
    child.on("newListener", armOnClose);
  }
  return child;
}

describe("createQuiesceHandler", () => {
  it("does not pause the agent if the live voice registry cannot be checked", async () => {
    const adapter = mkAdapter();
    const response = mkResponse();
    const voiceMigration = vi.fn(async () => { throw new Error("voice registry unavailable"); });
    await createQuiesceHandler(mkDeps({ adapter, voiceMigration }))(mkRequest(SAMPLE_QUIESCE, { signature: signForPod(SAMPLE_QUIESCE.migrationId, JSON.stringify(SAMPLE_QUIESCE)) }), response.res, vi.fn());
    expect(response.getStatus()).toBe(500);
    expect(adapter.quiesceUser).not.toHaveBeenCalled();
  });

  it("defers before touching the agent while a voice call is active", async () => {
    const adapter = mkAdapter();
    const voiceMigration = vi.fn(async () => ({ activeCalls: 1 }));
    const response = mkResponse();
    await createQuiesceHandler(mkDeps({ adapter, voiceMigration }))(mkRequest(SAMPLE_QUIESCE, { signature: signForPod(SAMPLE_QUIESCE.migrationId, JSON.stringify(SAMPLE_QUIESCE)) }), response.res, vi.fn());
    expect(response.getStatus()).toBe(200);
    expect(response.getBody()).toMatchObject({ drained: false, runningCount: 1 });
    expect(adapter.quiesceUser).not.toHaveBeenCalled();
  });

  it("waits for voice finalization before quiescing the agent", async () => {
    const adapter = mkAdapter();
    const voiceMigration = vi.fn().mockResolvedValueOnce({ activeCalls: 1 }).mockResolvedValue({ activeCalls: 0 });
    const voiceDrainSleep = vi.fn(async () => undefined);
    const response = mkResponse();
    await createQuiesceHandler(mkDeps({ adapter, voiceMigration, voiceDrainWaitMs: 2_000, voiceDrainSleep }))(
      mkRequest(SAMPLE_QUIESCE, { signature: signForPod(SAMPLE_QUIESCE.migrationId, JSON.stringify(SAMPLE_QUIESCE)) }), response.res, vi.fn());
    expect(response.getStatus()).toBe(200);
    expect(voiceDrainSleep).toHaveBeenCalledWith(1_000);
    expect(adapter.quiesceUser).toHaveBeenCalled();
  });

  it("passes the whole-process rollout's ingress ownership through", async () => {
    const adapter = mkAdapter();
    const body = { ...SAMPLE_QUIESCE, stopMattermost: false };
    const response = mkResponse();
    await createQuiesceHandler(mkDeps({ adapter }))(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(adapter.quiesceUser).toHaveBeenCalledWith("chris", 5_000, { stopMattermost: false });
  });
  it("passes a partial scheduler handoff through to the user quiesce", async () => {
    const adapter = mkAdapter();
    const body = { ...SAMPLE_QUIESCE, schedulerHandoff: true, schedulerMigrationId: "mig-1:scheduler:1", retainNonportable: true };
    const response = mkResponse();
    await createQuiesceHandler(mkDeps({ adapter }))(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(adapter.quiesceUser).toHaveBeenCalledWith("chris", 5_000, { stopMattermost: true, schedulerMigrationId: "mig-1:scheduler:1", retainNonportable: true });
  });
  it("ignores the partial flag outside a scheduler handoff", async () => {
    const adapter = mkAdapter();
    const body = { ...SAMPLE_QUIESCE, retainNonportable: true };
    const response = mkResponse();
    await createQuiesceHandler(mkDeps({ adapter }))(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(adapter.quiesceUser).toHaveBeenCalledWith("chris", 5_000);
  });
  it("rejects bad signature with 401", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const req = mkRequest(SAMPLE_QUIESCE, { signature: "deadbeef" });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(401);
    expect(getBody()).toEqual({ error: "invalid signature" });
  });

  it("rejects invalid JSON body with 400", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const req = mkRequest(SAMPLE_QUIESCE, { rawBody: "{not json" });
    const { res, getStatus } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(400);
  });

  it("checks the path gatewayId only after the signature, so an unsigned probe cannot identify the pod", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const unsigned = mkRequest(SAMPLE_QUIESCE, { pathGatewayId: "someone-else" });
    const { res, getStatus, getBody } = mkResponse();

    await handler(unsigned, res, vi.fn());

    expect(getStatus()).toBe(401);
    expect(getBody()).toEqual({ error: "invalid signature" });
  });

  it("refuses a signature minted for a sibling gateway, so a relayed capture cannot act here", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const rawBody = JSON.stringify(SAMPLE_QUIESCE);
    // What a sibling pod would hold after receiving its own signed quiesce: a
    // valid fleet controller signature whose scope names that other gateway.
    const relayed = mkRequest(SAMPLE_QUIESCE, {
      signature: signForPod(SAMPLE_QUIESCE.migrationId, rawBody, "someone-else"),
    });
    const { res, getStatus, getBody } = mkResponse();

    await handler(relayed, res, vi.fn());

    expect(getStatus()).toBe(401);
    expect(getBody()).toEqual({ error: "invalid signature" });
  });

  it("rejects a signed quiesce addressed to another gateway without naming this one", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const rawBody = JSON.stringify(SAMPLE_QUIESCE);
    const req = mkRequest(SAMPLE_QUIESCE, {
      signature: signForPod(SAMPLE_QUIESCE.migrationId, rawBody),
      pathGatewayId: "someone-else",
    });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(400);
    expect(JSON.stringify(getBody())).not.toContain(GATEWAY_ID);
  });

  it("rejects missing migrationId/slug with 400", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const req = mkRequest({} as QuiesceRequestBody, {
      signature: signForPod("x", "{}"),
    });
    const { res, getStatus } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(400);
  });

  it("rejects malformed slug with 400", async () => {
    const handler = createQuiesceHandler(mkDeps());
    const body: QuiesceRequestBody = { migrationId: "m", slug: "../etc" };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: "invalid slug" });
  });

  it("returns 200 + drained:true when adapter reports clean drain", async () => {
    const adapter = mkAdapter();
    const handler = createQuiesceHandler(mkDeps({ adapter }));
    const rawBody = JSON.stringify(SAMPLE_QUIESCE);
    const sig = signForPod(SAMPLE_QUIESCE.migrationId, rawBody);
    const req = mkRequest(SAMPLE_QUIESCE, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({
      migrationId: SAMPLE_QUIESCE.migrationId,
      slug: SAMPLE_QUIESCE.slug,
      drained: true,
      runningCount: 0,
    });
    expect(adapter.quiesceUser).toHaveBeenCalledWith("chris", 5_000);
  });

  it("returns 200 + drained:false when active work defers the move", async () => {
    const adapter = mkAdapter({
      quiesceUser: vi.fn(async () => ({ drained: false, runningCount: 2 })),
    });
    const handler = createQuiesceHandler(mkDeps({ adapter }));
    const rawBody = JSON.stringify(SAMPLE_QUIESCE);
    const sig = signForPod(SAMPLE_QUIESCE.migrationId, rawBody);
    const req = mkRequest(SAMPLE_QUIESCE, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({ drained: false, runningCount: 2 });
  });

  it("defaults timeoutMs to 60_000 when omitted", async () => {
    const adapter = mkAdapter();
    const handler = createQuiesceHandler(mkDeps({ adapter }));
    const body: QuiesceRequestBody = { migrationId: "m", slug: "chris" };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res } = mkResponse();
    await handler(req, res, vi.fn());
    expect(adapter.quiesceUser).toHaveBeenCalledWith("chris", 60_000);
  });

  it("returns 500 when adapter throws", async () => {
    const adapter = mkAdapter({
      quiesceUser: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const handler = createQuiesceHandler(mkDeps({ adapter }));
    const rawBody = JSON.stringify(SAMPLE_QUIESCE);
    const sig = signForPod(SAMPLE_QUIESCE.migrationId, rawBody);
    const req = mkRequest(SAMPLE_QUIESCE, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({ error: "quiesce failed", message: "boom" });
  });
});

describe("createFlushHandler", () => {
  it("reclaims the source SSH key before a migration-final durable flush", async () => {
    const registerKey = vi.fn(async () => undefined);
    const flushLocalState = vi.fn(async () => ({
      ok: true,
      durationMs: 12,
      steps: [],
    }));
    const adapter = mkAdapter({
      readLocalUserPubKey: vi.fn(() => "ssh-ed25519 SOURCE chris@gateway"),
      gitHost: mkGitHost({ registerKey }),
    });
    const handler = createFlushHandler(mkDeps({ adapter, flushLocalState }));
    const body = { migrationId: "mig-1", slug: "chris", reason: "migration-final" };
    const req = mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(registerKey).toHaveBeenCalledWith(
      "chris",
      "ssh-ed25519 SOURCE chris@gateway",
    );
    expect(registerKey.mock.invocationCallOrder[0]).toBeLessThan(
      flushLocalState.mock.invocationCallOrder[0],
    );
  });

  it("runs the configured local flush under the signed fleet-control envelope", async () => {
    const flushLocalState = vi.fn(async () => ({
      ok: true,
      durationMs: 12,
      steps: [{ name: "customer-files", status: "done" as const, durationMs: 10 }],
    }));
    const handler = createFlushHandler(mkDeps({ flushLocalState }));
    const body = { migrationId: "mig-1", slug: "chris", reason: "idle" };
    const req = mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(flushLocalState).toHaveBeenCalledWith({ slug: "chris", reason: "idle" });
    expect(getBody()).toEqual({
      migrationId: "mig-1",
      slug: "chris",
      ok: true,
      durationMs: 12,
      steps: [{ name: "customer-files", status: "done", durationMs: 10 }],
    });
  });

  it("fails closed when the gateway did not configure a flush implementation", async () => {
    const handler = createFlushHandler(mkDeps());
    const body = { migrationId: "mig-1", slug: "chris" };
    const req = mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(501);
    expect(getBody()).toEqual({ error: "flush not configured" });
  });

  it("passes the signed source checkpoint into the target migration-converge flush", async () => {
    const expectedSystemConfigCommit = "a".repeat(40);
    const flushLocalState = vi.fn(async () => ({
      ok: true,
      durationMs: 12,
      steps: [],
      systemConfigCommit: "b".repeat(40),
    }));
    const resumeSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const handler = createFlushHandler(mkDeps({
      flushLocalState,
      resumeSystemConfigWatch,
    }));
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      reason: "migration-converge",
      expectedSystemConfigCommit,
    };
    const req = mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(flushLocalState).toHaveBeenCalledWith({
      slug: "chris",
      reason: "migration-converge",
      expectedSystemConfigCommit,
    });
    expect(resumeSystemConfigWatch).toHaveBeenCalledWith("chris");
    expect(flushLocalState.mock.invocationCallOrder[0]).toBeLessThan(
      resumeSystemConfigWatch.mock.invocationCallOrder[0],
    );
  });

  it("keeps the target watcher fenced when migration convergence fails", async () => {
    const expectedSystemConfigCommit = "a".repeat(40);
    const flushLocalState = vi.fn(async () => {
      throw new Error("durable checkpoint unavailable");
    });
    const resumeSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const handler = createFlushHandler(mkDeps({
      flushLocalState,
      resumeSystemConfigWatch,
    }));
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      reason: "migration-converge",
      expectedSystemConfigCommit,
    };
    const req = mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(resumeSystemConfigWatch).not.toHaveBeenCalled();
  });

  it("keeps the target watcher fenced when a convergence step reports failure", async () => {
    const expectedSystemConfigCommit = "a".repeat(40);
    const flushLocalState = vi.fn(async () => ({
      ok: false,
      durationMs: 12,
      steps: [{
        name: "system-config",
        status: "failed" as const,
        error: "writer-lock-busy",
        durationMs: 12,
      }],
    }));
    const resumeSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const handler = createFlushHandler(mkDeps({
      flushLocalState,
      resumeSystemConfigWatch,
    }));
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      reason: "migration-converge",
      expectedSystemConfigCommit,
    };
    const req = mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(resumeSystemConfigWatch).not.toHaveBeenCalled();
  });

  it.each([
    ["an existing import fence", "import-fence"],
    ["no initial fence", null],
  ])("does not let a delayed convergence flush from %s clear a concurrent unmount fence", async (
    _label,
    initialFence,
  ) => {
    let finishFlush: () => void = () => {};
    const flushBlocked = new Promise<void>((resolve) => {
      finishFlush = resolve;
    });
    let flushStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      flushStarted = resolve;
    });
    let activeFence: string | null = initialFence;
    const flushLocalState = vi.fn(async () => {
      flushStarted();
      await flushBlocked;
      return { ok: true, durationMs: 12, steps: [] };
    });
    const readSystemConfigWatchFence = vi.fn(async () => activeFence);
    const resumeSystemConfigWatch = vi.fn(
      async (_slug: string, expectedGeneration?: string | null) => {
        if (activeFence === expectedGeneration) activeFence = null;
      },
    );
    const pauseSystemConfigWatch = vi.fn(async () => {
      activeFence = "unmount-fence";
      return activeFence;
    });
    const removeImportedUserBySlug = vi.fn(async () => ({
      wasMounted: true,
      steps: [],
    }));
    const deps = mkDeps({
      flushLocalState,
      readSystemConfigWatchFence,
      resumeSystemConfigWatch,
      pauseSystemConfigWatch,
      adapter: mkAdapter({ removeImportedUserBySlug }),
    });
    const flushBody = {
      migrationId: "mig-1",
      slug: "chris",
      reason: "migration-converge",
      expectedSystemConfigCommit: "a".repeat(40),
    };
    const flushResponse = mkResponse();
    const flushing = createFlushHandler(deps)(
      mkRequest(flushBody, {
        signature: signForPod(flushBody.migrationId, JSON.stringify(flushBody)),
      }),
      flushResponse.res,
      vi.fn(),
    );
    await started;

    const unmountRaw = JSON.stringify(SAMPLE_UNMOUNT);
    const unmountResponse = mkResponse();
    await createUnmountHandler(deps)(
      mkRequest(SAMPLE_UNMOUNT, {
        signature: signForPod(SAMPLE_UNMOUNT.migrationId, unmountRaw),
      }),
      unmountResponse.res,
      vi.fn(),
    );
    finishFlush();
    await flushing;

    expect(unmountResponse.getStatus()).toBe(200);
    expect(flushResponse.getStatus()).toBe(200);
    expect(resumeSystemConfigWatch).toHaveBeenCalledWith(
      "chris",
      initialFence,
    );
    expect(activeFence).toBe("unmount-fence");
  });

  it.each([
    {},
    { expectedSystemConfigCommit: "not-a-sha" },
  ])("rejects target convergence without a valid accepted commit: %o", async (extra) => {
    const flushLocalState = vi.fn();
    const handler = createFlushHandler(mkDeps({ flushLocalState }));
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      reason: "migration-converge",
      ...extra,
    };
    const req = mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(400);
    expect(flushLocalState).not.toHaveBeenCalled();
  });
});

describe("createVerifyHandler", () => {
  it("preserves Agent verification before the target can read the assignment-gated snapshot", async () => {
    const adapter = mkAdapter({ uidForSlug: vi.fn(async () => null) });
    const body = { migrationId: "mig-before-cutover", slug: "chris" };
    const response = mkResponse();
    await createVerifyHandler(mkDeps({ adapter }))(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(200);
    expect(response.getBody()).toMatchObject({ ready: true, checks: { customerDir: true, coachWired: true, mountMarked: true } });
    expect(adapter.uidForSlug).not.toHaveBeenCalled();
    expect(adapter.loadUserSnapshot).not.toHaveBeenCalled();
    expect(adapter.projectAgentsHealthy).not.toHaveBeenCalled();
  });
  it("rejects bad signature with 401", async () => {
    const handler = createVerifyHandler(mkDeps());
    const body = { migrationId: "mig-1", slug: "chris" };
    const req = mkRequest(body, { signature: "deadbeef" });
    const { res, getStatus } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(401);
  });

  it("returns 200 ready=true from the mount structure without waiting on the agent account", async () => {
    const adapter = mkAdapter({ waitForAccountHealthy: vi.fn(async () => false) });
    const log = vi.fn();
    const handler = createVerifyHandler(mkDeps({ adapter, log }));
    const body = { migrationId: "mig-1", slug: "chris" };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[migration-http] verify"), { status: "done" });
    expect(getBody()).toEqual({
      migrationId: "mig-1",
      slug: "chris",
      ready: true,
      checks: {
        customerDir: true,
        coachWired: true,
        mountMarked: true,
      },
    });
    expect(adapter.waitForAccountHealthy).not.toHaveBeenCalled();
  });

  it("returns 409 ready=false when any readiness check fails", async () => {
    const adapter = mkAdapter({
      userMountMarked: vi.fn(() => false),
    });
    const log = vi.fn();
    const handler = createVerifyHandler(mkDeps({ adapter, log }));
    const body = { migrationId: "mig-1", slug: "chris" };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(409);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[migration-http] verify"), { status: "failed" });
    expect(getBody()).toMatchObject({
      ready: false,
      checks: { mountMarked: false },
    });
  });

  async function verifyMidAttach(input: { attachPending: boolean; coachWired: boolean; mountMarked: boolean }) {
    const adapter = mkAdapter({
      userDefaultAgentWiredInOpenclawConfig: vi.fn(() => input.coachWired),
      userMountMarked: vi.fn(() => input.mountMarked),
    });
    const userAttachPending = vi.fn(async () => input.attachPending);
    const handler = createVerifyHandler(mkDeps({ adapter, userAttachPending }));
    const body = { migrationId: "mig-1", slug: "chris" };
    const response = mkResponse();
    await handler(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }),
      response.res,
      vi.fn(),
    );
    return { adapter, userAttachPending, status: response.getStatus(), body: response.getBody() };
  }

  it.each([
    { coachWired: false, mountMarked: true },
    { coachWired: true, mountMarked: false },
  ])("reports an agent attach still in progress without waiting on the account (wired=$coachWired, marked=$mountMarked)", async (wiring) => {
    const result = await verifyMidAttach({ attachPending: true, ...wiring });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      ready: false,
      code: MIGRATION_VERIFY_DEFAULT_AGENT_ATTACH_IN_PROGRESS,
      checks: { customerDir: true, ...wiring },
    });
    expect(result.userAttachPending).toHaveBeenCalledWith("chris");
    expect(result.adapter.waitForAccountHealthy).not.toHaveBeenCalled();
  });

  it("reports an unwired agent with no attach in progress as plainly not ready", async () => {
    const result = await verifyMidAttach({ attachPending: false, coachWired: false, mountMarked: true });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ ready: false, checks: { coachWired: false } });
    expect(result.body).not.toHaveProperty("code");
  });

  it("verifies a fully mounted agent normally while a content re-ensure is pending", async () => {
    const result = await verifyMidAttach({ attachPending: true, coachWired: true, mountMarked: true });

    expect(result.status).toBe(200);
    expect(result.body).not.toHaveProperty("code");
  });

  it.each([
    { configTransferMode: undefined, overlayPresent: true },
    { configTransferMode: "configured-builder-system-config", overlayPresent: true },
    { configTransferMode: undefined, overlayPresent: false },
  ])("verifies configured user readiness (mode=$configTransferMode, overlay=$overlayPresent)", async ({ configTransferMode, overlayPresent }) => {
    stubUserClaim("chris");
    const adapter = mkAdapter({
      isIsolatedGateway: vi.fn(() => true),
      configuredUserOverlayPresent: vi.fn(() => overlayPresent),
      hasWorkspaceGitDir: vi.fn(() => true),
      hasGitRemote: vi.fn(() => true),
      userDefaultAgentWiredInOpenclawConfig: vi.fn(() => false),
    });
    const handler = createVerifyHandler(mkDeps({ adapter }));
    const body = {
      migrationId: "mig-user-verify",
      slug: "chris",
      ...(configTransferMode ? { configTransferMode } : {}),
    };
    const response = mkResponse();

    await handler(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }),
      response.res,
      vi.fn(),
    );

    expect(response.getStatus()).toBe(overlayPresent ? 200 : 409);
    expect(response.getBody()).toEqual({
      migrationId: "mig-user-verify",
      slug: "chris",
      ready: overlayPresent,
      configTransferMode: "configured-builder-system-config",
      checks: {
        customerDir: true,
        configuredBuilderOverlay: overlayPresent,
        mountMarked: true,
        workspaceGit: true,
        gitRemote: true,
      },
    });
    expect(adapter.waitForAccountHealthy).not.toHaveBeenCalled();
  });
});

describe("held Native source maintenance admission", () => {
  const request = () => ({
    migrationId: "mig-op", slug: "alice", binding: { gatewayId: GATEWAY_ID, operationId: "op", slug: "alice" },
    expiresAt: Date.now() + 30_000, nonce: "f".repeat(64),
  });
  it("refuses an ordinary restore signature and never reads the customer's snapshot", async () => {
    const readHeldSourceSnapshot = vi.fn(), req = request(), res = mkResponse();
    await createHeldNativeSourceReconcileHandler(mkDeps({ readHeldSourceSnapshot }))(mkRequest(req, {
      signature: signForPod(req.migrationId, JSON.stringify(req)),
    }), res.res);
    expect(res.getStatus()).toBe(401);
    expect(readHeldSourceSnapshot).not.toHaveBeenCalled();
  });
  it("requires the in-guest keeper even on a correctly signed request", async () => {
    const readHeldSourceSnapshot = vi.fn(), req = request(), res = mkResponse();
    await createHeldNativeSourceReconcileHandler(mkDeps({ readHeldSourceSnapshot }))(mkRequest(req, {
      signature: signFleetRequest(PRIVATE_KEY, heldNativeSourceReconcileJobId(req.migrationId, GATEWAY_ID), JSON.stringify(req)),
    }), res.res);
    expect(res.getStatus()).toBe(409);
    expect(readHeldSourceSnapshot).not.toHaveBeenCalled();
  });
});

describe("createRestoreHandler", () => {
  it("refuses an acknowledged workspace restore on the ordinary restore route", async () => {
    const body = { migrationId: "mig-1", uid: "uid-chris", slug: "chris", snapshot: RESTORE_SNAPSHOT,
      workspaceCommits: { workspace: "a".repeat(40) } };
    const adapter = mkAdapter({ isIsolatedGateway: () => false, cloneWorkspaceRepo: vi.fn() });
    const response = mkResponse();
    const req = { ...mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }),
      path: `/restore/${GATEWAY_ID}` } as Request;
    await createRestoreHandler(mkDeps({ adapter }))(req, response.res, vi.fn());
    expect(response.getStatus()).toBe(500);
    expect(adapter.cloneWorkspaceRepo).not.toHaveBeenCalled();
  });

  it.each(["changed claim", "mounted without a completed marker"] as const)("refuses a workspace restore with %s before touching Git", async (scenario) => {
    const authority = { uid: "uid-chris", slug: "chris", gatewayId: GATEWAY_ID, fromGatewayId: "old",
      assignmentEpoch: 2, operationId: "1", claimStartedAt: 10, phase: "dispatched" as const, attemptId: "attempt",
      dispatchedAt: 11, dispatchClaimStartedAt: 10, migrationId: "mig-1" };
    const snapshot = { ...RESTORE_SNAPSHOT, agentIds: [...RESTORE_SNAPSHOT.agentIds], channels: [], projects: [],
      runtimeMutationFenced: true, restoreAuthority: authority };
    const body = { migrationId: "mig-1", uid: "uid-chris", slug: "chris", snapshot,
      workspaceCommits: { workspace: "a".repeat(40) } };
    const adapter = mkAdapter({ isIsolatedGateway: () => false, cloneWorkspaceRepo: vi.fn(), userMountMarked: () => false });
    const response = mkResponse();
    const req = { ...mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }),
      path: `/resume-restore/${GATEWAY_ID}` } as Request;
    const sameClaim = scenario !== "changed claim";
    const readHeldSourceSnapshot = async () => ({ ...snapshot, restoreAuthority: { ...authority, claimStartedAt: sameClaim ? 10 : 12 } });
    const getMountedUsers = () => sameClaim ? [snapshot.slug] : [];
    await createRestoreHandler(mkDeps({ adapter, readHeldSourceSnapshot, getMountedUsers }))(req, response.res, vi.fn());
    expect(response.getStatus()).toBe(500);
    expect(response.getBody()).toMatchObject({
      message: sameClaim ? "Acknowledged workspace restore replay has no completed ready mount" : "Acknowledged workspace restore authority changed",
    });
    expect(adapter.cloneWorkspaceRepo).not.toHaveBeenCalled();
  });

  it("joins a matching restore retry instead of starting competing mount work", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const adapter = mkAdapter({
      hasUserSshKey: vi.fn(() => true),
      readLocalUserPubKey: vi.fn(() => "ssh-ed25519 TEST"),
      gitHost: mkGitHost({ listKeys: vi.fn(async () => ["ssh-ed25519 TEST"]), ensureOwner: vi.fn(async () => undefined) }),
      hasWorkspaceGitDir: vi.fn(() => false),
      cloneWorkspaceRepo: vi.fn(async () => true),
      ensureUserDirectories: vi.fn(),
      writeUserTemplateFiles: vi.fn(async () => undefined),
      blobSyncForSlug: vi.fn(async () => undefined),
      restoreByosubForAgent: vi.fn(async () => ({ restored: false, present: false })),
      applyAddUserConfigPatch: vi.fn(async () => { await blocked; return { elapsedMs: 1 }; }),
    });
    const handler = createRestoreHandler(mkDeps({ adapter }));
    const body = { migrationId: "mig-1", uid: "uid-chris", slug: "chris", snapshot: RESTORE_SNAPSHOT };
    const response = () => mkResponse();
    const one = response(), two = response();
    const request = () => mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) });
    const first = handler(request(), one.res, vi.fn());
    await vi.waitFor(() => expect(adapter.applyAddUserConfigPatch).toHaveBeenCalledOnce());
    const foreignBody = { ...body, migrationId: "foreign" };
    const foreign = response();
    await handler(mkRequest(foreignBody, { signature: signForPod(foreignBody.migrationId, JSON.stringify(foreignBody)) }), foreign.res, vi.fn());
    expect(foreign.getStatus()).toBe(500);
    const second = handler(request(), two.res, vi.fn());
    release();
    await Promise.all([first, second]);
    expect(one.getStatus()).toBe(200);
    expect(two.getStatus()).toBe(200);
    expect(adapter.applyAddUserConfigPatch).toHaveBeenCalledOnce();
  });
  it("keeps late restore work exclusive after its response deadline until the work actually settles", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const adapter = mkAdapter({
      hasUserSshKey: vi.fn(() => true), readLocalUserPubKey: vi.fn(() => "ssh-ed25519 TEST"),
      gitHost: mkGitHost({ listKeys: vi.fn(async () => ["ssh-ed25519 TEST"]), ensureOwner: vi.fn(async () => undefined) }),
      hasWorkspaceGitDir: vi.fn(() => false), cloneWorkspaceRepo: vi.fn(async () => true),
      ensureUserDirectories: vi.fn(), writeUserTemplateFiles: vi.fn(async () => undefined),
      blobSyncForSlug: vi.fn(async () => undefined), restoreByosubForAgent: vi.fn(async () => ({ restored: false, present: false })),
      applyAddUserConfigPatch: vi.fn(async () => { await blocked; return { elapsedMs: 1 }; }),
    });
    const handler = createRestoreHandler(mkDeps({ adapter }));
    const body = { migrationId: "mig-1", uid: "uid-chris", slug: "chris", snapshot: RESTORE_SNAPSHOT };
    const request = () => mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) });
    vi.useFakeTimers();
    try {
      const first = mkResponse();
      const pending = handler(request(), first.res, vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(adapter.applyAddUserConfigPatch).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(300_001);
      await pending;
      expect(first.getStatus()).toBe(500);
      const second = mkResponse();
      await handler(request(), second.res, vi.fn());
      expect(second.getStatus()).toBe(500);
      expect(adapter.applyAddUserConfigPatch).toHaveBeenCalledOnce();
      release();
      await vi.advanceTimersByTimeAsync(0);
      const third = mkResponse();
      await handler(request(), third.res, vi.fn());
      expect(third.getStatus()).toBe(200);
      expect(adapter.applyAddUserConfigPatch).toHaveBeenCalledTimes(2);
    } finally {
      release();
      vi.useRealTimers();
    }
  });
  it("rejects bad signature with 401", async () => {
    const handler = createRestoreHandler(mkDeps());
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      uid: "uid-chris",
      snapshot: RESTORE_SNAPSHOT,
    };
    const req = mkRequest(body, { signature: "deadbeef" });
    const { res, getStatus } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(401);
  });

  it("passes signed Shared restore scope through the post-Git roster publication owner", async () => {
    const applyAddUserConfigPatch = vi.fn(async () => ({ elapsedMs: 1 }));
    const adapter = mkAdapter({ isIsolatedGateway: () => false, hasUserSshKey: () => true,
      readLocalUserPubKey: () => "ssh-ed25519 TEST", gitHost: mkGitHost({ listKeys: async () => ["ssh-ed25519 TEST"], ensureOwner: async () => undefined }),
      hasWorkspaceGitDir: () => false, cloneWorkspaceRepo: async () => true, ensureUserDirectories: () => undefined,
      writeUserTemplateFiles: async () => undefined, blobSyncForSlug: async () => undefined,
      restoreByosubForAgent: async () => ({ restored: false, present: false }), applyAddUserConfigPatch });
    const body = { migrationId: "mig-postcutover-restore", uid: "uid-chris", slug: "chris", snapshot: RESTORE_SNAPSHOT };
    const response = mkResponse();
    await createRestoreHandler(mkDeps({ adapter }))(mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn());
    expect(response.getStatus(), JSON.stringify(response.getBody())).toBe(200);
    expect(applyAddUserConfigPatch).toHaveBeenCalledWith(expect.anything(), null, expect.objectContaining({ migrationId: body.migrationId }));
  });

  it("restores runtime state from the controller-provided durable snapshot and leaves the mount marker intact", async () => {
    const usersDir = await fs.mkdtemp(path.join(os.tmpdir(), "restore-marker-"));
    let watcherFenced = false;
    const pauseSystemConfigWatch = vi.fn(async (slug: string) => {
      expect(slug).toBe("chris");
      watcherFenced = true;
    });
    const adapter = mkAdapter({
      loadUserSnapshot: vi.fn(async () => {
        throw new Error("restore should use the signed snapshot, not broker lookup");
      }),
      hasUserSshKey: vi.fn(() => true),
      readLocalUserPubKey: vi.fn(() => "ssh-ed25519 local"),
      gitHost: mkGitHost({ listKeys: vi.fn(async () => ["ssh-ed25519 local"]), ensureOwner: vi.fn(async () => undefined) }),
      hasWorkspaceGitDir: vi.fn(() => false),
      cloneWorkspaceRepo: vi.fn(async () => true),
      ensureUserDirectories: vi.fn(),
      writeUserTemplateFiles: vi.fn(async () => undefined),
      blobSyncForSlug: vi.fn(async () => undefined),
      restoreByosubForAgent: vi.fn(async () => ({ restored: false, present: false })),
      applyAddUserConfigPatch: vi.fn(async () => {
        expect(watcherFenced).toBe(true);
        return { elapsedMs: 1 };
      }),
      writeMountMarker: vi.fn((slug) => writeMountedMarker(usersDir, slug)),
      markUserMigratingIn: vi.fn((slug) => writeMigratingInPin(usersDir, slug)),
    });
    const handler = createRestoreHandler(mkDeps({ adapter, pauseSystemConfigWatch }));
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      uid: "uid-chris",
      snapshot: {
        ...RESTORE_SNAPSHOT,
        projectCheckoutScope: "workspace-and-projects",
        projects: [{ projectSlug: "demo", giteaRepoName: "chris-demo" }],
        projectAgents: [{ projectId: "demo", enabled: true, token: "pat-demo", mmUserId: "bot-demo", status: "ready", activationId: "activation-demo" }],
        planInputs: {
          selectedTier: "personal_free",
          builderSubscription: { tier: "pro", status: "trialing" },
          trialGrant: {
            schemaVersion: 3,
            offerId: "builder-signup",
            offerVersion: 1,
            personalTier: "personal",
            builderTier: "hobby",
            configHash: "trial-config-a",
            claimedAt: "2026-07-22T00:00:00.000Z",
            endsAt: "2026-07-29T00:00:00.000Z",
          },
        },
        freeTierModelRef: "platform-openrouter/moonshotai/kimi-k2",
        byotActive: true,
        systemConfig: { byot: { provider: "anthropic" } },
      },
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    try {
      await handler(req, res, vi.fn());

      expect(getStatus()).toBe(200);
      expect(getBody()).toMatchObject({
        migrationId: "mig-1",
        slug: "chris",
        restored: true,
      });
      expect(adapter.cloneWorkspaceRepo).toHaveBeenCalledWith(
        "chris",
        "git@gitea:octogee/chris.git",
      );
      expect(adapter.applyAddUserConfigPatch).toHaveBeenCalledWith(
        expect.objectContaining({
          uid: "uid-chris", slug: "chris", projectCheckoutScope: "workspace-and-projects",
          projectAgents: body.snapshot.projectAgents,
        }),
        null,
        expect.objectContaining({ byosActive: false }),
      );
      expect(adapter.reassertByotForUser).toHaveBeenCalledWith(
        expect.objectContaining({
          byotActive: true,
          planInputs: {
            selectedTier: "personal_free",
            builderSubscription: { tier: "pro", status: "trialing" },
            trialGrant: {
              schemaVersion: 3,
              offerId: "builder-signup",
              offerVersion: 1,
              personalTier: "personal",
              builderTier: "hobby",
              configHash: "trial-config-a",
              claimedAt: "2026-07-22T00:00:00.000Z",
              endsAt: "2026-07-29T00:00:00.000Z",
            },
          },
          freeTierModelRef: "platform-openrouter/moonshotai/kimi-k2",
          systemConfig: { byot: { provider: "anthropic" } },
          provisioning: { openclaw: { status: "complete" } },
        }),
      );
      expect(adapter.writeMountMarker).toHaveBeenCalledWith("chris");
      expect(adapter.cloneProjectRepo).toHaveBeenCalledWith("chris", "demo", "chris-demo", expect.objectContaining({ refreshRemote: true }));
      expect(adapter.markUserMigratingIn).toHaveBeenCalledTimes(1);
      expect(adapter.markUserMigratingIn).toHaveBeenCalledWith("chris");
      expect(pauseSystemConfigWatch).toHaveBeenCalledOnce();
      expect(hasMountedMarker(usersDir, "chris")).toBe(true);
    } finally {
      await fs.rm(usersDir, { recursive: true, force: true });
    }
  });

  it("refreshes the same-uid broker snapshot before the model re-assert", async () => {
    const currentSnapshot = {
      ...RESTORE_SNAPSHOT,
      byotActive: true,
      systemConfig: { byot: { provider: "anthropic" } },
    };
    const adapter = mkAdapter({
      loadUserSnapshot: vi.fn(async () => currentSnapshot),
      hasUserSshKey: vi.fn(() => true),
      readLocalUserPubKey: vi.fn(() => "ssh-ed25519 local"),
      gitHost: mkGitHost({ listKeys: vi.fn(async () => ["ssh-ed25519 local"]), ensureOwner: vi.fn(async () => undefined) }),
      hasWorkspaceGitDir: vi.fn(() => false),
      cloneWorkspaceRepo: vi.fn(async () => true),
      ensureUserDirectories: vi.fn(),
      writeUserTemplateFiles: vi.fn(async () => undefined),
      blobSyncForSlug: vi.fn(async () => undefined),
      restoreByosubForAgent: vi.fn(async () => ({ restored: false, present: false })),
      applyAddUserConfigPatch: vi.fn(async () => ({ elapsedMs: 1 })),
    });
    const handler = createRestoreHandler(mkDeps({ adapter }));
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      uid: "uid-chris",
      snapshot: RESTORE_SNAPSHOT,
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(adapter.loadUserSnapshot).toHaveBeenCalledWith("uid-chris");
    expect(adapter.reassertByotForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        byotActive: true,
        systemConfig: { byot: { provider: "anthropic" } },
        provisioning: { openclaw: { status: "complete" } },
      }),
    );
  });

  it("rejects a snapshot whose uid/slug do not match the signed restore body", async () => {
    const handler = createRestoreHandler(mkDeps());
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      uid: "uid-chris",
      snapshot: { ...RESTORE_SNAPSHOT, slug: "mallory" },
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: "snapshot mismatch" });
  });

  const WITHOUT_PLAN_INPUTS = "snapshot carries no plan inputs; the fleet controller predates this gateway image";
  const WITHOUT_PERSONA = "snapshot carries no persona; the fleet controller predates this gateway image";

  it.each([
    ["a previous fleet controller's snapshot that names a tier and carries no plan inputs", (() => {
      const { planInputs: _planInputs, contextTemplateKey: _contextTemplateKey, ...previous } = RESTORE_SNAPSHOT;
      return { ...previous, tier: "personal", selectedTier: "personal" };
    })(), WITHOUT_PLAN_INPUTS],
    ["plan inputs that are not an object", { ...RESTORE_SNAPSHOT, planInputs: "personal" }, WITHOUT_PLAN_INPUTS],
    ["an empty context template key", { ...RESTORE_SNAPSHOT, contextTemplateKey: "" }, WITHOUT_PLAN_INPUTS],
    ["a previous fleet controller's snapshot that carries the vibe under its previous name and no persona", (() => {
      const { persona: _persona, ...previous } = RESTORE_SNAPSHOT;
      return { ...previous, onboardingVibe: "garage" };
    })(), WITHOUT_PERSONA],
    ["a persona that is not an object", { ...RESTORE_SNAPSHOT, persona: "garage" }, WITHOUT_PERSONA],
  ])("refuses a restore whose snapshot has %s before it touches the user", async (_label, snapshot, refusal) => {
    const adapter = {
      markUserMigratingIn: vi.fn(),
      seedUserSnapshotForMigration: vi.fn(),
      cloneWorkspaceRepo: vi.fn(async () => true),
      writeUserTemplateFiles: vi.fn(async () => undefined),
      applyAddUserConfigPatch: vi.fn(async () => ({ elapsedMs: 1 })),
      reassertByotForUser: vi.fn(async () => undefined),
    };
    const log = vi.fn();
    const handler = createRestoreHandler(mkDeps({ adapter: mkAdapter(adapter), log }));
    const body = { migrationId: "mig-1", slug: "chris", uid: "uid-chris", snapshot };
    const sig = signForPod(body.migrationId, JSON.stringify(body));
    const { res, getStatus, getBody } = mkResponse();

    await handler(mkRequest(body, { signature: sig }), res, vi.fn());

    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: refusal });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(refusal.split(";")[0]), { status: "failed" });
    for (const touched of Object.values(adapter)) expect(touched).not.toHaveBeenCalled();
  });

  it("rejects a malformed snapshot body with 400 instead of throwing", async () => {
    const handler = createRestoreHandler(mkDeps());
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      uid: "uid-chris",
      snapshot: null,
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: "snapshot mismatch" });
  });
});

describe("createUnmountHandler", () => {
  it("releases the source voice hold after successful unmount", async () => {
    const voiceMigration = vi.fn(async () => ({ activeCalls: 0 }));
    const adapter = mkAdapter({ removeImportedUserBySlug: vi.fn(async () => ({ wasMounted: true, steps: [] })) });
    const response = mkResponse();
    await createUnmountHandler(mkDeps({ adapter, voiceMigration }))(mkRequest(SAMPLE_UNMOUNT, {
      signature: signForPod(SAMPLE_UNMOUNT.migrationId, JSON.stringify(SAMPLE_UNMOUNT)),
    }), response.res, vi.fn());
    expect(response.getStatus()).toBe(200);
    expect(voiceMigration).toHaveBeenCalledWith({ slug: 'chris', operationId: SAMPLE_UNMOUNT.migrationId, phase: 'resume' });
  });

  it("does not release voice when unmount fails", async () => {
    const voiceMigration = vi.fn(async () => ({ activeCalls: 0 }));
    const adapter = mkAdapter({ removeImportedUserBySlug: vi.fn(async () => { throw new Error('unmount failed'); }) });
    const response = mkResponse();
    await createUnmountHandler(mkDeps({ adapter, voiceMigration }))(mkRequest(SAMPLE_UNMOUNT, {
      signature: signForPod(SAMPLE_UNMOUNT.migrationId, JSON.stringify(SAMPLE_UNMOUNT)),
    }), response.res, vi.fn());
    expect(response.getStatus()).toBe(500);
    expect(voiceMigration).not.toHaveBeenCalled();
  });
  it.each([false, true])("cancels a user activation before rollback unmount; cancellation fails: %s", async (fails) => {
    vi.stubEnv("POD_UID", "builder-pod");
    const events: string[] = [];
    const adapter = mkAdapter({
      isIsolatedGateway: () => true,
      removeImportedUserBySlug: vi.fn(async () => {
        events.push("unmount");
        return { wasMounted: true, steps: [] };
      }),
    });
    const unreserveSurgeTarget = vi.fn(async (_request, cleanup?: (assertCurrent: () => Promise<void>) => Promise<void>) => {
      events.push("cancel");
      if (fails) throw new Error("cannot cancel serving assignment");
      await cleanup?.(async () => {});
      return HELD_USER_GATE_STATE;
    });
    const handler = createUnmountHandler(mkDeps({
      adapter, unreserveSurgeTarget,
      reserveSurgeTarget: async () => undefined, releaseSurgeReadiness: async () => undefined,
    }));
    const response = mkResponse();
    await handler(mkRequest(SAMPLE_UNMOUNT, {
      signature: signForPod(SAMPLE_UNMOUNT.migrationId, JSON.stringify(SAMPLE_UNMOUNT)),
    }), response.res, vi.fn());
    expect(unreserveSurgeTarget).toHaveBeenCalledExactlyOnceWith({
      migrationId: SAMPLE_UNMOUNT.migrationId, slug: "chris", targetPodUid: "builder-pod",
    }, expect.any(Function));
    expect(response.getStatus()).toBe(fails ? 500 : 200);
    expect(events).toEqual(fails ? ["cancel"] : ["cancel", "unmount"]);
  });

  it("rejects bad signature with 401", async () => {
    const handler = createUnmountHandler(mkDeps());
    const req = mkRequest(SAMPLE_UNMOUNT, { signature: "deadbeef" });
    const { res, getStatus } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(401);
  });

  it("refuses an unmount on a gateway whose adapter cannot remove an imported user", async () => {
    const adapter = mkAdapter();
    const pauseSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const handler = createUnmountHandler(mkDeps({ adapter, pauseSystemConfigWatch }));
    const rawBody = JSON.stringify(SAMPLE_UNMOUNT);
    const req = mkRequest(SAMPLE_UNMOUNT, { signature: signForPod(SAMPLE_UNMOUNT.migrationId, rawBody) });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({ error: "unmount failed", message: "unmount requires imported-user removal" });
    expect(adapter.applyRemoveUserConfigPatch).not.toHaveBeenCalled();
    expect(adapter.deleteDepartedUserState).not.toHaveBeenCalled();
  });

  it.each(["complete", "early-noop", "foreign-agent", "changed-pod"])(
    "requires exact Shared Native cleanup for a due-erasure unmount: %s", async mode => {
      vi.stubEnv("POD_UID", "shared-pod");
      const gatewayId = "shared-erasure";
      const agentIds = ["octogee-chris-coach", mode === "foreign-agent" ? "octogee-bob-coach" : "octogee-chris-proj-pgonly-coach"];
      const body: UnmountRequestBody = { ...SAMPLE_UNMOUNT, agentStoreErasure: {
        podUid: mode === "changed-pod" ? "old-pod" : "shared-pod", agentIds,
      } };
      const remove = vi.fn(async () => ({ wasMounted: false, steps: [],
        ...(mode === "early-noop" ? {} : { releasedAgentIds: agentIds }) }));
      const voiceMigration = vi.fn(async () => ({ activeCalls: 0 }));
      const handler = createUnmountHandler(mkDeps({ gatewayId, voiceMigration, adapter: mkAdapter({ removeImportedUserBySlug: remove }) }));
      const response = mkResponse();
      await handler(mkRequest(body, { pathGatewayId: gatewayId,
        signature: signForPod(body.migrationId, JSON.stringify(body), gatewayId) }), response.res, vi.fn());
      expect(response.getStatus()).toBe(mode === "complete" ? 200 : mode === "early-noop" ? 500 : 400);
      expect(voiceMigration).not.toHaveBeenCalled();
      if (mode === "complete") {
        expect(response.getBody()).toMatchObject({ unmounted: false, agentStoreErasure: body.agentStoreErasure });
        expect(remove).toHaveBeenCalledWith("chris", undefined, undefined, undefined, agentIds);
      }
      if (mode === "foreign-agent" || mode === "changed-pod") expect(remove).not.toHaveBeenCalled();
    });

  it("keeps a duplicate imported-user unmount fenced after response loss", async () => {
    const adapter = mkAdapter({
      removeImportedUserBySlug: vi.fn(async () => ({ wasMounted: false, steps: [] })),
    });
    const pauseSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const resumeSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const handler = createUnmountHandler(mkDeps({
      adapter,
      pauseSystemConfigWatch,
      resumeSystemConfigWatch,
    }));
    const rawBody = JSON.stringify(SAMPLE_UNMOUNT);
    const sig = signForPod(SAMPLE_UNMOUNT.migrationId, rawBody);
    const req = mkRequest(SAMPLE_UNMOUNT, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({ unmounted: false });
    expect(pauseSystemConfigWatch).toHaveBeenCalledWith("chris");
    expect(resumeSystemConfigWatch).not.toHaveBeenCalled();
  });

  it("rejects an unmount that crosses the dedicated watcher tenant boundary", async () => {
    stubUserClaim("alice");
    const removeImportedUserBySlug = vi.fn(async () => ({ wasMounted: false, steps: [] }));
    const adapter = mkAdapter({ removeImportedUserBySlug });
    const handler = createUnmountHandler(mkDeps({ adapter }));
    const rawBody = JSON.stringify(SAMPLE_UNMOUNT);
    const sig = signForPod(SAMPLE_UNMOUNT.migrationId, rawBody);
    const req = mkRequest(SAMPLE_UNMOUNT, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({
      error: "unmount failed",
      message: "system config watcher belongs to alice, not migration user chris",
    });
    expect(removeImportedUserBySlug).not.toHaveBeenCalled();
  });

  it("returns 200 + unmounted:true once the imported user is removed", async () => {
    const removeImportedUserBySlug = vi.fn(async () => ({ wasMounted: true, steps: ["config-patch-remove" as const, "delete-dir" as const] }));
    const onUnmounted = vi.fn();
    const adapter = mkAdapter({ removeImportedUserBySlug, onUnmounted });
    const pauseSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const handler = createUnmountHandler(mkDeps({ adapter, pauseSystemConfigWatch }));
    const rawBody = JSON.stringify(SAMPLE_UNMOUNT);
    const sig = signForPod(SAMPLE_UNMOUNT.migrationId, rawBody);
    const req = mkRequest(SAMPLE_UNMOUNT, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({ unmounted: true });
    expect(removeImportedUserBySlug).toHaveBeenCalledExactlyOnceWith("chris");
    expect(onUnmounted).toHaveBeenCalledWith("chris");
    expect(adapter.uidForSlug).not.toHaveBeenCalled();
    expect(pauseSystemConfigWatch).toHaveBeenCalledWith("chris");
  });

  it("keeps the retired watcher fenced when unmount fails after an ambiguous partial removal", async () => {
    let removalPatchApplied = false;
    const adapter = mkAdapter({
      removeImportedUserBySlug: vi.fn(async () => {
        removalPatchApplied = true;
        throw new Error("response lost after config remove");
      }),
    });
    const pauseSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const resumeSystemConfigWatch = vi.fn(async (_slug: string) => undefined);
    const handler = createUnmountHandler(mkDeps({
      adapter,
      pauseSystemConfigWatch,
      resumeSystemConfigWatch,
    }));
    const rawBody = JSON.stringify(SAMPLE_UNMOUNT);
    const sig = signForPod(SAMPLE_UNMOUNT.migrationId, rawBody);
    const req = mkRequest(SAMPLE_UNMOUNT, { signature: sig });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(removalPatchApplied).toBe(true);
    expect(pauseSystemConfigWatch).toHaveBeenCalledWith("chris");
    expect(resumeSystemConfigWatch).not.toHaveBeenCalled();
  });

  it("returns a structured config hash race for the surge controller's bounded retry", async () => {
    const adapter = mkAdapter({
      removeImportedUserBySlug: vi.fn(async () => {
        throw new OpenclawWireError("hash-mismatch", "config changed");
      }),
    });
    const handler = createUnmountHandler(mkDeps({
      adapter,
      pauseSystemConfigWatch: vi.fn(async () => undefined),
    }));
    const rawBody = JSON.stringify(SAMPLE_UNMOUNT);
    const req = mkRequest(SAMPLE_UNMOUNT, {
      signature: signForPod(SAMPLE_UNMOUNT.migrationId, rawBody),
    });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(getBody()).toEqual({
      error: "unmount failed",
      message: "config changed",
      code: "hash-mismatch",
    });
  });
});

describe("queued-rsync migration control handlers", () => {
  it("unmounts a held user and closes its fenced transfer without a transfer attempt ID", async () => {
    vi.stubEnv("POD_UID", "builder-pod");
    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), "user-unmount-"));
    migrationTempRoots.push(importDir);
    const close = vi.fn(async () => {});
    const removeImportedUserBySlug = vi.fn(async () => {
      expect(close).toHaveBeenCalledOnce();
      return { wasMounted: true, steps: [] };
    });
    const unreserveSurgeTarget: NonNullable<MigrationHandlerDeps["unreserveSurgeTarget"]> = async (_request, cleanup) => {
      await cleanup?.(async () => undefined);
      return HELD_USER_GATE_STATE;
    };
    const deps = mkDeps({
      adapter: mkAdapter({ isIsolatedGateway: () => true, prepareImportDir: async () => importDir, removeImportedUserBySlug }),
      reserveSurgeTarget: async () => undefined, releaseSurgeReadiness: async () => undefined, unreserveSurgeTarget,
      waitForRsyncReady: async () => undefined,
      openMigrationTlsEndpoint: async () => ({ certificatePem: TARGET_CERTIFICATE_PEM, close }),
    });
    const migrationId = "user-unmount-fenced";
    const send = async (handler: ReturnType<typeof createPrepareRsyncImportHandler>, body: object) => {
      const response = mkResponse();
      await handler(mkRequest(body, { signature: signForPod(migrationId, JSON.stringify(body)) }), response.res, vi.fn());
      return response;
    };
    spawnMock.mockReturnValueOnce(mkFakeChild());
    const prepare = { migrationId, slug: "chris", mode: "pre", rpcPhase: "prepare-rsync-import",
      transferAttempt: 1, transferAttemptId: "first", transferUser: "migration", transferKey: "a".repeat(64) };
    expect((await send(createPrepareRsyncImportHandler(deps), prepare)).getStatus()).toBe(200);
    try {
      expect((await send(createUnmountHandler(deps), { migrationId, slug: "chris" })).getBody()).toEqual({
        migrationId, slug: "chris", unmounted: true,
      });
      expect(removeImportedUserBySlug).toHaveBeenCalledOnce();
    } finally {
      await send(createAbortRsyncImportHandler(mkDeps({ adapter: mkAdapter() })), { ...prepare, rpcPhase: "abort-rsync-import" });
    }
  });

  it("serializes abort cleanup with prepare and remembers superseded attempts after cleanup", async () => {
    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), "rsync-abort-fence-"));
    migrationTempRoots.push(importDir);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const close = vi.fn(async () => {}).mockImplementationOnce(() => blocked);
    const deps = mkDeps({ adapter: mkAdapter({ prepareImportDir: vi.fn(async () => importDir) }),
      waitForRsyncReady: vi.fn(async () => {}),
      openMigrationTlsEndpoint: vi.fn(async () => ({ certificatePem: TARGET_CERTIFICATE_PEM, close })),
    });
    const prepare = { migrationId: "abort-cleanup-fence", slug: "chris", mode: "pre", rpcPhase: "prepare-rsync-import",
      transferAttempt: 1, transferAttemptId: "first", transferUser: "migration", transferKey: "a".repeat(64) };
    const send = async (handler: ReturnType<typeof createPrepareRsyncImportHandler>, body: object) => {
      const response = mkResponse();
      await handler(mkRequest(body, { signature: signForPod(prepare.migrationId, JSON.stringify(body)) }), response.res, vi.fn());
      return response;
    };
    spawnMock.mockImplementation(() => mkFakeChild());
    const prepareHandler = createPrepareRsyncImportHandler(deps), abortHandler = createAbortRsyncImportHandler(deps);
    const replacement = { ...prepare, transferAttempt: 2, transferAttemptId: "replacement" };
    expect((await send(prepareHandler, prepare)).getStatus()).toBe(200);
    const abort = send(abortHandler, { ...prepare, rpcPhase: "abort-rsync-import" });
    try {
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect((await send(prepareHandler, replacement)).getStatus()).toBe(409);
      expect(deps.adapter.prepareImportDir).toHaveBeenCalledTimes(1);
      release();
      expect((await abort).getStatus()).toBe(200);
      expect((await send(abortHandler, { ...prepare, rpcPhase: "abort-rsync-import" })).getStatus()).toBe(200);
      expect((await send(prepareHandler, prepare)).getStatus()).toBe(409);
      expect((await send(prepareHandler, replacement)).getStatus()).toBe(200);
      expect((await send(abortHandler, { ...prepare, rpcPhase: "abort-rsync-import" })).getStatus()).toBe(409);
      expect(deps.adapter.prepareImportDir).toHaveBeenCalledTimes(2);
    } finally {
      release(); await abort;
      await send(abortHandler, { ...replacement, rpcPhase: "abort-rsync-import" });
    }
  });

  it.each(["prepare-rsync-import", "finish-rsync-import", "abort-rsync-import"] as const)("rejects a stale %s without touching the replacement transfer session", async rpcPhase => {
    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), "rsync-attempt-fence-"));
    migrationTempRoots.push(importDir);
    const closeTransport = vi.fn(async () => undefined);
    const deps = mkDeps({
      adapter: mkAdapter({ prepareImportDir: vi.fn(async () => importDir) }),
      waitForRsyncReady: vi.fn(async () => undefined),
      openMigrationTlsEndpoint: vi.fn(async () => ({ certificatePem: TARGET_CERTIFICATE_PEM, close: closeTransport })),
    });
    const prepare = { migrationId: `attempt-fence-${rpcPhase}`, slug: "chris", mode: "pre", rpcPhase: "prepare-rsync-import",
      transferAttempt: 2, transferAttemptId: "new-attempt", transferUser: "migration", transferKey: "a".repeat(64) };
    const send = async (handler: ReturnType<typeof createPrepareRsyncImportHandler>, body: object) => {
      const response = mkResponse();
      await handler(mkRequest(body, { signature: signForPod(prepare.migrationId, JSON.stringify(body)) }), response.res, vi.fn());
      return response;
    };
    const daemon = mkFakeChild();
    spawnMock.mockReturnValueOnce(daemon);
    expect((await send(createPrepareRsyncImportHandler(deps), prepare)).getStatus()).toBe(200);
    try {
      for (const transferAttemptId of ["old-attempt", undefined]) {
        const handler = rpcPhase === "prepare-rsync-import" ? createPrepareRsyncImportHandler(deps)
          : rpcPhase === "finish-rsync-import" ? createFinishRsyncImportHandler(deps) : createAbortRsyncImportHandler(deps);
        const response = await send(handler, { ...prepare, rpcPhase, transferAttemptId, transferAttempt: transferAttemptId ? 1 : undefined });
        expect(response.getStatus()).toBe(409);
        expect(response.getBody()).toMatchObject({ error: expect.stringContaining("attempt") });
        expect(daemon.kill).not.toHaveBeenCalled();
      }
    } finally {
      await send(createAbortRsyncImportHandler(deps), { ...prepare, rpcPhase: "abort-rsync-import" });
    }
  });

  it("createExportPathsHandler filters key-only mode down to the user key dir", async () => {
    const adapter = mkAdapter({
      listExportPaths: vi.fn(async () => [
        { cwd: "/state", path: "agents/octogee-chris-coach" },
        { cwd: "/state", path: "agents/discord-helper" },
        { cwd: "/state", path: "memory/discord-helper.sqlite" },
        { cwd: "/openclaw", path: "customers/chris" },
        { cwd: "/openclaw", path: "customer-keys/chris" },
      ]),
    });
    const body: ExportPathsRequestBody = {
      migrationId: "mig-1",
      slug: "chris",
      mode: "keys",
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createExportPathsHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({
      migrationId: "mig-1",
      slug: "chris",
      sources: [{ cwd: "/openclaw", path: "customer-keys/chris" }],
    });
  });

  it.each(["pre", "final"] as const)(
    "createExportPathsHandler keeps pod-local user keys out of %s surge state",
    async (mode) => {
      const adapter = mkAdapter({
        listExportPaths: vi.fn(async () => [
          { cwd: "/state", path: "agents/octogee-chris-coach" },
          { cwd: "/openclaw", path: "customers/chris" },
          { cwd: "/openclaw", path: "customer-keys/chris" },
        ]),
      });
      const body: ExportPathsRequestBody = {
        migrationId: "mig-1",
        slug: "chris",
        mode,
      };
      const rawBody = JSON.stringify(body);
      const sig = signForPod(body.migrationId, rawBody);
      const handler = createExportPathsHandler(mkDeps({ adapter }));
      const req = mkRequest(body, { signature: sig });
      const { res, getStatus, getBody } = mkResponse();

      await handler(req, res, vi.fn());

      expect(getStatus()).toBe(200);
      expect(getBody()).toEqual({
        migrationId: "mig-1",
        slug: "chris",
        sources: [
          { cwd: "/state", path: "agents/octogee-chris-coach" },
          { cwd: "/openclaw", path: "customers/chris" },
        ],
      });
    },
  );

  it("createExportPathsHandler rejects a missing/invalid transfer mode", async () => {
    const adapter = mkAdapter({
      listExportPaths: vi.fn(async () => [
        { cwd: "/state", path: "agents/octogee-chris-coach" },
      ]),
    });
    const body = {
      migrationId: "mig-1",
      slug: "chris",
      mode: "bogus",
    } as unknown as ExportPathsRequestBody;
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createExportPathsHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: "invalid migration mode" });
    expect(adapter.listExportPaths).not.toHaveBeenCalled();
  });

  it("createPrepareImportHandler uses the key-only import prep without stamping migrating-in", async () => {
    const markUserMigratingIn = vi.fn();
    const adapter = mkAdapter({
      prepareKeyImportDir: vi.fn(async () => "/openclaw"),
      prepareImportDir: vi.fn(async () => "/openclaw"),
      markUserMigratingIn,
    });
    const body: PrepareImportRequestBody = {
      migrationId: "mig-1",
      slug: "chris",
      mode: "keys",
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createPrepareImportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(adapter.prepareKeyImportDir).toHaveBeenCalledWith("chris");
    expect(adapter.prepareImportDir).not.toHaveBeenCalled();
    expect(markUserMigratingIn).not.toHaveBeenCalled();
    expect(getBody()).toMatchObject({ migrationId: "mig-1", slug: "chris", imported: true });
  });

  it("createPrepareImportHandler rejects a missing/invalid transfer mode before wiping state", async () => {
    const adapter = mkAdapter({
      prepareKeyImportDir: vi.fn(async () => "/openclaw"),
      prepareImportDir: vi.fn(async () => "/openclaw"),
    });
    const body = {
      migrationId: "mig-1",
      slug: "chris",
    } as unknown as PrepareImportRequestBody;
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createPrepareImportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: "invalid migration mode" });
    expect(adapter.prepareKeyImportDir).not.toHaveBeenCalled();
    expect(adapter.prepareImportDir).not.toHaveBeenCalled();
  });

  it("createPrepareImportHandler wipes normal import paths and stamps the migrating-in pin", async () => {
    const markUserMigratingIn = vi.fn();
    const adapter = mkAdapter({
      prepareImportDir: vi.fn(async () => "/openclaw"),
      markUserMigratingIn,
    });
    const body: PrepareImportRequestBody = {
      migrationId: "mig-1",
      slug: "chris",
      mode: "pre",
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createPrepareImportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(adapter.prepareImportDir).toHaveBeenCalledWith("chris", "pre");
    expect(markUserMigratingIn).toHaveBeenCalledWith("chris");
  });

  it("createActivationManifestExportHandler returns the source manifest as signed JSON", async () => {
    const manifest = {
      version: 2,
      slug: "chris",
      appliedFingerprint: "fp-chris",
      agentId: "octogee-chris-coach",
      accountId: "chris-coach",
      agent: { id: "octogee-chris-coach" },
      mattermostAccount: { botToken: "token" },
      bindings: [{ agentId: "octogee-chris-coach" }],
    };
    const adapter = mkAdapter({
      exportOpenClawActivationManifest: vi.fn(async () => manifest),
    });
    const body: ActivationManifestExportRequestBody = {
      migrationId: "mig-1",
      slug: "chris",
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createActivationManifestExportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({ migrationId: "mig-1", slug: "chris", manifest });
  });

  it("attests a held import only with a scoped signature, canonical denial and no active destination owner", async () => {
    const body = { migrationId: "mig-1", slug: "chris", nonce: "1".repeat(32) };
    const signature = signForPod(body.migrationId, JSON.stringify(body));
    const call = async (readTargetImportPermit: MigrationHandlerDeps["readTargetImportPermit"], mountedUsers: string[], sig = signature) => {
      const fixture = mkResponse();
      const handler = createTargetImportHoldWitnessHandler(mkDeps({ readTargetImportPermit, getMountedUsers: () => mountedUsers }));
      await handler(mkRequest(body, { signature: sig }), fixture.res);
      return { status: fixture.getStatus(), body: fixture.getBody() };
    };
    const permit = vi.fn(async () => "held" as const);
    expect((await call(permit, [], "invalid")).status).toBe(401);
    expect(permit).not.toHaveBeenCalled();
    expect((await call(undefined, [])).status).toBe(409);
    expect((await call(async () => "permitted", [])).status).toBe(409);
    expect((await call(permit, ["chris"])).status).toBe(409);
    expect(await call(permit, ["unrelated"])).toEqual({ status: 200, body: { ...body, held: true } });
  });

  it.each([true, false])("source activation readiness returns only the scoped exportable acknowledgement (%s)", async exportable => {
    const exportOpenClawActivationManifest = vi.fn(async () => {
      if (!exportable) throw new Error("unexpected secret-shaped failure");
      return {
        version: 2, slug: "chris", appliedFingerprint: "applied", agentId: "octogee-chris-coach",
        accountId: "chris-coach", agent: {}, mattermostAccount: { botToken: "token" }, bindings: [],
      };
    });
    const adapter = mkAdapter({ exportOpenClawActivationManifest });
    const log = vi.fn();
    const body = { migrationId: "mig-1", slug: "chris" };
    const signature = signFleetRequest(PRIVATE_KEY, sourceActivationReadinessJobId("mig-1", GATEWAY_ID), JSON.stringify(body));
    const { res, getStatus, getBody } = mkResponse();

    await createSourceActivationReadinessHandler(mkDeps({ adapter, log }))(mkRequest(body, { signature }), res, vi.fn());

    expect(exportOpenClawActivationManifest).toHaveBeenCalledExactlyOnceWith("chris");
    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({ ...body, exportable });
    expect(log).not.toHaveBeenCalled();
  });

  it("prevents legacy manifest access with a readiness request signature", async () => {
    const exportOpenClawActivationManifest = vi.fn();
    const adapter = mkAdapter({ exportOpenClawActivationManifest });
    const body = { migrationId: "mig-1", slug: "chris" };
    const raw = JSON.stringify(body);
    const readiness = mkRequest(body, { signature: signFleetRequest(PRIVATE_KEY, sourceActivationReadinessJobId("mig-1", GATEWAY_ID), raw) });
    const legacy = mkRequest(body, { signature: signForPod("mig-1", raw) });
    const probes = [
      [createActivationManifestExportHandler, readiness],
      [createSourceActivationReadinessHandler, legacy],
    ] as const;

    for (const [handler, request] of probes) {
      const { res, getStatus } = mkResponse();
      await handler(mkDeps({ adapter }))(request, res, vi.fn());
      expect(getStatus()).toBe(401);
    }
    expect(exportOpenClawActivationManifest).not.toHaveBeenCalled();
  });

  it("createActivateImportHandler records a completed standard activation", async () => {
    const markUserMigratingIn = vi.fn();
    const onMounted = vi.fn();
    const recordAppliedFingerprint = vi.fn();
    const registerKey = vi.fn(async () => undefined);
    let pendingProjects = [{ projectSlug: "camp", giteaRepoName: "chris-camp" }];
    const cloneProjectRepo = vi.fn(async () => {
      pendingProjects = [];
      return true;
    });
    const adapter = mkAdapter({
      markUserMigratingIn,
      readLocalUserPubKey: vi.fn(() => "ssh-ed25519 TARGET chris@gateway"),
      gitHost: mkGitHost({ registerKey }),
      activateImportedUser: vi.fn(async () => ({ appliedFingerprint: "fp-chris" })),
      listProjectsNeedingClone: vi.fn(async () => pendingProjects),
      cloneProjectRepo,
      recordAppliedFingerprint,
      onMounted,
    });
    const body: ActivateImportRequestBody = {
      migrationId: "mig-1",
      slug: "chris",
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createActivateImportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(markUserMigratingIn).toHaveBeenCalledWith("chris");
    expect(registerKey).toHaveBeenCalledWith(
      "chris",
      "ssh-ed25519 TARGET chris@gateway",
    );
    expect(adapter.activateImportedUser).toHaveBeenCalledWith("chris", expect.objectContaining({ migrationId: body.migrationId }));
    expect(registerKey.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(adapter.activateImportedUser).mock.invocationCallOrder[0],
    );
    expect(cloneProjectRepo).toHaveBeenCalledWith(
      "chris",
      "camp",
      "chris-camp",
      undefined,
    );
    expect(cloneProjectRepo.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(adapter.activateImportedUser).mock.invocationCallOrder[0],
    );
    expect(recordAppliedFingerprint).toHaveBeenCalledWith("chris", "fp-chris");
    expect(onMounted).toHaveBeenCalledWith("chris");
    expect(getBody()).toMatchObject({ migrationId: "mig-1", slug: "chris", imported: true });
  });

  it("refuses a direct Shared activation without retained original identities before Native or key effects", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "direct-shared-target-")); migrationTempRoots.push(root); vi.stubEnv("OPENCLAW_STATE_DIR", root); vi.stubEnv("POD_UID", "target-pod");
    const adapter = mkAdapter({ isIsolatedGateway: () => false, targetMigrationIdentityCustody: async () => ({
      custody: { uid: "uid-chris", gatewayId: GATEWAY_ID, podUid: "target-pod", migrationId: "mig-direct-missing" },
      migration: { migrationId: "mig-direct-missing", claimStartedAt: 123, sourceGatewayId: "user-source", sourceEpoch: 4 },
    }) });
    const body = { migrationId: "mig-direct-missing", slug: "chris" };
    const response = mkResponse();
    await createActivateImportHandler(mkDeps({ adapter }))(mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn());
    expect(response.getStatus()).toBe(500);
    expect(adapter.activateImportedUser).not.toHaveBeenCalled();
    expect(adapter.gitHost.registerKey).not.toHaveBeenCalled();
  });

  it("does not activate a standard migration while a project checkout is still missing", async () => {
    const adapter = mkAdapter({
      listProjectsNeedingClone: vi.fn(async () => [
        { projectSlug: "camp", giteaRepoName: "chris-camp" },
      ]),
      cloneProjectRepo: vi.fn(async () => false),
    });
    const body: ActivateImportRequestBody = {
      migrationId: "mig-project-pending",
      slug: "chris",
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createActivateImportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({
      error: "activate-import failed",
      message: expect.stringContaining("project checkout hydration incomplete"),
    });
    expect(adapter.activateImportedUser).not.toHaveBeenCalled();
  });

  it("activates a standard migration when the only missing checkout is a GitHub project that hydrates on the owner's isolated runtime", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "direct-shared-github-")); migrationTempRoots.push(root); vi.stubEnv("OPENCLAW_STATE_DIR", root); vi.stubEnv("POD_UID", "shared-target-pod");
    await writeSharedTargetManifest(root, root, "mig-github-deferred");
    const cloneProjectRepo = vi.fn(async () => false);
    const adapter = mkAdapter({
      isIsolatedGateway: vi.fn(() => false),
      isConfiguredUser: vi.fn(() => false),
      listProjectsNeedingClone: vi.fn(async () => [
        { projectSlug: "octogee", giteaRepoName: null, repoSource: { provider: "github", owner: "octogee-ai", repo: "octogee" } },
      ]),
      cloneProjectRepo,
      activateImportedUser: vi.fn(async () => ({ appliedFingerprint: "fp-chris" })),
    });
    const body: ActivateImportRequestBody = {
      migrationId: "mig-github-deferred",
      slug: "chris",
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createActivateImportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(cloneProjectRepo).not.toHaveBeenCalled();
    expect(adapter.activateImportedUser).toHaveBeenCalledWith("chris", expect.objectContaining({ migrationId: body.migrationId }));
    expect(getBody()).toMatchObject({ migrationId: "mig-github-deferred", slug: "chris", imported: true });
  });

  it.each([
    ["fp-chris", pendingCloneAppliedFingerprint("fp-chris")],
    ["0123456789abcdef!import-reconcile-pending", "0123456789abcdef!import-reconcile-pending"],
  ])("preserves deferred reconciliation after standard import of %s", async (appliedFingerprint, expectedReceipt) => {
    const cloneProjectRepo = vi.fn(async () => false);
    const recordAppliedFingerprint = vi.fn();
    const adapter = mkAdapter({
      isIsolatedGateway: vi.fn(() => true),
      isConfiguredUser: vi.fn(() => true),
      listProjectsNeedingClone: vi.fn(async () => [
        { projectSlug: "octogee", giteaRepoName: null, repoSource: { provider: "github", owner: "octogee-ai", repo: "octogee" } },
      ]),
      cloneProjectRepo,
      activateImportedUser: vi.fn(async () => ({ appliedFingerprint })),
      recordAppliedFingerprint,
    });
    const body: ActivateImportRequestBody = {
      migrationId: "mig-github-owner-runtime",
      slug: "chris",
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createActivateImportHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(cloneProjectRepo).not.toHaveBeenCalled();
    expect(adapter.activateImportedUser).toHaveBeenCalledWith("chris", expect.objectContaining({ migrationId: body.migrationId }));
    expect(recordAppliedFingerprint).toHaveBeenCalledWith("chris", expectedReceipt);
    expect(getBody()).toMatchObject({ migrationId: "mig-github-owner-runtime", slug: "chris", imported: true });
  });

  it("createPrepareRsyncImportHandler opens a one-time target rsync import session", async () => {
    const adapter = mkAdapter({
      prepareImportDir: vi.fn(async () => "/openclaw"),
      markUserMigratingIn: vi.fn(),
    });
    const waitForRsyncReady = vi.fn(async () => undefined);
    const closeTransport = vi.fn(async () => undefined);
    const openMigrationTlsEndpoint = vi.fn(async () => ({
      certificatePem: TARGET_CERTIFICATE_PEM,
      close: closeTransport,
    }));
    const daemon = mkFakeChild();
    spawnMock.mockReturnValueOnce(daemon);
    const body: PrepareRsyncImportRequestBody = {
      migrationId: "mig-rsync",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "pre",
      transferUser: "migration",
      transferKey: "a".repeat(64),
      sourcePodIp: SOURCE_POD_IP,
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createPrepareRsyncImportHandler(
      mkDeps({ adapter, migrationRsyncPort: 30873, waitForRsyncReady, openMigrationTlsEndpoint }),
    );
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({
      migrationId: "mig-rsync",
      slug: "chris",
      imported: true,
      port: 30873,
      module: "state",
      certificatePem: TARGET_CERTIFICATE_PEM,
    });
    expect(adapter.prepareImportDir).toHaveBeenCalledWith("chris", "pre");
    expect(adapter.markUserMigratingIn).toHaveBeenCalledWith("chris");
    expect(waitForRsyncReady).toHaveBeenCalledWith(RSYNC_DAEMON_LOOPBACK_PORT);
    expect(openMigrationTlsEndpoint).toHaveBeenCalledWith(expect.objectContaining({
      publicPort: 30873,
      upstreamPort: RSYNC_DAEMON_LOOPBACK_PORT,
      sourceIp: SOURCE_POD_IP,
    }));
    expect(String(spawnMock.mock.calls[0][0])).toMatch(/\/rsync$/);
    const spawnArgs = spawnMock.mock.calls[0][1] as string[];
    expect(spawnArgs).toEqual(
      expect.arrayContaining(["--daemon", "--no-detach", `--port=${RSYNC_DAEMON_LOOPBACK_PORT}`]),
    );
    const configArg = spawnArgs.find((arg) => arg.startsWith("--config="));
    expect(configArg).toBeDefined();
    const configPath = configArg?.slice("--config=".length) ?? "";
    const config = await fs.readFile(configPath, "utf-8");
    expect(config).toContain(`pid file = ${configPath.replace(/rsyncd\.conf$/, "rsyncd.pid")}`);
    expect(config).toContain(`lock file = ${configPath.replace(/rsyncd\.conf$/, "rsyncd.lock")}`);
    expect(config).toContain("address = 127.0.0.1");
    expect(config).toContain("  hosts allow = 127.0.0.1");
    expect(config).not.toContain(SOURCE_POD_IP);

    const abortHandler = createAbortRsyncImportHandler(mkDeps({ adapter }));
    const replayedPrepare = mkResponse();
    await abortHandler(
      mkRequest(body, { signature: sig }),
      replayedPrepare.res,
      vi.fn(),
    );
    expect(replayedPrepare.getStatus()).toBe(400);
    expect(replayedPrepare.getBody()).toEqual({ error: "invalid rsync RPC phase" });
    expect(daemon.kill).not.toHaveBeenCalled();

    const abortBody: AbortRsyncImportRequestBody = {
      migrationId: "mig-rsync",
      slug: "chris",
      rpcPhase: "abort-rsync-import",
      mode: "pre",
    };
    const abortRaw = JSON.stringify(abortBody);
    const abortSig = signForPod(abortBody.migrationId, abortRaw);
    const abortReq = mkRequest(abortBody, { signature: abortSig });
    const abortRes = mkResponse();
    await abortHandler(abortReq, abortRes.res, vi.fn());
    expect(daemon.kill).toHaveBeenCalled();
    expect(closeTransport).toHaveBeenCalled();
  });

  it("releases the import port when the rsync daemon exits on its own, so the next migration can prepare", async () => {
    const port = await reserveLoopbackPort();
    const openMigrationTlsEndpoint = vi.fn(async ({ publicPort }: { publicPort: number }) => {
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(publicPort, () => resolve());
      });
      return {
        certificatePem: TARGET_CERTIFICATE_PEM,
        close: () => new Promise<void>((done) => server.close(() => done())),
      };
    });
    const log = vi.fn();
    const adapter = mkAdapter({ prepareImportDir: vi.fn(async () => "/openclaw"), markUserMigratingIn: vi.fn() });
    const deps = mkDeps({ adapter, log, migrationRsyncPort: port, waitForRsyncReady: async () => undefined, openMigrationTlsEndpoint });
    const prepare = async (migrationId: string) => {
      const body: PrepareRsyncImportRequestBody = {
        migrationId,
        slug: "chris",
        rpcPhase: "prepare-rsync-import",
        mode: "pre",
        transferUser: "migration",
        transferKey: "a".repeat(64),
        sourcePodIp: SOURCE_POD_IP,
      };
      const response = mkResponse();
      await createPrepareRsyncImportHandler(deps)(
        mkRequest(body, { signature: signForPod(migrationId, JSON.stringify(body)) }), response.res, vi.fn());
      return { status: response.getStatus(), body: response.getBody() };
    };
    const firstDaemon = mkFakeChild();
    spawnMock.mockReturnValueOnce(firstDaemon);
    expect(await prepare("mig-daemon-lost")).toMatchObject({ status: 200 });

    firstDaemon.signalCode = "SIGKILL";
    firstDaemon.emit("exit", null, "SIGKILL");

    spawnMock.mockReturnValueOnce(mkFakeChild());
    const next = await prepare("mig-after-daemon-lost");

    expect(next).toMatchObject({ status: 200, body: { port } });
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/rsync daemon exited before its import finished .*migrationId=mig-daemon-lost/),
      { status: "failed" },
    );
    const abortBody: AbortRsyncImportRequestBody = {
      migrationId: "mig-after-daemon-lost", slug: "chris", rpcPhase: "abort-rsync-import", mode: "pre",
    };
    const abortResponse = mkResponse();
    await createAbortRsyncImportHandler(deps)(
      mkRequest(abortBody, { signature: signForPod(abortBody.migrationId, JSON.stringify(abortBody)) }), abortResponse.res, vi.fn());
    expect(abortResponse.getStatus()).toBe(200);
  });

  it("reserves the surge target only for a configured user final import, before opening its session, and fails closed", async () => {
    stubUserClaim("chris");
    const adapter = mkAdapter({
      isIsolatedGateway: vi.fn(() => true),
      prepareKeyImportDir: vi.fn(async () => "/openclaw-keys"),
      prepareImportDir: vi.fn(async () => "/openclaw"),
      markUserMigratingIn: vi.fn(),
    });
    const reserveSurgeTarget = vi.fn(async () => undefined);
    const waitForRsyncReady = vi.fn(async () => undefined);
    spawnMock.mockReturnValue(mkFakeChild());
    const handler = createPrepareRsyncImportHandler(
      mkDeps({ adapter, migrationRsyncPort: 30873, waitForRsyncReady, reserveSurgeTarget }),
    );
    const prepare = async (body: PrepareRsyncImportRequestBody) => {
      const response = mkResponse();
      await handler(
        mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }),
        response.res,
        vi.fn(),
      );
      return response;
    };
    const surge: PrepareRsyncImportRequestBody = {
      migrationId: "surge-gw-a-target",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
      transferUser: "migration",
      transferKey: "a".repeat(64),
    };
    const activationKeys: PrepareRsyncImportRequestBody = {
      migrationId: "surge-gw-a-target",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "keys",
      transferUser: "migration",
      transferKey: "a".repeat(64),
    };

    expect((await prepare(surge)).getStatus()).toBe(200);
    expect(reserveSurgeTarget).toHaveBeenCalledWith({
      migrationId: "surge-gw-a-target",
      slug: "chris",
    });

    expect((await prepare(activationKeys)).getStatus()).toBe(200);
    expect(reserveSurgeTarget).toHaveBeenCalledTimes(1);

    reserveSurgeTarget.mockRejectedValueOnce(new Error("cannot hydrate a permitted surge OpenClaw process gate"));
    expect((await prepare(surge)).getStatus()).toBe(500);
    expect(adapter.prepareImportDir).toHaveBeenCalledTimes(1);

    const abort: AbortRsyncImportRequestBody = {
      migrationId: "surge-gw-a-target",
      slug: "chris",
      rpcPhase: "abort-rsync-import",
      mode: "keys",
    };
    await createAbortRsyncImportHandler(mkDeps({ adapter }))(
      mkRequest(abort, { signature: signForPod(abort.migrationId, JSON.stringify(abort)) }),
      mkResponse().res,
      vi.fn(),
    );
  });

  it("reclaims an interrupted rsync session only for its owning migration", async () => {
    const adapter = mkAdapter({
      prepareImportDir: vi.fn(async () => "/openclaw"),
      markUserMigratingIn: vi.fn(),
    });
    const waitForRsyncReady = vi.fn(async () => undefined);
    const interruptedDaemon = mkFakeChild();
    const resumedDaemon = mkFakeChild();
    spawnMock
      .mockReturnValueOnce(interruptedDaemon)
      .mockReturnValueOnce(resumedDaemon);
    const handler = createPrepareRsyncImportHandler(
      mkDeps({ adapter, migrationRsyncPort: 30873, waitForRsyncReady }),
    );
    const interrupted: PrepareRsyncImportRequestBody = {
      migrationId: "surge-default-b-target",
      slug: "smoke-dave-smoke",
      rpcPhase: "prepare-rsync-import",
      mode: "pre",
      transferUser: "migration",
      transferKey: "a".repeat(64),
    };
    const interruptedRaw = JSON.stringify(interrupted);
    const interruptedResponse = mkResponse();
    try {
      await handler(
        mkRequest(interrupted, {
          signature: signForPod(interrupted.migrationId, interruptedRaw),
        }),
        interruptedResponse.res,
        vi.fn(),
      );
      expect(interruptedResponse.getStatus()).toBe(200);

      const resumed: PrepareRsyncImportRequestBody = {
        ...interrupted,
        slug: "smoke-erica-smoke",
        mode: "final",
        transferKey: "b".repeat(64),
      };
      const resumedRaw = JSON.stringify(resumed);
      const resumedResponse = mkResponse();
      await handler(
        mkRequest(resumed, {
          signature: signForPod(resumed.migrationId, resumedRaw),
        }),
        resumedResponse.res,
        vi.fn(),
      );
      expect(resumedResponse.getStatus()).toBe(200);
      expect(interruptedDaemon.kill).toHaveBeenCalledWith("SIGTERM");

      const otherMigration: PrepareRsyncImportRequestBody = {
        ...resumed,
        migrationId: "surge-default-b-other-target",
        transferKey: "c".repeat(64),
      };
      const otherRaw = JSON.stringify(otherMigration);
      const otherResponse = mkResponse();
      await handler(
        mkRequest(otherMigration, {
          signature: signForPod(otherMigration.migrationId, otherRaw),
        }),
        otherResponse.res,
        vi.fn(),
      );
      expect(otherResponse.getStatus()).toBe(500);
      expect(otherResponse.getBody()).toMatchObject({
        error: "prepare-rsync-import failed",
        message: expect.stringContaining("surge-default-b-target"),
      });
      expect(resumedDaemon.kill).not.toHaveBeenCalled();
    } finally {
      for (const daemon of [interruptedDaemon, resumedDaemon]) {
        if (daemon.exitCode !== null || daemon.signalCode !== null) continue;
        daemon.exitCode = 0;
        daemon.emit("exit", 0, null);
      }
    }
  });

  describe("push migration export deadline", () => {
    const manifest = {
      version: 2 as const, slug: "chris", appliedFingerprint: "fp-chris",
      agentId: "octogee-chris-coach", accountId: "chris-coach",
      agent: { id: "octogee-chris-coach", workspace: path.join(process.env.OPENCLAW_STATE_DIR || OPENCLAW_DIR, "customers", "chris") }, projectAgents: [], mattermostAccount: { botToken: "default-agent-pat" }, bindings: [],
    };
    const sources = [{ cwd: "/state", path: "agents/octogee-chris-coach" }];
    function push(adapter: UserLifecycleAdapter, timeoutMs = 330_000) {
      const body: PushRsyncStateRequestBody = {
        migrationId: "mig-export-deadline", slug: "chris", rpcPhase: "push-rsync-state", mode: "pre",
        targetHost: TARGET_POD_IP, targetPort: 30873, targetCertificatePem: TARGET_CERTIFICATE_PEM,
        transferUser: "migration", transferKey: "b".repeat(64), includeActivationManifest: true,
      };
      const response = mkResponse();
      const handler = createPushRsyncStateHandler(mkDeps({ adapter, pushStateTimeoutMs: timeoutMs }));
      return { ...response, work: handler(mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn()) };
    }

    it("shares one budget across preparation, manifest waiting and rsync", async () => {
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const timers = vi.spyOn(globalThis, "setTimeout");
      const exportManifest = vi.fn(async (_slug, options) => {
        expect(options.timeoutMs).toBe(310_000);
        expect(options.signal.aborted).toBe(false);
        expect(options.convergeSource).toBe(true);
        now += 115_000;
        return manifest;
      });
      try {
        spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
        const result = push(mkAdapter({
          listExportPaths: vi.fn(async () => { now += 20_000; return sources; }),
          exportOpenClawActivationManifest: exportManifest,
        }));
        await result.work;
        expect(result.getStatus()).toBe(200);
        expect(timers.mock.calls.some((call) => call[1] === 195_000)).toBe(true);
        expect(result.res.listenerCount("close")).toBe(0);
      } finally { clock.mockRestore(); timers.mockRestore(); }
    });

    it("refuses manifest or rsync work when preparation consumed the deadline", async () => {
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const exportManifest = vi.fn(async () => manifest);
      try {
        const result = push(mkAdapter({
          listExportPaths: vi.fn(async () => { now += 330_000; return sources; }),
          exportOpenClawActivationManifest: exportManifest,
        }));
        await result.work;
        expect(result.getStatus()).toBe(500);
        expect(result.getBody()).toMatchObject({ message: expect.stringContaining("exhausted its transfer deadline") });
        expect(exportManifest).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();
      } finally { clock.mockRestore(); }
    });

    it("cancels queued manifest export on disconnect without releasing its competing writer", async () => {
      const guard = new OpenClawRuntimeUpdateGuard();
      let release!: () => void;
      const held = guard.tryRun(() => new Promise<void>((resolve) => { release = resolve; }))!;
      await Promise.resolve();
      const readManifest = vi.fn(async () => manifest);
      const exportManifest = vi.fn((_slug, options) => guard.run(readManifest, options));
      const result = push(mkAdapter({ listExportPaths: vi.fn(async () => sources), exportOpenClawActivationManifest: exportManifest }));
      try {
        await vi.waitFor(() => expect(exportManifest).toHaveBeenCalledOnce());
        result.res.emit("close");
        await result.work;
        expect(result.getStatus()).toBe(500);
        expect(result.getBody()).toMatchObject({ message: "client disconnected mid-export" });
        expect(guard.tryRun(async () => undefined)).toBeUndefined();
      } finally { release(); await held; }
      expect(readManifest).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(result.res.listenerCount("close")).toBe(0);
    });

    it.each(["AbortError", "disconnect", "deadline"])("retains transfer staging and response custody until child close after %s", async (reason) => {
      const child = Object.assign(mkFakeChild({ holdExit: true }), { pid: 4242 });
      const timers = vi.spyOn(globalThis, "setTimeout");
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      spawnMock.mockReturnValueOnce(child);
      const result = push(mkAdapter({ listExportPaths: vi.fn(async () => sources), exportOpenClawActivationManifest: vi.fn(async () => manifest) }), 330_000);
      let stageDir: string | undefined;
      try {
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
        const args = spawnMock.mock.calls[0][1] as string[];
        stageDir = path.dirname(args[args.indexOf("--password-file") + 1]!);
        expect(fsSync.existsSync(stageDir)).toBe(true);
        if (reason === "AbortError") child.emit("error", Object.assign(new Error("child aborted before close"), { name: "AbortError", code: "ABORT_ERR" }));
        else if (reason === "disconnect") result.res.emit("close");
        else {
          const transferDeadline = timers.mock.calls.find((call) => call[1] === 330_000)![0] as () => void;
          transferDeadline();
        }
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        expect(result.getStatus()).toBeUndefined();
        expect(fsSync.existsSync(stageDir)).toBe(true);
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        const escalation = timers.mock.calls.find((call) => call[1] === 5_000)![0] as () => void;
        escalation();
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
        child.emit("exit", null, "SIGKILL");
        await Promise.resolve();
        expect(result.getStatus()).toBeUndefined();
        expect(fsSync.existsSync(stageDir)).toBe(true);
      } finally {
        child.emit("close", null, "SIGKILL");
        await result.work;
        timers.mockRestore();
        clock.mockRestore();
      }
      expect(result.getStatus()).toBe(500);
      expect(fsSync.existsSync(stageDir!)).toBe(false);
      expect(result.res.listenerCount("close")).toBe(0);
    });

    it("reports a spawn failure without waiting for a nonexistent process to close", async () => {
      const child = mkFakeChild({ holdExit: true });
      spawnMock.mockReturnValueOnce(child);
      const result = push(mkAdapter({ listExportPaths: vi.fn(async () => sources), exportOpenClawActivationManifest: vi.fn(async () => manifest) }));
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
      const args = spawnMock.mock.calls[0][1] as string[];
      const stageDir = path.dirname(args[args.indexOf("--password-file") + 1]!);
      child.emit("error", Object.assign(new Error("spawn rsync ENOENT"), { code: "ENOENT" }));
      await result.work;
      expect(result.getStatus()).toBe(500);
      expect(result.getBody()).toMatchObject({ message: "spawn rsync ENOENT" });
      expect(fsSync.existsSync(stageDir)).toBe(false);
      expect(child.kill).not.toHaveBeenCalled();
    });

    it("waits for a real SIGTERM-resistant child to close before cleaning transfer staging", async () => {
      const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      let child!: ReturnType<typeof spawn>;
      let ready!: () => void;
      const readiness = new Promise<void>((resolve) => { ready = resolve; });
      let closed!: () => void;
      const closure = new Promise<void>((resolve) => { closed = resolve; });
      spawnMock.mockImplementationOnce((_command, _args, options) => {
        child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),10000);"], options);
        child.stdout!.once("data", ready);
        child.once("close", closed);
        return child;
      });
      const result = push(mkAdapter({ listExportPaths: vi.fn(async () => sources), exportOpenClawActivationManifest: vi.fn(async () => manifest) }));
      let stageDir: string | undefined;
      try {
        await readiness;
        const args = spawnMock.mock.calls[0][1] as string[];
        stageDir = path.dirname(args[args.indexOf("--password-file") + 1]!);
        result.res.emit("close");
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        expect(result.getStatus()).toBeUndefined();
        expect(fsSync.existsSync(stageDir)).toBe(true);
        await result.work;
        await closure;
        expect(child.signalCode).toBe("SIGKILL");
        expect(result.getStatus()).toBe(500);
        expect(fsSync.existsSync(stageDir)).toBe(false);
      } finally {
        child?.kill("SIGKILL");
        await closure;
        await result.work;
      }
    });
  });

  describe("push pre-copy against a permanently refused source mount", () => {
    const refusalReason = "config.patch would remove entries from array path(s): agents.entries.octogee-unmatched-route.tools.deny";
    const manifest = {
      version: 2 as const, slug: "livefixture", appliedFingerprint: "fp-livefixture",
      agentId: "octogee-livefixture-coach", accountId: "livefixture-coach",
      agent: { id: "octogee-livefixture-coach", workspace: path.join(process.env.OPENCLAW_STATE_DIR || OPENCLAW_DIR, "customers", "livefixture") },
      projectAgents: [], mattermostAccount: { botToken: "default-agent-pat" }, bindings: [],
    };
    const sources = [{ cwd: "/state", path: "agents/octogee-livefixture-coach" }];
    function push(deps: Partial<MigrationHandlerDeps>, mode: "pre" | "final" = "pre") {
      const body: PushRsyncStateRequestBody = {
        migrationId: "mig-refused-source", slug: "livefixture", rpcPhase: "push-rsync-state", mode,
        targetHost: TARGET_POD_IP, targetPort: 30873, targetCertificatePem: TARGET_CERTIFICATE_PEM,
        transferUser: "migration", transferKey: "b".repeat(64), includeActivationManifest: true,
      };
      const response = mkResponse();
      const handler = createPushRsyncStateHandler(mkDeps(deps));
      return { ...response, work: handler(mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn()) };
    }

    it("refuses the pre-copy at once when the source has no converged configuration for the user", async () => {
      const listExportPaths = vi.fn(async () => sources);
      const exportManifest = vi.fn(async () => manifest);
      const log = vi.fn();
      const result = push({
        adapter: mkAdapter({ listExportPaths, exportOpenClawActivationManifest: exportManifest }),
        log,
        sourceMountRefusal: vi.fn(() => ({ reason: refusalReason, converged: false })),
      });
      await result.work;
      expect(result.getStatus()).toBe(409);
      expect(result.getBody()).toEqual({
        error: "source mount refused",
        message: expect.stringContaining("source has no converged configuration for livefixture"),
      });
      expect((result.getBody() as { message: string }).message).toContain(refusalReason);
      expect(exportManifest).not.toHaveBeenCalled();
      expect(listExportPaths).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("source has no converged configuration for livefixture"), { status: "failed" });
    });

    it("exports the converged configuration without waiting when the source refuses only the pending one", async () => {
      const exportManifest = vi.fn(async () => manifest);
      spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
      const result = push({
        adapter: mkAdapter({ listExportPaths: vi.fn(async () => sources), exportOpenClawActivationManifest: exportManifest }),
        sourceMountRefusal: () => ({ reason: refusalReason, converged: true }),
      });
      await result.work;
      expect(result.getStatus()).toBe(200);
      expect(exportManifest).toHaveBeenCalledWith("livefixture", expect.objectContaining({ convergeSource: false }));
      expect(spawnMock).toHaveBeenCalledOnce();
    });

    it("consults the source mount only for the pre-copy", async () => {
      const sourceMountRefusal = vi.fn(() => ({ reason: refusalReason, converged: false }));
      spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
      const result = push({
        adapter: mkAdapter({ listExportPaths: vi.fn(async () => sources), exportOpenClawActivationManifest: vi.fn(async () => manifest) }),
        sourceMountRefusal,
      }, "final");
      await result.work;
      expect(result.getStatus()).toBe(200);
      expect(sourceMountRefusal).not.toHaveBeenCalled();
    });
  });

  it("createPushRsyncStateHandler runs rsync directly to the target pod with the one-time key", async () => {
    const adapter = mkAdapter({
      listExportPaths: vi.fn(async () => [
        { cwd: "/state", path: "agents/octogee-chris-coach" },
        { cwd: "/openclaw", path: "customers/chris" },
        { cwd: "/openclaw", path: "customer-keys/chris" },
      ]),
      exportOpenClawActivationManifest: vi.fn(async () => ({
        version: 2,
        slug: "chris",
        appliedFingerprint: "fp-chris",
        agentId: "octogee-chris-coach",
        accountId: "chris-coach",
        agent: { id: "octogee-chris-coach" },
        mattermostAccount: { botToken: "default-agent-pat" },
        bindings: [{ agentId: "octogee-chris-coach" }],
      })),
    });
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const body: PushRsyncStateRequestBody = {
      migrationId: "mig-rsync",
      slug: "chris",
      rpcPhase: "push-rsync-state",
      mode: "final",
      targetHost: TARGET_POD_IP,
      targetPort: 30873,
      targetCertificatePem: TARGET_CERTIFICATE_PEM,
      transferUser: "migration",
      transferKey: "b".repeat(64),
      includeActivationManifest: true,
    };
    const rawBody = JSON.stringify(body);
    const sig = signForPod(body.migrationId, rawBody);
    const handler = createPushRsyncStateHandler(mkDeps({ adapter }));
    const req = mkRequest(body, { signature: sig });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({ migrationId: "mig-rsync", slug: "chris", imported: true });
    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(command).toMatch(/\/rsync$/);
    expect(args).toContain("--relative");
    expect(args).toContain("/state/./agents/octogee-chris-coach");
    expect(args).toContain("/openclaw/./customers/chris");
    expect(args).not.toContain("/openclaw/./customer-keys/chris");
    expect(args.some((arg) => arg.endsWith("/./.octogee-migration-activation/chris/activation.json"))).toBe(true);
    expect(args).toContain(`rsync://migration@${TARGET_POD_IP}/state/`);
    expect(args).toEqual(expect.arrayContaining(["--compress", "--compress-choice=zstd"]));
    const env = (spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env;
    expect(env.RSYNC_CONNECT_PROG).toContain(`-connect ${TARGET_POD_IP}:30873`);
    expect(env.RSYNC_CONNECT_PROG).toContain("-verify_return_error");
    expect(env.RSYNC_CONNECT_PROG).toMatch(/-CAfile \S+\/target\.crt/);
  });

  it("refuses to push without the target's pinned TLS certificate", async () => {
    const body = {
      migrationId: "mig-rsync-no-pin",
      slug: "chris",
      rpcPhase: "push-rsync-state",
      mode: "final",
      targetHost: TARGET_POD_IP,
      targetPort: 30873,
      transferUser: "migration",
      transferKey: "b".repeat(64),
    };
    const { res, getStatus, getBody } = mkResponse();

    await createPushRsyncStateHandler(mkDeps())(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }),
      res,
      vi.fn(),
    );

    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: "invalid targetCertificatePem" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not materialize an activation manifest for a configured user final transfer", async () => {
    stubUserClaim("chris");
    const exportOpenClawActivationManifest = vi.fn(async () => {
      throw new Error("User transfer must not materialize an activation manifest");
    });
    const adapter = mkAdapter({
      listExportPaths: vi.fn(async () => [
        { cwd: "/state", path: "agents/octogee-chris-coach" },
        { cwd: "/state", path: "agents/discord-helper" },
        { cwd: "/state", path: "memory/discord-helper.sqlite" },
        { cwd: "/openclaw", path: "customers/chris" },
      ]),
      exportOpenClawActivationManifest,
    });
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const body: PushRsyncStateRequestBody = {
      migrationId: "mig-user-push",
      slug: "chris",
      rpcPhase: "push-rsync-state",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
      targetHost: TARGET_POD_IP,
      targetPort: 30873,
      targetCertificatePem: TARGET_CERTIFICATE_PEM,
      transferUser: "migration",
      transferKey: "b".repeat(64),
    };
    const handler = createPushRsyncStateHandler(mkDeps({ adapter }));
    const response = mkResponse();

    await handler(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }),
      response.res,
      vi.fn(),
    );

    expect(response.getStatus()).toBe(200);
    expect(exportOpenClawActivationManifest).not.toHaveBeenCalled();
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("/state/./agents/discord-helper");
    expect(args).toContain("/state/./memory/discord-helper.sqlite");
    expect(args.some((arg) => arg.includes(".octogee-migration-activation"))).toBe(false);
  });

  it("rejects a configured user transfer on a nonmatching gateway", async () => {
    stubUserClaim("alice");
    const body: PrepareRsyncImportRequestBody = {
      migrationId: "mig-user-wrong-target",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
      transferUser: "migration",
      transferKey: "b".repeat(64),
    };
    const handler = createPrepareRsyncImportHandler(mkDeps());
    const response = mkResponse();

    await handler(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }),
      response.res,
      vi.fn(),
    );

    expect(response.getStatus()).toBe(409);
    expect(response.getBody()).toEqual({
      error: "configured user system config transfer requires the matching isolated gateway",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each(["ready", "activation-failed", "verification-pending", "startup-failed", "disconnected", "cancellation-failed"])(
    "activates a held shared-to-isolated target through its process gate: %s",
    async (outcome) => {
      vi.stubEnv("POD_UID", "builder-pod");
      const events: string[] = [];
      const response = mkResponse();
      const adapter = mkAdapter({
        isIsolatedGateway: () => true,
        isConfiguredUser: (slug) => slug === "chris",
        prepareImportDir: vi.fn(async () => "/openclaw"),
        activateImportedUser: vi.fn(async () => {
          expect(events).toContain("attach-permit-verify");
          events.push("activate-manifest");
          if (outcome === "activation-failed") throw new Error("Agent activation failed");
          return { appliedFingerprint: "imported-coach", ...(outcome === "verification-pending" ? { verificationPending: "Agent disconnected" } : {}) };
        }),
      });
      const reserveSurgeTarget = vi.fn(async () => { events.push("reserve"); });
      const unreserveSurgeTarget = vi.fn(async () => {
        events.push("cancel");
        if (outcome === "cancellation-failed") throw new Error("supervisor unavailable");
        return HELD_USER_GATE_STATE;
      });
      const releaseSurgeReadiness = vi.fn(async () => {
        events.push("attach-permit-verify");
        if (outcome === "startup-failed" || outcome === "cancellation-failed") throw new Error("OpenClaw startup failed");
        if (outcome === "disconnected") response.res.emit("close");
      });
      const deps = mkDeps({
        adapter, reserveSurgeTarget, releaseSurgeReadiness, unreserveSurgeTarget,
        pauseSystemConfigWatch: vi.fn(async () => { events.push("pause-config-watch"); }),
        waitForRsyncReady: async () => undefined,
      });
      spawnMock.mockReturnValueOnce(mkFakeChild()).mockImplementationOnce(() => {
        events.push("copy");
        return mkFakeChild({ exitCode: 0 });
      });
      const prepare: PrepareRsyncImportRequestBody = {
        migrationId: `builder-${outcome}`, slug: "chris", mode: "final",
        rpcPhase: "prepare-rsync-import", transferUser: "migration", transferKey: "c".repeat(64),
      };
      const prepared = mkResponse();
      await createPrepareRsyncImportHandler(deps)(mkRequest(prepare, {
        signature: signForPod(prepare.migrationId, JSON.stringify(prepare)),
      }), prepared.res, vi.fn());
      expect(prepared.getStatus()).toBe(200);
      const finish: FinishRsyncImportRequestBody = {
        migrationId: prepare.migrationId, slug: "chris", mode: "final", rpcPhase: "finish-rsync-import",
      };
      await createFinishRsyncImportHandler(deps)(mkRequest(finish, {
        signature: signForPod(finish.migrationId, JSON.stringify(finish)),
      }), response.res, vi.fn());
      expect(events.slice(0, 4)).toEqual(["reserve", "copy", "pause-config-watch", "attach-permit-verify"]);
      if (["ready", "activation-failed", "verification-pending"].includes(outcome)) {
        expect(adapter.activateImportedUser).toHaveBeenCalledExactlyOnceWith("chris", { signal: expect.any(AbortSignal) });
      } else {
        expect(adapter.activateImportedUser).not.toHaveBeenCalled();
      }
      expect(releaseSurgeReadiness).toHaveBeenCalledWith({
        migrationId: prepare.migrationId, targetPodUid: "builder-pod", importSlug: "chris",
      });
      if (outcome === "ready" || outcome === "verification-pending") {
        expect(response.getStatus()).toBe(200);
        expect(response.getBody()).toEqual({
          migrationId: prepare.migrationId, slug: "chris", imported: true,
          ...(outcome === "verification-pending" ? { verificationPending: "Agent disconnected" } : {}),
        });
        expect(adapter.onMounted).toHaveBeenCalledWith("chris");
        expect(unreserveSurgeTarget).not.toHaveBeenCalled();
      } else {
        expect(response.getStatus()).toBe(outcome === "disconnected" ? 499 : 500);
        expect(adapter.onMounted).not.toHaveBeenCalled();
        expect(unreserveSurgeTarget).toHaveBeenCalledExactlyOnceWith({
          migrationId: prepare.migrationId, slug: "chris", targetPodUid: "builder-pod",
        });
        if (outcome === "cancellation-failed") {
          expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("OpenClaw startup failed"));
          expect(response.getBody()).toMatchObject({
            message: "User activation failed and could not be cancelled",
          });
        }
      }
    },
  );

  it.each(["missing-gate", "missing-pod", "wrong-user"])(
    "rejects unsafe cold user import before transferring state: %s",
    async (scenario) => {
      vi.stubEnv("POD_UID", scenario === "missing-pod" ? "" : "builder-pod");
      const adapter = mkAdapter({
        isIsolatedGateway: () => true,
        isConfiguredUser: () => scenario !== "wrong-user",
      });
      const reserveSurgeTarget = vi.fn(async () => undefined);
      const deps = mkDeps({
        adapter, reserveSurgeTarget,
        releaseSurgeReadiness: scenario === "missing-gate" ? undefined : async () => undefined,
        unreserveSurgeTarget: async () => HELD_USER_GATE_STATE,
      });
      const body: PrepareRsyncImportRequestBody = {
        migrationId: "unsafe-user", slug: "chris", mode: "final", rpcPhase: "prepare-rsync-import",
        transferUser: "migration", transferKey: "c".repeat(64),
      };
      const response = mkResponse();
      await createPrepareRsyncImportHandler(deps)(mkRequest(body, {
        signature: signForPod(body.migrationId, JSON.stringify(body)),
      }), response.res, vi.fn());
      expect(response.getStatus()).toBe(500);
      expect(reserveSurgeTarget).not.toHaveBeenCalled();
      expect(adapter.prepareImportDir).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("cancels a cold user reservation when import preparation fails; cancellation fails: %s", async (fails) => {
    vi.stubEnv("POD_UID", "builder-pod");
    const adapter = mkAdapter({
      isIsolatedGateway: () => true,
      prepareImportDir: vi.fn(async () => { throw new Error("cannot prepare import root"); }),
    });
    const reserveSurgeTarget = vi.fn(async () => undefined);
    const unreserveSurgeTarget = vi.fn(async () => {
      if (fails) throw new Error("supervisor unavailable");
      return HELD_USER_GATE_STATE;
    });
    const deps = mkDeps({
      adapter, reserveSurgeTarget,
      releaseSurgeReadiness: async () => undefined, unreserveSurgeTarget,
    });
    const body: PrepareRsyncImportRequestBody = {
      migrationId: "prepare-failed-user", slug: "chris", mode: "final", rpcPhase: "prepare-rsync-import",
      transferUser: "migration", transferKey: "c".repeat(64),
    };
    const response = mkResponse();
    await createPrepareRsyncImportHandler(deps)(mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    }), response.res, vi.fn());
    expect(response.getStatus()).toBe(500);
    expect(reserveSurgeTarget).toHaveBeenCalledExactlyOnceWith({
      migrationId: body.migrationId, slug: "chris", targetPodUid: "builder-pod",
    });
    expect(unreserveSurgeTarget).toHaveBeenCalledExactlyOnceWith({
      migrationId: body.migrationId, slug: "chris", targetPodUid: "builder-pod",
    });
    if (fails) expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("supervisor unavailable"));
  });

  it.each(["held", "failed", "permitted", "cleanup-failed"])("cancels a prepared cold user import; result: %s", async (outcome) => {
    vi.stubEnv("POD_UID", "builder-pod");
    const adapter = mkAdapter({
      isIsolatedGateway: () => true,
      clearMountMarker: vi.fn(),
      clearUserMigratingIn: vi.fn(),
      removeImportedUserBySlug: vi.fn(async () => {
        if (outcome === "cleanup-failed") throw new Error("Native journal unavailable");
        return { wasMounted: true, steps: [] };
      }),
    });
    const unreserveSurgeTarget = vi.fn<NonNullable<MigrationHandlerDeps["unreserveSurgeTarget"]>>(async (_request, cleanup) => {
      if (outcome === "failed") throw new Error("supervisor unavailable");
      await cleanup?.(async () => undefined);
      return { ...HELD_USER_GATE_STATE, mode: outcome === "held" ? "held" as const : "permitted" as const };
    });
    const deps = mkDeps({
      adapter, reserveSurgeTarget: async () => undefined,
      releaseSurgeReadiness: async () => undefined, unreserveSurgeTarget,
    });
    const body: AbortRsyncImportRequestBody = {
      migrationId: "cancel-user", slug: "chris", mode: "final", rpcPhase: "abort-rsync-import",
    };
    const response = mkResponse();
    await createAbortRsyncImportHandler(deps)(mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    }), response.res, vi.fn());
    expect(unreserveSurgeTarget).toHaveBeenCalledExactlyOnceWith({
      migrationId: body.migrationId, slug: "chris", targetPodUid: "builder-pod",
    }, expect.any(Function));
    expect(response.getStatus()).toBe(outcome === "held" ? 200 : 500);
    if (outcome !== "held") {
      expect(adapter.onUnmounted).not.toHaveBeenCalled();
      expect(adapter.clearMountMarker).not.toHaveBeenCalled();
      expect(adapter.clearUserMigratingIn).not.toHaveBeenCalled();
      expect(deps.log).toHaveBeenCalledWith(expect.stringContaining(
        outcome === "failed" ? "supervisor unavailable" : outcome === "cleanup-failed" ? "Native journal unavailable" : "process is permitted",
      ), { status: "failed" });
    } else {
      expect(adapter.onUnmounted).toHaveBeenCalledWith("chris");
      expect(adapter.clearMountMarker).toHaveBeenCalledWith("chris");
    }
  });

  it.each([undefined, "runtime verification pending"])(
    "keeps expedited hydration outstanding while recording verified activation (%s)", async (verificationPending) => {
    const recordAppliedFingerprint = vi.fn();
    const adapter = mkAdapter({
      prepareImportDir: vi.fn(async () => "/openclaw"),
      activateImportedUser: vi.fn(async () => ({ appliedFingerprint: "0123456789abcdef", verificationPending })),
      markUserMigratingIn: vi.fn(),
      recordAppliedFingerprint,
      onMounted: vi.fn(),
    });
    const daemon = mkFakeChild();
    const copy = mkFakeChild({ exitCode: 0 });
    spawnMock.mockReturnValueOnce(daemon).mockReturnValueOnce(copy);
    const prepareBody: PrepareRsyncImportRequestBody = {
      migrationId: "mig-finish",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "final",
      transferUser: "migration",
      transferKey: "c".repeat(64),
    };
    const prepareRaw = JSON.stringify(prepareBody);
    const prepareSig = signForPod(prepareBody.migrationId, prepareRaw);
    const deps = mkDeps({
      adapter,
      migrationRsyncPort: 30873,
      waitForRsyncReady: vi.fn(async () => undefined),
      pauseSystemConfigWatch: vi.fn(async (_slug: string) => undefined),
      resumeSystemConfigWatch: vi.fn(async (_slug: string) => undefined),
    });
    const prepareHandler = createPrepareRsyncImportHandler(deps);
    const prepareReq = mkRequest(prepareBody, {
      signature: prepareSig,
      localAddress: `::ffff:${TARGET_POD_IP}`,
    });
    const prepareRes = mkResponse();
    await prepareHandler(prepareReq, prepareRes.res, vi.fn());
    expect(prepareRes.getBody()).toMatchObject({
      host: TARGET_POD_IP,
      port: 30873,
      module: "state",
    });
    const [, daemonArgs, daemonOpts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { stdio: string[] },
    ];
    expect(daemonArgs).toContain("--daemon");
    expect(daemonOpts.stdio).toEqual(["ignore", "ignore", "ignore"]);

    const finishBody: FinishRsyncImportRequestBody = {
      migrationId: "mig-finish",
      slug: "chris",
      rpcPhase: "finish-rsync-import",
      mode: "final",
      loadStrategy: "expedited",
    };
    const finishRaw = JSON.stringify(finishBody);
    const finishSig = signForPod(finishBody.migrationId, finishRaw);
    const finishHandler = createFinishRsyncImportHandler(deps);
    const finishReq = mkRequest(finishBody, { signature: finishSig });
    const { res, getStatus, getBody } = mkResponse();

    await finishHandler(finishReq, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({ migrationId: "mig-finish", slug: "chris", imported: true });
    expect(daemon.kill).toHaveBeenCalled();
    expect(adapter.activateImportedUser).toHaveBeenCalledWith("chris", expect.any(Object));
    expect(deps.pauseSystemConfigWatch).toHaveBeenCalledWith("chris");
    expect(deps.resumeSystemConfigWatch).not.toHaveBeenCalled();
    if (verificationPending) expect(recordAppliedFingerprint).toHaveBeenCalledExactlyOnceWith("chris", "");
    else expect(recordAppliedFingerprint).toHaveBeenCalledExactlyOnceWith("chris", "0123456789abcdef!import-reconcile-pending");
    expect(adapter.listProjectsNeedingClone).not.toHaveBeenCalled();
    expect(adapter.writeMountMarker).toHaveBeenCalledWith("chris");
    expect(adapter.onMounted).toHaveBeenCalledWith("chris");
    const [copyCommand, copyArgs] = spawnMock.mock.calls[1] as [string, string[]];
    expect(copyCommand).toMatch(/\/rsync$/);
    expect(copyArgs.at(-1)).toBe("/openclaw/");
  });

  it("replaces only the imported user's files and Git refs with the final source state", async () => {
    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), "final-user-state-"));
    migrationTempRoots.push(importDir);
    const adapter = mkAdapter({ prepareImportDir: vi.fn(async () => importDir) });
    const spawn = await realMigrationSpawn();
    spawnMock.mockReturnValueOnce(mkFakeChild()).mockImplementation(spawn);
    const deps = mkDeps({ adapter, waitForRsyncReady: vi.fn(async () => undefined) });
    const prepareBody: PrepareRsyncImportRequestBody = {
      migrationId: "mig-exact-state", slug: "chris", rpcPhase: "prepare-rsync-import",
      mode: "final", transferUser: "migration", transferKey: "c".repeat(64),
    };
    const response = mkResponse();
    await createPrepareRsyncImportHandler(deps)(mkRequest(prepareBody, {
      signature: signForPod(prepareBody.migrationId, JSON.stringify(prepareBody)),
      localAddress: `::ffff:${TARGET_POD_IP}`,
    }), response.res, vi.fn());
    expect(response.getStatus(), JSON.stringify(response.getBody())).toBe(200);
    const daemonArgs = spawnMock.mock.calls[0][1] as string[];
    const configPath = daemonArgs.find((arg) => arg.startsWith("--config="))!.slice(9);
    const stageDir = /^\s*path = (.+)$/mu.exec(await fs.readFile(configPath, "utf8"))![1]!;
    for (const [relative, content] of [
      ["customers/chris/draft.txt", "latest draft"],
      ["git-metadata/chris/workspace.git/HEAD", "ref: refs/heads/work"],
    ]) {
      await fs.mkdir(path.dirname(path.join(stageDir, relative)), { recursive: true });
      await fs.writeFile(path.join(stageDir, relative), content);
    }
    for (const relative of ["customers/chris/deleted.txt", "git-metadata/chris/workspace.git/refs/heads/deleted", "customers/alice/keep.txt"]) {
      await fs.mkdir(path.dirname(path.join(importDir, relative)), { recursive: true });
      await fs.writeFile(path.join(importDir, relative), "presync");
    }
    const finishBody: FinishRsyncImportRequestBody = {
      migrationId: prepareBody.migrationId, slug: "chris", rpcPhase: "finish-rsync-import", mode: "final",
    };
    const finished = mkResponse();
    await createFinishRsyncImportHandler(deps)(mkRequest(finishBody, {
      signature: signForPod(finishBody.migrationId, JSON.stringify(finishBody)),
    }), finished.res, vi.fn());
    expect(finished.getStatus(), JSON.stringify(finished.getBody())).toBe(200);
    expect(await fs.readFile(path.join(importDir, "customers/chris/draft.txt"), "utf8")).toBe("latest draft");
    expect(await fs.readFile(path.join(importDir, "git-metadata/chris/workspace.git/HEAD"), "utf8")).toBe("ref: refs/heads/work");
    expect(fsSync.existsSync(path.join(importDir, "customers/chris/deleted.txt"))).toBe(false);
    expect(fsSync.existsSync(path.join(importDir, "git-metadata/chris/workspace.git/refs/heads/deleted"))).toBe(false);
    expect(await fs.readFile(path.join(importDir, "customers/alice/keep.txt"), "utf8")).toBe("presync");
  });

  it("keeps a committed import whose activation could not finish verifying", async () => {
    const adapter = mkAdapter({
      prepareImportDir: vi.fn(async () => "/openclaw"),
      activateImportedUser: vi.fn(async () => ({
        appliedFingerprint: "fp-chris",
        verificationPending: "connect response timed out after 30000ms",
      })),
      markUserMigratingIn: vi.fn(),
      onMounted: vi.fn(),
    });
    const daemon = mkFakeChild();
    const copy = mkFakeChild({ exitCode: 0 });
    spawnMock.mockReturnValueOnce(daemon).mockReturnValueOnce(copy);
    const deps = mkDeps({
      adapter,
      migrationRsyncPort: 30874,
      waitForRsyncReady: vi.fn(async () => undefined),
      pauseSystemConfigWatch: vi.fn(async (_slug: string) => undefined),
      resumeSystemConfigWatch: vi.fn(async (_slug: string) => undefined),
    });
    const prepareBody: PrepareRsyncImportRequestBody = {
      migrationId: "mig-pending",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "final",
      transferUser: "migration",
      transferKey: "d".repeat(64),
    };
    const prepareRaw = JSON.stringify(prepareBody);
    await createPrepareRsyncImportHandler(deps)(
      mkRequest(prepareBody, {
        signature: signForPod(prepareBody.migrationId, prepareRaw),
        localAddress: `::ffff:${TARGET_POD_IP}`,
      }),
      mkResponse().res,
      vi.fn(),
    );

    const finishBody: FinishRsyncImportRequestBody = {
      migrationId: "mig-pending",
      slug: "chris",
      rpcPhase: "finish-rsync-import",
      mode: "final",
    };
    const finishRaw = JSON.stringify(finishBody);
    const { res, getStatus, getBody } = mkResponse();
    await createFinishRsyncImportHandler(deps)(
      mkRequest(finishBody, {
        signature: signForPod(finishBody.migrationId, finishRaw),
      }),
      res,
      vi.fn(),
    );

    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({
      imported: true,
      verificationPending: "connect response timed out after 30000ms",
    });
    expect(adapter.writeMountMarker).toHaveBeenCalledWith("chris");
    expect(adapter.onMounted).toHaveBeenCalledWith("chris");
  });

  it("omits neutral fallback state from a configured user final import before surge release", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "user-finish-"));
    migrationTempRoots.push(stateDir);
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({
      agents: { list: [{ id: "discord-helper" }, { id: "octogee-unmatched-route" }] },
    }));
    vi.stubEnv("OPENCLAW_DIR", stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    stubUserClaim("chris");
    vi.stubEnv("POD_UID", "builder-pod");
    const mounted: string[] = [];
    const onMounted = vi.fn((slug: string) => {
      if (!mounted.includes(slug)) mounted.push(slug);
    });
    const markUserMigratingIn = vi.fn();
    const adapter = mkAdapter({
      isIsolatedGateway: vi.fn(() => true),
      isConfiguredUser: vi.fn(slug => slug === "chris"),
      configuredUserOverlayPresent: vi.fn(() => true),
      hasUserSshKey: vi.fn(() => true),
      gitHost: mkGitHost({ listKeys: vi.fn(async () => ["ssh-ed25519 LOCAL chris@gateway"]) }),
      hasWorkspaceGitDir: vi.fn(() => true),
      hasGitRemote: vi.fn(() => true),
      prepareImportDir: vi.fn(async () => stateDir),
      activateImportedUser: vi.fn(async () => ({ appliedFingerprint: "unexpected" })),
      applyAddUserConfigPatch: vi.fn(async () => ({ elapsedMs: 1 })),
      markUserMigratingIn,
      writeMountMarker: vi.fn(),
      userMountMarked: vi.fn(() => true),
      onMounted,
    });
    const daemon = mkFakeChild();
    const copy = mkFakeChild({ exitCode: 0 });
    let stageDir = "";
    const stagedFallbackFiles = [
      "agents/octogee-unmatched-route/agent/state.json",
      "workspace-octogee-unmatched-route/MEMORY.md",
      "memory/octogee-unmatched-route.sqlite",
    ];
    spawnMock.mockReturnValueOnce(daemon).mockImplementationOnce(() => {
      for (const relativePath of stagedFallbackFiles) {
        expect(fsSync.existsSync(path.join(stageDir, relativePath))).toBe(false);
      }
      return copy;
    });
    const deps = mkDeps({
      adapter,
      migrationRsyncPort: 30873,
      waitForRsyncReady: vi.fn(async () => undefined),
      getMountedUsers: () => mounted,
      surgeTargetOpenClawHeld: vi.fn(async request => {
        expect(request).toEqual({ migrationId: "mig-user-finish", slug: "chris", targetPodUid: "builder-pod" });
        return true;
      }),
    });
    const prepareBody: PrepareRsyncImportRequestBody = {
      migrationId: "mig-user-finish",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
      transferUser: "migration",
      transferKey: "d".repeat(64),
    };
    const prepareResponse = mkResponse();
    await createPrepareRsyncImportHandler(deps)(
      mkRequest(prepareBody, {
        signature: signForPod(prepareBody.migrationId, JSON.stringify(prepareBody)),
      }),
      prepareResponse.res,
      vi.fn(),
    );
    expect(prepareResponse.getStatus()).toBe(200);
    const [, daemonArgs] = spawnMock.mock.calls[0] as [string, string[]];
    const rsyncConfigPath = daemonArgs
      .find((arg) => arg.startsWith("--config="))!
      .slice("--config=".length);
    stageDir = /^\s*path = (.+)$/mu.exec(await fs.readFile(rsyncConfigPath, "utf-8"))![1]!;
    for (const relativePath of stagedFallbackFiles) {
      const absolutePath = path.join(stageDir, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, "legacy fallback state");
    }

    const finishBody: FinishRsyncImportRequestBody = {
      migrationId: "mig-user-finish",
      slug: "chris",
      rpcPhase: "finish-rsync-import",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
    };
    const finishResponse = mkResponse();
    await createFinishRsyncImportHandler(deps)(
      mkRequest(finishBody, {
        signature: signForPod(finishBody.migrationId, JSON.stringify(finishBody)),
      }),
      finishResponse.res,
      vi.fn(),
    );

    expect(finishResponse.getStatus()).toBe(200);
    expect(adapter.activateImportedUser).not.toHaveBeenCalled();
    expect(adapter.applyAddUserConfigPatch).not.toHaveBeenCalled();
    expect(adapter.loadUserSnapshot).not.toHaveBeenCalled();
    expect(adapter.writeMountMarker).not.toHaveBeenCalled();
    expect(onMounted).not.toHaveBeenCalled();
    expect(markUserMigratingIn).toHaveBeenCalledWith("chris");
    expect(mounted).toEqual([]);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("omitted system fallback state from staged import"),
    );
  });

  it("rejects a final import whose config transfer mode does not match the prepared user session", async () => {
    stubUserClaim("chris");
    const adapter = mkAdapter({ prepareImportDir: vi.fn(async () => "/openclaw") });
    const daemon = mkFakeChild();
    spawnMock.mockReturnValueOnce(daemon);
    const deps = mkDeps({
      adapter,
      migrationRsyncPort: 30873,
      waitForRsyncReady: vi.fn(async () => undefined),
    });
    const prepareBody: PrepareRsyncImportRequestBody = {
      migrationId: "mig-user-mismatch",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
      transferUser: "migration",
      transferKey: "e".repeat(64),
    };
    await createPrepareRsyncImportHandler(deps)(
      mkRequest(prepareBody, {
        signature: signForPod(prepareBody.migrationId, JSON.stringify(prepareBody)),
      }),
      mkResponse().res,
      vi.fn(),
    );
    const finishBody: FinishRsyncImportRequestBody = {
      migrationId: "mig-user-mismatch",
      slug: "chris",
      rpcPhase: "finish-rsync-import",
      mode: "final",
      configTransferMode: "activation-manifest",
    };
    const response = mkResponse();
    await createFinishRsyncImportHandler(deps)(
      mkRequest(finishBody, {
        signature: signForPod(finishBody.migrationId, JSON.stringify(finishBody)),
      }),
      response.res,
      vi.fn(),
    );

    expect(response.getStatus()).toBe(409);
    expect(response.getBody()).toEqual({
      error: "rsync import config transfer mode does not match prepared session",
    });
    const abortBody: AbortRsyncImportRequestBody = {
      migrationId: "mig-user-mismatch",
      slug: "chris",
      rpcPhase: "abort-rsync-import",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
    };
    await createAbortRsyncImportHandler(deps)(
      mkRequest(abortBody, {
        signature: signForPod(abortBody.migrationId, JSON.stringify(abortBody)),
      }),
      mkResponse().res,
      vi.fn(),
    );
    expect(daemon.kill).toHaveBeenCalled();
  });

  it("clears only user migration observation when a final import is aborted", async () => {
    stubUserClaim("chris");
    const clearMountMarker = vi.fn();
    const clearUserMigratingIn = vi.fn();
    const onUnmounted = vi.fn();
    const adapter = mkAdapter({
      clearMountMarker,
      clearUserMigratingIn,
      onUnmounted,
    });
    const body: AbortRsyncImportRequestBody = {
      migrationId: "mig-user-abort",
      slug: "chris",
      rpcPhase: "abort-rsync-import",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
    };
    const response = mkResponse();

    await createAbortRsyncImportHandler(mkDeps({ adapter }))(
      mkRequest(body, {
        signature: signForPod(body.migrationId, JSON.stringify(body)),
      }),
      response.res,
      vi.fn(),
    );

    expect(response.getStatus()).toBe(200);
    expect(clearMountMarker).toHaveBeenCalledWith("chris");
    expect(clearUserMigratingIn).toHaveBeenCalledWith("chris");
    expect(onUnmounted).toHaveBeenCalledWith("chris");
    expect(adapter.applyRemoveUserConfigPatch).not.toHaveBeenCalled();
    expect(adapter.deleteDepartedUserState).not.toHaveBeenCalled();
  });

  it("does not acknowledge a finished key import until its rsync listener exits", async () => {
    const adapter = mkAdapter({
      prepareKeyImportDir: vi.fn(async () => "/openclaw"),
    });
    const daemon = mkFakeChild({ holdExit: true });
    const copy = mkFakeChild({ exitCode: 0 });
    spawnMock.mockReturnValueOnce(daemon).mockReturnValueOnce(copy);
    const deps = mkDeps({
      adapter,
      migrationRsyncPort: 30873,
      waitForRsyncReady: vi.fn(async () => undefined),
    });
    const prepareBody: PrepareRsyncImportRequestBody = {
      migrationId: "mig-keys-exit",
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: "keys",
      transferUser: "migration",
      transferKey: "d".repeat(64),
    };
    const prepareRaw = JSON.stringify(prepareBody);
    const prepareHandler = createPrepareRsyncImportHandler(deps);
    await prepareHandler(
      mkRequest(prepareBody, { signature: signForPod(prepareBody.migrationId, prepareRaw) }),
      mkResponse().res,
      vi.fn(),
    );

    const finishBody: FinishRsyncImportRequestBody = {
      migrationId: "mig-keys-exit",
      slug: "chris",
      rpcPhase: "finish-rsync-import",
      mode: "keys",
    };
    const finishRaw = JSON.stringify(finishBody);
    const finishHandler = createFinishRsyncImportHandler(deps);
    const finishResponse = mkResponse();
    const finish = finishHandler(
      mkRequest(finishBody, { signature: signForPod(finishBody.migrationId, finishRaw) }),
      finishResponse.res,
      vi.fn(),
    );

    expect(await Promise.race([
      finish.then(() => "finished"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 100)),
    ])).toBe("pending");
    expect(daemon.kill).toHaveBeenCalledWith("SIGTERM");

    daemon.exitCode = 0;
    daemon.emit("exit", 0, null);
    await finish;

    expect(finishResponse.getStatus()).toBe(200);
  });
});

describe("PostgreSQL agent anchors across an rsync carry", () => {
  const CARRIED_STORE = path.join(
    "agents",
    "octogee-chris-coach",
    "agent",
    "openclaw-agent.sqlite",
  );
  const tempRoots: string[] = [];

  beforeEach(async () => {
    await fs.rm(path.dirname(path.join(OPENCLAW_DIR, activationManifestTarPath("chris"))), { recursive: true, force: true });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(path.join(OPENCLAW_DIR, activationManifestTarPath("chris"))), { recursive: true, force: true });
    for (const root of tempRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  async function mkTempRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "carry-"));
    tempRoots.push(root);
    return root;
  }

  async function writeStore(
    root: string,
    rel: string,
    seed: (db: DatabaseSync) => void,
  ): Promise<string> {
    const dbPath = path.join(root, rel);
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE transcript_events(body TEXT); CREATE TABLE session_nodes(status TEXT)");
    if (!rel.includes("codex-home")) {
      db.exec("CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)");
      db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run("1514f000-4540-4f4e-92a1-831adeac3d5b", "octogee_agent_fixture");
    }
    seed(db);
    db.close();
    return dbPath;
  }

  function rowCount(dbPath: string): number {
    const db = new DatabaseSync(dbPath);
    try {
      return (db.prepare("SELECT count(*) AS c FROM transcript_events").get() as { c: number }).c;
    } finally {
      db.close();
    }
  }

  const SNAPSHOT_REPOSITORY = path.join("agents", "octogee-chris-coach", "agent", ".octogee-snapshot");

  function snapshotResult(ok: boolean, extra: Record<string, unknown> = {}): { code: number; stdout: string } {
    return ok
      ? { code: 0, stdout: JSON.stringify({ ok: true, ...extra }) }
      : { code: 1, stdout: JSON.stringify({ ok: false, error: { message: String(extra.message) } }) };
  }

  function fakeOpenClaw(options: { failSnapshot?: string } = {}) {
    return vi.fn(async (args: string[], commandOptions?: { env: NodeJS.ProcessEnv }) => {
      if (args[0] === "agents") {
        const stateDir = commandOptions?.env.OPENCLAW_STATE_DIR;
        if (!stateDir) throw new Error("Native agent commands require the target state root");
        if (args[1] === "list") return { code: 0, stdout: JSON.stringify([
          { id: "octogee-chris-coach", workspace: path.join(stateDir, "customers", "chris"), agentDir: path.dirname(path.join(stateDir, CARRIED_STORE)) },
        ]) };
        if (args[1] === "add") return { code: 0, stdout: JSON.stringify({ agentId: args[2],
          workspace: args[args.indexOf("--workspace") + 1], agentDir: args[args.indexOf("--agent-dir") + 1] }) };
      }
      const [, , action] = args;
      if (action === "create") {
        if (options.failSnapshot) return snapshotResult(false, { message: options.failSnapshot });
        const repository = args[args.indexOf("--repository") + 1]!;
        const snapshotPath = path.join(repository, "snap-1");
        await fs.mkdir(snapshotPath, { recursive: true });
        await fs.writeFile(path.join(snapshotPath, "manifest.json"), "{}");
        await fs.writeFile(path.join(snapshotPath, "database.sqlite"), "snapshot");
        return snapshotResult(true, { snapshotPath });
      }
      if (args[0] === "database" && args[1] === "preflight-agent") {
        return { code: 0, stdout: JSON.stringify({
          schema: "openclaw.agent-schema-preflight.v1", databasePath: args[2], agentId: args[args.indexOf("--agent-id") + 1],
          foundVersion: 24, targetVersion: 24, status: "exact",
        }) };
      }
      if (action === "verify") return snapshotResult(true);
      if (action === "restore") {
        await fs.copyFile(path.join(args[3]!, "database.sqlite"), args[args.indexOf("--target") + 1]!);
        return snapshotResult(true);
      }
      throw new Error(`unexpected openclaw ${args.join(" ")}`);
    });
  }

  function pushRsync(stateDir: string, migrationId: string, options: {
    mode?: "pre" | "final";
    runOpenClaw?: ReturnType<typeof fakeOpenClaw>;
    log?: MigrationHandlerDeps["log"];
    releaseAgent?: (slug: string, agentId: string, signal?: AbortSignal) => Promise<void>;
    surgeSourceOpenClawHeld?: MigrationHandlerDeps["surgeSourceOpenClawHeld"];
  } = {}): {
    handler: ReturnType<typeof createPushRsyncStateHandler>;
    adapter: ReturnType<typeof mkAdapter>;
    req: Request;
  } {
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("POD_UID", "source-pod");
    const workspace = path.join(stateDir, "customers", "chris");
    fsSync.mkdirSync(workspace, { recursive: true });
    const body: PushRsyncStateRequestBody = {
      migrationId,
      slug: "chris",
      rpcPhase: "push-rsync-state",
      mode: options.mode ?? "final",
      targetHost: TARGET_POD_IP,
      targetPort: 30873,
      targetCertificatePem: TARGET_CERTIFICATE_PEM,
      transferUser: "migration",
      transferKey: "b".repeat(64),
    };
    const adapter = mkAdapter({
      listExportPaths: vi.fn(async () => [
        { cwd: stateDir, path: path.join("agents", "octogee-chris-coach") },
      ]),
      releaseAgent: vi.fn(options.releaseAgent ?? (async () => undefined)),
      detachSourceAgents: vi.fn(async () => undefined),
      sourceMigrationIdentityCustody: vi.fn(async () => ({ migrationId, uid: "uid-chris", gatewayId: GATEWAY_ID, podUid: "source-pod", epoch: 4 })),
      sourceMigrationAgentAnchors: vi.fn(async () => [{ agentId: "octogee-chris-coach", storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" }]),
      exportOpenClawActivationManifest: vi.fn(async () => ({ version: 2, slug: "chris", appliedFingerprint: "fp-chris", agentId: "octogee-chris-coach", accountId: "chris-coach", agent: { id: "octogee-chris-coach", workspace }, projectAgents: [], mattermostAccount: { botToken: "synthetic-coach-token" }, bindings: [{ agentId: "octogee-chris-coach", match: { channel: "mattermost", accountId: "chris-coach" } }] })),
    });
    return {
      handler: createPushRsyncStateHandler(mkDeps({ adapter, runOpenClaw: options.runOpenClaw ?? fakeOpenClaw(), ...(options.log ? { log: options.log } : {}),
        ...(options.surgeSourceOpenClawHeld ? { surgeSourceOpenClawHeld: options.surgeSourceOpenClawHeld } : {}) })),
      adapter,
      req: mkRequest(body, {
        signature: signForPod(migrationId, JSON.stringify(body)),
      }),
    };
  }

  it("captures source persona before detach and retains its first bytes across a failed push retry", async () => {
    const stateDir = await mkTempRoot();
    await writeStore(stateDir, CARRIED_STORE, () => {});
    const original = Buffer.from("# Identity\r\n- **Name:** Original source 🐙\r\n");
    const workspace = path.join(stateDir, "customers", "chris"), file = path.join(workspace, "IDENTITY.md");
    await fs.mkdir(workspace, { recursive: true }); await fs.writeFile(file, original);
    const captured: unknown[] = [];
    const { handler, adapter, req } = pushRsync(stateDir, "source-persona-retry", { releaseAgent: async () => {
      const manifest = await readActivationManifest(OPENCLAW_DIR, "chris");
      captured.push(manifest.sourceWorkspaceIdentities);
      expect(Buffer.from(manifest.sourceWorkspaceIdentities!.files[0].content!, "base64")).toEqual(original);
      await fs.writeFile(file, "Native drift after the initial capture");
    } });
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 23 }));
    const first = mkResponse(); await handler(req, first.res, vi.fn()); expect(first.getStatus()).toBe(500);
    const retained = await readActivationManifest(OPENCLAW_DIR, "chris");
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const retry = mkResponse(); await handler(req, retry.res, vi.fn()); expect(retry.getStatus()).toBe(200);
    expect(adapter.exportOpenClawActivationManifest).toHaveBeenCalledOnce();
    expect(captured).toEqual([retained.sourceWorkspaceIdentities, retained.sourceWorkspaceIdentities]);
  });

  it("carries a detached PostgreSQL anchor and never the live files", async () => {
    const stateDir = await mkTempRoot();
    const dbPath = await writeStore(stateDir, CARRIED_STORE, () => {});
    const live = new DatabaseSync(dbPath);
    live.prepare("INSERT INTO transcript_events VALUES (?)").run("newest");
    live.close();
    const runOpenClaw = fakeOpenClaw();
    let snapshotCarried = false;
    spawnMock.mockImplementationOnce((_command: string, args: string[]) => {
      const snapshotSource = args.find((arg) => arg.endsWith(`/./${SNAPSHOT_REPOSITORY}`));
      snapshotCarried = snapshotSource !== undefined &&
        fsSync.existsSync(path.join(snapshotSource.replace("/./", "/"), "postgres-anchor", "database.sqlite"));
      return mkFakeChild({ exitCode: 0 });
    });
    const { handler, req } = pushRsync(stateDir, "mig-carry-snapshot", { runOpenClaw });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus(), JSON.stringify(getBody())).toBe(200);
    expect(runOpenClaw).not.toHaveBeenCalled();
    expect(snapshotCarried).toBe(true);
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(expect.arrayContaining([
      "--exclude=openclaw-agent.sqlite",
      "--exclude=openclaw-agent.sqlite-*",
    ]));
  });

  it.each([false, true])("carries a fresh held user source without a captured manifest (uncaptured=%s)", async (uncaptured) => {
    const stateDir = await mkTempRoot();
    await writeStore(stateDir, CARRIED_STORE, () => {});
    const surgeSourceOpenClawHeld = vi.fn(async () => true);
    let snapshotCarried = false;
    spawnMock.mockImplementationOnce((_command: string, args: string[]) => {
      const snapshotSource = args.find((arg) => arg.endsWith(`/./${SNAPSHOT_REPOSITORY}`));
      snapshotCarried = snapshotSource !== undefined &&
        fsSync.existsSync(path.join(snapshotSource.replace("/./", "/"), "postgres-anchor", "database.sqlite"));
      return mkFakeChild({ exitCode: 0 });
    });
    const { handler, adapter, req } = pushRsync(stateDir, "surge-held-source", {
      surgeSourceOpenClawHeld,
      releaseAgent: async () => { throw new Error("WS open failed: connect ECONNREFUSED 127.0.0.1:18789"); },
    });
    if (uncaptured) await writeActivationManifest(OPENCLAW_DIR, await adapter.exportOpenClawActivationManifest!("chris"));
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(surgeSourceOpenClawHeld).toHaveBeenCalledWith({ migrationId: "surge-held-source", slug: "chris" });
    expect(adapter.releaseAgent).not.toHaveBeenCalled();
    expect(snapshotCarried).toBe(true);
  });

  it.each(["complete", "running", "builder running", "batch refused", "archived", "archived missing anchor", "archived directory symlink", "foreign extra anchor", "missing authority", "foreign custody", "foreign anchor", "missing anchor", "authority changed"])("carries the retained roster after current source roster shrinks (%s)", async (scenario) => {
    const stateDir = await mkTempRoot(), migrationId = "held-roster-retry";
    vi.stubEnv("POD_UID", "source-pod");
    const ids = ["octogee-chris-coach", "octogee-chris-proj-one-coach", "octogee-chris-proj-two-coach"];
    for (const id of ids) await writeStore(stateDir, `agents/${id}/agent/openclaw-agent.sqlite`, () => {});
    const { handler, adapter, req } = pushRsync(stateDir, migrationId, { surgeSourceOpenClawHeld: async () => scenario !== "running" && scenario !== "builder running" && scenario !== "batch refused" });
    if (scenario === "builder running") adapter.isIsolatedGateway = () => true;
    const manifest = await adapter.exportOpenClawActivationManifest!("chris");
    manifest.projectAgents = ids.slice(1).map((agentId, index) => ({ agentId, accountId: agentId.replace(/^octogee-/, "").replace(/-coach$/, ""), agent: { id: agentId, workspace: path.join(stateDir, "customers/chris/projects", index ? "two" : "one") }, mattermostAccount: { botToken: "synthetic-project-token" }, bindings: [{ agentId, match: { channel: "mattermost", accountId: agentId.replace(/^octogee-/, "").replace(/-coach$/, "") } }] }));
    for (const project of manifest.projectAgents) await fs.mkdir(String(project.agent.workspace), { recursive: true });
    if (scenario.startsWith("archived") || scenario === "foreign extra anchor") manifest.projectAgents = [];
    manifest.sourceWorkspaceIdentities = { migrationId, uid: "uid-chris", gatewayId: GATEWAY_ID, podUid: "source-pod", epoch: 4,
      files: [manifest.agentId, ...manifest.projectAgents.map(agent => agent.agentId)].map(agentId => ({ agentId, content: null, sha256: null })) };
    await writeActivationManifest(OPENCLAW_DIR, manifest);
    Object.assign(adapter, { sourceMigrationAgentAnchors: async () => ids.map(agentId => ({ agentId, storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" })) });
    if (scenario === "missing authority") delete adapter.sourceMigrationAgentAnchors;
    if (scenario === "foreign custody") adapter.sourceMigrationIdentityCustody = async () => ({ migrationId, uid: "foreign", gatewayId: GATEWAY_ID, podUid: "source-pod", epoch: 4 });
    if (scenario === "foreign anchor") adapter.sourceMigrationAgentAnchors = async () => ids.map(agentId => ({ agentId, storeId: "foreign", schema: "octogee_agent_fixture" }));
    if (scenario === "foreign extra anchor") adapter.sourceMigrationAgentAnchors = async () => [...ids, "octogee-alice-proj-private-coach"].map(agentId => ({ agentId, storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" }));
    if (scenario === "missing anchor" || scenario === "archived missing anchor") await fs.rm(path.join(stateDir, `agents/${ids[2]}/agent/openclaw-agent.sqlite`));
    if (scenario === "archived directory symlink") {
      const directory = path.join(stateDir, "agents", ids[2]!);
      await fs.rm(directory, { recursive: true });
      await fs.symlink(path.join(stateDir, "agents", ids[0]!), directory, "dir");
    }
    if (scenario === "authority changed") {
      let reads = 0;
      adapter.sourceMigrationAgentAnchors = async () => ++reads === 1 ? ids.map(agentId => ({ agentId, storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" })) : [];
    }
    if (scenario === "batch refused") vi.mocked(adapter.detachSourceAgents!).mockRejectedValueOnce(new Error("detach not confirmed"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const response = mkResponse(); await handler(req, response.res, vi.fn());
    if (scenario !== "complete" && scenario !== "running" && scenario !== "builder running" && scenario !== "archived") {
      const errors = {
        "batch refused": "detach not confirmed",
        "missing authority": "Retained source requires current migration anchor authority",
        "foreign custody": "Source workspace identity custody changed",
        "foreign anchor": "Retained source agent anchor does not match migration authority",
        "missing anchor": "Retained source is missing an authorized agent anchor",
        "archived missing anchor": "Retained source is missing an authorized agent anchor",
        "archived directory symlink": "Carried agent directory is not canonical",
        "foreign extra anchor": "Retained source manifest roster does not match migration anchor authority",
        "authority changed": "Retained source migration export authority changed",
      };
      expect(response.getBody()).toMatchObject({ message: expect.stringContaining(errors[scenario]) });
      expect(response.getStatus()).toBe(500);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(adapter.releaseAgent).not.toHaveBeenCalled();
      return;
    }
    expect(response.getStatus(), JSON.stringify(response.getBody())).toBe(200);
    const args = spawnMock.mock.calls[0]![1] as string[];
    for (const id of ids) expect(args.some(arg => arg.endsWith(`/./agents/${id}/agent/.octogee-snapshot`))).toBe(true);
    if (scenario === "running" || scenario === "builder running") {
      expect(adapter.detachSourceAgents).toHaveBeenCalledExactlyOnceWith("chris", ids, expect.any(AbortSignal));
    } else {
      expect(adapter.detachSourceAgents).not.toHaveBeenCalled();
    }
    expect(adapter.releaseAgent).not.toHaveBeenCalled();
  });

  it("detaches through OpenClaw when the source is not held for the migration", async () => {
    const stateDir = await mkTempRoot();
    await writeStore(stateDir, CARRIED_STORE, () => {});
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const { handler, adapter, req } = pushRsync(stateDir, "surge-running-source", { surgeSourceOpenClawHeld: vi.fn(async () => false) });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(adapter.releaseAgent).toHaveBeenCalledExactlyOnceWith("chris", "octogee-chris-coach", expect.any(AbortSignal));
  });

  it("detaches a one-agent user's source behind only that user's runtime publication", async () => {
    const stateDir = await mkTempRoot();
    await writeStore(stateDir, CARRIED_STORE, () => {});
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const guard = new OpenClawRuntimeUpdateGuard();
    let settleBob!: () => void;
    await guard.run(async () => undefined, { slug: "bob", holdUntil: new Promise<void>((resolve) => { settleBob = resolve; }) });
    const { handler, req } = pushRsync(stateDir, "one-agent-behind-other-publication", {
      surgeSourceOpenClawHeld: vi.fn(async () => false),
      releaseAgent: (slug, _agentId, signal) => guard.run(async () => undefined, { slug, ...(signal ? { signal } : {}) }),
    });
    const { res, getStatus } = mkResponse();

    try {
      await handler(req, res, vi.fn());
      expect(getStatus()).toBe(200);
    } finally { settleBob(); }
  });

  it("leaves a user-owned agent folder the migration authority does not name on the shared source", async () => {
    const stateDir = await mkTempRoot();
    const authorized = ["octogee-chris-coach", "octogee-chris-proj-one-coach"], retired = "octogee-chris-proj-retired-coach";
    for (const id of [...authorized, retired]) await writeStore(stateDir, `agents/${id}/agent/openclaw-agent.sqlite`, () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const { handler, adapter, req } = pushRsync(stateDir, "shared-unauthorized-agent", { surgeSourceOpenClawHeld: async () => false });
    Object.assign(adapter, {
      isIsolatedGateway: () => false,
      listExportPaths: vi.fn(async () => [...authorized, retired].map(id => ({ cwd: stateDir, path: path.join("agents", id) }))),
      sourceMigrationAgentAnchors: vi.fn(async () => authorized.map(agentId => ({ agentId, storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" }))),
    });
    const response = mkResponse();

    await handler(req, response.res, vi.fn());
    const warnings = warn.mock.calls.map(([line]) => String(line));
    warn.mockRestore();

    expect(response.getStatus(), JSON.stringify(response.getBody())).toBe(200);
    const args = spawnMock.mock.calls[0]![1] as string[];
    for (const id of authorized) expect(args.some(arg => arg.endsWith(`/./agents/${id}/agent/.octogee-snapshot`))).toBe(true);
    expect(args.some(arg => arg.includes(retired))).toBe(false);
    expect(adapter.detachSourceAgents).toHaveBeenCalledExactlyOnceWith("chris", authorized, expect.any(AbortSignal));
    expect(warnings).toContainEqual(expect.stringMatching(new RegExp(`"severity":"WARNING".*"message":"[^"]*${retired}`)));
  });

  it.each([
    ["another user's agent", ["octogee-chris-coach", "octogee-alice-coach"]],
    ["a duplicate agent", ["octogee-chris-coach", "octogee-chris-coach"]],
  ])("refuses a shared source export whose migration authority names %s", async (_scenario, ids) => {
    const stateDir = await mkTempRoot();
    await writeStore(stateDir, CARRIED_STORE, () => {});
    const { handler, adapter, req } = pushRsync(stateDir, "shared-foreign-authority");
    Object.assign(adapter, {
      isIsolatedGateway: () => false,
      sourceMigrationAgentAnchors: vi.fn(async () => ids.map(agentId => ({ agentId, storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" }))),
    });
    const response = mkResponse();

    await handler(req, response.res, vi.fn());

    expect(response.getStatus()).toBe(500);
    expect(response.getBody()).toMatchObject({ message: "Shared source migration anchor authority does not belong to the user" });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(adapter.releaseAgent).not.toHaveBeenCalled();
  });

  describe("a user with one active and one archived project agent on a shared source", () => {
    const coach = "octogee-chris-coach", active = "octogee-chris-proj-one-coach", archived = "octogee-chris-proj-shelved-coach";
    const anchors = [coach, active, archived].map(agentId => ({ agentId, storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" }));

    async function sharedSource(mode: "pre" | "final", migrationId: string, onDisk: readonly string[]) {
      const stateDir = await mkTempRoot();
      for (const id of onDisk) await writeStore(stateDir, `agents/${id}/agent/openclaw-agent.sqlite`, () => {});
      spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
      const pushed = pushRsync(stateDir, migrationId, { mode, surgeSourceOpenClawHeld: async () => false });
      Object.assign(pushed.adapter, {
        isIsolatedGateway: () => false,
        listExportPaths: vi.fn(async () => [coach, active].filter(id => onDisk.includes(id)).map(id => ({ cwd: stateDir, path: path.join("agents", id) }))),
        sourceMigrationAgentAnchors: vi.fn(async () => {
          if (mode === "pre") throw new Error("fleet-broker POST /internal/fleet/agent-anchors/read → 403 {\"error\":\"forbidden\"}");
          return anchors;
        }),
        sourceAssignedAgentAnchors: vi.fn(async () => anchors),
      });
      return pushed;
    }

    it("carries the archived agent's kept store with the active agents in the final push", async () => {
      const { handler, adapter, req } = await sharedSource("final", "shared-archived-carried", [coach, active, archived]);
      const response = mkResponse();

      await handler(req, response.res, vi.fn());

      expect(response.getStatus(), JSON.stringify(response.getBody())).toBe(200);
      const args = spawnMock.mock.calls[0]![1] as string[];
      for (const id of [coach, active, archived]) expect(args.some(arg => arg.endsWith(`/./agents/${id}/agent/.octogee-snapshot`))).toBe(true);
      expect(adapter.detachSourceAgents).toHaveBeenCalledExactlyOnceWith("chris", [coach, active, archived], expect.any(AbortSignal));
    });

    it("refuses the pre-sync push, before the source is quiesced, when an authorized agent has no store on the source", async () => {
      const { handler, adapter, req } = await sharedSource("pre", "shared-archived-purged", [coach, active]);
      const response = mkResponse();

      await handler(req, response.res, vi.fn());

      expect(response.getStatus()).toBe(500);
      expect(response.getBody()).toMatchObject({ message: `shared source holds no agent store for authorized agents: [${archived}]` });
      expect(spawnMock).not.toHaveBeenCalled();
      expect(adapter.releaseAgent).not.toHaveBeenCalled();
    });

    it("pre-syncs, before the source is quiesced, through its serving assignment's anchors when every authorized agent's store is on the source", async () => {
      const { handler, adapter, req } = await sharedSource("pre", "shared-archived-kept", [coach, active, archived]);
      const response = mkResponse();

      await handler(req, response.res, vi.fn());

      expect(response.getStatus(), JSON.stringify(response.getBody())).toBe(200);
      expect(adapter.sourceAssignedAgentAnchors).toHaveBeenCalledExactlyOnceWith("chris", "shared-archived-kept");
      expect(adapter.sourceMigrationAgentAnchors).not.toHaveBeenCalled();
    });
  });

  describe("a user returning from an isolated gateway after a project was archived there", () => {
    const coach = "octogee-chris-coach", active = "octogee-chris-proj-one-coach", archived = "octogee-chris-proj-shelved-coach";
    const anchor = (agentId: string) => ({ agentId, storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" });

    async function configureRoster(stateDir: string, configured: readonly string[]): Promise<void> {
      const workspaceFor = (agentId: string) => agentId === coach
        ? path.join(stateDir, "customers", "chris")
        : path.join(stateDir, "customers", "chris", "projects", agentId.replace(/^octogee-chris-proj-/, "").replace(/-coach$/, ""));
      for (const agentId of configured) await fs.mkdir(workspaceFor(agentId), { recursive: true });
      await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
      await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify({
        agents: { list: configured.map(agentId => ({ id: agentId, ...(agentId === coach ? { default: true } : {}), workspace: workspaceFor(agentId) })) },
      }));
      onTestFinished(() => fs.rm(OPENCLAW_CONFIG, { force: true }));
    }

    async function isolatedSource(mode: "pre" | "final", migrationId: string, roster: { configured: readonly string[]; onDisk: readonly string[]; authorized: readonly string[] }) {
      const stateDir = await mkTempRoot();
      for (const id of roster.onDisk) await writeStore(stateDir, `agents/${id}/agent/openclaw-agent.sqlite`, () => {});
      spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
      const pushed = pushRsync(stateDir, migrationId, { mode });
      stubUserClaim("chris");
      await configureRoster(stateDir, roster.configured);
      const { buildBrokeredLifecycleAdapter } = await import("../lib/user-lifecycle-broker-adapter.js");
      const configured = buildBrokeredLifecycleAdapter({ client: {} as never, rpc: {} as never, log: vi.fn() });
      Object.assign(pushed.adapter, {
        isIsolatedGateway: () => true,
        listExportPaths: configured.listExportPaths,
        sourceMigrationAgentAnchors: vi.fn(async () => roster.authorized.map(anchor)),
        sourceAssignedAgentAnchors: vi.fn(async () => { throw new Error("an isolated source reads its move's anchor authority"); }),
      });
      return pushed;
    }

    const carriedAgents = () => (spawnMock.mock.calls[0]![1] as string[])
      .map(arg => /\/\.\/agents\/([^/]+)\/agent\/\.octogee-snapshot$/.exec(arg)?.[1]).filter(Boolean).sort();

    it.each([
      ["an active and an archived project agent", [coach, active], [coach, active, archived]],
      ["only an archived project agent", [coach], [coach, archived]],
    ])("carries the detached archived agent's kept store with %s in the final push", async (_case, configured, held) => {
      const { handler, req } = await isolatedSource("final", "isolated-return-archived", { configured, onDisk: held, authorized: held });
      const response = mkResponse();

      await handler(req, response.res, vi.fn());

      expect(response.getStatus(), JSON.stringify(response.getBody())).toBe(200);
      expect(carriedAgents()).toEqual([...held].sort());
    });

    it("refuses the pre-sync push, before the source is quiesced, when an authorized agent has no store on the isolated source", async () => {
      const { handler, adapter, req } = await isolatedSource("pre", "isolated-return-purged", { configured: [coach], onDisk: [coach], authorized: [coach, archived] });
      const response = mkResponse();

      await handler(req, response.res, vi.fn());

      expect(response.getStatus()).toBe(500);
      expect(response.getBody()).toMatchObject({ message: `isolated source holds no agent store for authorized agents: [${archived}]` });
      expect(adapter.sourceMigrationAgentAnchors).toHaveBeenCalledExactlyOnceWith("chris", "isolated-return-purged");
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("pre-syncs through its move's anchor authority when the isolated source holds every authorized agent's store", async () => {
      const { handler, adapter, req } = await isolatedSource("pre", "isolated-return-kept", { configured: [coach], onDisk: [coach, archived], authorized: [coach, archived] });
      const response = mkResponse();

      await handler(req, response.res, vi.fn());

      expect(response.getStatus(), JSON.stringify(response.getBody())).toBe(200);
      expect(adapter.sourceMigrationAgentAnchors).toHaveBeenCalledExactlyOnceWith("chris", "isolated-return-kept");
      expect(adapter.sourceAssignedAgentAnchors).not.toHaveBeenCalled();
    });
  });

  it("pushes files only during pre-sync without snapshotting or transferring agent databases", async () => {
    const stateDir = await mkTempRoot();
    await writeStore(stateDir, CARRIED_STORE, () => {});
    const runOpenClaw = fakeOpenClaw();
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const { handler, req } = pushRsync(stateDir, "mig-files-only-pre", { mode: "pre", runOpenClaw });
    const { res, getStatus } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(200);
    expect(runOpenClaw).not.toHaveBeenCalled();
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("--exclude=openclaw-agent.sqlite");
    expect(args.some((arg) => arg.includes(SNAPSHOT_REPOSITORY))).toBe(false);
  });

  it("continues a Hobby push when a managed Codex database is corrupt", async () => {
    const stateDir = await mkTempRoot();
    await writeStore(stateDir, CARRIED_STORE, () => {});
    const home = path.join(stateDir, "agents/octogee-chris-coach/agent/codex-home");
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, "goals_1.sqlite"), "corrupt optional state");
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const log = vi.fn();
    const { handler, req } = pushRsync(stateDir, "mig-codex-optional", { runOpenClaw: fakeOpenClaw(), log });
    const { res, getStatus } = mkResponse();
    await handler(req, res, vi.fn());
    expect(getStatus()).toBe(200);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("omitted optional database"));
    expect(spawnMock.mock.calls[0]![1]).toContain("--exclude=/agents/*/agent/codex-home/*.sqlite");
  });

  it("refuses a SQLite agent after the PostgreSQL cutover", async () => {
    const stateDir = await mkTempRoot();
    await writeStore(stateDir, CARRIED_STORE, () => {});
    await writeStore(stateDir, "agents/octogee-chris-coach/agent/codex-home/goals_1.sqlite", () => {});
    const sqlite = new DatabaseSync(path.join(stateDir, CARRIED_STORE)); sqlite.exec("DROP TABLE openclaw_engine_anchor"); sqlite.close();
    const { handler, req } = pushRsync(stateDir, "mig-carry-bad", {
      runOpenClaw: fakeOpenClaw({ failSnapshot: "database disk image is malformed" }),
    });
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({
      error: "push-rsync-state failed",
      message: "SQLite agent handoff is unsupported after the PostgreSQL cutover",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses to carry an unexpected SQLite store from agent state", async () => {
    const stateDir = await mkTempRoot();
    await writeStore(stateDir, path.join("agents", "octogee-chris-coach", "agent", "stray.sqlite"), () => {});
    const { handler, req } = pushRsync(stateDir, "mig-carry-stray");
    const { res, getStatus, getBody } = mkResponse();

    await handler(req, res, vi.fn());

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({
      message: expect.stringContaining("unexpected OpenClaw SQLite store in agent state"),
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  async function prepareImport(input: {
    migrationId: string;
    importDir: string;
    daemon: ReturnType<typeof mkFakeChild>;
    mode?: "pre" | "final";
    configTransferMode?: PrepareRsyncImportRequestBody["configTransferMode"];
    adapter?: Partial<UserLifecycleAdapter>;
    deps?: Partial<MigrationHandlerDeps>;
  }): Promise<{ deps: MigrationHandlerDeps; stageDir: string }> {
    if (input.adapter?.isIsolatedGateway?.() === false && !process.env.POD_UID) vi.stubEnv("POD_UID", "shared-target-pod");
    const adapter = mkAdapter({
      prepareImportDir: vi.fn(async () => input.importDir),
      activateImportedUser: vi.fn(async () => ({ appliedFingerprint: "fp-chris" })),
      markUserMigratingIn: vi.fn(),
      onMounted: vi.fn(),
      ...input.adapter,
    });
    const deps = mkDeps({
      adapter,
      migrationRsyncPort: 30873,
      waitForRsyncReady: vi.fn(async () => undefined),
      pauseSystemConfigWatch: vi.fn(async () => undefined),
      resumeSystemConfigWatch: vi.fn(async () => undefined),
      runOpenClaw: fakeOpenClaw(),
      upgradeImportedAgents: vi.fn(async () => {}),
      ...input.deps,
    });
    spawnMock.mockReturnValueOnce(input.daemon);
    const body: PrepareRsyncImportRequestBody = {
      migrationId: input.migrationId,
      slug: "chris",
      rpcPhase: "prepare-rsync-import",
      mode: input.mode ?? "final",
      ...(input.configTransferMode ? { configTransferMode: input.configTransferMode } : {}),
      transferUser: "migration",
      transferKey: "c".repeat(64),
    };
    await createPrepareRsyncImportHandler(deps)(
      mkRequest(body, {
        signature: signForPod(input.migrationId, JSON.stringify(body)),
      }),
      mkResponse().res,
      vi.fn(),
    );
    const [, daemonArgs] = spawnMock.mock.calls.at(-1) as [string, string[]];
    const configPath = daemonArgs
      .find((arg) => arg.startsWith("--config="))!
      .slice("--config=".length);
    const stageDir = /^\s*path = (.+)$/mu.exec(await fs.readFile(configPath, "utf-8"))![1]!;
    if (input.adapter?.isIsolatedGateway?.() === false) await writeSharedTargetManifest(stageDir, input.importDir);
    return { deps, stageDir };
  }

  async function finishImport(
    deps: MigrationHandlerDeps,
    migrationId: string,
    mode: "pre" | "final" = "final",
  ): Promise<ReturnType<typeof mkResponse>> {
    const body: FinishRsyncImportRequestBody = {
      migrationId,
      slug: "chris",
      rpcPhase: "finish-rsync-import",
      mode,
    };
    const response = mkResponse();
    await createFinishRsyncImportHandler(deps)(
      mkRequest(body, {
        signature: signForPod(migrationId, JSON.stringify(body)),
      }),
      response.res,
      vi.fn(),
    );
    return response;
  }

  it.each(["pre", "final"] as const)(
    "omits neutral fallback state from a staged %s import",
    async (mode) => {
      const importDir = await mkTempRoot();
      const migrationId = `mig-neutral-fallback-${mode}`;
      const { deps, stageDir } = await prepareImport({
        migrationId,
        importDir,
        daemon: mkFakeChild(),
        mode,
      });
      const stagedFallbackFiles = [
        "agents/octogee-unmatched-route/agent/state.json",
        "workspace-octogee-unmatched-route/MEMORY.md",
        "workspaces/octogee-unmatched-route/MEMORY.md",
        "memory/octogee-unmatched-route.sqlite",
      ];
      for (const relativePath of stagedFallbackFiles) {
        const absolutePath = path.join(stageDir, relativePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, "legacy fallback state");
      }
      const copy = mkFakeChild({ exitCode: 0 });
      spawnMock.mockImplementationOnce(() => {
        for (const relativePath of stagedFallbackFiles) {
          expect(fsSync.existsSync(path.join(stageDir, relativePath))).toBe(false);
        }
        expect(fsSync.existsSync(path.join(stageDir, "workspaces"))).toBe(false);
        return copy;
      });

      const { getStatus } = await finishImport(deps, migrationId, mode);

      expect(getStatus()).toBe(200);
      expect(deps.log).toHaveBeenCalledWith(
        expect.stringContaining("omitted system fallback state from staged import"),
      );
    },
  );

  it("does not follow an untrusted staged fallback ancestor", async () => {
    const importDir = await mkTempRoot();
    const outside = await mkTempRoot();
    const sentinel = path.join(outside, "octogee-unmatched-route", "MEMORY.md");
    await fs.mkdir(path.dirname(sentinel), { recursive: true });
    await fs.writeFile(sentinel, "outside stage");
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-neutral-symlink",
      importDir,
      daemon: mkFakeChild(),
    });
    await fs.symlink(outside, path.join(stageDir, "workspaces"));

    const { getStatus } = await finishImport(deps, "mig-neutral-symlink");

    expect(getStatus()).toBe(500);
    await expect(fs.readFile(sentinel, "utf-8")).resolves.toBe("outside stage");
    expect(spawnMock.mock.calls).toHaveLength(1);
  });

  const STAGED_SNAPSHOT = path.join(SNAPSHOT_REPOSITORY, "snap-1");

  async function stageSnapshot(stageDir: string, seed: (db: DatabaseSync) => void, agentId = "octogee-chris-coach"): Promise<void> {
    const snapshot = STAGED_SNAPSHOT.replace("octogee-chris-coach", agentId);
    await writeStore(stageDir, path.join(snapshot, "database.sqlite"), seed);
    const bytes = await fs.readFile(path.join(stageDir, snapshot, "database.sqlite"));
    await fs.writeFile(path.join(stageDir, snapshot, "manifest.json"), JSON.stringify({ schemaVersion: 1,
      database: { role: "agent", agentId, engine: "postgres", storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" },
      artifact: { path: "database.sqlite", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    }));
  }

  it.each(["pre", "final"] as const)("imports required state while omitting legacy Codex temporary helpers (%s)", async mode => {
    const importDir = await mkTempRoot(), migrationId = `mig-codex-temporary-${mode}`;
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(), mode });
    if (mode === "final") await stageSnapshot(stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('required')"));
    const home = path.join(stageDir, "agents/octogee-chris-coach/agent/codex-home");
    const temporary = path.join(home, "tmp/arg0/codex-arg0l58nfp");
    await fs.mkdir(temporary, { recursive: true });
    await fs.symlink("/rsyncd-munged//usr/local/lib/node_modules/@openai/codex/bin/codex", path.join(temporary, "apply_patch"));
    await fs.writeFile(path.join(home, "auth.json"), "durable auth");
    await fs.writeFile(path.join(home, "session.jsonl"), "durable transcript");
    spawnMock.mockImplementationOnce((_command: string, args: string[]) => {
      expect(fsSync.existsSync(path.join(home, "tmp"))).toBe(false);
      expect(fsSync.readFileSync(path.join(home, "auth.json"), "utf8")).toBe("durable auth");
      expect(fsSync.readFileSync(path.join(home, "session.jsonl"), "utf8")).toBe("durable transcript");
      expect(args).toContain("--exclude=/agents/*/agent/codex-home/tmp");
      return mkFakeChild({ exitCode: 0 });
    });
    const { getStatus, getBody } = await finishImport(deps, migrationId, mode);
    expect(getStatus(), JSON.stringify(getBody())).toBe(200);
    if (mode === "final") expect(rowCount(path.join(importDir, CARRIED_STORE))).toBe(1);
    else await expect(fs.lstat(path.join(importDir, CARRIED_STORE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("activates with the required OpenClaw snapshot even when Codex raw files and its backup are corrupt", async () => {
    const importDir = await mkTempRoot();
    const migrationId = "mig-codex-import-optional";
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild() });
    await stageSnapshot(stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('required')"));
    const home = path.join(stageDir, "agents/octogee-chris-coach/agent/codex-home");
    const artifacts = path.join(home, ".octogee-codex-snapshots");
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(home, "goals_1.sqlite"), "raw corrupt state");
    await fs.writeFile(path.join(artifacts, "goals_1.sqlite.backup"), "bad snapshot");
    await fs.writeFile(path.join(artifacts, "goals_1.sqlite.backup.json"), "{}");
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const { getStatus, getBody } = await finishImport(deps, migrationId);
    expect(getStatus(), JSON.stringify(getBody())).toBe(200);
    expect(rowCount(path.join(importDir, CARRIED_STORE))).toBe(1);
    expect(deps.adapter.activateImportedUser).toHaveBeenCalledOnce();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("omitted optional database"));
    await expect(fs.access(path.join(importDir, "agents/octogee-chris-coach/agent/codex-home/goals_1.sqlite"))).rejects.toThrow();
  });

  it("rejects a carried workspace store that does not open instead of delivering it", async () => {
    const importDir = await mkTempRoot();
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-carry-unreadable",
      importDir,
      daemon: mkFakeChild(),
    });
    const staged = path.join(stageDir, "customers", "chris", "app.sqlite");
    await fs.mkdir(path.dirname(staged), { recursive: true });
    await fs.writeFile(staged, "this is not a database");

    const { getStatus, getBody } = await finishImport(deps, "mig-carry-unreadable");

    expect(getStatus()).toBe(400);
    expect(getBody()).toMatchObject({
      error: "rsync import failed validation",
      message: expect.stringContaining("carried agent store customers/chris/app.sqlite does not open"),
    });
    expect(spawnMock.mock.calls).toHaveLength(1);
    expect(deps.adapter.activateImportedUser).not.toHaveBeenCalled();
  });

  it("rejects live agent database files carried instead of a snapshot", async () => {
    const importDir = await mkTempRoot();
    const { deps, stageDir } = await prepareImport({ migrationId: "mig-carry-live", importDir, daemon: mkFakeChild() });
    await writeStore(stageDir, CARRIED_STORE, () => {});

    const { getStatus, getBody } = await finishImport(deps, "mig-carry-live");

    expect(getStatus()).toBe(400);
    expect(getBody()).toMatchObject({
      message: `carried live agent database files instead of snapshots: ${CARRIED_STORE}`,
    });
    expect(spawnMock.mock.calls).toHaveLength(1);
    await expect(fs.access(path.join(importDir, CARRIED_STORE))).rejects.toThrow();
  });

  it("runs scoped Shared agent upgrade after landing anchors and before activation", async () => {
    const importDir = await mkTempRoot(), procRoot = await mkTempRoot(), order: string[] = [];
    const migrationId = "shared-scoped-doctor";
    const upgradeImportedAgents = vi.fn(async (input: { stores: Array<{ agentId: string; anchorPath: string }>; assertCurrent: () => Promise<void> }) => {
      await input.assertCurrent();
      expect(input.stores).toMatchObject([{ agentId: "octogee-chris-coach", anchorPath: path.join(importDir, CARRIED_STORE) }]);
      expect(fsSync.existsSync(input.stores[0]!.anchorPath)).toBe(true);
      order.push("doctor");
    });
    const targetMigrationIdentityCustody = vi.fn(async () => ({ ...sharedTargetAuthority("chris", migrationId),
      anchors: [{ agentId: "octogee-chris-coach", storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" }] }));
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(),
      adapter: { isIsolatedGateway: () => false, targetMigrationIdentityCustody,
        activateImportedUser: vi.fn(async () => { order.push("activate"); return { appliedFingerprint: "fp-chris" }; }) },
      deps: { procRoot, upgradeImportedAgents } as Partial<MigrationHandlerDeps> });
    await stageSnapshot(stageDir, () => {});
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const result = await finishImport(deps, migrationId);
    expect(result.getStatus(), JSON.stringify(result.getBody())).toBe(200);
    expect(order).toEqual(["doctor", "activate"]);
  });

  it("installs a returning user's carried archived project agent store on a shared target and leaves it unregistered", async () => {
    const importDir = await mkTempRoot(), procRoot = await mkTempRoot();
    const migrationId = "builder-return-archived";
    const coach = "octogee-chris-coach", archived = "octogee-chris-proj-shelved-coach";
    const targetMigrationIdentityCustody = vi.fn(async () => ({ ...sharedTargetAuthority("chris", migrationId), builderToShared: true,
      anchors: [coach, archived].map(agentId => ({ agentId, storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" })) }));
    const upgradeImportedAgents = vi.fn(async (input: { stores: Array<{ agentId: string }>; assertCurrent: () => Promise<void> }) => { await input.assertCurrent(); });
    const runOpenClaw = vi.fn(async () => ({ code: 0, stdout: "[]" }));
    const activateImportedUser = vi.fn(async () => ({ appliedFingerprint: "fp-chris" }));
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(),
      adapter: { isIsolatedGateway: () => false, targetMigrationIdentityCustody, activateImportedUser },
      deps: { procRoot, upgradeImportedAgents, runOpenClaw } as Partial<MigrationHandlerDeps> });
    await stageSnapshot(stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('coach')"));
    await stageSnapshot(stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('shelved'), ('shelved')"), archived);
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const result = await finishImport(deps, migrationId);

    expect(result.getStatus(), JSON.stringify(result.getBody())).toBe(200);
    expect(rowCount(path.join(importDir, "agents", archived, "agent", "openclaw-agent.sqlite"))).toBe(2);
    expect(upgradeImportedAgents.mock.calls[0]![0].stores.map(store => store.agentId).sort()).toEqual([coach, archived]);
    expect(runOpenClaw).not.toHaveBeenCalledWith(expect.arrayContaining(["add", archived]), expect.anything());
    expect(activateImportedUser).toHaveBeenCalledOnce();
  });

  it.each(["roster", "authority"] as const)("refuses Shared import when %s changes before agent adoption", async failure => {
    const importDir = await mkTempRoot(), procRoot = await mkTempRoot();
    const migrationId = `shared-doctor-${failure}`, order: string[] = [];
    const anchor = { agentId: "octogee-chris-coach", storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" };
    let changed = false;
    const targetMigrationIdentityCustody = vi.fn(async () => ({ ...sharedTargetAuthority("chris", migrationId),
      anchors: failure === "roster" ? [] : [{ ...anchor, ...(changed ? { schema: "octogee_agent_foreign" } : {}) }] }));
    const upgradeImportedAgents = vi.fn(async (input: { assertCurrent: () => Promise<void> }) => { changed = true; await input.assertCurrent(); });
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(),
      adapter: { isIsolatedGateway: () => false, targetMigrationIdentityCustody,
        activateImportedUser: vi.fn(async () => { order.push("activate"); return { appliedFingerprint: "fp-chris" }; }) },
      deps: { procRoot, upgradeImportedAgents } as Partial<MigrationHandlerDeps> });
    await stageSnapshot(stageDir, () => {});
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const result = await finishImport(deps, migrationId);
    expect(result.getStatus()).toBe(500);
    expect(order).toEqual([]);
    if (failure === "roster") expect(upgradeImportedAgents).not.toHaveBeenCalled();
    else expect(upgradeImportedAgents).toHaveBeenCalledOnce();
  });

  it("leaves agent state untouched when the carried roster exceeds the migration authority", async () => {
    const importDir = await mkTempRoot(), procRoot = await mkTempRoot();
    const migrationId = "shared-unauthorized-carried-agent";
    const retired = "octogee-chris-proj-retired-coach";
    const targetMigrationIdentityCustody = vi.fn(async () => ({ ...sharedTargetAuthority("chris", migrationId),
      anchors: [{ agentId: "octogee-chris-coach", storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" }] }));
    const upgradeImportedAgents = vi.fn(async () => {});
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(),
      adapter: { isIsolatedGateway: () => false, targetMigrationIdentityCustody },
      deps: { procRoot, upgradeImportedAgents } as Partial<MigrationHandlerDeps> });
    await stageSnapshot(stageDir, () => {});
    await stageSnapshot(stageDir, () => {}, retired);
    const spawnsBeforeFinish = spawnMock.mock.calls.length;
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const result = await finishImport(deps, migrationId);

    expect(result.getStatus()).toBe(500);
    expect(result.getBody()).toMatchObject({ message: "carried agent roster does not match migration authority: " +
      `authority [octogee-chris-coach] carried [octogee-chris-coach, ${retired}]` });
    expect(spawnMock.mock.calls).toHaveLength(spawnsBeforeFinish);
    for (const agentId of ["octogee-chris-coach", retired]) {
      expect(fsSync.existsSync(path.join(importDir, "agents", agentId, "agent", "openclaw-agent.sqlite"))).toBe(false);
    }
    expect(upgradeImportedAgents).not.toHaveBeenCalled();
  });

  it("names both rosters when the migration authority lists an agent the source no longer carries", async () => {
    const importDir = await mkTempRoot(), procRoot = await mkTempRoot();
    const migrationId = "shared-uncarried-authorized-agent";
    const retired = "octogee-chris-proj-retired-coach";
    const targetMigrationIdentityCustody = vi.fn(async () => ({ ...sharedTargetAuthority("chris", migrationId), anchors: [
      { agentId: "octogee-chris-coach", storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" },
      { agentId: retired, storeId: "2624f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_retired" },
    ] }));
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(),
      adapter: { isIsolatedGateway: () => false, targetMigrationIdentityCustody },
      deps: { procRoot, upgradeImportedAgents: vi.fn(async () => {}) } as Partial<MigrationHandlerDeps> });
    await stageSnapshot(stageDir, () => {});
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const result = await finishImport(deps, migrationId);

    expect(result.getStatus()).toBe(500);
    expect(result.getBody()).toMatchObject({ message: "carried agent roster does not match migration authority: " +
      `authority [octogee-chris-coach, ${retired}] carried [octogee-chris-coach]` });
  });

  it("rejects a delayed user release while final import holds its in-process claim", async () => {
    stubUserClaim("chris");
    vi.stubEnv("POD_UID", "target-pod");
    const importDir = await mkTempRoot(), daemon = mkFakeChild({ holdExit: true });
    const { deps } = await prepareImport({ migrationId: "copy-release-race", importDir, daemon });
    const finishing = finishImport(deps, "copy-release-race");
    try {
      await vi.waitFor(() => expect(migrationImportBusy()).toBe(true));
      const wiring = createIsolatedSurgeGateWiring({ adapter: { isIsolatedGateway: () => true,
        isConfiguredUser: () => true, configuredUserOverlayPresent: () => true } as never,
        processGate: { status: async () => { throw new Error("owned release entered"); } } as never,
        surgeReadiness: {} as never, waitForGatewayReady: async () => {}, log: () => {},
        provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() } });
      await expect(wiring.releaseSurgeReadiness({ migrationId: "copy-release-race", targetPodUid: "target-pod" }))
        .rejects.toThrow("import is in progress");
      await expect(wiring.releaseSurgeReadiness({ migrationId: "copy-release-race", targetPodUid: "target-pod", importSlug: "other" }))
        .rejects.toThrow("import is in progress");
      await expect(wiring.releaseSurgeReadiness({ migrationId: "copy-release-race", targetPodUid: "target-pod", importSlug: "chris" }))
        .rejects.toThrow("owned release entered");
    } finally {
      daemon.exitCode = 0; daemon.emit("exit", 0, null);
      spawnMock.mockReturnValue(mkFakeChild({ exitCode: 0 }));
      await finishing;
    }
  });

  it("rejects user final import while surge release owns the in-process claim", async () => {
    stubUserClaim("chris");
    const importDir = await mkTempRoot(), target = isolatedTargetImport(async () => true);
    const { deps } = await prepareImport({ migrationId: "release-copy-race", importDir, daemon: mkFakeChild(),
      adapter: target.adapter, deps: { ...target.deps } });
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const status = vi.fn(async () => { await blocked; throw new Error("test release stopped"); });
    const wiring = createIsolatedSurgeGateWiring({ adapter: { ...target.adapter, configuredUserOverlayPresent: () => true } as never,
      processGate: { status } as never, surgeReadiness: {} as never, waitForGatewayReady: async () => {}, log: () => {},
      provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() } });
    const release = wiring.releaseSurgeReadiness({ migrationId: "release-copy-race", targetPodUid: "builder-pod" }).catch(() => {});
    try {
      await vi.waitFor(() => expect(status).toHaveBeenCalledOnce());
      deps.surgeReleaseInProgress = wiring.surgeReleaseInProgress;
      const result = await finishImport(deps, "release-copy-race");
      expect(result.getStatus()).toBe(409);
      expect(result.getBody()).toMatchObject({ error: "User surge release is already in progress" });
    } finally {
      unblock(); await release;
      const body: AbortRsyncImportRequestBody = { migrationId: "release-copy-race", slug: "chris", mode: "final", rpcPhase: "abort-rsync-import" };
      await createAbortRsyncImportHandler(deps)(mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), mkResponse().res, vi.fn());
    }
  });

  it("verifies and lands the PostgreSQL anchor before activating", async () => {
    const importDir = await mkTempRoot();
    const landedAtActivation: boolean[] = [];
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-carry-land",
      importDir,
      daemon: mkFakeChild(),
      adapter: {
        activateImportedUser: vi.fn(async () => {
          landedAtActivation.push(fsSync.existsSync(path.join(importDir, CARRIED_STORE)));
          return { appliedFingerprint: "fp-chris" };
        }),
      },
    });
    await stageSnapshot(stageDir, (db) => db.exec("INSERT INTO transcript_events VALUES ('carried')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus } = await finishImport(deps, "mig-carry-land");

    expect(getStatus()).toBe(200);
    const run = deps.runOpenClaw as ReturnType<typeof fakeOpenClaw>;
    expect(run).not.toHaveBeenCalled();
    expect(rowCount(path.join(importDir, CARRIED_STORE))).toBe(1);
    expect((await fs.stat(path.join(importDir, CARRIED_STORE))).mode & 0o777).toBe(0o600);
    expect(landedAtActivation).toEqual([true]);
    await expect(fs.access(path.join(importDir, ".octogee-import", "mig-carry-land"))).rejects.toThrow();
    await expect(fs.access(path.join(stageDir, SNAPSHOT_REPOSITORY))).rejects.toThrow();
  });

  it("keeps Shared pre-copy agents undiscoverable until the final authoritative snapshot arrives", async () => {
    const importDir = await mkTempRoot();
    const procRoot = await mkTempRoot();
    const migrationId = "mig-shared-undiscoverable-pre";
    const releaseAgent = vi.fn(async () => undefined);
    const adapter = { isIsolatedGateway: () => false, releaseAgent, targetMigrationIdentityCustody: vi.fn(async () => ({
      ...sharedTargetAuthority("chris", migrationId), anchors: [{ agentId: "octogee-chris-coach", storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" }] })) };
    const pre = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(), mode: "pre", adapter, deps: { procRoot } });
    await fs.mkdir(path.join(pre.stageDir, "agents/octogee-chris-coach/agent"), { recursive: true });
    await fs.writeFile(path.join(pre.stageDir, "agents/octogee-chris-coach/agent/auth.json"), "agent configuration");
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    expect((await finishImport(pre.deps, migrationId, "pre")).getStatus()).toBe(200);
    expect(pre.deps.runOpenClaw).not.toHaveBeenCalled();
    await expect(fs.access(path.join(path.dirname(pre.stageDir), ".octogee-import"))).rejects.toThrow();

    const liveDatabase = path.join(importDir, CARRIED_STORE);
    const final = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(), adapter, deps: { procRoot } });
    expect(final.stageDir).toBe(pre.stageDir);
    await stageSnapshot(final.stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('pre'), ('final')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const result = await finishImport(final.deps, migrationId);

    expect(result.getBody()).toEqual({ migrationId, slug: "chris", imported: true });
    expect(result.getStatus()).toBe(200);
    expect(rowCount(liveDatabase)).toBe(2);
    expect(releaseAgent).not.toHaveBeenCalled();
    expect(final.deps.adapter.activateImportedUser).toHaveBeenCalledOnce();
    await expect(fs.access(path.dirname(pre.stageDir))).rejects.toThrow();
  });

  it("pre-copies Shared repositories without agent state and removes the staging on abort", async () => {
    const importDir = await mkTempRoot();
    const migrationId = "mig-shared-private-pre";
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(), mode: "pre" });
    await fs.mkdir(path.join(stageDir, "agents/octogee-chris-coach/agent"), { recursive: true });
    await fs.writeFile(path.join(stageDir, "agents/octogee-chris-coach/agent/auth.json"), "agent configuration");
    await fs.mkdir(path.join(stageDir, "customers/chris/projects/project"), { recursive: true });
    await fs.writeFile(path.join(stageDir, "customers/chris/projects/project/README.md"), "source checkout");
    const spawn = await realMigrationSpawn();
    spawnMock.mockImplementation(spawn);

    const finished = await finishImport(deps, migrationId, "pre");

    expect(finished.getStatus()).toBe(200);
    expect(await fs.readFile(path.join(importDir, "customers/chris/projects/project/README.md"), "utf8")).toBe("source checkout");
    await expect(fs.access(path.join(importDir, "agents"))).rejects.toThrow();
    await expect(fs.access(path.join(path.dirname(stageDir), ".octogee-import"))).rejects.toThrow();
    expect(deps.runOpenClaw).not.toHaveBeenCalled();
    expect(deps.adapter.activateImportedUser).not.toHaveBeenCalled();

    const body: AbortRsyncImportRequestBody = { migrationId, slug: "chris", mode: "pre", rpcPhase: "abort-rsync-import" };
    const aborted = mkResponse();
    await createAbortRsyncImportHandler(deps)(mkRequest(body, { signature: signForPod(migrationId, JSON.stringify(body)) }), aborted.res, vi.fn());
    expect(aborted.getStatus()).toBe(200);
    await expect(fs.access(path.dirname(stageDir))).rejects.toThrow();
    expect(await fs.readFile(path.join(importDir, "customers/chris/projects/project/README.md"), "utf8")).toBe("source checkout");
  });

  it("rejects user pre-copy without a configured activation gate before staging agent state", async () => {
    vi.stubEnv("POD_UID", "user-without-gate");
    const prepareImportDir = vi.fn(async () => "/unused-user-state");
    const deps = mkDeps({ adapter: mkAdapter({
      isIsolatedGateway: () => true,
      isConfiguredUser: () => true,
      prepareImportDir,
    }) });
    const body: PrepareRsyncImportRequestBody = {
      migrationId: "mig-user-without-gate", slug: "chris", mode: "pre",
      rpcPhase: "prepare-rsync-import", transferUser: "migration", transferKey: "c".repeat(64),
    };
    const response = mkResponse();

    await createPrepareRsyncImportHandler(deps)(mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    }), response.res, vi.fn());

    expect(response.getStatus()).toBe(500);
    expect(response.getBody()).toMatchObject({ message: "configured user activation requires its pod-bound process gate" });
    expect(prepareImportDir).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("releases an occupied destination through OpenClaw before replacing its database", async () => {
    const importDir = await mkTempRoot();
    const procRoot = await mkTempRoot();
    const previous = await writeStore(importDir, CARRIED_STORE, () => {});
    await fs.writeFile(`${previous}-wal`, "previous wal");
    const releaseAgent = vi.fn(async () => undefined);
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-carry-release",
      importDir,
      daemon: mkFakeChild(),
      adapter: { releaseAgent },
      deps: { procRoot },
    });
    await stageSnapshot(stageDir, (db) => db.exec("INSERT INTO transcript_events VALUES ('carried')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus } = await finishImport(deps, "mig-carry-release");

    expect(getStatus()).toBe(200);
    expect(releaseAgent).toHaveBeenCalledWith("chris", "octogee-chris-coach");
    expect(rowCount(previous)).toBe(1);
    await expect(fs.access(`${previous}-wal`)).rejects.toThrow();
  });

  it("refuses to replace a database a process still holds after release", async () => {
    const importDir = await mkTempRoot();
    const procRoot = await mkTempRoot();
    const previous = await writeStore(importDir, CARRIED_STORE, (db) => db.exec("INSERT INTO transcript_events VALUES ('previous')"));
    await fs.mkdir(path.join(procRoot, "92", "fd"), { recursive: true });
    await fs.symlink(`${previous}-shm (deleted)`, path.join(procRoot, "92", "fd", "41"));
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-carry-held",
      importDir,
      daemon: mkFakeChild(),
      adapter: { releaseAgent: vi.fn(async () => undefined) },
      deps: { procRoot },
    });
    await stageSnapshot(stageDir, (db) => db.exec("INSERT INTO transcript_events VALUES ('carried'), ('carried')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus, getBody } = await finishImport(deps, "mig-carry-held");

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({ message: `agent database files are still held open: ${previous}-shm` });
    expect(rowCount(previous)).toBe(1);
    expect(deps.adapter.activateImportedUser).not.toHaveBeenCalled();
  });

  it("refuses to replace an occupied database when the gateway cannot release agents", async () => {
    const importDir = await mkTempRoot();
    const previous = await writeStore(importDir, CARRIED_STORE, () => {});
    const { deps, stageDir } = await prepareImport({ migrationId: "mig-carry-no-release", importDir, daemon: mkFakeChild() });
    await stageSnapshot(stageDir, () => {});
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus, getBody } = await finishImport(deps, "mig-carry-no-release");

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({ message: expect.stringContaining("cannot release agents") });
    expect(fsSync.existsSync(previous)).toBe(true);
    expect(deps.adapter.activateImportedUser).not.toHaveBeenCalled();
  });

  function carriedAgentAuthority(agentIds: readonly string[]) {
    return vi.fn(async (slug: string, migrationId: string) => ({ ...sharedTargetAuthority(slug, migrationId),
      anchors: agentIds.map(agentId => ({ agentId, storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" })) }));
  }

  function isolatedTargetImport(openClawHeld: MigrationHandlerDeps["surgeTargetOpenClawHeld"], carriedAgentIds: readonly string[] = ["octogee-chris-coach"]): {
    adapter: Partial<UserLifecycleAdapter>;
    deps: Partial<MigrationHandlerDeps>;
  } {
    vi.stubEnv("POD_UID", "builder-pod");
    return {
      adapter: {
        isIsolatedGateway: () => true,
        isConfiguredUser: (slug) => slug === "chris",
        releaseAgent: vi.fn(async () => undefined),
        targetMigrationIdentityCustody: carriedAgentAuthority(carriedAgentIds),
      },
      deps: {
        reserveSurgeTarget: vi.fn(async () => undefined),
        releaseSurgeReadiness: vi.fn(async () => undefined),
        unreserveSurgeTarget: vi.fn(async () => HELD_USER_GATE_STATE),
        ...(openClawHeld ? { surgeTargetOpenClawHeld: openClawHeld } : {}),
      },
    };
  }

  it("retains Shared when a source-preserving import finds the target stopped", async () => {
    const target = isolatedTargetImport(async () => true), migrationId = "mig-source-safe-stopped";
    const importDir = await mkTempRoot(), procRoot = await mkTempRoot();
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(), adapter: target.adapter, deps: { ...target.deps, procRoot } });
    await stageSnapshot(stageDir, () => {});
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const body: FinishRsyncImportRequestBody = { migrationId, slug: "chris", rpcPhase: "finish-rsync-import", mode: "final", preserveSource: true };
    const response = mkResponse();
    await createFinishRsyncImportHandler(deps)(mkRequest(body, { signature: signForPod(migrationId, JSON.stringify(body)) }), response.res, vi.fn());
    expect(response.getStatus()).toBe(500);
    expect(response.getBody()).toMatchObject({ message: expect.stringContaining("source retained") });
    expect(deps.adapter.activateImportedUser).not.toHaveBeenCalled();
    expect(deps.releaseSurgeReadiness).not.toHaveBeenCalled();
  });

  it("runs the scoped agent upgrade on a held user activation target before its OpenClaw starts", async () => {
    const importDir = await mkTempRoot(), procRoot = await mkTempRoot(), migrationId = "mig-held-user-upgrade";
    const upgradeImportedAgents = vi.fn(async (input: { stores: Array<{ agentId: string; anchorPath: string }>; assertCurrent: () => Promise<void> }) => {
      await input.assertCurrent();
      expect(input.stores).toMatchObject([{ agentId: "octogee-chris-coach", anchorPath: path.join(importDir, CARRIED_STORE) }]);
    });
    const target = isolatedTargetImport(vi.fn(async () => true));
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(), adapter: target.adapter,
      deps: { ...target.deps, procRoot, upgradeImportedAgents } });
    await stageSnapshot(stageDir, () => {});
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const result = await finishImport(deps, migrationId);

    expect(result.getStatus(), JSON.stringify(result.getBody())).toBe(200);
    expect(upgradeImportedAgents).toHaveBeenCalledOnce();
    expect(target.adapter.targetMigrationIdentityCustody).toHaveBeenCalledWith("chris", migrationId);
    expect(deps.releaseSurgeReadiness).toHaveBeenCalledOnce();
  });

  it.each(["success", "late-writer", "claim-loss", "capture-loss", "absence"])("preserves the staged Shared activation personas across %s", async mode => {
    const importDir = await mkTempRoot(); vi.stubEnv("OPENCLAW_STATE_DIR", importDir); vi.stubEnv("POD_UID", "target-pod");
    const migrationId = `mig-target-persona-${mode}`, projectId = "octogee-chris-proj-persona-coach";
    const workspace = path.join(importDir, "customers/chris"), project = path.join(workspace, "projects/persona");
    const originals = new Map([[workspace, Buffer.from("# Agent\r\n- Name: Human agent 🐙\r\n")], [project, Buffer.from("# Project\n- Name: Human project\nNotes.\n")]]);
    const authority = { custody: { migrationId, uid: "uid-chris", gatewayId: GATEWAY_ID, podUid: "target-pod" }, migration: { migrationId, claimStartedAt: 123, sourceGatewayId: "source-user", sourceEpoch: 4 }, anchors: [{ agentId: "octogee-chris-coach", storeId: "1514f000-4540-4f4e-92a1-831adeac3d5b", schema: "octogee_agent_fixture" }] };
    let currentAuthority = authority, lateWrite: (() => Promise<void>) | undefined;
    let calls = 0, published = false;
    const adapter: Partial<UserLifecycleAdapter> = { isIsolatedGateway: () => false, releaseAgent: async () => undefined,
      targetMigrationIdentityCustody: vi.fn(async () => currentAuthority),
      activateImportedUser: vi.fn(async (_slug, opts) => {
        calls++;
        expect(opts?.beforeRuntimePublish).toBeTypeOf("function");
        expect(opts?.sharedToSharedRoster).toBe(true);
        const writeNative = async () => {
          for (const [dir] of originals) { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, "IDENTITY.md"), "- Name: machine-agent-id\n"); }
        };
        if (mode === "late-writer" && calls === 1) { lateWrite = writeNative; throw new Error("Native create client timed out"); }
        await writeNative();
        if (mode === "claim-loss") currentAuthority = { ...authority, migration: { ...authority.migration, claimStartedAt: 124 } };
        if (mode === "capture-loss") { const value = await readActivationManifest(importDir, "chris"); value.targetWorkspaceIdentities!.podUid = "foreign-pod"; await writeActivationManifest(importDir, value); }
        await opts!.beforeRuntimePublish!();
        for (const [dir, bytes] of originals) {
          if (mode === "absence" && dir === project) await expect(fs.stat(path.join(dir, "IDENTITY.md"))).rejects.toMatchObject({ code: "ENOENT" });
          else expect(await fs.readFile(path.join(dir, "IDENTITY.md"))).toEqual(bytes);
        }
        published = true;
        return { appliedFingerprint: "target-persona" };
      }),
    };
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(), adapter });
    await stageSnapshot(stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('original')"));
    for (const [dir, bytes] of originals) { const target = path.join(stageDir, path.relative(importDir, dir)); await fs.mkdir(target, { recursive: true }); if (mode !== "absence" || dir !== project) await fs.writeFile(path.join(target, "IDENTITY.md"), bytes); }
    await writeActivationManifest(stageDir, { version: 2, slug: "chris", appliedFingerprint: "target-persona", agentId: "octogee-chris-coach", accountId: "chris-coach", agent: { id: "octogee-chris-coach", workspace, identity: { name: "Config differs" } }, mattermostAccount: { botToken: "synthetic-coach-token" }, bindings: [{ agentId: "octogee-chris-coach", match: { channel: "mattermost", accountId: "chris-coach" } }], projectAgents: [{ agentId: projectId, accountId: "chris-proj-persona", agent: { id: projectId, workspace: project }, mattermostAccount: { botToken: "synthetic-project-token" }, bindings: [{ agentId: projectId, match: { channel: "mattermost", accountId: "chris-proj-persona" } }] }] });
    spawnMock.mockImplementation(await realMigrationSpawn());
    const result = await finishImport(deps, migrationId);
    if (mode === "late-writer") {
      expect(result.getStatus()).toBe(500); expect(published).toBe(false); expect(lateWrite).toBeTypeOf("function");
      await lateWrite!();
      await expect(fs.access(stageDir)).rejects.toThrow();
      const retained = await readActivationManifest(importDir, "chris");
      const body = { migrationId, slug: "chris" }, retry = mkResponse();
      await createActivateImportHandler(deps)(mkRequest(body, { signature: signForPod(migrationId, JSON.stringify(body)) }), retry.res, vi.fn());
      expect(retry.getStatus(), JSON.stringify(retry.getBody())).toBe(200);
      expect((await readActivationManifest(importDir, "chris")).targetWorkspaceIdentities).toEqual(retained.targetWorkspaceIdentities);
      expect(calls).toBe(2); expect(published).toBe(true);
    } else if (mode === "claim-loss" || mode === "capture-loss") {
      expect(result.getStatus()).toBe(500); expect(published).toBe(false); expect(deps.adapter.onMounted).not.toHaveBeenCalled();
      for (const [dir] of originals) expect(await fs.readFile(path.join(dir, "IDENTITY.md"), "utf8")).toBe("- Name: machine-agent-id\n");
    } else { expect(result.getStatus(), JSON.stringify(result.getBody())).toBe(200); expect(published).toBe(true); }
  });

  it.each([false, true])("pre-copy never imports or deletes the source mount marker (target marker exists: %s)", async (existing) => {
    const importDir = await mkTempRoot();
    const migrationId = `mig-local-mount-marker-${existing}`;
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(), mode: "pre" });
    const relative = "customers/chris/.system/.mounted";
    await fs.mkdir(path.dirname(path.join(stageDir, relative)), { recursive: true });
    await fs.writeFile(path.join(stageDir, relative), "source");
    if (existing) {
      await fs.mkdir(path.dirname(path.join(importDir, relative)), { recursive: true });
      await fs.writeFile(path.join(importDir, relative), "target");
    }
    spawnMock.mockImplementation(await realMigrationSpawn());
    expect((await finishImport(deps, migrationId, "pre")).getStatus()).toBe(200);
    if (existing) expect(await fs.readFile(path.join(importDir, relative), "utf8")).toBe("target");
    else await expect(fs.stat(path.join(importDir, relative))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prepares a held user from a file-only pre-copy without touching its agent database", async () => {
    const importDir = await mkTempRoot();
    const procRoot = await mkTempRoot();
    const migrationId = "mig-user-pre-files-only";
    const target = isolatedTargetImport(async () => true);
    const previous = await writeStore(importDir, CARRIED_STORE, db => db.exec("INSERT INTO transcript_events VALUES ('native')"));
    const prepareSurgeTarget = vi.fn(async () => {
      expect(rowCount(previous)).toBe(1);
    });
    const { deps, stageDir } = await prepareImport({
      migrationId, importDir, daemon: mkFakeChild(), mode: "pre", adapter: target.adapter,
      deps: { ...target.deps, procRoot, prepareSurgeTarget },
    });
    await fs.mkdir(path.join(stageDir, "agents", "octogee-chris-coach", "agent"), { recursive: true });
    await fs.writeFile(path.join(stageDir, "agents", "octogee-chris-coach", "agent", "memory.md"), "shared-memory");
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const result = await finishImport(deps, migrationId, "pre");

    expect(result.getStatus()).toBe(200);
    expect(prepareSurgeTarget).toHaveBeenCalledOnce();
    expect(deps.runOpenClaw).not.toHaveBeenCalled();
    expect(deps.adapter.releaseAgent).not.toHaveBeenCalled();
    expect(deps.releaseSurgeReadiness).not.toHaveBeenCalled();
    expect(rowCount(previous)).toBe(1);
    migrationTempRoots.push(path.dirname(stageDir));
  });

  it("discards agent snapshots an older source carried in a pre-copy and continues file-only", async () => {
    const importDir = await mkTempRoot();
    const migrationId = "mig-pre-snapshot-discarded";
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(), mode: "pre" });
    await stageSnapshot(stageDir, () => {});
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const result = await finishImport(deps, migrationId, "pre");

    expect(result.getStatus()).toBe(200);
    expect(deps.runOpenClaw).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("discarded agent snapshots an older source carried in its pre-copy: octogee-chris-coach"));
    await expect(fs.access(path.join(stageDir, SNAPSHOT_REPOSITORY))).rejects.toThrow();
    await expect(fs.access(path.join(importDir, SNAPSHOT_REPOSITORY))).rejects.toThrow();
  });

  it.each([false, true])("reattaches carried user agents offline before permitting Native (restoration fails: %s)", async (refused) => {
    const importDir = await mkTempRoot();
    const procRoot = await mkTempRoot();
    const target = isolatedTargetImport(async () => true);
    const destination = path.join(importDir, CARRIED_STORE);
    const workspace = path.join(importDir, "customers", "chris");
    const runOpenClaw = vi.fn(async (args: string[]) => {
      expect(rowCount(destination)).toBe(2);
      expect(target.deps.releaseSurgeReadiness).not.toHaveBeenCalled();
      if (args[1] === "list") return { code: 0, stdout: JSON.stringify([
        { id: "octogee-chris-coach", workspace, agentDir: path.dirname(destination) },
      ]) };
      return refused
        ? { code: 1, stdout: JSON.stringify({ ok: false, error: { type: "cli_error", message: "deletion cleanup is still pending" } }) }
        : { code: 0, stdout: JSON.stringify({ agentId: "octogee-chris-coach", workspace, agentDir: path.dirname(destination) }) };
    });
    const migrationId = `mig-user-restore-${refused}`;
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(), adapter: target.adapter,
      deps: { ...target.deps, procRoot, runOpenClaw } });
    await stageSnapshot(stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('carried'), ('carried')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus } = await finishImport(deps, migrationId);

    expect(getStatus()).toBe(refused ? 500 : 200);
    expect(runOpenClaw.mock.calls.map(([args]) => args)).toEqual([
      ["agents", "list", "--json"],
      ["agents", "add", "octogee-chris-coach", "--workspace", workspace, "--agent-dir", path.dirname(destination), "--non-interactive", "--json"],
    ]);
    expect(target.deps.releaseSurgeReadiness).toHaveBeenCalledTimes(refused ? 0 : 1);
    expect(rowCount(destination)).toBe(2);
    if (!refused) {
      for (const step of ["final-import agent-reattach", "final-import file-copy", "isolated-release"]) {
        expect(deps.log).toHaveBeenCalledWith(expect.stringContaining(`[migration-rsync] ${step} migrationId=${migrationId} slug=chris`),
          { durationMs: expect.any(Number) });
      }
    }
  });

  it.each([false, true])("reattaches a missing carried user agent only for the current owner (owner changed=%s)", async ownerChanged => {
    const importDir = await mkTempRoot(), procRoot = await mkTempRoot();
    const migrationId = `mig-builder-missing-coach-${ownerChanged}`;
    const agentId = "octogee-chris-coach";
    const workspace = path.join(importDir, "customers", "chris");
    const agentDir = path.dirname(path.join(importDir, CARRIED_STORE));
    const target = isolatedTargetImport(async () => true);
    const runOpenClaw = vi.fn(async (args: string[]) => {
      if (args[1] === "list") return { code: 0, stdout: "[]" };
      expect(target.deps.releaseSurgeReadiness).not.toHaveBeenCalled();
      expect(args).toEqual(["agents", "add", agentId, "--workspace", workspace, "--agent-dir", agentDir, "--non-interactive", "--json"]);
      return { code: 0, stdout: JSON.stringify({ agentId, workspace, agentDir }) };
    });
    const { deps, stageDir } = await prepareImport({
      migrationId, importDir, daemon: mkFakeChild(),
      adapter: { ...target.adapter, loadUserSnapshot: vi.fn(async () => ({
        ...RESTORE_SNAPSHOT, uid: ownerChanged ? "other-owner" : "uid-chris",
      })) },
      deps: { ...target.deps, procRoot, runOpenClaw },
    });
    await stageSnapshot(stageDir, () => {});
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const result = await finishImport(deps, migrationId);

    expect(result.getStatus(), JSON.stringify(result.getBody())).toBe(ownerChanged ? 500 : 200);
    expect(runOpenClaw).toHaveBeenCalledTimes(ownerChanged ? 1 : 2);
    expect(target.deps.releaseSurgeReadiness).toHaveBeenCalledTimes(ownerChanged ? 0 : 1);
  });

  it.each(["active", "archived", "disabled", "missing-token", "owner-changed", "hold-lost"] as const)("checks current ownership before admitting a carried project absent from a fresh user roster: %s", async mode => {
    const importDir = await mkTempRoot(), procRoot = await mkTempRoot();
    let held = true;
    const agentId = "octogee-chris-proj-demo-coach";
    const target = isolatedTargetImport(async () => held, [agentId]);
    const workspace = path.join(importDir, "customers", "chris", "projects", "demo");
    const agentDir = path.join(importDir, "agents", agentId, "agent");
    const runOpenClaw = vi.fn(async (args: string[]) => {
      expect(target.deps.releaseSurgeReadiness).not.toHaveBeenCalled();
      if (args[1] === "list") return { code: 0, stdout: JSON.stringify([
        { id: "octogee-chris-coach", workspace: path.dirname(path.dirname(workspace)), agentDir: path.dirname(path.join(importDir, CARRIED_STORE)) },
      ]) };
      expect(args).toEqual(["agents", "add", agentId, "--workspace", workspace, "--agent-dir", agentDir, "--non-interactive", "--json"]);
      expect(rowCount(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(2);
      return { code: 0, stdout: JSON.stringify({ agentId, workspace, agentDir }) };
    });
    const { deps, stageDir } = await prepareImport({ migrationId: "mig-user-unconfigured-project", importDir, daemon: mkFakeChild(),
      adapter: { ...target.adapter, loadUserSnapshot: vi.fn(async () => {
        if (mode === "hold-lost") held = false;
        return { ...RESTORE_SNAPSHOT, uid: mode === "owner-changed" ? "other-owner" : "uid-chris",
          projectAgents: mode === "archived" ? [] : [{ projectId: "demo", enabled: mode !== "disabled", status: "ready" as const,
            ...(mode === "missing-token" ? {} : { token: "fixture-project-token" }) }],
          ...(mode === "archived" ? { archivedProjectIds: ["demo"] } : {}),
        };
      }) }, deps: { ...target.deps, procRoot, runOpenClaw } });
    await stageSnapshot(stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('project'), ('project')"), agentId);
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const result = await finishImport(deps, "mig-user-unconfigured-project");
    const admitted = mode === "active" || mode === "archived";

    expect(result.getStatus(), JSON.stringify(result.getBody())).toBe(admitted ? 200 : 500);
    expect(runOpenClaw).toHaveBeenCalledTimes(mode === "active" ? 2 : 1);
    expect(target.deps.releaseSurgeReadiness).toHaveBeenCalledTimes(admitted ? 1 : 0);
    expect(rowCount(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(2);
  });

  it("preserves carried project persona files after Native registration of a fresh user roster", async () => {
    const importDir = await mkTempRoot(), procRoot = await mkTempRoot();
    const agentId = "octogee-chris-proj-demo-coach";
    const target = isolatedTargetImport(async () => true, [agentId]);
    const workspace = path.join(importDir, "customers", "chris", "projects", "demo");
    const agentDir = path.join(importDir, "agents", agentId, "agent");
    const identity = "# IDENTITY.md\n\n- **Name:** Harbor\n\nAuthored project personality.\n";
    const runOpenClaw = vi.fn(async (args: string[]) => {
      if (args[1] === "list") return { code: 0, stdout: "[]" };
      expect(rowCount(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(2);
      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(path.join(workspace, "IDENTITY.md"), `# IDENTITY.md\n\n- Name: ${agentId}\n`);
      return { code: 0, stdout: JSON.stringify({ agentId, workspace, agentDir }) };
    });
    const { deps, stageDir } = await prepareImport({ migrationId: "mig-user-project-persona", importDir, daemon: mkFakeChild(),
      adapter: { ...target.adapter, loadUserSnapshot: vi.fn(async () => ({ ...RESTORE_SNAPSHOT,
        projectAgents: [{ projectId: "demo", enabled: true, status: "ready" as const, token: "fixture-project-token" }],
      })) }, deps: { ...target.deps, procRoot, runOpenClaw } });
    await stageSnapshot(stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('project'), ('project')"), agentId);
    const sourceWorkspace = path.join(stageDir, "customers", "chris", "projects", "demo");
    await fs.mkdir(sourceWorkspace, { recursive: true });
    await fs.writeFile(path.join(sourceWorkspace, "IDENTITY.md"), identity);
    spawnMock.mockImplementation(await realMigrationSpawn());

    const result = await finishImport(deps, "mig-user-project-persona");

    expect(result.getStatus(), JSON.stringify(result.getBody())).toBe(200);
    expect(await fs.readFile(path.join(workspace, "IDENTITY.md"), "utf8")).toBe(identity);
    expect(rowCount(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(2);
    expect(target.deps.releaseSurgeReadiness).toHaveBeenCalledOnce();
  });

  it("restores a late-created Codex home after held user registration and final copy", async () => {
    const importDir = await mkTempRoot(), procRoot = await mkTempRoot();
    const target = isolatedTargetImport(async () => true);
    const migrationId = `mig-user-late-codex-${path.basename(importDir)}`;
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(),
      adapter: target.adapter, deps: { ...target.deps, procRoot } });
    await stageSnapshot(stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('required')"));
    const home = "agents/octogee-chris-coach/agent/codex-home";
    const raw = await writeStore(stageDir, `${home}/goals_1.sqlite`, db =>
      db.exec("INSERT INTO transcript_events VALUES ('late Codex history'), ('late Codex history')"));
    await fs.writeFile(path.join(stageDir, home, "config.toml"), "late-home=true\n");
    const canonicalStage = await fs.realpath(stageDir);
    const codexLog = vi.fn();
    const exported = await exportCodexStoreSnapshots({ sources: [{ cwd: canonicalStage, path: home }], exportRoot: canonicalStage, log: codexLog });
    expect(exported, JSON.stringify(codexLog.mock.calls)).toHaveLength(1);
    const snapshot = await fs.readFile(path.join(stageDir, home, ".octogee-codex-snapshots/goals_1.sqlite.backup"));
    await fs.writeFile(raw, "raw database must not be copied");
    await expect(fs.access(path.join(importDir, home))).rejects.toMatchObject({ code: "ENOENT" });
    spawnMock.mockImplementation(await realMigrationSpawn());

    const result = await finishImport(deps, migrationId);

    expect(result.getStatus(), JSON.stringify(result.getBody())).toBe(200);
    expect(await fs.readFile(path.join(importDir, home, "goals_1.sqlite"))).toEqual(snapshot);
    expect(rowCount(path.join(importDir, home, "goals_1.sqlite"))).toBe(2);
    expect(await fs.readFile(path.join(importDir, home, "config.toml"), "utf8")).toBe("late-home=true\n");
    expect(rowCount(path.join(importDir, CARRIED_STORE))).toBe(1);
    expect(target.deps.releaseSurgeReadiness).toHaveBeenCalledOnce();
  });

  it("refuses Native startup when the user hold is lost during anchor installation", async () => {
    const importDir = await mkTempRoot();
    const procRoot = await mkTempRoot();
    await writeStore(importDir, CARRIED_STORE, () => {});
    const held = vi.fn(async () => true);
    const target = isolatedTargetImport(held);
    const migrationId = "mig-user-restore-hold-lost";
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(),
      adapter: target.adapter, deps: { ...target.deps, procRoot } });
    await stageSnapshot(stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('carried')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    held.mockResolvedValue(false).mockResolvedValueOnce(true);

    const { getStatus, getBody } = await finishImport(deps, migrationId);

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({ message: "Native user restoration requires the migration target to remain held" });
    expect(deps.runOpenClaw).not.toHaveBeenCalled();
    expect(target.deps.releaseSurgeReadiness).not.toHaveBeenCalled();
  });

  it("replaces an occupied database on a held isolated target without using its unavailable RPC", async () => {
    const importDir = await mkTempRoot();
    const procRoot = await mkTempRoot();
    const previous = await writeStore(importDir, CARRIED_STORE, (db) => db.exec("INSERT INTO transcript_events VALUES ('previous')"));
    await fs.writeFile(`${previous}-wal`, "previous session wal");
    const surgeTargetOpenClawHeld = vi.fn(async () => true);
    const target = isolatedTargetImport(surgeTargetOpenClawHeld);
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-carry-held-user",
      importDir,
      daemon: mkFakeChild(),
      adapter: target.adapter,
      deps: { ...target.deps, procRoot },
    });
    await stageSnapshot(stageDir, (db) => db.exec("INSERT INTO transcript_events VALUES ('carried'), ('carried')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus } = await finishImport(deps, "mig-carry-held-user");

    expect(getStatus()).toBe(200);
    expect(surgeTargetOpenClawHeld).toHaveBeenCalledWith({
      migrationId: "mig-carry-held-user", slug: "chris", targetPodUid: "builder-pod",
    });
    expect(deps.adapter.releaseAgent).not.toHaveBeenCalled();
    expect(rowCount(previous)).toBe(2);
    await expect(fs.access(`${previous}-wal`)).rejects.toThrow();
    expect(deps.releaseSurgeReadiness).toHaveBeenCalledOnce();
  });

  it.each(["held", "missing-status", "permitted", "foreign-owner", "pod-changed", "hold-lost"])("protects an occupied system-config user store (%s)", async boundary => {
    const importDir = await mkTempRoot(), procRoot = await mkTempRoot();
    const configPath = path.join(importDir, "openclaw.json");
    const config = { agents: { list: [{ id: "octogee-chris-coach",
      workspace: path.join(importDir, "customers/chris"),
      agentDir: path.join(importDir, "agents/octogee-chris-coach/agent") }] } };
    await fs.writeFile(configPath, JSON.stringify(config));
    vi.stubEnv("OPENCLAW_DIR", importDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", importDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    stubUserClaim("chris");
    const previous = await writeStore(importDir, CARRIED_STORE, db => db.exec("INSERT INTO transcript_events VALUES ('previous')"));
    const workspaceFile = path.join(importDir, "customers/chris/README.md");
    await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
    await fs.writeFile(workspaceFile, "original workspace");
    const held = vi.fn(async () => true);
    if (boundary === "permitted") held.mockResolvedValue(false);
    if (boundary === "hold-lost") held.mockResolvedValue(false).mockResolvedValueOnce(true);
    if (boundary === "pod-changed") held.mockImplementationOnce(async () => { vi.stubEnv("POD_UID", "foreign-pod"); return true; });
    const target = isolatedTargetImport(boundary === "missing-status" ? undefined : held);
    if (boundary === "foreign-owner") target.adapter.isConfiguredUser = () => false;
    const releaseAgent = vi.fn(async () => { throw new Error("OpenClaw workspace identities are not initialized for this boot"); });
    const migrationId = "mig-system-config-occupied-held";
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(),
      configTransferMode: "configured-builder-system-config",
      adapter: { ...target.adapter, releaseAgent, applyAddUserConfigPatch: vi.fn(async () => ({ elapsedMs: 1 })),
        writeMountMarker: vi.fn(), onMounted: vi.fn() }, deps: { ...target.deps, procRoot } });
    await stageSnapshot(stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('carried'), ('carried')"));
    const carriedWorkspace = path.join(stageDir, "customers/chris/README.md");
    await fs.mkdir(path.dirname(carriedWorkspace), { recursive: true });
    await fs.writeFile(carriedWorkspace, "carried workspace");
    spawnMock.mockImplementation(await realMigrationSpawn());
    const body: FinishRsyncImportRequestBody = { migrationId, slug: "chris", rpcPhase: "finish-rsync-import",
      mode: "final", configTransferMode: "configured-builder-system-config" };
    const response = mkResponse();

    await createFinishRsyncImportHandler(deps)(mkRequest(body, {
      signature: signForPod(migrationId, JSON.stringify(body)),
    }), response.res, vi.fn());

    expect(response.getStatus(), JSON.stringify(response.getBody())).toBe(boundary === "held" ? 200 : 500);
    if (boundary !== "missing-status" && boundary !== "foreign-owner") {
      expect(held).toHaveBeenCalledWith({ migrationId, slug: "chris", targetPodUid: "builder-pod" });
    }
    expect(releaseAgent).not.toHaveBeenCalled();
    expect(rowCount(previous)).toBe(boundary === "held" ? 2 : 1);
    expect(await fs.readFile(workspaceFile, "utf8")).toBe(boundary === "held" ? "carried workspace" : "original workspace");
    expect(deps.runOpenClaw).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(config);
    expect(deps.adapter.activateImportedUser).not.toHaveBeenCalled();
    expect(deps.adapter.applyAddUserConfigPatch).not.toHaveBeenCalled();
    expect(deps.releaseSurgeReadiness).not.toHaveBeenCalled();
    expect(deps.adapter.writeMountMarker).not.toHaveBeenCalled();
    expect(deps.adapter.onMounted).not.toHaveBeenCalled();
  });

  it("still refuses to replace a held isolated target's database while a process holds it", async () => {
    const importDir = await mkTempRoot();
    const procRoot = await mkTempRoot();
    const previous = await writeStore(importDir, CARRIED_STORE, (db) => db.exec("INSERT INTO transcript_events VALUES ('previous')"));
    await fs.mkdir(path.join(procRoot, "77", "fd"), { recursive: true });
    await fs.symlink(`${previous}-wal`, path.join(procRoot, "77", "fd", "9"));
    const target = isolatedTargetImport(async () => true);
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-carry-held-user-open",
      importDir,
      daemon: mkFakeChild(),
      adapter: target.adapter,
      deps: { ...target.deps, procRoot },
    });
    await stageSnapshot(stageDir, () => {});
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus, getBody } = await finishImport(deps, "mig-carry-held-user-open");

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({ message: `agent database files are still held open: ${previous}-wal` });
    expect(rowCount(previous)).toBe(1);
    expect(deps.releaseSurgeReadiness).not.toHaveBeenCalled();
  });

  it("releases an occupied database through OpenClaw on a isolated target whose OpenClaw is permitted", async () => {
    const importDir = await mkTempRoot();
    const procRoot = await mkTempRoot();
    const previous = await writeStore(importDir, CARRIED_STORE, () => {});
    const target = isolatedTargetImport(async () => false);
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-carry-permitted-user",
      importDir,
      daemon: mkFakeChild(),
      adapter: target.adapter,
      deps: { ...target.deps, procRoot },
    });
    await stageSnapshot(stageDir, (db) => db.exec("INSERT INTO transcript_events VALUES ('carried')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus, getBody } = await finishImport(deps, "mig-carry-permitted-user");

    expect(getStatus(), JSON.stringify(getBody())).toBe(200);
    expect(deps.adapter.releaseAgent).toHaveBeenCalledExactlyOnceWith("chris", "octogee-chris-coach");
    expect(deps.runOpenClaw).not.toHaveBeenCalled();
    expect(rowCount(previous)).toBe(1);
  });

  function liveIsolatedTargetImport(carriedAgentIds: readonly string[] = ["octogee-chris-coach"]): {
    adapter: Partial<UserLifecycleAdapter>;
    deps: Partial<MigrationHandlerDeps>;
  } {
    vi.stubEnv("POD_UID", "builder-pod");
    const permitted = (message: string) => vi.fn(async () => { throw new Error(message); });
    return {
      adapter: {
        isIsolatedGateway: () => true,
        isConfiguredUser: (slug) => slug === "chris",
        userMountMarked: vi.fn(() => false),
        targetMigrationIdentityCustody: carriedAgentAuthority(carriedAgentIds),
        releaseAgent: vi.fn(async () => undefined),
        removeImportedUserBySlug: vi.fn(async () => ({ wasMounted: true, steps: [], retained: true })),
        clearMountMarker: vi.fn(),
        clearUserMigratingIn: vi.fn(),
      },
      deps: {
        reserveSurgeTarget: permitted("cannot hydrate a permitted surge OpenClaw process gate"),
        prepareSurgeTarget: permitted("User preparation requires its reserved OpenClaw process to remain held"),
        releaseSurgeReadiness: permitted("configured isolated target is not reserved by this migration"),
        unreserveSurgeTarget: vi.fn(async (_request, cleanup) => {
          await cleanup?.(async () => {});
          return PRELAUNCH_USER_GATE_STATE;
        }),
        surgeTargetOpenClawHeld: permitted("configured isolated target is not reserved by this migration"),
        surgeTargetLive: vi.fn(async (request) => {
          liveAdmissionRecords.push({ ...request, instanceId: process.env.POD_UID ?? "" });
          return true;
        }),
        admitLiveSurgeTarget: vi.fn(async () => undefined),
        pauseSystemConfigWatch: vi.fn(async () => undefined),
        migrationRsyncPort: 30873,
        waitForRsyncReady: vi.fn(async () => undefined),
      },
    };
  }

  async function restartedMigrationHandlers(): Promise<typeof import("../lib/fleet-http-migration.js")> {
    vi.resetModules();
    return import("../lib/fleet-http-migration.js");
  }

  function expectNoHeldGateCalls(deps: MigrationHandlerDeps): void {
    expect(deps.reserveSurgeTarget).not.toHaveBeenCalled();
    expect(deps.prepareSurgeTarget).not.toHaveBeenCalled();
    expect(deps.releaseSurgeReadiness).not.toHaveBeenCalled();
    expect(deps.unreserveSurgeTarget).not.toHaveBeenCalled();
    expect(deps.surgeTargetOpenClawHeld).not.toHaveBeenCalled();
  }

  it("pre-copies files into a live user without reserving, preparing, or touching its agent databases", async () => {
    const importDir = await mkTempRoot(), procRoot = await mkTempRoot();
    const previous = await writeStore(importDir, CARRIED_STORE, db => db.exec("INSERT INTO transcript_events VALUES ('native')"));
    const target = liveIsolatedTargetImport();
    const migrationId = "mig-live-user-pre";
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(), mode: "pre",
      adapter: target.adapter, deps: { ...target.deps, procRoot } });
    await fs.mkdir(path.join(stageDir, "agents", "octogee-chris-coach", "agent"), { recursive: true });
    await fs.writeFile(path.join(stageDir, "agents", "octogee-chris-coach", "agent", "memory.md"), "shared-memory");
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const result = await finishImport(deps, migrationId, "pre");

    expect(result.getStatus()).toBe(200);
    expect(deps.admitLiveSurgeTarget).toHaveBeenCalledExactlyOnceWith({ migrationId, slug: "chris", targetPodUid: "builder-pod" });
    expectNoHeldGateCalls(deps);
    expect(deps.adapter.releaseAgent).not.toHaveBeenCalled();
    expect(deps.adapter.activateImportedUser).not.toHaveBeenCalled();
    const copy = spawnMock.mock.calls.find(([command, args]) => command === "/usr/bin/rsync" && args[0] === "-a");
    expect(copy![1]).toContain("--exclude=/agents/");
    expect(rowCount(previous)).toBe(1);
    migrationTempRoots.push(path.dirname(stageDir));
  });

  it.each(["ready", "verification-pending"] as const)(
    "activates a live user by releasing each carried agent through its running OpenClaw: %s",
    async (outcome) => {
      const importDir = await mkTempRoot(), procRoot = await mkTempRoot();
      const previous = await writeStore(importDir, CARRIED_STORE, db => db.exec("INSERT INTO transcript_events VALUES ('native')"));
      await fs.writeFile(`${previous}-wal`, "native wal");
      const target = liveIsolatedTargetImport();
      const migrationId = `mig-live-user-${outcome}`;
      const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(),
        adapter: {
          ...target.adapter,
          activateImportedUser: vi.fn(async () => {
            expect(rowCount(previous)).toBe(2);
            return { appliedFingerprint: "fp-chris", ...(outcome === "verification-pending" ? { verificationPending: "Agent disconnected" } : {}) };
          }),
        },
        deps: { ...target.deps, procRoot } });
      await stageSnapshot(stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('carried'), ('carried')"));
      spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

      const result = await finishImport(deps, migrationId);

      expectNoHeldGateCalls(deps);
      expect(deps.adapter.releaseAgent).toHaveBeenCalledExactlyOnceWith("chris", "octogee-chris-coach");
      expect(deps.adapter.activateImportedUser).toHaveBeenCalledExactlyOnceWith("chris", { signal: expect.any(AbortSignal), migrationId });
      expect(rowCount(previous)).toBe(2);
      expect(result.getStatus()).toBe(200);
      expect(result.getBody()).toEqual({
        migrationId, slug: "chris", imported: true,
        ...(outcome === "verification-pending" ? { verificationPending: "Agent disconnected" } : {}),
      });
      expect(deps.adapter.writeMountMarker).toHaveBeenCalledWith("chris");
      expect(deps.adapter.onMounted).toHaveBeenCalledWith("chris");
    },
  );

  it("accepts Native activation without an additional agent connection probe", async () => {
    const importDir = await mkTempRoot(), procRoot = await mkTempRoot();
    const target = liveIsolatedTargetImport(), migrationId = "mig-live-native-activation";
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(),
      adapter: { ...target.adapter, waitForAccountHealthy: vi.fn(async () => false) }, deps: { ...target.deps, procRoot } });
    await stageSnapshot(stageDir, () => {});
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));
    const body: FinishRsyncImportRequestBody = { migrationId, slug: "chris", rpcPhase: "finish-rsync-import", mode: "final", preserveSource: true };
    const response = mkResponse();
    await createFinishRsyncImportHandler(deps)(mkRequest(body, { signature: signForPod(migrationId, JSON.stringify(body)) }), response.res, vi.fn());
    expect(response.getStatus(), JSON.stringify(response.getBody())).toBe(200);
    expect(deps.adapter.activateImportedUser).toHaveBeenCalledWith("chris", { signal: expect.any(AbortSignal), migrationId, deferRuntimeVerification: true });
    expect(deps.adapter.waitForAccountHealthy).not.toHaveBeenCalled();
    expect(deps.adapter.writeMountMarker).toHaveBeenCalledWith("chris");
  });

  it("resumes a live release that left native cleanup pending before swapping the agent database", async () => {
    const importDir = await mkTempRoot(), procRoot = await mkTempRoot();
    const previous = await writeStore(importDir, CARRIED_STORE, db => db.exec("INSERT INTO transcript_events VALUES ('native')"));
    const target = liveIsolatedTargetImport();
    const releaseAgent = vi.fn(async () => undefined)
      .mockRejectedValueOnce(new Error("[release:octogee-chris-coach] agents.delete failed for octogee-chris-coach (native cleanup incomplete: purgeFailed=true failed=[])"));
    const migrationId = "mig-live-user-pending-cleanup";
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(),
      adapter: { ...target.adapter, releaseAgent }, deps: { ...target.deps, procRoot } });
    await stageSnapshot(stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('carried'), ('carried')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const result = await finishImport(deps, migrationId);

    expect(result.getStatus()).toBe(200);
    expect(releaseAgent.mock.calls).toEqual([["chris", "octogee-chris-coach"], ["chris", "octogee-chris-coach"]]);
    expect(rowCount(previous)).toBe(2);
    expect(deps.adapter.activateImportedUser).toHaveBeenCalledOnce();
  });

  it("does not resume a live release that failed for another reason", async () => {
    const importDir = await mkTempRoot(), procRoot = await mkTempRoot();
    await writeStore(importDir, CARRIED_STORE, db => db.exec("INSERT INTO transcript_events VALUES ('native')"));
    const target = liveIsolatedTargetImport();
    const releaseAgent = vi.fn(async () => { throw new Error("config mutation lock timed out"); });
    const migrationId = "mig-live-isolated-release-refused";
    const { deps, stageDir } = await prepareImport({ migrationId, importDir, daemon: mkFakeChild(),
      adapter: { ...target.adapter, releaseAgent }, deps: { ...target.deps, procRoot } });
    await stageSnapshot(stageDir, db => db.exec("INSERT INTO transcript_events VALUES ('carried')"));
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const result = await finishImport(deps, migrationId);

    expect(result.getStatus()).toBe(500);
    expect(releaseAgent).toHaveBeenCalledOnce();
    expect(deps.adapter.activateImportedUser).not.toHaveBeenCalled();
  });

  async function prepareLiveImport(deps: MigrationHandlerDeps, migrationId: string): Promise<number> {
    const body: PrepareRsyncImportRequestBody = {
      migrationId, slug: "chris", mode: "final", rpcPhase: "prepare-rsync-import",
      transferUser: "migration", transferKey: "c".repeat(64),
    };
    const response = mkResponse();
    await createPrepareRsyncImportHandler(deps)(mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    }), response.res, vi.fn());
    return response.getStatus();
  }

  async function abortLiveImport(deps: MigrationHandlerDeps, migrationId: string): Promise<number> {
    const body: AbortRsyncImportRequestBody = { migrationId, slug: "chris", mode: "final", rpcPhase: "abort-rsync-import" };
    const response = mkResponse();
    await createAbortRsyncImportHandler(deps)(mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    }), response.res, vi.fn());
    return response.getStatus();
  }

  async function unmountLiveImport(deps: MigrationHandlerDeps, migrationId: string): Promise<ReturnType<typeof mkResponse>> {
    const body: UnmountRequestBody = { migrationId, slug: "chris" };
    const response = mkResponse();
    await createUnmountHandler(deps)(mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    }), response.res, vi.fn());
    return response;
  }

  function mountedLiveUserDeps(): MigrationHandlerDeps {
    const target = liveIsolatedTargetImport();
    return mkDeps({ ...target.deps, adapter: mkAdapter({ ...target.adapter, userMountMarked: vi.fn(() => true) }) });
  }

  it("refuses a live user import when the configured user is still mounted", async () => {
    const deps = mountedLiveUserDeps();
    expect(await prepareLiveImport(deps, "mig-live-user-mounted")).toBe(500);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(deps.admitLiveSurgeTarget).not.toHaveBeenCalled();
    expect(deps.adapter.prepareImportDir).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("requires the configured user to be unmounted"), { status: "failed" });
    expectNoHeldGateCalls(deps);
  });

  it("leaves a serving user untouched when aborting a live import it refused to admit", async () => {
    const deps = mountedLiveUserDeps();
    expect(await prepareLiveImport(deps, "mig-live-refused-abort")).toBe(500);
    expect(await abortLiveImport(deps, "mig-live-refused-abort")).toBe(200);
    expect(deps.adapter.removeImportedUserBySlug).not.toHaveBeenCalled();
    expect(deps.adapter.clearMountMarker).not.toHaveBeenCalled();
    expect(deps.adapter.clearUserMigratingIn).not.toHaveBeenCalled();
    expect(deps.adapter.onUnmounted).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("import was never admitted migrationId=mig-live-refused-abort"));
    expectNoHeldGateCalls(deps);
  });

  it("leaves a serving user mounted when rolling back a live import it refused to admit", async () => {
    const deps = mountedLiveUserDeps();
    expect(await prepareLiveImport(deps, "mig-live-refused-unmount")).toBe(500);
    const response = await unmountLiveImport(deps, "mig-live-refused-unmount");
    expect(response.getStatus()).toBe(200);
    expect(response.getBody()).toEqual({ migrationId: "mig-live-refused-unmount", slug: "chris", unmounted: false });
    expect(deps.adapter.removeImportedUserBySlug).not.toHaveBeenCalled();
    expectNoHeldGateCalls(deps);
  });

  it("returns an admitted live user import like a user return on abort, leaving its OpenClaw permitted", async () => {
    const target = liveIsolatedTargetImport();
    const deps = mkDeps({ ...target.deps, adapter: mkAdapter(target.adapter) });
    spawnMock.mockReturnValueOnce(mkFakeChild());
    expect(await prepareLiveImport(deps, "mig-live-user-abort")).toBe(200);
    expect(await abortLiveImport(deps, "mig-live-user-abort")).toBe(200);
    expectNoHeldGateCalls(deps);
    expect(deps.liveSurgeTargetAssigned).toHaveBeenCalledWith({ migrationId: "mig-live-user-abort", slug: "chris", targetPodUid: "builder-pod" });
    expect(deps.pauseSystemConfigWatch).toHaveBeenCalledWith("chris");
    expect(deps.adapter.removeImportedUserBySlug).toHaveBeenCalledExactlyOnceWith("chris");
    expect(deps.adapter.onUnmounted).toHaveBeenCalledWith("chris");
  });

  it.each(["abort", "unmount"] as const)("refuses to %s an admitted live user import once its assignment serves it", async (call) => {
    const target = liveIsolatedTargetImport();
    const deps = mkDeps({ ...target.deps, adapter: mkAdapter(target.adapter), liveSurgeTargetAssigned: vi.fn(async () => true) });
    const migrationId = `mig-live-user-served-${call}`;
    spawnMock.mockReturnValueOnce(mkFakeChild());
    expect(await prepareLiveImport(deps, migrationId)).toBe(200);
    const status = call === "abort" ? await abortLiveImport(deps, migrationId) : (await unmountLiveImport(deps, migrationId)).getStatus();
    expect(status).toBe(500);
    expect(deps.adapter.removeImportedUserBySlug).not.toHaveBeenCalled();
    expectNoHeldGateCalls(deps);
    await abortLiveImport({ ...deps, liveSurgeTargetAssigned: vi.fn(async () => false) }, migrationId);
  });

  it("rolls back an admitted live user import through held target cleanup", async () => {
    const target = liveIsolatedTargetImport();
    const deps = mkDeps({ ...target.deps, adapter: mkAdapter(target.adapter) });
    spawnMock.mockReturnValueOnce(mkFakeChild());
    expect(await prepareLiveImport(deps, "mig-live-user-unmount")).toBe(200);
    const response = await unmountLiveImport(deps, "mig-live-user-unmount");
    expect(response.getStatus()).toBe(200);
    expect(deps.unreserveSurgeTarget).toHaveBeenCalledOnce();
    expect(deps.liveSurgeTargetAssigned).toHaveBeenCalledOnce();
    expect(deps.adapter.removeImportedUserBySlug).toHaveBeenCalledWith("chris", undefined, undefined, expect.objectContaining({ slug: "chris", assertCurrent: expect.any(Function) }));
    expect(await abortLiveImport(deps, "mig-live-user-unmount")).toBe(200);
  });

  it.each([
    { case: "live user restarted in prelaunch", live: true, gate: PRELAUNCH_USER_GATE_STATE, status: 200 },
    { case: "live user left held", live: true, gate: HELD_USER_GATE_STATE, status: 500 },
    { case: "replayed return already restarted in prelaunch", live: false, gate: PRELAUNCH_USER_GATE_STATE, status: 200 },
    { case: "cancelled import left held", live: false, gate: HELD_USER_GATE_STATE, status: 200 },
    { case: "target custody never released", live: false, gate: { ...HELD_USER_GATE_STATE, role: "target" }, status: 500 },
  ] as const)("unmount after user cleanup: $case → $status", async ({ live, gate, status }) => {
    const target = liveIsolatedTargetImport();
    const deps = mkDeps({
      ...target.deps,
      adapter: mkAdapter(target.adapter),
      surgeTargetLive: vi.fn(async () => live),
      unreserveSurgeTarget: vi.fn(async (_request, cleanup) => {
        await cleanup?.(async () => {});
        return gate;
      }),
    });
    const response = await unmountLiveImport(deps, `mig-builder-return-${live}-${gate.role}-${gate.mode}`);
    expect(response.getStatus()).toBe(status);
    expect(deps.adapter.removeImportedUserBySlug).toHaveBeenCalledOnce();
  });

  it("fails the unmount when a live user cannot restart in prelaunch after cleanup", async () => {
    const target = liveIsolatedTargetImport();
    const deps = mkDeps({
      ...target.deps,
      adapter: mkAdapter(target.adapter),
      unreserveSurgeTarget: vi.fn(async (_request, cleanup) => {
        await cleanup?.(async () => {});
        throw new Error("Isolated prelaunch requires its accepted system config");
      }),
    });
    const response = await unmountLiveImport(deps, "mig-builder-return-prelaunch-failed");
    expect(response.getStatus()).toBe(500);
    expect(deps.adapter.removeImportedUserBySlug).toHaveBeenCalledOnce();
  });

  async function unmountAfterRestart(deps: MigrationHandlerDeps, migrationId: string): Promise<ReturnType<typeof mkResponse>> {
    const restarted = await restartedMigrationHandlers();
    const body: UnmountRequestBody = { migrationId, slug: "chris" };
    const response = mkResponse();
    await restarted.createUnmountHandler(deps)(mkRequest(body, {
      signature: signForPod(body.migrationId, JSON.stringify(body)),
    }), response.res, vi.fn());
    return response;
  }

  it("leaves a serving user mounted when a restarted gateway rolls back a live import it refused", async () => {
    const deps = mountedLiveUserDeps();
    expect(await prepareLiveImport(deps, "mig-live-refused-restart")).toBe(500);
    const response = await unmountAfterRestart(deps, "mig-live-refused-restart");
    expect(response.getStatus()).toBe(200);
    expect(response.getBody()).toEqual({ migrationId: "mig-live-refused-restart", slug: "chris", unmounted: false });
    expect(deps.adapter.removeImportedUserBySlug).not.toHaveBeenCalled();
  });

  it("returns an admitted live user import when a restarted gateway rolls it back", async () => {
    const target = liveIsolatedTargetImport();
    const deps = mkDeps({ ...target.deps, adapter: mkAdapter(target.adapter) });
    spawnMock.mockReturnValueOnce(mkFakeChild());
    expect(await prepareLiveImport(deps, "mig-live-admitted-restart")).toBe(200);
    const response = await unmountAfterRestart(deps, "mig-live-admitted-restart");
    expect(response.getStatus()).toBe(200);
    expect(deps.liveSurgeTargetAssigned).toHaveBeenCalledOnce();
    expect(deps.adapter.removeImportedUserBySlug).toHaveBeenCalledWith("chris", undefined, undefined, expect.objectContaining({ slug: "chris", assertCurrent: expect.any(Function) }));
    expect(await abortLiveImport(deps, "mig-live-admitted-restart")).toBe(200);
  });

  it("returns a live user that imported nothing on its own return unmount", async () => {
    const target = liveIsolatedTargetImport();
    const deps = mkDeps({ ...target.deps, adapter: mkAdapter(target.adapter) });
    const response = await unmountLiveImport(deps, "mig-user-return");
    expect(response.getStatus()).toBe(200);
    expect(deps.unreserveSurgeTarget).toHaveBeenCalledOnce();
    expect(deps.liveSurgeTargetAssigned).toHaveBeenCalledExactlyOnceWith({
      migrationId: "mig-user-return", slug: "chris", targetPodUid: "builder-pod",
    });
    expect(deps.adapter.removeImportedUserBySlug).toHaveBeenCalledWith("chris", undefined, undefined, expect.objectContaining({ slug: "chris", assertCurrent: expect.any(Function) }));
  });

  it("refuses to unmount a serving live user that recorded no import for the migration", async () => {
    const target = liveIsolatedTargetImport();
    const deps = mkDeps({ ...target.deps, adapter: mkAdapter(target.adapter), liveSurgeTargetAssigned: vi.fn(async () => true) });
    const response = await unmountLiveImport(deps, "mig-live-unrecorded-serving");
    expect(response.getStatus()).toBe(500);
    expect(deps.adapter.removeImportedUserBySlug).not.toHaveBeenCalled();
    expectNoHeldGateCalls(deps);
  });

  it("refuses to replace a isolated target's database without its process gate status", async () => {
    const importDir = await mkTempRoot();
    const previous = await writeStore(importDir, CARRIED_STORE, () => {});
    const target = isolatedTargetImport(undefined);
    const { deps, stageDir } = await prepareImport({
      migrationId: "mig-carry-user-no-status",
      importDir,
      daemon: mkFakeChild(),
      adapter: target.adapter,
      deps: target.deps,
    });
    await stageSnapshot(stageDir, () => {});
    spawnMock.mockReturnValueOnce(mkFakeChild({ exitCode: 0 }));

    const { getStatus, getBody } = await finishImport(deps, "mig-carry-user-no-status");

    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({ message: expect.stringContaining("process gate status") });
    expect(deps.adapter.releaseAgent).not.toHaveBeenCalled();
    expect(fsSync.existsSync(previous)).toBe(true);
  });

  it("refuses a SQLite import instead of invoking offline upgrade", async () => {
    const importDir = await mkTempRoot();
    const { deps, stageDir } = await prepareImport({ migrationId: "mig-schema-failure", importDir, daemon: mkFakeChild() });
    await stageSnapshot(stageDir, () => {});
    const artifact = path.join(stageDir, STAGED_SNAPSHOT, "database.sqlite");
    const sqlite = new DatabaseSync(artifact); sqlite.exec("DROP TABLE openclaw_engine_anchor"); sqlite.close();
    const bytes = await fs.readFile(artifact);
    await fs.writeFile(path.join(stageDir, STAGED_SNAPSHOT, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      database: { role: "agent", agentId: "octogee-chris-coach" },
      artifact: { path: "database.sqlite", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    }));
    deps.runOpenClaw = vi.fn(async () => ({ code: 1, stdout: JSON.stringify({
      schema: "openclaw.agent-schema-preflight.v1", databasePath: artifact, agentId: "octogee-chris-coach",
      foundVersion: 23, targetVersion: 24, status: "incompatible",
    }) }));
    const { getStatus, getBody } = await finishImport(deps, "mig-schema-failure");
    expect(getStatus()).toBe(500);
    expect(getBody()).toMatchObject({ message: "SQLite agent handoff is unsupported after the PostgreSQL cutover" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(deps.adapter.activateImportedUser).not.toHaveBeenCalled();
    await expect(fs.access(path.join(importDir, CARRIED_STORE))).rejects.toThrow();
  });
});

describe("Git metadata across migration imports", () => {
  async function tempRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-metadata-import-"));
    migrationTempRoots.push(root);
    return root;
  }

  async function importMetadata(sourceDir: string, importDir: string) {
    const adapter = mkAdapter({ prepareImportDir: vi.fn(async () => importDir) });
    const deps = mkDeps({ adapter, waitForRsyncReady: vi.fn(async () => undefined) });
    const migrationId = `mig-git-rsync-${path.basename(sourceDir)}`;
    const spawn = await realMigrationSpawn();
    spawnMock.mockReturnValueOnce(mkFakeChild()).mockImplementation(spawn);
    const prepare: PrepareRsyncImportRequestBody = {
      migrationId, slug: "chris", mode: "final", rpcPhase: "prepare-rsync-import",
      transferUser: "migration", transferKey: "c".repeat(64),
    };
    const prepared = mkResponse();
    await createPrepareRsyncImportHandler(deps)(mkRequest(prepare, {
      signature: signForPod(migrationId, JSON.stringify(prepare)),
    }), prepared.res, vi.fn());
    expect(prepared.getStatus()).toBe(200);
    const args = spawnMock.mock.calls[0][1] as string[];
    const configPath = args.find((arg) => arg.startsWith("--config="))!.slice(9);
    const stageDir = /^\s*path = (.+)$/mu.exec(await fs.readFile(configPath, "utf8"))![1]!;
    await fs.cp(sourceDir, stageDir, { recursive: true, dereference: false });
    const finish: FinishRsyncImportRequestBody = {
      migrationId, slug: "chris", mode: "final", rpcPhase: "finish-rsync-import",
    };
    const response = mkResponse();
    await createFinishRsyncImportHandler(deps)(mkRequest(finish, {
      signature: signForPod(migrationId, JSON.stringify(finish)),
    }), response.res, vi.fn());
    return { ...response, adapter };
  }

  describe("rsync", () => {
    it.each([
      ["git-metadata", "symlink"],
      ["git-metadata/chris", "symlink"],
      ["git-metadata/chris/workspace.git/objects", "symlink"],
      ["git-metadata/chris/workspace.git/objects/info/alternates", "indirection"],
      ["git-metadata/chris/workspace.git/commondir", "indirection"],
      ["git-metadata/chris/projects/demo.git/objects/info/alternates", "indirection"],
      ["git-metadata/chris/workspace.git", "gitfile"],
      ["git-metadata/chris/projects/demo.git", "gitfile"],
    ])("rejects unsafe Git metadata at %s before copying or activating", async (relative, kind) => {
      const sourceDir = await tempRoot();
      const importDir = await tempRoot();
      const outsideDir = await tempRoot();
      const userFile = "customers/chris/draft.txt";
      for (const [root, content] of [[sourceDir, "source draft"], [importDir, "destination draft"]]) {
        await fs.mkdir(path.dirname(path.join(root, userFile)), { recursive: true });
        await fs.writeFile(path.join(root, userFile), content);
      }
      await fs.writeFile(path.join(outsideDir, "sentinel"), "outside metadata");
      const unsafePath = path.join(sourceDir, relative);
      await fs.mkdir(path.dirname(unsafePath), { recursive: true });
      const unsafeContent = `${kind === "gitfile" ? "gitdir: " : ""}${outsideDir}\n`;
      if (kind === "symlink") await fs.symlink(outsideDir, unsafePath);
      else await fs.writeFile(unsafePath, unsafeContent);

      const result = await importMetadata(sourceDir, importDir);

      expect(result.getStatus()).toBe(400);
      expect(result.getBody()).toMatchObject({
        error: "rsync import failed validation",
        message: expect.stringContaining("unsafe Git metadata"),
      });
      expect(spawnMock.mock.calls).toHaveLength(1);
        expect(result.adapter.activateImportedUser).not.toHaveBeenCalled();
      expect(result.adapter.writeMountMarker).not.toHaveBeenCalled();
      expect(result.adapter.onMounted).not.toHaveBeenCalled();
      expect(result.adapter.removePartialWorkspace).not.toHaveBeenCalled();
      expect(result.adapter.deleteDepartedUserState).not.toHaveBeenCalled();
      expect(result.adapter.onUnmounted).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(importDir, userFile), "utf8")).toBe("destination draft");
      expect(await fs.readFile(path.join(sourceDir, userFile), "utf8")).toBe("source draft");
      expect(await fs.readFile(path.join(outsideDir, "sentinel"), "utf8")).toBe("outside metadata");
      if (kind === "symlink") expect(await fs.readlink(unsafePath)).toBe(outsideDir);
      else expect(await fs.readFile(unsafePath, "utf8")).toBe(unsafeContent);
    });

    it("imports user files without Git metadata", async () => {
      const sourceDir = await tempRoot();
      const importDir = await tempRoot();
      await fs.mkdir(path.join(sourceDir, "customers/chris"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, "customers/chris/draft.txt"), "source draft");

      await fs.symlink("/rsyncd-munged/draft.txt", path.join(sourceDir, "customers/chris/draft-link"));
      const result = await importMetadata(sourceDir, importDir);

      expect(result.getStatus()).toBe(200);
      expect(await fs.readlink(path.join(importDir, "customers/chris/draft-link"))).toBe("draft.txt");
      const copies = spawnMock.mock.calls.filter(([command, args]) => command === "/usr/bin/rsync" && args[0] === "-a");
      expect(copies).toHaveLength(2);
      expect(copies.every(([, args]) => args.includes("--munge-links"))).toBe(true);
      expect(await fs.readFile(path.join(importDir, "customers/chris/draft.txt"), "utf8")).toBe("source draft");
      expect(result.adapter.activateImportedUser).toHaveBeenCalledOnce();
    });

    it("copies normal Git metadata unchanged and activates", async () => {
      const sourceDir = await tempRoot();
      const importDir = await tempRoot();
      const files = [
        ["git-metadata/chris/workspace.git/HEAD", "ref: refs/heads/work\n"],
        ["git-metadata/chris/workspace.git/config", "[core]\n\tbare = false\n"],
        ["git-metadata/chris/workspace.git/refs/heads/work", `${"1".repeat(40)}\n`],
        ["git-metadata/chris/workspace.git/objects/ab/cdef", "object contents"],
        ["git-metadata/chris/projects/demo.git/HEAD", "ref: refs/heads/commondir\n"],
        ["git-metadata/chris/projects/demo.git/refs/heads/commondir", `${"2".repeat(40)}\n`],
        ["customers/chris/draft.txt", "source draft"],
      ];
      for (const [relative, content] of files) {
        await fs.mkdir(path.dirname(path.join(sourceDir, relative)), { recursive: true });
        await fs.writeFile(path.join(sourceDir, relative), content);
      }

      const result = await importMetadata(sourceDir, importDir);

      expect(result.getStatus(), JSON.stringify(result.getBody())).toBe(200);
      for (const [relative, content] of files) {
        expect(await fs.readFile(path.join(importDir, relative), "utf8")).toBe(content);
      }
      expect(result.adapter.activateImportedUser).toHaveBeenCalledOnce();
    });
  });
});

describe("findPathTraversalViolation — no permanent operator lane", () => {
  it("rejects every legacy operator agent directory", () => {
    expect(
      findPathTraversalViolation(
        ["agents/octogee-ops-eggman/sessions/sessions.json"],
        "eggman",
      ),
    ).toContain("outside the per-slug allowlist");
  });
});

describe("findPathTraversalViolation", () => {
  const slug = "chris";

  it("returns null for a clean tarball", () => {
    expect(findPathTraversalViolation([
      "agents/octogee-chris-coach/sessions/sessions.json",
      "agents/octogee-chris-coach/",
      "memory/octogee-chris-coach.sqlite",
      "memory/octogee-chris-coach.sqlite-shm",
      "customers/chris/.git/config",
      "customer-keys/chris/id_ed25519",
      ".octogee-migration-activation/chris/activation.json",
    ], slug)).toBeNull();
  });

  it("accepts project-agent state paths owned by the migrating user", () => {
    expect(findPathTraversalViolation([
      "agents/octogee-chris-proj-cityscout-coach/sessions/sessions.json",
      "agents/octogee-chris-proj-cityscout-coach/",
      "memory/octogee-chris-proj-cityscout-coach.sqlite",
      "memory/octogee-chris-proj-cityscout-coach.sqlite-wal",
      "memory/octogee-chris-proj-cityscout-coach.sqlite-shm",
    ], slug)).toBeNull();
  });

  it("accepts opaque user agent state only when the configured safe ID is allowlisted", () => {
    const state = [
      "agents/discord-helper/agent/auth.json",
      "agents/discord-helper/sessions/session.json",
      "memory/discord-helper.sqlite",
    ];
    expect(findPathTraversalViolation(state, slug, "final", ["discord-helper"])).toBeNull();
    expect(findPathTraversalViolation(state, slug, "final")).toContain(
      "outside the per-slug allowlist",
    );
    expect(findPathTraversalViolation(state, slug, "final", ["../outside"])).toContain(
      "outside the per-slug allowlist",
    );
  });

  it("accepts bare directory entries that match a prefix exactly", () => {
    expect(findPathTraversalViolation([
      "customers/chris",
      "customers/chris/",
      "customer-keys/chris",
      ".octogee-migration-activation/chris",
    ], slug)).toBeNull();
  });

  it("accepts rsync --relative parent directory entries", () => {
    expect(findPathTraversalViolation([
      "customers/",
      "customers/chris/",
      "customer-keys/",
      "customer-keys/chris/",
      "memory/",
      "memory/octogee-chris-coach.sqlite",
      ".octogee-migration-activation/",
      ".octogee-migration-activation/chris/",
    ], slug)).toBeNull();
  });

  it("accepts the customer-keys parent directory during keys-only transfer", () => {
    expect(findPathTraversalViolation([
      "customer-keys/",
      "customer-keys/chris/",
      "customer-keys/chris/id_ed25519",
    ], slug, "keys")).toBeNull();
  });

  it.each(["pre", "final"] as const)(
    "accepts an empty customer-keys parent during %s surge import",
    (mode) => {
      expect(findPathTraversalViolation([
        "customer-keys/",
      ], slug, mode)).toBeNull();
    },
  );

  it.each(["pre", "final"] as const)(
    "rejects pod-local user keys during %s surge import",
    (mode) => {
      expect(findPathTraversalViolation([
        "customer-keys/chris/id_ed25519",
      ], slug, mode)).toContain("outside the per-slug allowlist");
    },
  );

  it("rejects an absolute-path entry", () => {
    expect(findPathTraversalViolation(["/etc/passwd"], slug)).toContain("absolute path");
  });

  it("rejects a `..` segment", () => {
    expect(findPathTraversalViolation(["customers/chris/../../../etc/passwd"], slug)).toContain("path traversal");
  });

  it("rejects a leading `..`", () => {
    expect(findPathTraversalViolation(["../etc/passwd"], slug)).toContain("path traversal");
  });

  it("does NOT false-positive on legitimate names containing `..`", () => {
    expect(findPathTraversalViolation([
      "customers/chris/notes/foo..bar.txt",
    ], slug)).toBeNull();
  });

  it("rejects a path for a different slug (cross-user escape)", () => {
    expect(findPathTraversalViolation([
      "customers/other/secrets",
    ], slug)).toContain("outside the per-slug allowlist");
  });

  it("rejects another slug below an allowed parent directory", () => {
    expect(findPathTraversalViolation([
      "customer-keys/",
      "customer-keys/other/id_ed25519",
    ], slug, "keys")).toContain("outside the per-slug allowlist");
  });

  it("rejects a truncated file-prefix match", () => {
    expect(findPathTraversalViolation([
      "memory/octogee-chris-coach.sqlit",
    ], slug)).toContain("outside the per-slug allowlist");
  });

  it("rejects an unknown top-level directory", () => {
    expect(findPathTraversalViolation([
      "etc/openclaw.json",
    ], slug)).toContain("outside the per-slug allowlist");
  });

  it("rejects an agent dir for a different slug", () => {
    expect(findPathTraversalViolation([
      "agents/octogee-attacker-coach/sessions.json",
    ], slug)).toContain("outside the per-slug allowlist");
  });

  it("rejects project agent state for another user", () => {
    expect(findPathTraversalViolation([
      "agents/octogee-attacker-proj-cityscout-coach/sessions.json",
    ], slug)).toContain("outside the per-slug allowlist");
    expect(findPathTraversalViolation([
      "memory/octogee-attacker-proj-cityscout-coach.sqlite",
    ], slug)).toContain("outside the per-slug allowlist");
  });

  it("rejects neutral route agent state even when a configured user plan includes it", () => {
    const configuredUserStatePlan: ConfiguredUserPortableStatePlan = {
      agentIds: ["octogee-unmatched-route"],
      agentDirs: ["agents/octogee-unmatched-route/agent"],
      sessionStorePaths: ["agents/octogee-unmatched-route/sessions/sessions.json"],
      paths: [
        { relativePath: "agents/octogee-unmatched-route", kind: "directory" },
        { relativePath: "workspace-octogee-unmatched-route", kind: "directory" },
        { relativePath: "workspaces/octogee-unmatched-route", kind: "directory" },
        { relativePath: "memory/octogee-unmatched-route.sqlite", kind: "file" },
      ],
    };
    expect(findPathTraversalViolation([
      "agents/octogee-unmatched-route/",
      "workspace-octogee-unmatched-route/",
      "workspaces/octogee-unmatched-route/",
      "memory/octogee-unmatched-route.sqlite",
    ], slug, "final", [], configuredUserStatePlan)).toContain("outside the per-slug allowlist");
  });

  it("returns the FIRST violation found (deterministic for ops messages)", () => {
    const v = findPathTraversalViolation([
      "customers/chris/ok.txt",
      "/etc/passwd",
      "../also-bad",
    ], slug);
    expect(v).toContain("absolute path");
    expect(v).toContain("/etc/passwd");
  });
});


describe("destination migration progress", () => {
  it("accepts the migration runner's rollback phase names", async () => {
    const body = { migrationId: "mig-1", slug: "chris", source: "gw-old", phase: "rollback:unmount-target", status: "running" };
    const { res, getStatus } = mkResponse();
    await createMigrationProgressHandler(mkDeps())(mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), res, vi.fn());
    expect(getStatus()).toBe(200);
  });
  it.each(["running", "pending", "done", "failed"])("logs %s as structured progress", async (status) => {
    const body = { migrationId: "mig-1", slug: "chris", source: "gw-old", phase: "quiesce-source", status, elapsedMs: 123 };
    const deps = mkDeps();
    const { res, getStatus } = mkResponse();
    await createMigrationProgressHandler(deps)(mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), res, vi.fn());
    expect(getStatus()).toBe(200);
    expect(deps.log).toHaveBeenCalledWith("Migration quiesce-source", expect.objectContaining({ builderSlug: "chris", operationId: "mig-1", sourceGateway: "gw-old", gatewayId: "gw-a", phase: "quiesce-source", status, durationMs: 123 }));
  });
  it.each([{ status: "green" }, { phase: "x\ninjected" }, { elapsedMs: -1 }, { source: "x\ninjected" }])("rejects malformed progress %j", async (invalid) => {
    const body = { migrationId: "mig-1", slug: "chris", source: "gw-old", phase: "copy", status: "done", elapsedMs: 1, ...invalid };
    const { res, getStatus } = mkResponse();
    await createMigrationProgressHandler(mkDeps())(mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), res, vi.fn());
    expect(getStatus()).toBe(400);
  });
  it("rejects unsigned progress", async () => {
    const { res, getStatus } = mkResponse();
    await createMigrationProgressHandler(mkDeps())(mkRequest({ migrationId: "mig-1", slug: "chris" }), res, vi.fn());
    expect(getStatus()).toBe(401);
  });
});

describe("createResumeHandler", () => {
  it("reclaims the retained key before resuming the signed user's channels and voice", async () => {
    let releaseClaim!: () => void;
    const claimPending = new Promise<void>(resolve => { releaseClaim = resolve; });
    const adapter = mkAdapter({ gitHost: mkGitHost({ registerKey: vi.fn(() => claimPending) }) });
    const deps = mkDeps({ adapter });
    const body = { migrationId: SAMPLE_QUIESCE.migrationId, slug: "chris" };
    const response = mkResponse();
    const resumed = createResumeHandler(deps)(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    try {
      expect(adapter.gitHost.registerKey).toHaveBeenCalledExactlyOnceWith("chris", "ssh-ed25519 LOCAL chris@gateway");
      expect(adapter.resumeUser).not.toHaveBeenCalled();
      expect(deps.voiceMigration).not.toHaveBeenCalled();
    } finally {
      releaseClaim();
      await resumed;
    }
    expect(response.getStatus()).toBe(200);
    expect(adapter.resumeUser).toHaveBeenCalledExactlyOnceWith("chris", { migrationId: body.migrationId });
    expect(deps.voiceMigration).toHaveBeenCalledExactlyOnceWith({ slug: "chris", operationId: body.migrationId, phase: "resume" });
  });

  it.each(["missing-key", "broker-failure"])("refuses resume effects after %s", async failure => {
    const adapter = mkAdapter(failure === "missing-key"
      ? { readLocalUserPubKey: vi.fn(() => null) }
      : { gitHost: mkGitHost({ registerKey: vi.fn(async () => { throw new Error("key reclaim denied"); }) }) });
    const deps = mkDeps({ adapter });
    const body = { migrationId: SAMPLE_QUIESCE.migrationId, slug: "chris" };
    const response = mkResponse();
    await createResumeHandler(deps)(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(500);
    expect(response.getBody()).toEqual({
      error: "resume failed",
      message: failure === "missing-key" ? "[migration-http] local SSH public key is missing for chris" : "key reclaim denied",
    });
    expect(adapter.resumeUser).not.toHaveBeenCalled();
    expect(deps.voiceMigration).not.toHaveBeenCalled();
    if (failure === "missing-key") expect(adapter.gitHost.registerKey).not.toHaveBeenCalled();
  });

  it("reclaims the source key so a stale failed target release cannot remove it", async () => {
    const sourceOwner = "builder/source-pod";
    const targetOwner = "shared/failed-target-pod";
    const inheritedKey = "ssh-ed25519 INHERITED chris@gateway";
    const keyTitle = (owner: string) => `octogee-gateway-${createHash("sha256").update(owner).digest("hex").slice(0, 16)}`;
    let keys: Array<{ id: number; title: string; key: string }> = [];
    let nextKeyId = 1;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const pathname = new URL(url).pathname;
      if (method === "POST" && pathname === "/api/v1/admin/users") return new globalThis.Response("{}", { status: 422 });
      if (method === "GET" && pathname === "/api/v1/users/ws-chris/keys") return globalThis.Response.json(keys);
      if (method === "DELETE" && pathname.startsWith("/api/v1/admin/users/ws-chris/keys/")) {
        keys = keys.filter(key => key.id !== Number(pathname.split("/").at(-1)));
        return new globalThis.Response(null, { status: 204 });
      }
      if (method === "POST" && pathname === "/api/v1/admin/users/ws-chris/keys") {
        const body = JSON.parse(String(init?.body)) as { title: string; key: string };
        keys.push({ id: nextKeyId++, ...body });
        return globalThis.Response.json({}, { status: 201 });
      }
      throw new Error(`unexpected Gitea request: ${method} ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { createGiteaGitHost } = await import("@octogee/core/git-host");
      const gitea = createGiteaGitHost({
        apiBaseUrl: "http://gitea.test:3000/api/v1",
        token: () => "synthetic-admin-token",
      });
      await gitea.registerKey("chris", inheritedKey, sourceOwner);
      await gitea.registerKey("chris", inheritedKey, targetOwner);
      expect(keys).toEqual([{ id: 2, title: keyTitle(targetOwner), key: inheritedKey }]);
      const adapter = mkAdapter({
        readLocalUserPubKey: vi.fn(() => inheritedKey),
        gitHost: mkGitHost({ registerKey: vi.fn((slug, key) => gitea.registerKey(slug, key, sourceOwner)) }),
        resumeUser: vi.fn(async () => {
          expect(keys).toEqual([{ id: 3, title: keyTitle(sourceOwner), key: inheritedKey }]);
        }),
      });
      const deps = mkDeps({ adapter });
      const body = { migrationId: SAMPLE_QUIESCE.migrationId, slug: "chris" };
      const response = mkResponse();
      await createResumeHandler(deps)(
        mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
      );
      expect(response.getStatus()).toBe(200);
      expect(adapter.resumeUser).toHaveBeenCalledExactlyOnceWith("chris", { migrationId: body.migrationId });
      await gitea.releaseKey("chris", inheritedKey, targetOwner);
      expect(keys).toEqual([{ id: 3, title: keyTitle(sourceOwner), key: inheritedKey }]);
      const retried = mkResponse();
      await createResumeHandler(deps)(
        mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), retried.res, vi.fn(),
      );
      expect(retried.getStatus()).toBe(200);
      expect(keys).toEqual([{ id: 3, title: keyTitle(sourceOwner), key: inheritedKey }]);
      expect(adapter.gitHost.registerKey).toHaveBeenCalledTimes(2);
      expect(adapter.resumeUser).toHaveBeenCalledTimes(2);
      expect(deps.voiceMigration).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports the user provisioned once it resumes as the target of a cutover", async () => {
    const order: string[] = [];
    const adapter = mkAdapter({
      resumeUser: vi.fn(async () => { order.push("resume"); }),
      reportProvisioned: vi.fn(async () => { order.push("report"); }),
    });
    const deps = mkDeps({ adapter });
    const body = { migrationId: SAMPLE_QUIESCE.migrationId, slug: "chris", role: "target" as const };
    const response = mkResponse();
    await createResumeHandler(deps)(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(200);
    expect(adapter.reportProvisioned).toHaveBeenCalledExactlyOnceWith({ uid: "uid-chris", slug: "chris" }, { first: false });
    expect(order).toEqual(["resume", "report"]);
  });

  it("keeps a resumed target serving and logs when its provisioned report fails", async () => {
    const adapter = mkAdapter({ reportProvisioned: vi.fn(async () => { throw new Error("broker unavailable"); }) });
    const deps = mkDeps({ adapter });
    const body = { migrationId: SAMPLE_QUIESCE.migrationId, slug: "chris", role: "target" as const };
    const response = mkResponse();
    await createResumeHandler(deps)(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(200);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("provisioned report failed slug=chris: broker unavailable"),
      { status: "failed" },
    );
  });

  it("does not report a source that resumes after a rollback", async () => {
    const adapter = mkAdapter();
    const deps = mkDeps({ adapter });
    const body = { migrationId: SAMPLE_QUIESCE.migrationId, slug: "chris" };
    const response = mkResponse();
    await createResumeHandler(deps)(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(200);
    expect(adapter.reportProvisioned).not.toHaveBeenCalled();
  });

  it("does not resume channels without a valid signature", async () => {
    const adapter = mkAdapter();
    const deps = mkDeps({ adapter });
    const response = mkResponse();
    await createResumeHandler(deps)(mkRequest(SAMPLE_QUIESCE, { signature: "bad" }), response.res, vi.fn());
    expect(response.getStatus()).toBe(401);
    expect(adapter.readLocalUserPubKey).not.toHaveBeenCalled();
    expect(adapter.gitHost.registerKey).not.toHaveBeenCalled();
    expect(adapter.resumeUser).not.toHaveBeenCalled();
    expect(deps.voiceMigration).not.toHaveBeenCalled();
  });
});


describe("scheduler readiness signed endpoint", () => {
  const body = { migrationId: "m1", slug: "chris" };
  const signed = () => mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) });
  it("confirms readiness only after a gateway RPC connects, and never touches cron.migration", async () => {
    const schedulerReady = vi.fn(async () => undefined);
    const schedulerMigration = vi.fn();
    const response = mkResponse();
    await createSchedulerReadyHandler(mkDeps({ adapter: mkAdapter({ schedulerReady, schedulerMigration }) }))(signed(), response.res, vi.fn());
    expect(response.getStatus()).toBe(200);
    expect(response.getBody()).toEqual({ ready: true });
    expect(schedulerReady).toHaveBeenCalledOnce();
    expect(schedulerMigration).not.toHaveBeenCalled();
  });
  it("reports why the scheduler is not ready", async () => {
    const schedulerReady = vi.fn(async () => { throw new Error("OpenClaw workspace identities are not initialized for this boot"); });
    const response = mkResponse();
    await createSchedulerReadyHandler(mkDeps({ adapter: mkAdapter({ schedulerReady }) }))(signed(), response.res, vi.fn());
    expect(response.getStatus()).toBe(500);
    expect(response.getBody()).toEqual({ error: "scheduler readiness failed", message: "OpenClaw workspace identities are not initialized for this boot" });
  });
  it("rejects an unsigned readiness probe", async () => {
    const schedulerReady = vi.fn();
    const response = mkResponse();
    await createSchedulerReadyHandler(mkDeps({ adapter: mkAdapter({ schedulerReady }) }))(mkRequest(body, {}), response.res, vi.fn());
    expect(response.getStatus()).toBe(401);
    expect(schedulerReady).not.toHaveBeenCalled();
  });
});

describe("scheduler migration signed endpoint", () => {
  const body = { migrationId: "handoff-1", slug: "chris", phase: "hold" as const };
  it("rejects unsigned scheduler commands", async () => {
    const schedulerMigration = vi.fn();
    const response = mkResponse();
    await createSchedulerMigrationHandler(mkDeps({ adapter: mkAdapter({ schedulerMigration }) }))(mkRequest(body, {}), response.res, vi.fn());
    expect(response.getStatus()).toBe(401);
    expect(schedulerMigration).not.toHaveBeenCalled();
  });
  it("holds schedules under the authenticated handoff identity", async () => {
    const result = { operationId: body.migrationId, phase: body.phase, agentIds: ["octogee-chris-coach"], drained: true };
    const schedulerMigration = vi.fn(async () => result);
    const response = mkResponse();
    await createSchedulerMigrationHandler(mkDeps({ adapter: mkAdapter({ schedulerMigration }) }))(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(200);
    expect(response.getBody()).toEqual(result);
    expect(schedulerMigration).toHaveBeenCalledWith("chris", { operationId: "handoff-1", phase: "hold" });
  });
  it.each([
    [new OpenclawWireError("connect-failed", "socket closed before cron.migration response"), true],
    [new OpenclawWireError("timeout", "cron.migration response timed out after 30000ms"), true],
    [new OpenclawWireError("rpc-error", "Cron migration snapshot contains unsettled runs"), true],
    [new OpenclawWireError("rpc-error", "Cron migration requires an explicit owner for legacy default-agent jobs"), false],
    [new SchedulerRefusal("Cannot hold scheduler for chris: no user agents"), false],
    [new Error("ENOENT: no such file or directory, open '/home/node/.openclaw/openclaw.json'"), true],
  ] as const)("says whether a failed scheduler command may yet succeed: %s", async (error, retryable) => {
    const schedulerMigration = vi.fn(async () => { throw error; });
    const response = mkResponse();
    await createSchedulerMigrationHandler(mkDeps({ adapter: mkAdapter({ schedulerMigration }), log: vi.fn() }))(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(500);
    expect(response.getBody()).toEqual({ error: "scheduler migration failed", message: error.message, retryable });
  });
  it("does not report a draining scheduler as ready", async () => {
    const schedulerMigration = vi.fn(async () => ({ operationId: body.migrationId, phase: body.phase, agentIds: ["octogee-chris-coach"], drained: false }));
    const response = mkResponse();
    await createSchedulerMigrationHandler(mkDeps({ adapter: mkAdapter({ schedulerMigration }) }))(
      mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(409);
  });
  it.each(["shared-operator", null])("forwards the destination requester in a partial export (%s)", async targetRequesterProfileId => {
    const partial = { ...body, phase: "export" as const, retainNonportable: true, targetRequesterProfileId };
    const result = { operationId: partial.migrationId, phase: "export", agentIds: ["octogee-chris-coach"], drained: true, snapshot: { retainedJobIds: ["desktop-watch"] } };
    const schedulerMigration = vi.fn(async () => result);
    const response = mkResponse();
    await createSchedulerMigrationHandler(mkDeps({ adapter: mkAdapter({ schedulerMigration }) }))(
      mkRequest(partial, { signature: signForPod(partial.migrationId, JSON.stringify(partial)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(200);
    expect(schedulerMigration).toHaveBeenCalledWith("chris", { operationId: "handoff-1", phase: "export", retainNonportable: true, targetRequesterProfileId });
  });
  it("returns the staging requester through the signed scheduler route", async () => {
    const probe = { ...body, phase: "stage-requester" as const };
    const result = { operationId: body.migrationId, phase: probe.phase, agentIds: [], drained: true, stageRequesterProfileId: "shared-operator" };
    const schedulerMigration = vi.fn(async () => result);
    const response = mkResponse();
    await createSchedulerMigrationHandler(mkDeps({ adapter: mkAdapter({ schedulerMigration }) }))(
      mkRequest(probe, { signature: signForPod(probe.migrationId, JSON.stringify(probe)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(200);
    expect(response.getBody()).toEqual(result);
    expect(schedulerMigration).toHaveBeenCalledWith("chris", { operationId: body.migrationId, phase: probe.phase });
  });
  it("resolves the initial export scope only when explicitly requested", async () => {
    const initial = { ...body, phase: "export", resolveAgentScope: true };
    const schedulerMigration = vi.fn(async () => ({ operationId: body.migrationId, phase: "export", agentIds: ["octogee-chris-coach"], drained: true }));
    const response = mkResponse();
    await createSchedulerMigrationHandler(mkDeps({ adapter: mkAdapter({ schedulerMigration }) }))(
      mkRequest(initial, { signature: signForPod(initial.migrationId, JSON.stringify(initial)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(200);
    expect(schedulerMigration).toHaveBeenCalledWith("chris", { operationId: "handoff-1", phase: "export", resolveAgentScope: true });
  });
  it("rejects initial scope resolution mixed with another phase or an explicit scope", async () => {
    for (const invalid of [{ ...body, resolveAgentScope: true }, { ...body, phase: "export", resolveAgentScope: false },
      { ...body, phase: "export", resolveAgentScope: true, agentIds: ["octogee-chris-coach"] }]) {
      const schedulerMigration = vi.fn();
      const response = mkResponse();
      await createSchedulerMigrationHandler(mkDeps({ adapter: mkAdapter({ schedulerMigration }) }))(
        mkRequest(invalid, { signature: signForPod(invalid.migrationId, JSON.stringify(invalid)) }), response.res, vi.fn(),
      );
      expect(response.getStatus()).toBe(400);
      expect(schedulerMigration).not.toHaveBeenCalled();
    }
  });
  it("rejects a partial flag that is not a boolean or names a phase that cannot retain", async () => {
    for (const invalid of [{ ...body, retainNonportable: "yes" }, { ...body, phase: "retire", retainNonportable: true }]) {
      const schedulerMigration = vi.fn();
      const response = mkResponse();
      await createSchedulerMigrationHandler(mkDeps({ adapter: mkAdapter({ schedulerMigration }) }))(
        mkRequest(invalid, { signature: signForPod(invalid.migrationId, JSON.stringify(invalid)) }), response.res, vi.fn(),
      );
      expect(response.getStatus()).toBe(400);
      expect(schedulerMigration).not.toHaveBeenCalled();
    }
  });
  it("rejects staging without a snapshot before calling the runtime", async () => {
    const invalid = { ...body, phase: "stage" };
    const schedulerMigration = vi.fn();
    const response = mkResponse();
    await createSchedulerMigrationHandler(mkDeps({ adapter: mkAdapter({ schedulerMigration }) }))(
      mkRequest(invalid, { signature: signForPod(invalid.migrationId, JSON.stringify(invalid)) }), response.res, vi.fn(),
    );
    expect(response.getStatus()).toBe(400);
    expect(schedulerMigration).not.toHaveBeenCalled();
  });
});

describe("schedule transfer signed endpoint", () => {
  const snapshot = { migrationId: "move-1", slug: "chris", op: "snapshot" as const };
  const record = { sourceJobId: "job-1", agentId: "octogee-chris-coach", job: { name: "Morning brief", agentId: "octogee-chris-coach" } };
  const restore = { migrationId: "move-1", slug: "chris", op: "restore" as const, records: [record] };
  const remove = { migrationId: "move-1", slug: "chris", op: "remove" as const, jobIds: ["job-1"] };
  const check = { migrationId: "move-1", slug: "chris", op: "check" as const, records: [record] };
  const signed = (body: { migrationId: string }) => mkRequest(body, { signature: signForPod(body.migrationId, JSON.stringify(body)) });

  it("rejects an unsigned schedule transfer", async () => {
    const scheduleTransfer = vi.fn();
    const response = mkResponse();
    await createScheduleTransferHandler(mkDeps({ scheduleTransfer }))(mkRequest(snapshot, {}), response.res, vi.fn());
    expect(response.getStatus()).toBe(401);
    expect(scheduleTransfer).not.toHaveBeenCalled();
  });
  it("snapshots the user's schedules under the authenticated migration", async () => {
    const result = { ...snapshot, records: [record], skipped: [] };
    const scheduleTransfer = vi.fn(async () => result);
    const response = mkResponse();
    await createScheduleTransferHandler(mkDeps({ scheduleTransfer }))(signed(snapshot), response.res, vi.fn());
    expect(response.getStatus()).toBe(200);
    expect(response.getBody()).toEqual(result);
    expect(scheduleTransfer).toHaveBeenCalledWith(snapshot);
  });
  it("restores the recorded schedules", async () => {
    const result = { migrationId: "move-1", slug: "chris", op: "restore", created: 1, existing: 0, failed: [] };
    const scheduleTransfer = vi.fn(async () => result);
    const response = mkResponse();
    await createScheduleTransferHandler(mkDeps({ scheduleTransfer }))(signed(restore), response.res, vi.fn());
    expect(response.getStatus()).toBe(200);
    expect(response.getBody()).toEqual(result);
    expect(scheduleTransfer).toHaveBeenCalledWith(restore);
  });
  it("removes the saved source jobs", async () => {
    const result = { ...remove, removed: 1, failed: [] };
    const scheduleTransfer = vi.fn(async () => result);
    const response = mkResponse();
    await createScheduleTransferHandler(mkDeps({ scheduleTransfer }))(signed(remove), response.res, vi.fn());
    expect(response.getStatus()).toBe(200);
    expect(response.getBody()).toEqual(result);
    expect(scheduleTransfer).toHaveBeenCalledWith(remove);
  });
  it("checks records against the live schedules", async () => {
    const result = { migrationId: "move-1", slug: "chris", op: "check", conflicts: [] };
    const scheduleTransfer = vi.fn(async () => result);
    const response = mkResponse();
    await createScheduleTransferHandler(mkDeps({ scheduleTransfer }))(signed(check), response.res, vi.fn());
    expect(response.getStatus()).toBe(200);
    expect(response.getBody()).toEqual(result);
    expect(scheduleTransfer).toHaveBeenCalledWith(check);
  });
  it("rejects an unknown op or malformed records before touching the scheduler", async () => {
    for (const invalid of [
      { ...snapshot, op: "export" },
      { ...remove, jobIds: undefined },
      { ...remove, jobIds: ["job-1", ""] },
      { ...remove, jobIds: [7] },
      { ...restore, records: undefined },
      { ...restore, records: [{ ...record, agentId: "" }] },
      { ...restore, records: [{ ...record, job: ["name"] }] },
      { ...restore, records: [{ ...record, sourceJobId: 7 }] },
      { ...check, records: undefined },
      { ...check, records: [{ ...record, agentId: "" }] },
    ]) {
      const scheduleTransfer = vi.fn();
      const response = mkResponse();
      await createScheduleTransferHandler(mkDeps({ scheduleTransfer }))(signed(invalid), response.res, vi.fn());
      expect(response.getStatus()).toBe(400);
      expect(response.getBody()).toEqual({ error: "invalid schedule transfer request" });
      expect(scheduleTransfer).not.toHaveBeenCalled();
    }
  });
  it("reports and logs why a transfer failed", async () => {
    const log = vi.fn();
    const scheduleTransfer = vi.fn(async () => { throw new Error("gateway down"); });
    const response = mkResponse();
    await createScheduleTransferHandler(mkDeps({ scheduleTransfer, log }))(signed(snapshot), response.res, vi.fn());
    expect(response.getStatus()).toBe(500);
    expect(response.getBody()).toEqual({ error: "schedule transfer failed", message: "gateway down", retryable: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("gateway down"), expect.anything());
  });
  it.each([
    [new OpenclawWireError("timeout", "cron.list response timed out after 30000ms"), true],
    [new OpenclawWireError("connect-failed", "socket closed before cron.list response"), true],
    [new OpenclawWireError("rpc-error", "cron.list refused"), false],
    [new Error("ENOENT: no such file or directory, open '/home/node/.openclaw/openclaw.json'"), true],
  ] as const)("says whether a failed transfer may yet succeed: %s", async (error, retryable) => {
    const scheduleTransfer = vi.fn(async () => { throw error; });
    const response = mkResponse();
    await createScheduleTransferHandler(mkDeps({ scheduleTransfer, log: vi.fn() }))(signed(restore), response.res, vi.fn());
    expect(response.getStatus()).toBe(500);
    expect(response.getBody()).toEqual({ error: "schedule transfer failed", message: error.message, retryable });
  });
  it("fails loudly on a gateway without schedule transfer wiring", async () => {
    const response = mkResponse();
    await createScheduleTransferHandler(mkDeps())(signed(snapshot), response.res, vi.fn());
    expect(response.getStatus()).toBe(500);
    expect(response.getBody()).toEqual({ error: "schedule transfer failed", message: "schedule transfer is not configured", retryable: false });
  });
});

describe("prepared migration staging", () => {
  it.each([false, true])("acknowledges keys completion only after releasing the import session (disconnect=%s)", async disconnected => {
    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), "keys-finish-cleanup-"));
    migrationTempRoots.push(importDir);
    let releaseCleanup!: () => void;
    const cleanupHeld = new Promise<void>(resolve => { releaseCleanup = resolve; });
    const closeTransport = vi.fn(async () => undefined)
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => cleanupHeld);
    const deps = mkDeps({
      adapter: mkAdapter({ prepareKeyImportDir: vi.fn(async () => importDir), prepareImportDir: vi.fn(async () => importDir) }),
      waitForRsyncReady: vi.fn(async () => undefined),
      openMigrationTlsEndpoint: vi.fn(async () => ({ certificatePem: TARGET_CERTIFICATE_PEM, close: closeTransport })),
    });
    const migrationId = "keys-finish-cleanup";
    const prepare = { migrationId, slug: "chris", mode: "keys", rpcPhase: "prepare-rsync-import", transferUser: "migration", transferKey: "d".repeat(64) };
    spawnMock.mockReturnValueOnce(mkFakeChild());
    const prepared = mkResponse();
    const prepareHandler = createPrepareRsyncImportHandler(deps);
    await prepareHandler(mkRequest(prepare, { signature: signForPod(migrationId, JSON.stringify(prepare)) }), prepared.res, vi.fn());
    expect(prepared.getStatus()).toBe(200);
    spawnMock.mockImplementation(() => mkFakeChild({ exitCode: 0 }));
    const finish = { migrationId, slug: "chris", mode: "keys", rpcPhase: "finish-rsync-import" };
    const next = { ...prepare, mode: "final" };
    const finished = mkResponse(), nextPrepared = mkResponse();
    const send = finished.res.json.bind(finished.res);
    let nextPreparation: Promise<unknown> | undefined;
    vi.spyOn(finished.res, "json").mockImplementation(payload => {
      const response = send(payload);
      if (payload.imported === true) nextPreparation = Promise.resolve(prepareHandler(mkRequest(next, { signature: signForPod(migrationId, JSON.stringify(next)) }), nextPrepared.res, vi.fn()));
      return response;
    });
    const finishing = createFinishRsyncImportHandler(deps)(mkRequest(finish, { signature: signForPod(migrationId, JSON.stringify(finish)) }), finished.res, vi.fn());
    try {
      await vi.waitFor(() => expect(closeTransport).toHaveBeenCalledTimes(2));
      expect(finished.getBody()).toBeUndefined();
      expect(nextPreparation).toBeUndefined();
      const abort = { ...finish, rpcPhase: "abort-rsync-import" };
      const abortResponse = mkResponse();
      await createAbortRsyncImportHandler(deps)(mkRequest(abort, { signature: signForPod(migrationId, JSON.stringify(abort)) }), abortResponse.res, vi.fn());
      expect(abortResponse.getStatus()).toBe(409);
      if (disconnected) finished.res.emit("close");
    } finally {
      releaseCleanup();
      await finishing;
      await nextPreparation;
      const abort = { migrationId, slug: "chris", mode: "final", rpcPhase: "abort-rsync-import" };
      await createAbortRsyncImportHandler(deps)(mkRequest(abort, { signature: signForPod(migrationId, JSON.stringify(abort)) }), mkResponse().res, vi.fn());
    }
    expect(finished.getStatus()).toBe(disconnected ? 499 : 200);
    expect(nextPrepared.getStatus()).toBe(disconnected ? undefined : 200);
  });

  it("finishes a Shared import before ownership moves and removes source-deleted projects", async () => {
    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-prepared-import-"));
    migrationTempRoots.push(importDir);
    const uidForSlug = vi.fn(async () => null);
    const loadUserSnapshot = vi.fn();
    const deps = mkDeps({
      adapter: mkAdapter({ isIsolatedGateway: () => false, uidForSlug, loadUserSnapshot,
        prepareImportDir: vi.fn(async () => importDir) }),
      waitForRsyncReady: vi.fn(async () => undefined),
    });
    const migrationId = "shared-unassigned-final-import";
    const prepare = async (mode: "pre" | "final") => {
      spawnMock.mockReturnValueOnce(mkFakeChild());
      const body = { migrationId, slug: "chris", mode, rpcPhase: "prepare-rsync-import", transferUser: "migration", transferKey: "c".repeat(64) };
      const response = mkResponse();
      await createPrepareRsyncImportHandler(deps)(mkRequest(body, { signature: signForPod(migrationId, JSON.stringify(body)) }), response.res, vi.fn());
      expect(response.getStatus()).toBe(200);
      const configPath = (spawnMock.mock.calls.at(-1)![1] as string[]).find(arg => arg.startsWith("--config="))!.slice(9);
      return /^\s*path = (.+)$/mu.exec(await fs.readFile(configPath, "utf8"))![1]!;
    };
    const finish = async (mode: "pre" | "final") => {
      spawnMock.mockImplementation(() => mkFakeChild({ exitCode: 0 }));
      const body = { migrationId, slug: "chris", mode, rpcPhase: "finish-rsync-import" };
      const response = mkResponse();
      await createFinishRsyncImportHandler(deps)(mkRequest(body, { signature: signForPod(migrationId, JSON.stringify(body)) }), response.res, vi.fn());
      return response;
    };
    const stageDir = await prepare("pre");
    for (const root of [stageDir, importDir]) {
      await fs.mkdir(path.join(root, "customers/chris/projects/active-repo"), { recursive: true });
      await fs.writeFile(path.join(root, "customers/chris/projects/active-repo/README.md"), "source checkout");
      await fs.mkdir(path.join(root, "customers/chris/projects/deleted-repo"), { recursive: true });
      await fs.writeFile(path.join(root, "customers/chris/projects/deleted-repo/draft"), "removed after pre-sync");
    }
    await fs.mkdir(path.join(stageDir, "customers/chris/.system"), { recursive: true });
    await fs.writeFile(path.join(stageDir, "customers/chris/.system/.mounted"), "source marker");
    await fs.writeFile(path.join(stageDir, "customers/chris/.system/.mount"), "obsolete source file");
    expect((await finish("pre")).getStatus()).toBe(200);
    await fs.mkdir(path.join(importDir, "customers/chris/.system"), { recursive: true });
    await fs.writeFile(path.join(importDir, "customers/chris/.system/.mounted"), "target marker");
    await fs.writeFile(path.join(importDir, "customers/chris/.system/.mount"), "obsolete target file");
    expect(await prepare("final")).toBe(stageDir);
    await fs.rm(path.join(stageDir, "customers/chris/.system"), { recursive: true });
    await fs.rm(path.join(stageDir, "customers/chris/projects/deleted-repo"), { recursive: true });
    await writeSharedTargetManifest(stageDir, importDir);
    const readdir = vi.spyOn(fs, "readdir");
    syncBuiltinESMExports();
    const checkout = path.join(stageDir, "customers/chris/projects/active-repo");
    let checkoutReads = 0;
    const completed = await finish("final").finally(() => {
      checkoutReads = readdir.mock.calls.filter(([directory]) => directory === checkout).length;
      readdir.mockRestore();
      syncBuiltinESMExports();
    });
    expect(completed.getBody()).toEqual({ migrationId, slug: "chris", imported: true });
    expect(checkoutReads).toBe(4);
    expect(completed.getStatus()).toBe(200);
    expect(uidForSlug).not.toHaveBeenCalled();
    expect(loadUserSnapshot).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(importDir, "customers/chris/projects/active-repo/README.md"), "utf8")).toBe("source checkout");
    await expect(fs.stat(path.join(importDir, "customers/chris/projects/deleted-repo"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(importDir, "customers/chris/.system/.mounted"), "utf8")).toBe("target marker");
    await expect(fs.stat(path.join(importDir, "customers/chris/.system/.mount"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not finish an existing import while another phase prepares its staging", async () => {
    vi.stubEnv("POD_UID", "concurrent-isolated-pod");
    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), "concurrent-import-"));
    migrationTempRoots.push(importDir);
    let releasePreparation!: () => void;
    const blocked = new Promise<void>(resolve => { releasePreparation = resolve; });
    const reserveSurgeTarget = vi.fn(async () => blocked);
    const deps = mkDeps({
      adapter: mkAdapter({ isIsolatedGateway: () => true,
        prepareKeyImportDir: vi.fn(async () => importDir), prepareImportDir: vi.fn(async () => importDir) }),
      reserveSurgeTarget, releaseSurgeReadiness: vi.fn(async () => undefined),
      unreserveSurgeTarget: vi.fn(async () => HELD_USER_GATE_STATE),
      waitForRsyncReady: vi.fn(async () => undefined),
    });
    const migrationId = "concurrent-preparation";
    const first = { migrationId, slug: "chris", mode: "keys", rpcPhase: "prepare-rsync-import", transferUser: "migration", transferKey: "d".repeat(64) };
    spawnMock.mockReturnValueOnce(mkFakeChild());
    const prepared = mkResponse();
    await createPrepareRsyncImportHandler(deps)(mkRequest(first, { signature: signForPod(migrationId, JSON.stringify(first)) }), prepared.res, vi.fn());
    expect(prepared.getStatus()).toBe(200);
    const next = { ...first, mode: "pre" };
    const preparing = createPrepareRsyncImportHandler(deps)(mkRequest(next, { signature: signForPod(migrationId, JSON.stringify(next)) }), mkResponse().res, vi.fn());
    try {
      await vi.waitFor(() => expect(reserveSurgeTarget).toHaveBeenCalledOnce());
      spawnMock.mockImplementation(() => mkFakeChild({ exitCode: 0 }));
      const finish = { migrationId, slug: "chris", mode: "keys", rpcPhase: "finish-rsync-import" };
      const finished = mkResponse();
      await createFinishRsyncImportHandler(deps)(mkRequest(finish, { signature: signForPod(migrationId, JSON.stringify(finish)) }), finished.res, vi.fn());
      expect(finished.getStatus()).toBe(409);
      expect(finished.getBody()).toEqual({ error: "migration import completion is already in progress" });
    } finally {
      releasePreparation();
      await preparing;
      const abort = { migrationId, slug: "chris", mode: "pre", rpcPhase: "abort-rsync-import" };
      await createAbortRsyncImportHandler(deps)(mkRequest(abort, { signature: signForPod(migrationId, JSON.stringify(abort)) }), mkResponse().res, vi.fn());
    }
  });

  it.each(["generated", "authored"] as const)("handles a removed %s AGENTS baseline through final user import", async kind => {
    vi.stubEnv("POD_UID", "placeholder-prepared-pod");
    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), "placeholder-prepared-import-"));
    migrationTempRoots.push(importDir);
    const projectPath = "customers/chris/projects/octogee";
    const obsoletePath = "customers/chris/projects/obsolete";
    const prepareSurgeTarget = vi.fn(async () => {
      for (const relative of [projectPath, obsoletePath]) {
        const project = path.join(importDir, relative);
        await fs.rm(path.join(project, "AGENTS.md"));
        await fs.writeFile(path.join(project, "CLAUDE.md"), "canonical prepared instructions\n");
        await fs.symlink("CLAUDE.md", path.join(project, "AGENTS.md"));
      }
    });
    const deps = mkDeps({
      adapter: mkAdapter({ isIsolatedGateway: () => true, prepareImportDir: vi.fn(async () => importDir),
        loadUserSnapshot: vi.fn(async () => ({ ...RESTORE_SNAPSHOT, agentIds: [...RESTORE_SNAPSHOT.agentIds], channels: [],
          projects: [{ projectId: "octogee", projectSlug: "octogee", giteaRepoName: null,
            repoSource: { provider: "github", owner: "octogee-ai", repo: "octogee" } }],
        })),
      }),
      reserveSurgeTarget: vi.fn(async () => undefined), prepareSurgeTarget,
      releaseSurgeReadiness: vi.fn(async () => undefined),
      unreserveSurgeTarget: vi.fn(async () => HELD_USER_GATE_STATE),
      waitForRsyncReady: vi.fn(async () => undefined),
    });
    const spawn = await realMigrationSpawn();
    const migrationId = `prepared-placeholder-baseline-${kind}`;
    const prepare = async (mode: "pre" | "final") => {
      spawnMock.mockReturnValueOnce(mkFakeChild());
      const body = { migrationId, slug: "chris", mode, rpcPhase: "prepare-rsync-import", transferUser: "migration", transferKey: "b".repeat(64) };
      const response = mkResponse();
      await createPrepareRsyncImportHandler(deps)(mkRequest(body, { signature: signForPod(migrationId, JSON.stringify(body)) }), response.res, vi.fn());
      expect(response.getStatus()).toBe(200);
      const configPath = (spawnMock.mock.calls.at(-1)![1] as string[]).find(arg => arg.startsWith("--config="))!.slice(9);
      return /^\s*path = (.+)$/mu.exec(await fs.readFile(configPath, "utf8"))![1]!;
    };
    const finish = async (mode: "pre" | "final") => {
      spawnMock.mockImplementation(spawn);
      const body = { migrationId, slug: "chris", mode, rpcPhase: "finish-rsync-import" };
      const response = mkResponse();
      await createFinishRsyncImportHandler(deps)(mkRequest(body, { signature: signForPod(migrationId, JSON.stringify(body)) }), response.res, vi.fn());
      expect(response.getStatus()).toBe(200);
    };
    const stageDir = await prepare("pre");
    for (const relative of [projectPath, obsoletePath]) {
      await fs.mkdir(path.join(stageDir, relative), { recursive: true });
      await fs.writeFile(path.join(stageDir, relative, "AGENTS.md"),
        kind === "generated" ? deferredProjectPlaceholder("chris", path.basename(relative)) : "authored source instructions\n");
    }
    await fs.writeFile(path.join(stageDir, projectPath, "SOUL.md"), "retained project context\n");
    await finish("pre");
    expect(prepareSurgeTarget).toHaveBeenCalledOnce();
    expect(await prepare("final")).toBe(stageDir);
    await fs.rm(path.join(stageDir, projectPath, "AGENTS.md"));
    await fs.rm(path.join(stageDir, obsoletePath), { recursive: true });

    await finish("final");

    const targetAgents = path.join(importDir, projectPath, "AGENTS.md");
    if (kind === "generated") {
      expect((await fs.lstat(targetAgents)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(targetAgents)).toBe("CLAUDE.md");
    } else {
      await expect(fs.lstat(targetAgents)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await fs.readFile(path.join(importDir, projectPath, "CLAUDE.md"), "utf8")).toBe("canonical prepared instructions\n");
    expect(await fs.readFile(path.join(importDir, projectPath, "SOUL.md"), "utf8")).toBe("retained project context\n");
    await expect(fs.lstat(path.join(importDir, obsoletePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reuses the prepared file tree for final synchronization and holds user startup", async () => {
    vi.stubEnv("POD_UID", "user-prepared-pod");
    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), "prepared-import-"));
    migrationTempRoots.push(importDir);
    const prepareSurgeTarget = vi.fn(async () => undefined);
    const releaseSurgeReadiness = vi.fn(async () => undefined);
    const deps = mkDeps({
      adapter: mkAdapter({ isIsolatedGateway: () => true, prepareImportDir: vi.fn(async () => importDir),
        loadUserSnapshot: vi.fn(async () => ({ ...RESTORE_SNAPSHOT, agentIds: [...RESTORE_SNAPSHOT.agentIds], channels: [], projects: [{ projectId: "new", projectSlug: "new-repo", giteaRepoName: "chris-new-repo" }] })),
      }),
      reserveSurgeTarget: vi.fn(async () => undefined), prepareSurgeTarget,
      releaseSurgeReadiness, unreserveSurgeTarget: vi.fn(async () => HELD_USER_GATE_STATE),
      waitForRsyncReady: vi.fn(async () => undefined),
    });
    const migrationId = "prepared-persistent-stage";
    const prepare = async (mode: "pre" | "final") => {
      spawnMock.mockReturnValueOnce(mkFakeChild());
      const body = { migrationId, slug: "chris", mode, rpcPhase: "prepare-rsync-import", transferUser: "migration", transferKey: "b".repeat(64) };
      const response = mkResponse();
      await createPrepareRsyncImportHandler(deps)(mkRequest(body, { signature: signForPod(migrationId, JSON.stringify(body)) }), response.res, vi.fn());
      expect(response.getStatus()).toBe(200);
      const call = spawnMock.mock.calls.at(-1)!;
      const configPath = (call[1] as string[]).find(arg => arg.startsWith("--config="))!.slice(9);
      return /^\s*path = (.+)$/mu.exec(await fs.readFile(configPath, "utf8"))![1]!;
    };
    const stageDir = await prepare("pre");
    await fs.mkdir(path.join(stageDir, "customers/chris"), { recursive: true });
    await fs.writeFile(path.join(stageDir, "customers/chris/draft.txt"), "uncommitted source work");
    spawnMock.mockImplementation(() => mkFakeChild({ exitCode: 0 }));
    const finish = { migrationId, slug: "chris", mode: "pre", rpcPhase: "finish-rsync-import" };
    const finished = mkResponse();
    await createFinishRsyncImportHandler(deps)(mkRequest(finish, { signature: signForPod(migrationId, JSON.stringify(finish)) }), finished.res, vi.fn());
    expect(finished.getStatus()).toBe(200);
    expect(prepareSurgeTarget).toHaveBeenCalledWith({ migrationId, slug: "chris", targetPodUid: "user-prepared-pod" }, expect.any(AbortSignal));
    expect(releaseSurgeReadiness).not.toHaveBeenCalled();
    const finalStage = await prepare("final");
    expect(finalStage).toBe(stageDir);
    expect(await fs.readFile(path.join(finalStage, "customers/chris/draft.txt"), "utf8")).toBe("uncommitted source work");
    await fs.mkdir(path.join(importDir, "customers/chris/projects/new-repo"), { recursive: true });
    await fs.writeFile(path.join(importDir, "customers/chris/projects/new-repo/README.md"), "prepared checkout");
    await fs.mkdir(path.join(importDir, "customers/chris/projects/archived-repo"), { recursive: true });
    await fs.writeFile(path.join(importDir, "customers/chris/projects/archived-repo/draft"), "prepared before project removal");
    await fs.writeFile(path.join(importDir, "customers/chris/draft.txt"), "old source content");
    await fs.rm(path.join(finalStage, "customers/chris/draft.txt"));
    const finishFinal = { migrationId, slug: "chris", mode: "final", rpcPhase: "finish-rsync-import" };
    const completed = mkResponse();
    await createFinishRsyncImportHandler(deps)(mkRequest(finishFinal, { signature: signForPod(migrationId, JSON.stringify(finishFinal)) }), completed.res, vi.fn());
    expect(completed.getStatus()).toBe(200);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("final-import agent-snapshots"), expect.objectContaining({ durationMs: expect.any(Number) }));
    await expect(fs.stat(path.join(importDir, "customers/chris/draft.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(importDir, "customers/chris/projects/new-repo/README.md"), "utf8")).toBe("prepared checkout");
    await expect(fs.stat(path.join(importDir, "customers/chris/projects/archived-repo"))).rejects.toMatchObject({ code: "ENOENT" });
    const abort = { migrationId, slug: "chris", mode: "final", rpcPhase: "abort-rsync-import" };
    await createAbortRsyncImportHandler(deps)(mkRequest(abort, { signature: signForPod(migrationId, JSON.stringify(abort)) }), mkResponse().res, vi.fn());
    await expect(fs.stat(stageDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
