import { describe, expect, it } from "vitest";
import { isValidProjectId } from "@octogee/shared/types/identity";
import {
  IDENTITY_FAILURE,
  POD_PROFILE,
  identityReady,
  lastIdentityFailure,
  projectSlug,
  redactSecrets,
  run,
} from "../ops/kind-isolated-gateway.mjs";

const MODEL = "platform-openrouter/meta/muse-ember";
const BOT = "bot-user-id";
const ISOLATED = "b-lin-1";
const BOOT_FILE = "/home/node/.openclaw/workspace-identity-boot";
const READY_FILE = "/home/node/.openclaw/workspace-identity-ready";
const FAILURE_LINE = `2026-11-13T10:00:02Z [octogee-identity-tools] ${IDENTITY_FAILURE}: Error: OpenClaw returned no profile for uid-1`;

interface Scenario {
  identityReadyAfterBoot?: boolean;
  identityReadyAfterResume?: boolean;
  log?: string;
  lastError?: string | null;
  homeSurvives?: boolean;
  gatewayStartsAfterMs?: number;
  markerReadError?: string;
  previousLog?: string;
  kubernetes?: { pods?: unknown[]; events?: Array<{ involvedObject: { name: string } }>; networkPolicies?: unknown[] };
  migrationToIsolated?: Migration;
  migrationBack?: Migration;
  projectStoreNeverRecorded?: boolean;
  archivedAgentNeverDetached?: boolean;
}

interface Step { name: string; status: string; error?: unknown }
interface Migration { finishesAfterMs?: number; ends?: { status: string; steps: Step[]; error?: unknown } }

const SUCCEEDED = { status: "succeeded", steps: [{ name: "import", status: "succeeded" }, { name: "cutover-firestore", status: "succeeded" }] };
const MIGRATION_TO_ISOLATED = "op-to-isolated";
const MIGRATION_BACK = "op-back";

const RESUMED_PROCESS_STARTS_MS = 30_000;
const CONFIG_FILE = "/home/node/.openclaw/system_config/openclaw.json";
const PROJECT_AGENT = "octogee-lin-proj-harbor0-coach";

