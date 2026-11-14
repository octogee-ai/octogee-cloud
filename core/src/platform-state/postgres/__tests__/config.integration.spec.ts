import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HOUSE_MODEL_REF,
  DEFAULT_PLATFORM_CONNECT_CONFIG,
  parsePlatformModelConfig,
} from "@octogee/shared/types/platform-config";
import type { GatewaySizingProfile } from "../../config.js";
import { FenceMismatchError, MalformedRecordError, MissingRecordError } from "../../errors.js";
import type { Revision } from "../../store.js";
import { createHarness, dsn, recordingListener, type PlatformStateHarness, type RecordingListener } from "./fixtures/harness.js";

const NOW = 1_762_500_000_000;
const WAIT = { timeout: 20_000, interval: 20 };
const MODELS = parsePlatformModelConfig({ freeTierModelRef: DEFAULT_HOUSE_MODEL_REF })!;
const HOBBY: GatewaySizingProfile = {
  isolation: "isolated",
  sizingTier: "s",
  fallbackStorageGb: 100,
  computer: {
    runtime: "gce-vm",
    desktop: "x11",
    machineType: "e2-medium",
    provisioningModel: "STANDARD",
    bootDisk: { sizeGb: 80, type: "pd-balanced" },
    homeSizeGiB: 10,
  },
};
const POD: GatewaySizingProfile = {
  isolation: "isolated",
  sizingTier: "s",
  fallbackStorageGb: null,
  computer: { runtime: "cluster", homeSizeGiB: 10 },
};
const SIZING_PROFILES: Record<string, GatewaySizingProfile> = { hobby: HOBBY, pod: POD, enterprise: { isolation: "shared" } };

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function changeKeys(listener: RecordingListener<"config">): string[] {
  return listener.events
    .flatMap((event) => (event.kind === "changes" ? [...event.changes] : []))
    .map((change) => `${change.type}:${change.key}`);
}

