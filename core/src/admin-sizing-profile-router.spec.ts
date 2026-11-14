import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { addAdminSizingProfileRoutes } from "./admin-sizing-profile-router.js";
import { resolveIsolatedSizingProfile } from "./operator-isolated-gateway.js";
import { createDocumentFixtureStore, FIXTURE_SIZING_PROFILES } from "./testing/journal-store.js";

type Row = Record<string, unknown>;

const STANDARD = {
  isolation: "isolated",
  sizingTier: "s",
  computer: {
    runtime: "gce-vm",
    desktop: "x11",
    machineType: "e2-small",
    provisioningModel: "SPOT",
    bootDisk: { sizeGb: 40, type: "pd-balanced" },
    homeSizeGiB: 20,
  },
  fallbackStorageGb: null,
};

const POD = {
  isolation: "isolated",
  sizingTier: "s",
  computer: { runtime: "cluster", homeSizeGiB: 10 },
  fallbackStorageGb: null,
};

function harness(seed: Record<string, Row> = {}, beforeTransaction?: (records: Map<string, Row>, label: string) => void) {
  const records = new Map<string, Row>(Object.entries(structuredClone(seed)));
  const store = createDocumentFixtureStore(records, { beforeTransaction: (label) => beforeTransaction?.(records, label) });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { uid: "operator", isAdmin: true });
    next();
  });
  addAdminSizingProfileRoutes(app, { store });
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  const snapshot = () => JSON.stringify([...records.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return { app, store, records, snapshot };
}

const withFixtureProfiles = () => ({ "config/orchestrator": { sizingProfiles: FIXTURE_SIZING_PROFILES } });

const put = (app: express.Express, name: string, body: unknown, dryRun = false) =>
  request(app).put(`/sizing-profiles/${name}${dryRun ? "?dryRun=true" : ""}`).send(body as object);

const without = (profile: Row, field: string): Row => {
  const { [field]: _removed, ...rest } = profile;
  return rest;
};

describe("listing and showing sizing profiles", () => {
  it("lists every profile by name with the profile as stored", async () => {
    const { app } = harness(withFixtureProfiles());

    const res = await request(app).get("/sizing-profiles").expect(200);

    expect(res.body.sizingProfiles.map((entry: { name: string }) => entry.name)).toEqual(["enterprise", "hobby", "pro", "team"]);
    expect(res.body.sizingProfiles[1]).toEqual({ name: "hobby", profile: FIXTURE_SIZING_PROFILES.hobby });
  });

  it("lists no profiles on a platform that has never stored any", async () => {
    const { app } = harness();

    await request(app).get("/sizing-profiles").expect(200, { sizingProfiles: [] });
  });

  it("shows one profile", async () => {
    const { app } = harness(withFixtureProfiles());

    await request(app).get("/sizing-profiles/pro").expect(200, { name: "pro", profile: FIXTURE_SIZING_PROFILES.pro });
  });

  it("answers an unknown profile with 404 and a code", async () => {
    const { app } = harness(withFixtureProfiles());

    const res = await request(app).get("/sizing-profiles/platinum").expect(404);

    expect(res.body).toMatchObject({ code: "sizing-profile-unknown" });
  });

  it("does not read inherited properties as profiles", async () => {
    const { app } = harness(withFixtureProfiles());

    await request(app).get("/sizing-profiles/constructor").expect(404);
  });
});

describe("setting a sizing profile", () => {
  it("stores a profile that a move to an isolated gateway then accepts, and journals the write", async () => {
    const { app, store } = harness();

    const res = await put(app, "standard", STANDARD).expect(200);

    expect(res.body).toMatchObject({ name: "standard", profile: STANDARD });
    expect(await resolveIsolatedSizingProfile(store, "standard")).toEqual({ sizingKey: "standard", sizingTier: "s" });
    const audit = await store.journal.getRecord(res.body.operationId);
    expect(audit).toMatchObject({
      recordType: "audit",
      status: "completed",
      actor: "operator",
      what: "set sizing profile",
      target: { sizingProfile: "standard" },
      preActionStatus: { profile: null },
      mutation: { kind: "set-sizing-profile", sizingProfile: "standard", profile: STANDARD },
    });
  });

  it("replaces one profile and keeps the others", async () => {
    const { app, store } = harness(withFixtureProfiles());
    const hobby = { ...FIXTURE_SIZING_PROFILES.hobby, fallbackStorageGb: 200 };

    await put(app, "hobby", hobby).expect(200);

    expect((await store.config.orchestrator.get())?.sizingProfiles).toEqual({ ...FIXTURE_SIZING_PROFILES, hobby });
  });

  it("stores a shared profile", async () => {
    const { app, store } = harness();

    await put(app, "default", { isolation: "shared" }).expect(200);

    expect((await store.config.orchestrator.get())?.sizingProfiles).toEqual({ default: { isolation: "shared" } });
  });

  it("stores a Kubernetes pod profile, which names only the size of the gateway's home", async () => {
    const { app, store } = harness();

    const res = await put(app, "pod", POD).expect(200);

    expect(res.body).toMatchObject({ name: "pod", profile: POD });
    expect((await store.config.orchestrator.get())?.sizingProfiles).toEqual({ pod: POD });
  });

  it("allows a pod profile at a tier where another profile runs a VM", async () => {
    const { app, store } = harness(withFixtureProfiles());
    expect(FIXTURE_SIZING_PROFILES.hobby).toMatchObject({ sizingTier: POD.sizingTier, computer: { runtime: "gce-vm" } });

    await put(app, "pod", POD).expect(200);

    expect((await store.config.orchestrator.get())?.sizingProfiles.pod).toEqual(POD);
  });

  it("allows a second profile at a tier when its VM settings are the same", async () => {
    const { app, store } = harness(withFixtureProfiles());
    const hobbyPlus = { ...FIXTURE_SIZING_PROFILES.hobby, fallbackStorageGb: 300 };

    await put(app, "hobby-plus", hobbyPlus).expect(200);

    expect((await store.config.orchestrator.get())?.sizingProfiles["hobby-plus"]).toEqual(hobbyPlus);
  });
});

describe("a dry run of setting a sizing profile", () => {
  it("answers with the plan, the profile it would replace, and writes nothing", async () => {
    const { app, snapshot } = harness(withFixtureProfiles());
    const before = snapshot();
    const hobby = { ...FIXTURE_SIZING_PROFILES.hobby, fallbackStorageGb: 200 };

    const res = await put(app, "hobby", hobby, true).expect(200);

    expect(res.headers["admin-api-capabilities"]).toBe("dry-run");
    expect(res.body).toEqual({
      dryRun: true,
      plans: [expect.objectContaining({
        what: "set sizing profile",
        kind: "set-sizing-profile",
        target: { sizingProfile: "hobby" },
        preActionStatus: { profile: FIXTURE_SIZING_PROFILES.hobby },
        mutation: { kind: "set-sizing-profile", sizingProfile: "hobby", profile: hobby },
        forced: false,
      })],
    });
    expect(snapshot()).toBe(before);
  });

  it("refuses a dryRun value other than true or false", async () => {
    const { app, snapshot } = harness();
    const before = snapshot();

    const res = await request(app).put("/sizing-profiles/standard?dryRun=yes").send(STANDARD).expect(400);

    expect(res.body).toEqual({ error: "dryRun must be true or false" });
    expect(snapshot()).toBe(before);
  });
});

describe("refusing a sizing profile", () => {
  const refusals: Array<[string, string, unknown, number, string]> = [
    ["a name with characters outside lower-case letters, digits and hyphens", "Big_One", STANDARD, 400, "sizing-profile-name-invalid"],
    ["a profile the platform-state schema rejects", "standard", without(STANDARD, "computer"), 400, "sizing-profile-invalid"],
    ["a profile with a field the platform does not read", "standard", { ...STANDARD, zone: "us-central1-a" }, 400, "sizing-profile-invalid"],
    ["VM settings with a field the platform does not read", "standard", { ...STANDARD, computer: { ...STANDARD.computer, gpus: 1 } }, 400, "sizing-profile-invalid"],
    ["a boot disk that is not a positive whole number of GB", "standard", { ...STANDARD, computer: { ...STANDARD.computer, bootDisk: { sizeGb: 0, type: "pd-ssd" } } }, 400, "sizing-profile-invalid"],
    ["a home disk that is not a whole number of GiB", "standard", { ...STANDARD, computer: { ...STANDARD.computer, homeSizeGiB: 2.5 } }, 400, "sizing-profile-invalid"],
    ["a negative fallback storage size", "standard", { ...STANDARD, fallbackStorageGb: -1 }, 400, "sizing-profile-invalid"],
    ["an isolated profile without a machine type", "standard", { ...STANDARD, computer: { ...STANDARD.computer, machineType: null } }, 400, "sizing-profile-no-vm"],
    ["an isolated profile without a boot disk", "standard", { ...STANDARD, computer: { ...STANDARD.computer, bootDisk: null } }, 400, "sizing-profile-no-vm"],
    ["pod settings with a VM field", "pod", { ...POD, computer: { ...POD.computer, machineType: "e2-small" } }, 400, "sizing-profile-invalid"],
    ["pod settings without a home size", "pod", { ...POD, computer: { runtime: "cluster" } }, 400, "sizing-profile-invalid"],
    ["a pod home that is not a positive whole number of GiB", "pod", { ...POD, computer: { runtime: "cluster", homeSizeGiB: 0 } }, 400, "sizing-profile-invalid"],
    ["VM settings that differ from another profile at the same tier", "studio", { ...FIXTURE_SIZING_PROFILES.pro, computer: { ...STANDARD.computer, desktop: "omarchy" }, sizingTier: "m" }, 409, "sizing-tier-conflict"],
  ];

  for (const [what, name, body, status, code] of refusals) {
    it(`refuses ${what}, applied or as a dry run, and writes nothing`, async () => {
      const { app, snapshot } = harness(withFixtureProfiles());
      const before = snapshot();

      const dryRun = await put(app, name, body, true).expect(status);
      const applied = await put(app, name, body).expect(status);

      expect(dryRun.body).toMatchObject({ code });
      expect(applied.body).toEqual(dryRun.body);
      expect(snapshot()).toBe(before);
    });
  }

  it("names the profiles at the conflicting tier", async () => {
    const { app } = harness(withFixtureProfiles());

    const res = await put(app, "studio", { ...FIXTURE_SIZING_PROFILES.pro, computer: { ...STANDARD.computer, desktop: "omarchy" } }).expect(409);

    expect(res.body).toMatchObject({ code: "sizing-tier-conflict", sizingTier: "m", sizingProfiles: ["pro"] });
  });

  it("refuses and journals the failure when a conflicting profile is stored after the check", async () => {
    const { app, store, records } = harness({ "config/orchestrator": { sizingProfiles: { pro: FIXTURE_SIZING_PROFILES.pro } } }, (seeded, label) => {
      if (label !== "admin.sizing-profiles.set") return;
      const orchestrator = seeded.get("config/orchestrator")!;
      seeded.set("config/orchestrator", {
        ...orchestrator,
        sizingProfiles: { ...(orchestrator.sizingProfiles as Row), rival: { ...STANDARD, computer: { ...STANDARD.computer, machineType: "e2-micro" } } },
      });
    });

    const res = await put(app, "standard", STANDARD).expect(409);

    expect(res.body).toMatchObject({ code: "sizing-tier-conflict", sizingProfiles: ["rival"] });
    expect(Object.keys((await store.config.orchestrator.get())?.sizingProfiles ?? {})).not.toContain("standard");
    const audits = [...records.entries()].filter(([path]) => path.startsWith("glmOperations/")).map(([, row]) => row);
    expect(audits).toEqual([expect.objectContaining({ recordType: "audit", status: "failed", what: "set sizing profile" })]);
  });
});