function cluster(scenario: Scenario = {}) {
  let now = 0;
  const events: string[] = [];
  const sql: Array<{ sql: string; variables: Record<string, string> }> = [];
  let mounted = "shared-a";
  let isolatedMounted: string[] = [];
  let staleHeartbeats = 0;
  let pods = 0;
  let claim: string | null = null;
  let boots = 0;
  let resumedProcessStartsAt: number | null = null;
  let runningFrom = 0;
  const running = () => pods > 0 && now >= runningFrom;
  const home = new Map<string, string>();
  let sent = 0;
  let projectCreated = false;
  let archived = false;
  let detached = false;
  const operations = new Map<string, { finishesAt: number; ends: NonNullable<Migration["ends"]> }>();
  const startMigration = (id: string, migration: Migration | undefined, defaultMs: number) => {
    operations.set(id, { finishesAt: now + (migration?.finishesAfterMs ?? defaultMs), ends: migration?.ends ?? SUCCEEDED });
  };
  const inFlight = (id: string) => {
    const operation = operations.get(id);
    return operation !== undefined && now < operation.finishesAt;
  };
  const refuseWhileMigrating = (verb: string) => {
    if (inFlight(MIGRATION_TO_ISOLATED) || inFlight(MIGRATION_BACK)) {
      throw new Error(`octogee-fleet --env=kind gateway ${verb} ${ISOLATED} --apply exited with 1: octogee-fleet: the Admin API refused this request (409): user migration is in flight for gateway ${ISOLATED}`);
    }
  };

  const boot = (identityReady: boolean) => {
    boots += 1;
    pods = 1;
    if (archived && !scenario.archivedAgentNeverDetached) detached = true;
    claim = "Bound";
    if (scenario.homeSurvives === false) home.clear();
    home.set(BOOT_FILE, `boot-${boots}`);
    if (identityReady) home.set(READY_FILE, `boot-${boots}`);
    mounted = ISOLATED;
    isolatedMounted = ["lin"];
  };
  const settle = () => {
    if (resumedProcessStartsAt === null || now < resumedProcessStartsAt) return;
    resumedProcessStartsAt = null;
    boot(scenario.identityReadyAfterResume !== false);
  };

  const deps = {
    log: () => {},
    clock: { now: () => now, sleep: async (ms: number) => { now += ms; } },
    fleet: (args: string[]) => {
      settle();
      events.push(args.slice(0, 3).join(" "));
      const [noun, verb] = args;
      if (noun === "gateway" && verb === "ls") {
        if (staleHeartbeats > 0 && --staleHeartbeats === 0) isolatedMounted = [];
        return { gateways: [
          { gatewayId: "shared-a", status: "ready", mountedUsers: mounted === "shared-a" ? ["lin"] : [] },
          ...(claim === null && boots > 0 ? [] : [{
            gatewayId: ISOLATED, status: "starting", mountedUsers: isolatedMounted,
            lastError: { message: scenario.lastError ?? null, at: null },
          }]),
        ] };
      }
      if (noun === "user" && verb === "ls") return { users: [{ id: "uid-1", name: "lin", assignedGatewayId: "shared-a" }] };
      if (noun === "user" && verb === "inspect") {
        return { user: { id: "uid-1", name: "lin", provisioningStatus: "complete", mountedGatewayId: mounted } };
      }
      if (noun === "user" && verb === "migrate" && args[2] === "lin" && args[3] === "--to-isolated=pod-s") {
        runningFrom = now + (scenario.gatewayStartsAfterMs ?? 0);
        boot(scenario.identityReadyAfterBoot !== false);
        startMigration(MIGRATION_TO_ISOLATED, scenario.migrationToIsolated, 90_000);
        return { dryRun: false, response: { uid: "uid-1", gatewayId: ISOLATED, operationId: MIGRATION_TO_ISOLATED } };
      }
      if (noun === "user" && verb === "migrate" && args[3] === "--to=shared-a") {
        mounted = "shared-a";
        staleHeartbeats = 2;
        startMigration(MIGRATION_BACK, scenario.migrationBack, 60_000);
        return { dryRun: false, response: { operationId: MIGRATION_BACK } };
      }
      if (noun === "ops" && verb === "inspect") {
        const operation = operations.get(args[2]);
        if (!operation) throw new Error(`octogee-fleet --env=kind ops inspect ${args[2]} exited with 1: operation not found`);
        return { operation: inFlight(args[2])
          ? { id: args[2], kind: "migrate-user", status: "running", steps: [{ name: "import", status: "succeeded" }, { name: "cutover-firestore", status: "running" }] }
          : { id: args[2], kind: "migrate-user", ...operation.ends } };
      }
      if (noun === "user" && verb === "issue-passwords") {
        return { dryRun: false, response: { chat: { username: "lin", password: "chat-pass" }, git: { username: "ws-lin", password: "git" } } };
      }
      if (noun === "gateway" && verb === "park") {
        refuseWhileMigrating("park");
        pods = 0;
        mounted = "none";
        return { dryRun: false, response: {} };
      }
      if (noun === "gateway" && verb === "resume") {
        pods = 1;
        runningFrom = now;
        resumedProcessStartsAt = now + RESUMED_PROCESS_STARTS_MS;
        return { dryRun: false, response: {} };
      }
      if (noun === "gateway" && verb === "retire") {
        refuseWhileMigrating("retire");
        if (isolatedMounted.length > 0) {
          throw new Error(`octogee-fleet --env=kind gateway retire ${ISOLATED} --apply exited with 1: gateway ${ISOLATED} still has mounted users: ${isolatedMounted.join(", ")}`);
        }
        pods = 0;
        claim = null;
        return { dryRun: false, response: {} };
      }
      throw new Error(`unexpected fleet call ${args.join(" ")}`);
    },
    sql: (query: string, variables: Record<string, string>) => {
      sql.push({ sql: query, variables });
      if (query.includes("platform.agent_stores")) {
        return projectCreated && !scenario.projectStoreNeverRecorded && variables.agent === PROJECT_AGENT ? "shared-a\n" : "";
      }
      if (query.includes("commercial_lifecycle_status = 'archived'")) {
        events.push("archive project");
        archived = true;
        return "";
      }
      if (query.includes("model_broker_usage_events")) {
        return JSON.stringify({ provider: "openrouter", model: "meta/muse-ember", gatewayId: ISOLATED, upstreamStatus: 200, totalTokens: 900, costUsd: 0.0001 });
      }
      return "";
    },
    waitForGatewayPod: () => "",
    platformApi: async (token: string) => {
      expect(token).toBe("chat-token");
      return {
        post: async (path: string, body: unknown) => {
          events.push(`api post ${path}`);
          expect(body).toEqual({ name: "Harbor", slug: "harbor0" });
          projectCreated = true;
          return { workspaceId: "lin", slug: "harbor0" };
        },
      };
    },
    signIn: async () => ({
      token: "chat-token",
      get: async (path: string) => {
        if (path === "/api/v4/users/username/lin-coach") return { id: BOT, username: "lin-coach" };
        if (path === "/api/v4/users/me/teams") return [{ id: "team-1" }];
        if (path === "/api/v4/teams/team-1/channels/name/lin-coach") return { id: "channel-1" };
        if (path.startsWith("/api/v4/channels/channel-1/posts?since=")) {
          return { posts: { reply: { id: "reply", user_id: BOT, create_at: sent + 1, message: "I can hear you." } } };
        }
        throw new Error(`unexpected GET ${path}`);
      },
      post: async () => {
        events.push("chat post");
        sent = now;
        return { id: "sent", create_at: sent };
      },
    }),
    setSizingProfile: (name: string, profile: unknown) => { events.push(`sizing set ${name}`); expect(profile).toEqual(POD_PROFILE); },
    readGatewayFile: (gatewayId: string, path: string) => {
      settle();
      expect(gatewayId).toBe(ISOLATED);
      if (!running()) throw new Error(`container "gateway" of ${gatewayId} is not running`);
      if (path === CONFIG_FILE) {
        events.push("config read");
        return JSON.stringify({ agents: { entries: { "octogee-lin-coach": {}, ...(detached ? {} : { [PROJECT_AGENT]: {} }) } } });
      }
      if (path === BOOT_FILE || path === READY_FILE) {
        events.push("identity read");
        if (scenario.markerReadError) throw new Error(scenario.markerReadError);
      }
      return home.get(path) ?? null;
    },
    writeGatewayFile: (_gatewayId: string, path: string, content: string) => { home.set(path, content); },
    gatewayLog: () => scenario.log ?? "",
    previousGatewayLog: () => {
      if (scenario.previousLog === undefined) throw new Error("previous terminated container \"gateway\" not found");
      return scenario.previousLog;
    },
    gatewayPods: () => scenario.kubernetes?.pods ?? [],
    gatewayEvents: (names: string[]) => (scenario.kubernetes?.events ?? []).filter(event => names.includes(event.involvedObject.name)),
    networkPolicies: () => scenario.kubernetes?.networkPolicies ?? [],
    homeClaimPhase: () => claim,
    gatewayPodCount: () => pods,
    gatewayRunning: () => { settle(); return running(); },
  };
  return { deps, events, sql };
}

