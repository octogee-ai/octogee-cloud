import { describe, expect, it } from "vitest";
import { MissingRecordError } from "../../errors.js";
import { NOW, REVISION, useUserFixture } from "./fixtures/users.js";
import { dsn } from "./fixtures/harness.js";

describe.skipIf(!dsn)("PostgreSQL agent model selections", () => {
  const fixture = useUserFixture();

  it("stores one selection per agent, replaces it on put and removes it on delete", async () => {
    const { users, admitted } = fixture();
    await admitted("ada");
    await users.agentModels.put({ uid: "ada", agentId: "octogee-ada-coach", primary: "anthropic/claude-opus-5", fallbacks: ["openai/gpt-5"], updatedAt: NOW });
    await users.agentModels.put({ uid: "ada", agentId: "octogee-ada-writer", primary: "openai/gpt-5", fallbacks: [], updatedAt: NOW });
    await users.agentModels.put({ uid: "ada", agentId: "octogee-ada-coach", primary: "anthropic/claude-sonnet-5", fallbacks: [], updatedAt: { serverNow: true } });

    const selections = await users.agentModels.list("ada");
    expect(selections).toEqual([
      { uid: "ada", agentId: "octogee-ada-coach", primary: "anthropic/claude-sonnet-5", fallbacks: [], updatedAt: expect.any(Number), revision: expect.stringMatching(REVISION) },
      { uid: "ada", agentId: "octogee-ada-writer", primary: "openai/gpt-5", fallbacks: [], updatedAt: NOW, revision: expect.stringMatching(REVISION) },
    ]);
    expect(selections[0]!.updatedAt).toBeGreaterThan(NOW);

    await users.agentModels.delete("ada", "octogee-ada-coach");
    await users.agentModels.delete("ada", "octogee-ada-absent");
    expect((await users.agentModels.list("ada")).map((selection) => selection.agentId)).toEqual(["octogee-ada-writer"]);
    expect(await users.agentModels.list("nobody")).toEqual([]);
  });

  it("drops a user's selections with the user", async () => {
    const { users, admitted, count } = fixture();
    await admitted("ada");
    await users.agentModels.put({ uid: "ada", agentId: "octogee-ada-coach", primary: "openai/gpt-5", fallbacks: [], updatedAt: NOW });

    await users.records.delete("ada");

    expect(await count("user_agent_models", "ada")).toBe(0);
  });
});

describe.skipIf(!dsn)("PostgreSQL session model audit", () => {
  const fixture = useUserFixture();
  const entry = {
    auditId: "audit-1",
    actorUid: "ada",
    channelId: "channel-1",
    workspaceSlug: "ada",
    projectId: null,
    agentId: "octogee-ada-coach",
    operation: "setSessionModel" as const,
    requestedModel: "openai/gpt-5",
    createdAt: NOW,
  };

  it("records a pending command and completes it with the agent's result", async () => {
    const { users, admitted } = fixture();
    await admitted("ada");
    await users.sessionModelAudit.create(entry);
    expect(await users.sessionModelAudit.get("audit-1")).toEqual({
      ...entry,
      outcome: "pending",
      commandPostId: null,
      replyPostId: null,
      resultingModel: null,
      completedAt: null,
      revision: expect.stringMatching(REVISION),
    });

    await users.sessionModelAudit.complete("audit-1", {
      outcome: "applied",
      commandPostId: "post-1",
      replyPostId: "post-2",
      resultingModel: "openai/gpt-5",
      completedAt: { serverNow: true },
    });

    expect(await users.sessionModelAudit.get("audit-1")).toMatchObject({
      outcome: "applied",
      commandPostId: "post-1",
      replyPostId: "post-2",
      resultingModel: "openai/gpt-5",
      completedAt: expect.any(Number),
    });
    expect(await users.sessionModelAudit.get("audit-absent")).toBeNull();
  });

  it("refuses to complete an audit that was never recorded", async () => {
    const { users } = fixture();
    await expect(users.sessionModelAudit.complete("audit-absent", {
      outcome: "failed",
      commandPostId: null,
      replyPostId: null,
      resultingModel: null,
      completedAt: NOW,
    })).rejects.toBeInstanceOf(MissingRecordError);
  });

  it("drops the actor's audit entries with the actor", async () => {
    const { users, admitted, harness } = fixture();
    await admitted("ada");
    await users.sessionModelAudit.create(entry);

    await users.records.delete("ada");

    const rows = await harness.query("SELECT count(*)::int AS count FROM $schema.session_model_audit WHERE actor_uid = $1::text", ["ada"]);
    expect(rows[0]!.count).toBe(0);
  });
});