describe.skipIf(!dsn)("PostgreSQL config", { timeout: 30_000 }, () => {
  let harness: PlatformStateHarness;
  const orchestrator = () => harness.store.config.orchestrator;
  const platform = () => harness.store.config.platform;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  describe("orchestrator config", () => {
    it("creates the singleton on its first patch and reads absent fields as null and absent autoscaling as the defaults", async () => {
      expect(await orchestrator().get()).toBeNull();
      await orchestrator().patch({ defaultGatewayId: "shared-0" });

      expect(await orchestrator().get()).toEqual({
        sharedGatewayAutoscaling: { enabled: true, buildersPerGateway: 10 },
        sizingProfiles: {},
        defaultGatewayId: "shared-0",
        disposableGatewayIdleMs: null,
        placementUpdatedAt: null,
        placementUpdatedBy: null,
        revision: expect.stringMatching(/^\d+$/),
      });
    });

    it("patches only the fields given and clears the ones asked for", async () => {
      await orchestrator().patch({ sharedGatewayAutoscaling: { enabled: false, buildersPerGateway: 4 }, placementUpdatedAt: NOW, placementUpdatedBy: "uid-admin" });
      await orchestrator().patch({ disposableGatewayIdleMs: 0, defaultGatewayId: "shared-0" });

      expect(await orchestrator().get()).toEqual({
        sharedGatewayAutoscaling: { enabled: false, buildersPerGateway: 4 },
        sizingProfiles: {},
        defaultGatewayId: "shared-0",
        disposableGatewayIdleMs: 0,
        placementUpdatedAt: NOW,
        placementUpdatedBy: "uid-admin",
        revision: expect.any(String),
      });

      await orchestrator().patch({ defaultGatewayId: { clear: true }, placementUpdatedBy: null });
      expect(await orchestrator().get()).toMatchObject({ defaultGatewayId: null, placementUpdatedBy: null, placementUpdatedAt: NOW });
    });

    it("clears the idle-time override through the clear sentinel", async () => {
      await orchestrator().patch({ disposableGatewayIdleMs: 60_000, defaultGatewayId: "shared-0" });

      await orchestrator().patch({ disposableGatewayIdleMs: { clear: true } });

      expect(await orchestrator().get()).toMatchObject({ disposableGatewayIdleMs: null, defaultGatewayId: "shared-0" });
    });

    it("creates the singleton from a patch that also clears an override", async () => {
      await orchestrator().patch({ defaultGatewayId: { clear: true }, placementUpdatedBy: "uid-admin" });

      expect(await orchestrator().get()).toMatchObject({ defaultGatewayId: null, placementUpdatedBy: "uid-admin" });
    });

    it("patches under the revision fence and refuses a fenced patch of a missing singleton", async () => {
      expect(await failure(orchestrator().patch({ disposableGatewayIdleMs: 1 }, { revision: "1" as Revision }))).toMatchObject({
        constructor: MissingRecordError,
        record: { aggregate: "orchestrator-config", key: "orchestrator" },
      });

      await orchestrator().patch({ placementUpdatedBy: "uid-admin" });
      const first = await orchestrator().get();
      await orchestrator().patch({ disposableGatewayIdleMs: 60_000 }, { revision: first?.revision });
      expect(await orchestrator().get()).toMatchObject({ disposableGatewayIdleMs: 60_000, placementUpdatedBy: "uid-admin" });

      expect(await failure(orchestrator().patch({ disposableGatewayIdleMs: 1 }, { revision: first?.revision }))).toMatchObject({
        constructor: FenceMismatchError,
        fence: "revision",
      });
      expect((await orchestrator().get())?.disposableGatewayIdleMs).toBe(60_000);
    });

    it("refuses to store invalid autoscaling, sizing profiles or idle time", async () => {
      const refused = await Promise.all([
        failure(orchestrator().patch({ sharedGatewayAutoscaling: { enabled: true, buildersPerGateway: 1 } })),
        failure(orchestrator().patch({ sharedGatewayAutoscaling: { enabled: "yes" as never, buildersPerGateway: 4 } })),
        failure(orchestrator().patch({ sizingProfiles: { hobby: { isolation: "isolated" } as never } })),
        failure(orchestrator().patch({ disposableGatewayIdleMs: -1 })),
        failure(orchestrator().patch({ disposableGatewayIdleMs: 1.5 })),
      ]);
      for (const error of refused) expect(error).toBeInstanceOf(MalformedRecordError);
      expect(await orchestrator().get()).toBeNull();
    });

    it("holds the stored autoscaling to the shared parser's bounds", async () => {
      await orchestrator().patch({ sharedGatewayAutoscaling: { enabled: true, buildersPerGateway: 2 } });

      expect(await failure(harness.query("UPDATE $schema.orchestrator_config SET shared_users_per_gateway = 1"))).toMatchObject({ code: "23514" });
      expect(await failure(harness.query("UPDATE $schema.orchestrator_config SET shared_autoscaling_enabled = NULL"))).toMatchObject({ code: "23514" });
      expect((await orchestrator().get())?.sharedGatewayAutoscaling).toEqual({ enabled: true, buildersPerGateway: 2 });
    });

    it("reads a stored sizing profile the shape check rejects as malformed", async () => {
      await orchestrator().patch({ sizingProfiles: SIZING_PROFILES });
      await harness.query(`UPDATE $schema.orchestrator_config SET sizing_profiles = '{"hobby":{"isolation":"isolated"}}'::jsonb`);

      expect(await failure(orchestrator().get())).toBeInstanceOf(MalformedRecordError);
      expect(await failure(orchestrator().getSizingProfile("hobby"))).toBeInstanceOf(MalformedRecordError);
    });

    it("looks up a seeded sizing profile and refuses an unknown sizing key or a missing singleton", async () => {
      expect(await failure(orchestrator().getSizingProfile("hobby"))).toMatchObject({
        constructor: MissingRecordError,
        record: { aggregate: "orchestrator-config", key: "orchestrator/sizingProfiles/hobby" },
      });

      await orchestrator().patch({ sizingProfiles: SIZING_PROFILES });
      expect(await orchestrator().getSizingProfile("hobby")).toEqual(HOBBY);
      expect(await orchestrator().getSizingProfile("pod")).toEqual(POD);
      expect(await orchestrator().getSizingProfile("enterprise")).toEqual({ isolation: "shared" });
      expect(await failure(orchestrator().getSizingProfile("platinum"))).toMatchObject({
        constructor: MissingRecordError,
        record: { aggregate: "orchestrator-config", key: "orchestrator/sizingProfiles/platinum" },
      });
    });
  });

  describe("platform config", () => {
    it("puts the parsed value with a server-stamped or given updatedAt and deletes it", async () => {
      await platform().put("free", { schemaVersion: 1, workspaceStorageGb: 20 }, "uid-admin", { serverNow: true });
      const free = await platform().get("free");
      expect(free).toEqual({
        key: "free",
        value: { schemaVersion: 1, workspaceStorageGb: 20 },
        updatedAt: expect.any(Number),
        updatedBy: "uid-admin",
        revision: expect.stringMatching(/^\d+$/),
      });
      expect(Math.abs((free?.updatedAt ?? 0) - Date.now())).toBeLessThan(60_000);

      await platform().put("models", MODELS, "uid-admin", NOW);
      await platform().put("connect", DEFAULT_PLATFORM_CONNECT_CONFIG, "uid-admin", NOW);
      expect(await platform().get("models")).toEqual({ key: "models", value: MODELS, updatedAt: NOW, updatedBy: "uid-admin", revision: expect.any(String) });
      expect((await platform().get("connect"))?.value).toEqual(DEFAULT_PLATFORM_CONNECT_CONFIG);

      await platform().put("free", { schemaVersion: 1, workspaceStorageGb: 40 }, "uid-other", NOW + 1);
      expect(await platform().get("free")).toMatchObject({ value: { workspaceStorageGb: 40 }, updatedAt: NOW + 1, updatedBy: "uid-other" });

      await platform().delete("models");
      await platform().delete("models");
      expect(await platform().get("models")).toBeNull();
    });

    it("refuses to write or read a value the shared parser rejects", async () => {
      expect(await failure(platform().put("free", { schemaVersion: 1, workspaceStorageGb: 5000 }, "uid-admin", NOW))).toBeInstanceOf(MalformedRecordError);
      expect(await platform().get("free")).toBeNull();

      await harness.query(`INSERT INTO $schema.platform_config (key, value) VALUES ('free', '{"schemaVersion":2,"workspaceStorageGb":20}'::jsonb)`);
      expect(await failure(platform().get("free"))).toBeInstanceOf(MalformedRecordError);
    });
  });

  describe("singleton config records", () => {
    it("replaces and deletes the writer quiescence marker as an opaque record", async () => {
      const marker = { operator: "chris", reason: "platform migration", writers: ["glm-controller", "octogee-api"], startedAt: NOW, note: null };
      expect(await harness.store.config.writerQuiescence.get()).toBeNull();
      await harness.store.config.writerQuiescence.put(marker);
      expect(await harness.store.config.writerQuiescence.get()).toEqual({ ...marker, revision: expect.stringMatching(/^\d+$/) });

      await harness.store.config.writerQuiescence.put({ operator: "chris" });
      expect(await harness.store.config.writerQuiescence.get()).toEqual({ operator: "chris", revision: expect.any(String) });

      await harness.store.config.writerQuiescence.delete();
      await harness.store.config.writerQuiescence.delete();
      expect(await harness.store.config.writerQuiescence.get()).toBeNull();
    });

    it("puts the Mattermost admin identity with a server-stamped updatedAt and replaces it whole", async () => {
      expect(await harness.store.config.mattermostAdmin.get()).toBeNull();
      await harness.store.config.mattermostAdmin.put({ userId: "mm-admin", proxyUrl: "", updatedAt: { serverNow: true } });
      const first = await harness.store.config.mattermostAdmin.get();
      expect(first).toEqual({ userId: "mm-admin", proxyUrl: "", updatedAt: expect.any(Number), revision: expect.stringMatching(/^\d+$/) });
      expect(Math.abs((first?.updatedAt ?? 0) - Date.now())).toBeLessThan(60_000);

      await harness.store.config.mattermostAdmin.put({ userId: "mm-admin-2", proxyUrl: null, updatedAt: NOW });
      expect(await harness.store.config.mattermostAdmin.get()).toEqual({ userId: "mm-admin-2", proxyUrl: null, updatedAt: NOW, revision: expect.any(String) });
    });
  });

  describe("config watch", () => {
    it("delivers orchestrator and platform config as one snapshot followed by keyed changes", async () => {
      await orchestrator().patch({ defaultGatewayId: "shared-0" });
      await platform().put("models", MODELS, "uid-admin", NOW);
      const listener = recordingListener<"config">();
      harness.store.watch({ aggregate: "config", filter: {} }, listener);

      await vi.waitFor(() => expect(listener.events[0]).toMatchObject({ kind: "snapshot" }), WAIT);
      const snapshot = listener.events[0];
      expect(snapshot.kind === "snapshot" ? snapshot.records : []).toEqual([
        { kind: "orchestrator", value: expect.objectContaining({ defaultGatewayId: "shared-0" }), revision: expect.any(String) },
        { kind: "platform", entry: { key: "models", value: MODELS, updatedAt: NOW, updatedBy: "uid-admin" }, revision: expect.any(String) },
      ]);

      await platform().put("free", { schemaVersion: 1, workspaceStorageGb: 20 }, "uid-admin", NOW);
      await vi.waitFor(() => expect(changeKeys(listener)).toEqual(["added:platform/free"]), WAIT);
      await orchestrator().patch({ defaultGatewayId: "shared-1" });
      await vi.waitFor(() => expect(changeKeys(listener)).toEqual(["added:platform/free", "modified:orchestrator"]), WAIT);
      await platform().delete("models");
      await vi.waitFor(() => expect(changeKeys(listener)).toEqual(["added:platform/free", "modified:orchestrator", "removed:platform/models"]), WAIT);

      const changes = listener.events.flatMap((event) => (event.kind === "changes" ? [...event.changes] : []));
      expect(changes[0].record).toMatchObject({ kind: "platform", entry: { key: "free", value: { workspaceStorageGb: 20 } } });
      expect(changes[1].record).toMatchObject({ kind: "orchestrator", value: { defaultGatewayId: "shared-1" } });
      expect(listener.errors).toEqual([]);
    });
  });
});