function eventIndex(events: string[], prefix: string, from = 0) {
  const index = events.findIndex((event, at) => at >= from && event.startsWith(prefix));
  if (index < 0) throw new Error(`no ${prefix} event in ${events.join(" | ")}`);
  return index;
}

const options = { fleet: "octogee-fleet", gateway: "shared-a", user: "lin", model: MODEL, replyTimeoutMs: 300_000, state: "/state/isolated" };

describe("kind isolated gateway smoke", () => {
  it("gives the user a pod gateway, requires its workspace identities before the Coach round trip, keeps the home through park and resume, then returns and retires it", async () => {
    const { deps, events, sql } = cluster();

    const result = await run(deps, options);

    expect(result.gatewayId).toBe(ISOLATED);
    expect(events).toContain("sizing set pod-s");
    expect(events.indexOf("sizing set pod-s")).toBeLessThan(events.indexOf("user migrate lin"));
    expect(events.indexOf("identity read")).toBeLessThan(events.indexOf("chat post"));
    expect(events.filter(event => event.startsWith("gateway park") || event.startsWith("gateway resume") || event.startsWith("gateway retire")))
      .toEqual([`gateway park ${ISOLATED}`, `gateway resume ${ISOLATED}`, `gateway retire ${ISOLATED}`]);
    expect(sql.find(entry => entry.sql.includes("model_broker_usage_events"))?.variables).toMatchObject({ gateway: ISOLATED });
    expect(result.evidence).toMatchObject({ calls: 1, provider: "openrouter", model: "meta/muse-ember" });
  });

  it("gives the user a project before the move to the isolated gateway, archives it there, and returns them only after the gateway detached its agent", async () => {
    const { deps, events, sql } = cluster();

    await run(deps, options);

    const toIsolated = eventIndex(events, "user migrate lin");
    expect(eventIndex(events, "api post /api/projects")).toBeLessThan(toIsolated);
    const archivedAt = eventIndex(events, "archive project");
    expect(archivedAt).toBeGreaterThan(eventIndex(events, "chat post"));
    expect(archivedAt).toBeLessThan(eventIndex(events, `gateway park ${ISOLATED}`));
    const back = eventIndex(events, "user migrate lin", toIsolated + 1);
    expect(events.lastIndexOf("config read")).toBeGreaterThan(eventIndex(events, `gateway resume ${ISOLATED}`));
    expect(events.lastIndexOf("config read")).toBeLessThan(back);
    expect(sql.find(entry => entry.sql.includes("commercial_lifecycle_status"))?.variables).toEqual({ uid: "uid-1", project: "harbor0" });
    expect(sql.find(entry => entry.sql.includes("platform.agent_stores"))?.variables).toEqual({ uid: "uid-1", agent: PROJECT_AGENT });
  });

  it("gives each run a new project slug the platform API accepts, so a rerun on the same cluster does not collide", () => {
    const first = projectSlug(Date.UTC(2026, 10, 27, 23, 0, 0));
    const second = projectSlug(Date.UTC(2026, 10, 27, 23, 0, 1));
    expect(first).not.toBe(second);
    expect([first, second, projectSlug(Date.UTC(2099, 0, 1))].every(isValidProjectId)).toBe(true);
  });

  it("does not give the user an isolated gateway before their project agent has a store on the shared gateway", async () => {
    const { deps, events } = cluster({ projectStoreNeverRecorded: true });

    await expect(run(deps, options)).rejects.toThrow(`waiting for ${PROJECT_AGENT}'s store to be recorded on shared-a`);
    expect(events.some(event => event.startsWith("user migrate lin"))).toBe(false);
  });

  it("does not return the user while the isolated gateway still configures the archived project's agent", async () => {
    const { deps, events } = cluster({ archivedAgentNeverDetached: true });

    await expect(run(deps, options)).rejects.toThrow(`waiting for ${ISOLATED} to detach archived project agent ${PROJECT_AGENT}`);
    expect(events.filter(event => event.startsWith("user migrate lin"))).toHaveLength(1);
    expect(events).not.toContain(`gateway retire ${ISOLATED}`);
  });

  it("waits for each migration to succeed before the Coach round trip, the park and the retire, which the Admin API refuses while a migration is in flight", async () => {
    const { deps, events } = cluster();

    await run(deps, options);

    const lastInspect = (id: string) => events.lastIndexOf(`ops inspect ${id}`);
    expect(lastInspect(MIGRATION_TO_ISOLATED)).toBeLessThan(events.indexOf("chat post"));
    expect(lastInspect(MIGRATION_TO_ISOLATED)).toBeLessThan(events.indexOf(`gateway park ${ISOLATED}`));
    expect(lastInspect(MIGRATION_BACK)).toBeGreaterThan(events.indexOf("user migrate lin"));
    expect(lastInspect(MIGRATION_BACK)).toBeLessThan(events.indexOf(`gateway retire ${ISOLATED}`));
  });

  it.each([
    ["failed", { status: "failed", steps: [{ name: "import", status: "succeeded" }, { name: "cutover-firestore", status: "failed", error: `target ${ISOLATED} has no accepted system config commit to converge slug on` }] },
      `migration ${MIGRATION_TO_ISOLATED} to ${ISOLATED} ended failed at step cutover-firestore: target ${ISOLATED} has no accepted system config commit to converge slug on`],
    ["rolled back", { status: "rolled-back", steps: [{ name: "import", status: "succeeded" }], error: { message: "source retained" } },
      `migration ${MIGRATION_TO_ISOLATED} to ${ISOLATED} ended rolled-back: {"message":"source retained"}`],
  ])("names the state of a migration to the isolated gateway that %s, before the Coach round trip", async (_how, ends, message) => {
    const { deps, events } = cluster({ migrationToIsolated: { ends } });

    await expect(run(deps, options)).rejects.toThrow(message);
    expect(events).not.toContain("chat post");
    expect(events).not.toContain(`gateway park ${ISOLATED}`);
  });

  it("names the step a migration to the isolated gateway is still on when it does not finish", async () => {
    const { deps, events } = cluster({ migrationToIsolated: { finishesAfterMs: Number.POSITIVE_INFINITY } });

    await expect(run(deps, options)).rejects.toThrow(
      `Timed out after 600s waiting for migration ${MIGRATION_TO_ISOLATED} to ${ISOLATED} to finish; it is running at step cutover-firestore`,
    );
    expect(events).not.toContain("chat post");
  });

  it("does not retire the isolated gateway when the return to the shared gateway fails", async () => {
    const ends = { status: "failed", steps: [{ name: "unmount-source", status: "failed", error: "transport failed: fetch failed" }] };
    const { deps, events } = cluster({ migrationBack: { ends } });

    await expect(run(deps, options)).rejects.toThrow(
      `migration ${MIGRATION_BACK} to shared-a ended failed at step unmount-source: transport failed: fetch failed`,
    );
    expect(events).not.toContain(`gateway retire ${ISOLATED}`);
  });

  it("fails before the Coach round trip when the gateway never marks its identities ready, with the gateway's last identity failure", async () => {
    const log = ["boot", `${IDENTITY_FAILURE}: Error: first`, "retrying", FAILURE_LINE, "idle"].join("\n");
    const { deps, events } = cluster({ identityReadyAfterBoot: false, log });

    await expect(run(deps, options)).rejects.toThrow(
      `Timed out after 900s waiting for ${ISOLATED} to mark its workspace identities ready for this boot. `
        + `Last identity failure in the gateway log: ${FAILURE_LINE}`,
    );
    expect(events).not.toContain("chat post");
  });

  it("says when the gateway log has no identity failure, and names what blocks the gateway", async () => {
    const { deps } = cluster({ identityReadyAfterBoot: false, lastError: "the isolated gateway image is linux/amd64 only, and this cluster has no amd64 node" });

    await expect(run(deps, options)).rejects.toThrow(
      `The gateway log has no "${IDENTITY_FAILURE}" line. `
        + `${ISOLATED} is blocked: the isolated gateway image is linux/amd64 only, and this cluster has no amd64 node`,
    );
  });

  it("adds the pod's status, its events, the network policies that select it and the gateway log's redacted tail to a failure", async () => {
    const pod = {
      metadata: { name: `octogee-gateway-${ISOLATED}-b7db69b87-lbr56`, labels: { app: "octogee-gateway", "gateway-instance": ISOLATED } },
      status: {
        phase: "Running",
        containerStatuses: [
          {
            name: "gateway", ready: false, restartCount: 1,
            state: { running: { startedAt: "2026-11-14T03:51:58Z" } },
            lastState: { terminated: { exitCode: 137, reason: "Error", finishedAt: "2026-11-14T03:51:56Z" } },
          },
          { name: "gateway-edge", ready: true, restartCount: 0, state: { running: { startedAt: "2026-11-14T03:41:12Z" } } },
        ],
      },
    };
    const events = [
      {
        type: "Normal", reason: "Killing", lastTimestamp: "2026-11-14T03:51:37Z",
        involvedObject: { kind: "Pod", name: pod.metadata.name }, message: "Container gateway failed startup probe, will be restarted",
      },
      {
        type: "Warning", reason: "Unhealthy", lastTimestamp: "2026-11-14T03:46:57Z", count: 30,
        involvedObject: { kind: "Pod", name: pod.metadata.name }, message: "Startup probe failed: connect: connection refused",
      },
    ];
    const networkPolicies = [
      {
        metadata: { name: `octogee-gateway-apiserver-egress-${ISOLATED}` },
        spec: { podSelector: { matchLabels: { app: "octogee-gateway", "gateway-instance": ISOLATED } }, policyTypes: ["Egress"] },
      },
      {
        metadata: { name: "isolated-gateways" },
        spec: { podSelector: { matchExpressions: [{ key: "gateway-instance", operator: "In", values: [ISOLATED] }] }, ingress: [] },
      },
      {
        metadata: { name: "shared-a-ingress" },
        spec: { podSelector: { matchLabels: { app: "octogee-gateway", "gateway-instance": "shared-a" } }, policyTypes: ["Ingress"] },
      },
    ];
    const log = [
      "[entrypoint] Pre-boot: reading user identity",
      "[builder-identity] broker read failed: fetch failed",
      "[entrypoint] Pre-boot: User identity unavailable; retrying in 5s...",
      "[mm] connecting with authorization: Bearer mm-session-1f2e3d",
    ].join("\n");
    const previousLog = "[provisioner] issued token=gitea-token-9a8b7c for lin";
    const { deps } = cluster({ identityReadyAfterBoot: false, log, previousLog, kubernetes: { pods: [pod], events, networkPolicies } });

    const failure = await run(deps, options).then(() => null, (error: Error) => error.message);

    expect(failure).toContain(`Timed out after 900s waiting for ${ISOLATED} to mark its workspace identities ready for this boot`);
    expect(failure).toContain(`pod ${pod.metadata.name}: Running`);
    expect(failure).toContain("gateway: not ready, 1 restarts, running since 2026-11-14T03:51:58Z, last exited 137 (Error) at 2026-11-14T03:51:56Z");
    expect(failure).toContain("gateway-edge: ready, 0 restarts, running since 2026-11-14T03:41:12Z");
    expect(failure.indexOf("Unhealthy")).toBeLessThan(failure.indexOf("Killing"));
    expect(failure).toContain(`2026-11-14T03:46:57Z Warning Unhealthy pod/${pod.metadata.name} (30 times): Startup probe failed: connect: connection refused`);
    expect(failure).toContain(`octogee-gateway-apiserver-egress-${ISOLATED} (Egress)`);
    expect(failure).toContain("isolated-gateways (Ingress)");
    expect(failure).not.toContain("shared-a-ingress");
    expect(failure).toContain("[builder-identity] broker read failed: fetch failed");
    expect(failure).toContain("previous gateway container");
    expect(failure).not.toContain("mm-session-1f2e3d");
    expect(failure).not.toContain("gitea-token-9a8b7c");
  });

  it("lists the events of the gateway's own Deployment, ReplicaSet, pod and home claim, and no other gateway's", async () => {
    const replicaSet = `octogee-gateway-${ISOLATED}-b7db69b87`;
    const pod = {
      metadata: {
        name: `${replicaSet}-lbr56`,
        labels: { app: "octogee-gateway", "gateway-instance": ISOLATED },
        ownerReferences: [{ kind: "ReplicaSet", name: replicaSet }],
      },
      status: { phase: "Pending" },
    };
    const event = (name: string, message: string, at: string) =>
      ({ type: "Normal", reason: "Seen", lastTimestamp: at, involvedObject: { kind: "Object", name }, message });
    const events = [
      event(`octogee-gateway-${ISOLATED}`, "deployment scaled", "2026-11-14T03:40:00Z"),
      event(replicaSet, "replica set created the pod", "2026-11-14T03:40:01Z"),
      event(pod.metadata.name, "pod scheduled", "2026-11-14T03:40:02Z"),
      event(`octogee-gateway-${ISOLATED}-data`, "home claim bound", "2026-11-14T03:40:03Z"),
      event(`octogee-gateway-${ISOLATED}0-6f5d8c9b4-x2k7p`, "another gateway's pod scheduled", "2026-11-14T03:40:04Z"),
    ];
    const { deps } = cluster({ identityReadyAfterBoot: false, kubernetes: { pods: [pod], events } });

    const failure = await run(deps, options).then(() => null, (error: Error) => error.message);

    for (const message of ["deployment scaled", "replica set created the pod", "pod scheduled", "home claim bound"]) {
      expect(failure).toContain(message);
    }
    expect(failure).not.toContain("another gateway's pod scheduled");
  });

  it("still fails with the original error when the diagnostics cannot be read", async () => {
    const { deps } = cluster({ identityReadyAfterBoot: false });
    const broken = {
      ...deps,
      gatewayPods: () => { throw new Error("kubectl get pods exited with 1: connection refused"); },
      networkPolicies: () => { throw new Error("kubectl get networkpolicies exited with 1: forbidden"); },
    };

    const failure = await run(broken, options).then(() => null, (error: Error) => error.message);

    expect(failure).toContain(`Timed out after 900s waiting for ${ISOLATED} to mark its workspace identities ready for this boot`);
    expect(failure).toContain("could not be read: kubectl get pods exited with 1: connection refused");
    expect(failure).toContain("could not be read: kubectl get networkpolicies exited with 1: forbidden");
  });

  it.each([
    ["the gateway log's last identity failure", { log: `${IDENTITY_FAILURE}: Error: broker refused authorization: Bearer leaked-identity-5d4c` }, "Bearer [redacted]"],
    ["the last marker read failure", { markerReadError: "error: exec refused for token=leaked-kubectl-7e6f" }, "token=[redacted]"],
  ])("keeps a secret out of %s that the failure quotes", async (_source, scenario, redacted) => {
    const { deps } = cluster({ identityReadyAfterBoot: false, ...scenario });

    const failure = await run(deps, options).then(() => null, (error: Error) => error.message);

    expect(failure).toContain(redacted);
    expect(failure).not.toContain("leaked-");
  });

  it("fails when the home does not survive park and resume", async () => {
    const { deps, events } = cluster({ homeSurvives: false });

    await expect(run(deps, options)).rejects.toThrow(`${ISOLATED} lost its home across park and resume`);
    expect(events).not.toContain(`gateway retire ${ISOLATED}`);
  });

  it("does not take the previous boot's identity markers, which the home keeps through park, as the resumed boot's", async () => {
    const { deps, events } = cluster({ identityReadyAfterResume: false });

    await expect(run(deps, options)).rejects.toThrow(
      `Timed out after 900s waiting for ${ISOLATED} to mark its workspace identities ready for this boot`,
    );
    expect(events.filter(event => event === "user migrate lin")).toHaveLength(1);
  });

  it("waits through a gateway container that has not started yet without counting it as a marker read failure", async () => {
    const { deps } = cluster({ gatewayStartsAfterMs: 120_000 });

    await expect(run(deps, options)).resolves.toMatchObject({ gatewayId: ISOLATED });
  });

  it("fails fast when the markers cannot be read three times in a row while the gateway container runs", async () => {
    const { deps, events } = cluster({ markerReadError: "error: unable to upgrade connection: Forbidden" });

    const failure = await run(deps, options).then(() => null, (error: Error) => error.message);

    expect(failure).toContain(`${ISOLATED}'s gateway container is running, but its identity markers could not be read 3 times in a row. `);
    expect(failure).toContain("The last marker read failed: error: unable to upgrade connection: Forbidden");
    expect(events.filter(event => event === "identity read")).toHaveLength(3);
    expect(deps.clock.now()).toBeLessThan(60_000);
    expect(events).not.toContain("chat post");
  });
});

