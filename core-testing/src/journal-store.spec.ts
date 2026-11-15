import { describe, expect, it } from "vitest";
import { FenceMismatchError, MalformedRecordError, MissingRecordError, type SharedPoolScalerState } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "./journal-store.js";

describe("journal fixture store user records", () => {
  it("creates a user record and keeps its fields when created again", async () => {
    const store = createDocumentFixtureStore(new Map());
    await store.users.records.create({ uid: "ada", createdAt: 1_000 });
    await store.users.records.patch("ada", { slug: "ada" });
    await store.users.records.create({ uid: "ada", createdAt: 2_000 });

    expect(await store.users.records.get("ada")).toMatchObject({ uid: "ada", createdAt: 2_000, slug: "ada" });
  });

  it("stores and clears a role through patch", async () => {
    const store = createDocumentFixtureStore(new Map());
    await store.users.records.create({ uid: "ada", createdAt: 1_000 });

    await store.users.records.patch("ada", { role: "admin" });
    expect(await store.users.records.getRole("ada")).toBe("admin");

    await store.users.records.patch("ada", { role: { clear: true } });
    expect(await store.users.records.getRole("ada")).toBeNull();
  });

  it("replaces the activated agents of a user", async () => {
    const store = createDocumentFixtureStore(new Map());
    await store.users.records.create({ uid: "ada", createdAt: 1_000 });

    await store.users.records.setActivatedAgents("ada", ["coach", "builder"]);
    await store.users.records.setActivatedAgents("ada", ["coach"]);

    expect((await store.users.records.get("ada"))?.agents.activatedAgents).toEqual(["coach"]);
  });

  it("admits a user with its slug, persona and a resolved provisioning start, keeping an earlier creation time", async () => {
    const store = createDocumentFixtureStore(new Map());
    await store.users.records.create({ uid: "ada", createdAt: 1_000 });

    await store.users.records.admit("ada", {
      slug: "ada",
      persona: { vibe: "calm", timeZone: "UTC" },
      createdAt: { serverNow: true },
      provisioningStartedAt: { serverNow: true },
    });

    const record = await store.users.records.get("ada");
    expect(record).toMatchObject({ slug: "ada", admitted: true, persona: { vibe: "calm", timeZone: "UTC" }, createdAt: 1_000 });
    expect(record?.provisioning.status).toBe("in_progress");
    expect(typeof record?.provisioning.startedAt).toBe("number");
  });

  it("refuses to admit a user twice or under another slug", async () => {
    const store = createDocumentFixtureStore(new Map());
    const admission = { persona: null, createdAt: 1, provisioningStartedAt: 2 };
    await store.users.records.create({ uid: "ada", createdAt: 1 });
    await store.users.records.patch("ada", { slug: "ada" });

    await expect(store.users.records.admit("ada", { ...admission, slug: "eve" })).rejects.toThrow(FenceMismatchError);
    await store.users.records.admit("ada", { ...admission, slug: "ada" });
    await expect(store.users.records.admit("ada", { ...admission, slug: "ada" })).rejects.toThrow(FenceMismatchError);
  });

  it("lists only admitted users, ordered by uid", async () => {
    const store = createDocumentFixtureStore(new Map());
    const admission = { persona: null, createdAt: 1, provisioningStartedAt: 2 };
    for (const uid of ["eve", "bob", "ada"]) await store.users.records.create({ uid, createdAt: 1 });
    await store.users.records.admit("eve", { ...admission, slug: "eve" });
    await store.users.records.admit("ada", { ...admission, slug: "ada" });

    expect((await store.users.records.listAdmitted()).map((record) => record.uid)).toEqual(["ada", "eve"]);
  });
});

