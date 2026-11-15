import { releasePayloadHash, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { GatewayArtifact } from "@octogee/core/gateway-live-release";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

type Data = Record<string, unknown>;

export interface JourneyScalerDeps {
  store: PlatformStateStore;
  bounds: { minReplicas: number; maxReplicas: number };
  platformArtifact: GatewayArtifact;
  newGatewayId(): string;
  now(): number;
  log(message: string): void;
  recordMaxCapacity(sample: { assignmentCount: number; hotMemberCount: number }): void;
}

export type JourneyTick = (deps: JourneyScalerDeps) => Promise<unknown>;

const REPOSITORY = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
const SCALER = "glm-controller-shared-pool-scaler";

function build(tag: string): ReleasePayload {
  return {
    imageRepository: REPOSITORY,
    imageTag: `${tag}@sha256:${tag.charAt(0).repeat(64)}`,
    profileImages: {
      builder: { imageRepository: `${REPOSITORY}-builder`, imageTag: `${tag}@sha256:${tag.charAt(2).repeat(64)}` },
    },
    gatewayEdgeImage: {
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge",
      imageTag: `${tag}@sha256:${tag.charAt(1).repeat(64)}`,
    },
  };
}

export const JOURNEY_FIRST_BUILD = build("abc1234");
export const JOURNEY_NEXT_BUILD = build("def5678");

function root(gatewayId: string): Data {
  return {
    gatewayId, createdAt: 1, createdBy: SCALER, updatedAt: 1, updatedBy: SCALER,
    configSchemaVersion: 1, profile: null, gatewayClass: "shared", imageProfile: "standard", sizingTier: null,
    gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null,
    builderAccess: null, ownerUid: null, builderSlug: null, modelBrokerLimits: null, allocation: null,
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running",
  };
}

function release(gatewayId: string, payload: ReleasePayload): Data {
  return {
    gatewayId, release: 1, createdAt: 1, createdBy: SCALER, sourceRelease: null, note: null,
    payloadHash: releasePayloadHash(payload), payload,
  };
}

class Journey {
  readonly records = new Map<string, Data>();
  readonly logs: string[] = [];
  private nextId = 0;
  now = 1_000_000;
  platform: ReleasePayload = JOURNEY_FIRST_BUILD;

  readonly store = createDocumentFixtureStore(this.records, { serializeTransactions: true });

  deps(): JourneyScalerDeps {
    return {
      store: this.store,
      bounds: { minReplicas: 1, maxReplicas: 4 },
      platformArtifact: this.platform,
      newGatewayId: () => `shared-${String(++this.nextId).padStart(12, "0")}`,
      now: () => this.now,
      log: (message) => this.logs.push(message),
      recordMaxCapacity: (sample) => this.logs.push(`max-capacity ${JSON.stringify(sample)}`),
    };
  }

  seedGateway(gatewayId: string, payload: ReleasePayload): void {
    this.records.set(`gateways/${gatewayId}`, root(gatewayId));
    this.records.set(`gateways/${gatewayId}/releases/1`, release(gatewayId, payload));
    this.serve(gatewayId, []);
  }

  serve(gatewayId: string, slugs: string[]): void {
    const gateway = this.records.get(`gateways/${gatewayId}`)!;
    gateway.liveRelease = gateway.desiredRelease;
    this.records.set(`glmGateways/${gatewayId}`, {
      docKind: "runtime", gatewayId, release: gateway.liveRelease, lifecycle: "serving",
      heartbeat: { status: "ready", mountedCustomers: slugs, lastHeartbeatAt: this.now },
    });
  }

  assign(gatewayId: string, uid: string): void {
    const slug = uid.replace(/^uid-/, "");
    this.records.set(`gateways/${gatewayId}/assignments/${uid}`, {
      uid, gatewayId, slug, source: "repair", state: "serving", epoch: 0, createdAt: 1, updatedAt: 1, updatedByOperationId: null,
    });
    this.records.set(`users/${uid}`, {
      username: slug, onboardingStep: "complete",
      provisioning: { status: "complete", openclaw: { gatewayId, slug } },
    });
    this.serve(gatewayId, this.slugsOn(gatewayId));
  }

  unassign(gatewayId: string, uid: string): void {
    this.records.delete(`gateways/${gatewayId}/assignments/${uid}`);
    this.records.delete(`users/${uid}`);
    this.serve(gatewayId, this.slugsOn(gatewayId));
  }

  waiting(uid: string): void {
    this.records.set(`users/${uid}`, {
      username: uid.replace(/^uid-/, ""), onboardingStep: "complete",
      provisioning: { status: "in_progress", openclaw: {} },
    });
  }

  finishOperation(kind: string, gatewayId: string): void {
    for (const [path, data] of this.records) {
      if (path.startsWith("glmOperations/") && data.kind === kind && data.gatewayId === gatewayId) {
        this.records.set(path, { ...data, status: "succeeded" });
      }
    }
  }

  retireRuntime(gatewayId: string): void {
    this.records.delete(`glmGateways/${gatewayId}`);
  }

  slugsOn(gatewayId: string): string[] {
    return [...this.records.entries()]
      .filter(([path]) => path.startsWith(`gateways/${gatewayId}/assignments/`))
      .map(([, data]) => String(data.slug))
      .sort();
  }

  snapshot(): Data {
    const gateways: Data = {};
    const operations: Data[] = [];
    for (const [path, data] of [...this.records.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const segments = path.split("/");
      if (segments[0] === "gateways" && segments.length === 2) {
        gateways[segments[1]!] = { desiredStatus: data.desiredStatus, createdBy: data.createdBy, updatedBy: data.updatedBy };
      }
      if (segments[0] === "glmOperations" && data.recordType !== "audit") {
        operations.push({
          id: /^shared-pool-/.test(segments[1]!) ? segments[1] : "(generated)",
          kind: data.kind, status: data.status, gatewayId: data.gatewayId, input: data.input,
        });
      }
    }
    const scaler = this.records.get("glmControllerState/sharedPoolScaler");
    return {
      gateways,
      operations: operations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      scaler: scaler === undefined ? null : { actionSequence: scaler.actionSequence, replacements: scaler.replacements },
    };
  }
}

export async function runSharedPoolScalerJourney(tick: JourneyTick): Promise<Data[]> {
  const journey = new Journey();
  const steps: Data[] = [];
  const step = async (name: string) => {
    journey.now += 60_000;
    for (const gatewayId of Object.keys(journey.snapshot().gateways as Data)) {
      const runtime = journey.records.get(`glmGateways/${gatewayId}`);
      if (runtime) (runtime.heartbeat as Data).lastHeartbeatAt = journey.now;
    }
    journey.logs.length = 0;
    const result = await tick(journey.deps());
    steps.push({ step: name, result, logs: [...journey.logs], state: journey.snapshot() });
  };

  journey.records.set("config/orchestrator", { sharedGatewayAutoscaling: { enabled: true, buildersPerGateway: 4 } });
  journey.seedGateway("shared-a", JOURNEY_FIRST_BUILD);
  for (const index of [1, 2, 3, 4]) journey.assign("shared-a", `uid-a${index}`);
  journey.waiting("uid-w1");
  journey.waiting("uid-w2");
  await step("demand above capacity scales up");

  await step("holds after scaling up while demand fits");

  journey.serve("shared-000000000001", []);
  journey.finishOperation("add-gateway", "shared-000000000001");
  journey.records.delete("users/uid-w1");
  journey.records.delete("users/uid-w2");
  journey.assign("shared-000000000001", "uid-w1");
  journey.assign("shared-000000000001", "uid-w2");
  await step("holds with demand inside capacity");

  journey.unassign("shared-000000000001", "uid-w1");
  journey.unassign("shared-000000000001", "uid-w2");
  journey.unassign("shared-a", "uid-a4");
  await step("demand falls and an empty gateway drains");

  journey.serve("shared-000000000001", []);
  await step("retires the drained empty gateway");

  journey.finishOperation("retire-gateway", "shared-000000000001");
  journey.retireRuntime("shared-000000000001");
  await step("sweeps the retired gateway");

  journey.platform = JOURNEY_NEXT_BUILD;
  await step("a new platform build mints a replacement");

  journey.serve("shared-000000000002", []);
  journey.finishOperation("add-gateway", "shared-000000000002");
  await step("drains the replaced gateway onto its converged replacement");

  for (const index of [1, 2, 3]) {
    journey.unassign("shared-a", `uid-a${index}`);
    journey.assign("shared-000000000002", `uid-a${index}`);
  }
  await step("retires the emptied replaced gateway");

  journey.finishOperation("retire-gateway", "shared-a");
  journey.retireRuntime("shared-a");
  await step("finishes the replacement");

  await step("holds once the pool is current");
  return steps;
}