describe("identityReady", () => {
  it("needs this boot's marker, not an earlier boot's", () => {
    expect(identityReady({ boot: "boot-2", ready: "boot-2" })).toBe(true);
    expect(identityReady({ boot: "boot-2", ready: "boot-1" })).toBe(false);
    expect(identityReady({ boot: "boot-2", ready: null })).toBe(false);
    expect(identityReady({ boot: null, ready: null })).toBe(false);
  });

  it("needs a boot after the one before park, even when that earlier boot's markers still match", () => {
    expect(identityReady({ boot: "boot-1", ready: "boot-1" }, "boot-1")).toBe(false);
    expect(identityReady({ boot: "boot-2", ready: "boot-1" }, "boot-1")).toBe(false);
    expect(identityReady({ boot: "boot-2", ready: "boot-2" }, "boot-1")).toBe(true);
  });
});

describe("lastIdentityFailure", () => {
  it("takes the last failure line, or none", () => {
    expect(lastIdentityFailure(`a\n${IDENTITY_FAILURE}: one\nb\n${IDENTITY_FAILURE}: two\nc`)).toBe(`${IDENTITY_FAILURE}: two`);
    expect(lastIdentityFailure("a\nb")).toBeNull();
  });
});

describe("redactSecrets", () => {
  it("hides bearer and basic credentials, tokens, keys, passwords and URL credentials, and leaves the rest", () => {
    expect(redactSecrets("authorization: Bearer abc.def-ghi")).toBe("authorization: Bearer [redacted]");
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: Basic [redacted]");
    expect(redactSecrets("ok eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl ok")).toBe("ok [redacted] ok");
    expect(redactSecrets("OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123")).toBe("OPENROUTER_API_KEY=[redacted]");
    expect(redactSecrets("key sk-or-v1-0123456789abcdef0123 used")).toBe("key [redacted] used");
    expect(redactSecrets('{"password":"chat-pass","user":"lin"}')).toBe('{"password":"[redacted]","user":"lin"}');
    expect(redactSecrets("clone http://ws-lin:git-pass@gitea:3000/x.git")).toBe("clone http://[redacted]@gitea:3000/x.git");
    expect(redactSecrets("[builder-identity] broker read failed: fetch failed")).toBe("[builder-identity] broker read failed: fetch failed");
  });
});