describe("journal fixture store shared pool scaler state", () => {
  const REPLACEMENT = { sourceGatewayId: "shared-0", targetGatewayId: "shared-1", updatedAt: 1_000 };
  const state = (overrides: Partial<SharedPoolScalerState> = {}): SharedPoolScalerState => ({
    schemaVersion: 1, actionSequence: 4, lastActionAt: 1_000, replacements: [REPLACEMENT], lastAction: { decision: "drain" }, updatedAt: 1_000, ...overrides,
  });
  const scaler = (store = createDocumentFixtureStore(new Map())) => store.controllerState.sharedPoolScaler;
  const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

  it("puts the first state only when absent, then replaces it only under a matching sequence", async () => {
    const repository = scaler();
    await repository.put(state({ actionSequence: 0 }), "absent");
    expect(await failure(repository.put(state(), "absent"))).toMatchObject({ constructor: FenceMismatchError, fence: "absent" });

    await repository.put({ schemaVersion: 1, actionSequence: 1, lastActionAt: 1_000, replacements: [] }, { actionSequence: 0 });
    const replaced = await repository.get();
    expect(replaced).toMatchObject({ actionSequence: 1, replacements: [] });
    expect(replaced).not.toHaveProperty("updatedAt");
    expect(await failure(repository.put(state(), { actionSequence: 0 }))).toMatchObject({
      constructor: FenceMismatchError, fence: "actionSequence", expected: 0, actual: 1,
    });
  });

  it("refuses to put over missing state without the absent fence, or to store state the parser rejects", async () => {
    const repository = scaler();
    expect(await failure(repository.put(state(), { actionSequence: 0 }))).toBeInstanceOf(MissingRecordError);
    expect(await failure(repository.put(state({ replacements: [REPLACEMENT, REPLACEMENT] }), "absent"))).toBeInstanceOf(MalformedRecordError);
    expect(await failure(repository.put(state({ actionSequence: -1 }), "absent"))).toBeInstanceOf(MalformedRecordError);
    expect(await repository.get()).toBeNull();
  });

  it("patches under the sequence fence, clears optional fields and refuses invalid or missing state", async () => {
    const repository = scaler();
    expect(await failure(repository.patch({ actionSequence: 1 }))).toBeInstanceOf(MissingRecordError);
    await repository.put(state(), "absent");

    await repository.patch({ replacements: [], actionSequence: 5, lastActionAt: 1_001 }, { actionSequence: 4 });
    await repository.patch({ lastAction: { clear: true }, updatedAt: { clear: true } });
    const patched = await repository.get();
    expect(patched).toMatchObject({ replacements: [], actionSequence: 5, lastActionAt: 1_001 });
    expect(patched).not.toHaveProperty("lastAction");

    expect(await failure(repository.patch({ actionSequence: 6 }, { actionSequence: 4 }))).toBeInstanceOf(FenceMismatchError);
    expect(await failure(repository.patch({ lastActionAt: { clear: true } }))).toBeInstanceOf(MalformedRecordError);
    expect((await repository.get())?.actionSequence).toBe(5);
  });

  it("advances the sequence exactly once per transaction when transactions run in turn", async () => {
    const store = createDocumentFixtureStore(new Map(), { serializeTransactions: true });
    await scaler(store).put(state(), "absent");
    const advance = () => store.transaction({ label: "scale" }, async (tx) => {
      const current = await tx.controllerState.sharedPoolScaler.get();
      await tx.controllerState.sharedPoolScaler.patch({ actionSequence: current!.actionSequence + 1 }, { actionSequence: current!.actionSequence });
    });

    await Promise.all([advance(), advance()]);
    expect((await scaler(store).get())?.actionSequence).toBe(6);
  });
});

describe("journal fixture store operations", () => {
  it("gives operations enqueued in separate transactions distinct ids", async () => {
    const store = createDocumentFixtureStore(new Map());
    const draft = { kind: "add-gateway", status: "pending", input: {}, createdAt: 1, createdBy: "test", updatedAt: 1 } as never;
    const enqueue = () => store.transaction({ label: "enqueue" }, (tx) => tx.journal.operations.enqueue(draft));

    const ids = [await enqueue(), await enqueue()];
    expect(new Set(ids).size).toBe(2);
    expect(await store.journal.operations.getMany(ids)).toHaveProperty("size", 2);
  });
});
