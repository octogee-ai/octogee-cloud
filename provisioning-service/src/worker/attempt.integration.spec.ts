import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, dsn, spec, TOKENS, untilSettled, type Harness } from "../__tests__/harness.js";

const KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA gateway-a";
const KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB gateway-a";

describe.skipIf(!dsn)("a provisioning attempt", { timeout: 30_000 }, () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function provisioned(uid: string) {
    return (await harness.request("GET", `/v1/users/${uid}/provisioning`)).body;
  }

  it("converges a new spec to Ready with every output and exactly one of each host resource", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin", { git: { repositories: ["workspace", "project-coaches"], systemConfigRepository: true } }) } });
    await untilSettled(harness);

    const resource = await provisioned("u1");
    expect(resource.status.observedGeneration).toBe(1);
    expect(Object.fromEntries(resource.status.conditions.map((condition: { type: string; status: string }) => [condition.type, condition.status])))
      .toEqual({ ChatReady: "True", GitReady: "True", CredentialsIssued: "True", Ready: "True" });
    expect(resource.status.work).toMatchObject({ state: "idle", attempts: 0 });
    expect(resource.status.outputs.chat).toMatchObject({ userId: expect.any(String), teamId: expect.any(String), agentBotUserId: expect.any(String), channels: { general: expect.any(String), agent: expect.any(String) } });
    expect(Object.keys(resource.status.outputs.git.repositories).sort()).toEqual(["project-coaches", "system-config", "workspace"]);
    expect(resource.status.outputs.credentials).toEqual(["agent-chat-token", "user-chat-token"]);
    expect([harness.chat.users.size, harness.chat.teams.size, harness.chat.bots.size, harness.chat.channels.size, harness.chat.tokens.length]).toEqual([1, 1, 1, 2, 2]);
    expect([harness.git.owners.size, harness.git.repositories.size]).toEqual([1, 3]);
  });

  it("issues a token only when the credential store holds none for that name, so a resync issues nothing", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);
    const issued = harness.chat.host.calls.filter((call) => call.operation.startsWith("issue")).length;
    expect(issued).toBe(2);

    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET due_at = now()`);
    await untilSettled(harness);

    expect(harness.chat.host.calls.filter((call) => call.operation.startsWith("issue"))).toHaveLength(issued);
    expect(harness.chat.tokens).toHaveLength(2);
    const credential = await harness.request("GET", "/v1/users/u1/credentials/user-chat-token", { token: TOKENS.platformApi });
    expect(credential.body.version).toBe(1);
  });

  it("issues the user token again on the next attempt when its issue failed, without reissuing the agent token", async () => {
    harness.chat.host.failNext("issueUserToken", "transient");
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);
    const failed = await provisioned("u1");
    expect(failed.status.conditions.find((condition: { type: string }) => condition.type === "CredentialsIssued"))
      .toMatchObject({ status: "False", reason: "UserChatTokenFailed" });
    expect(failed.status.conditions.find((condition: { type: string }) => condition.type === "ChatReady")).toMatchObject({ status: "True" });

    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET due_at = now()`);
    await untilSettled(harness);

    expect(harness.chat.host.calls.filter((call) => call.operation === "issueAgentToken")).toHaveLength(1);
    expect(harness.chat.host.calls.filter((call) => call.operation === "issueUserToken")).toHaveLength(2);
    expect((await provisioned("u1")).status.conditions.find((condition: { type: string }) => condition.type === "Ready")).toMatchObject({ status: "True" });
  });

  it("recreates a resource deleted from the host on resync and adopts what already exists", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);
    const teamId = (await provisioned("u1")).status.outputs.chat.teamId;
    harness.chat.teams.clear();

    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET due_at = now()`);
    await untilSettled(harness);

    expect(harness.chat.teams.size).toBe(1);
    expect((await provisioned("u1")).status.outputs.chat.teamId).not.toBe(teamId);
    expect(harness.chat.users.size).toBe(1);
  });

  it("keeps git converging when chat fails, and names the failing chat step", async () => {
    harness.chat.host.failNext("ensureTeam", "transient");
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);

    const resource = await provisioned("u1");
    const conditions = Object.fromEntries(resource.status.conditions.map((condition: { type: string; reason: string }) => [condition.type, condition.reason]));
    expect(conditions).toEqual({ ChatReady: "ChatTeamFailed", GitReady: "Converged", CredentialsIssued: "ChatNotReady", Ready: "ChatNotReady" });
    expect(resource.status.work).toMatchObject({ state: "retrying", attempts: 1 });
    const events = (await harness.request("GET", "/v1/users/u1/provisioning/events")).body.items;
    expect(events[0]).toMatchObject({ result: "failed", reason: "ChatTeamFailed" });
    expect(events[0].steps.map((record: { step: string; outcome: string }) => `${record.step}:${record.outcome}`)).toEqual(expect.arrayContaining([
      "chat-user:succeeded", "chat-team:failed", "chat-channels:skipped", "chat-agent:skipped", "user-chat-token:skipped",
      "git-owner:succeeded", "git-repositories:succeeded",
    ]));
    expect(harness.log.lines.some((line) => line.level === "error" && line.message === "provisioning step failed")).toBe(true);
  });

  it("registers a git key, replaces it when the public key changes, and releases it on delete", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a" }]);
    const registered = await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    expect(registered.status).toBe(200);
    expect(registered.body.status.conditions[0]).toMatchObject({ type: "Registered", status: "True", observedGeneration: 1 });

    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_B } } });
    await untilSettled(harness);
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_B, holder: "gateway-a" }]);

    expect((await harness.request("DELETE", "/v1/users/u1/git-keys/gateway-a", { token: TOKENS.platformApi })).status).toBe(202);
    await untilSettled(harness);
    expect(harness.git.keys.get("lin")).toEqual([]);
    const { rowCount } = await harness.service.db.pool.query(`SELECT 1 FROM ${harness.service.db.table("git_keys")}`);
    expect(rowCount).toBe(0);
  });

  async function keyCondition(uid: string, gatewayId: string, publicKey: string) {
    const key = await harness.request("PUT", `/v1/users/${uid}/git-keys/${gatewayId}`, { token: TOKENS.platformApi, body: { spec: { publicKey } } });
    return key.body.status.conditions.find((condition: { type: string }) => condition.type === "Registered");
  }

  it("adopts the identical public key the user's account holds under a title it does not manage, as its own holder's key", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    harness.git.owners.add("lin");
    harness.git.keys.set("lin", [{ publicKey: KEY_A, holder: "gateway-a/pod-1" }]);
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a" }]);
    expect(await keyCondition("u1", "gateway-a", KEY_A)).toMatchObject({ status: "True", reason: "Converged", observedGeneration: 1 });
    expect((await provisioned("u1")).status.work.state).toBe("idle");
  });

  it("adds a different public key beside an unmanaged one and leaves that one alone", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    harness.git.owners.add("lin");
    harness.git.keys.set("lin", [{ publicKey: KEY_B, holder: "gateway-a/pod-1" }]);
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_B, holder: "gateway-a/pod-1" }, { publicKey: KEY_A, holder: "gateway-a" }]);
    expect(await keyCondition("u1", "gateway-a", KEY_A)).toMatchObject({ status: "True" });
  });

  it("never adopts a public key another user's account holds", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    harness.git.owners.add("ada");
    harness.git.keys.set("ada", [{ publicKey: KEY_A, holder: "gateway-x/pod-1" }]);
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);

    expect(harness.git.keys.get("ada")).toEqual([{ publicKey: KEY_A, holder: "gateway-x/pod-1" }]);
    expect(harness.git.keys.get("lin") ?? []).toEqual([]);
    expect(await keyCondition("u1", "gateway-a", KEY_A)).toMatchObject({ status: "False", reason: "GitKeyFailed" });
  });

  it("keeps two gateways' different keys for one user registered across a resync without another host write", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-b", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_B } } });
    await untilSettled(harness);
    const writes = () => harness.git.host.calls.filter((call) => call.operation === "registerKey" || call.operation === "releaseKey").length;
    const before = writes();

    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET due_at = now()`);
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a" }, { publicKey: KEY_B, holder: "gateway-b" }]);
    expect(writes()).toBe(before);
  });

  it("retries, on the next PUT of the same key, a row an earlier build refused while its work sat idle", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);
    harness.git.keys.set("lin", [{ publicKey: KEY_A, holder: "gateway-a/pod-1" }]);
    const refused = [{ type: "Registered", status: "False", reason: "GitKeyFailed", message: "registered under a holder this service does not manage; left unchanged", lastTransitionTime: new Date().toISOString(), observedGeneration: 1 }];
    await harness.service.db.pool.query(
      `INSERT INTO ${harness.service.db.table("git_keys")} (uid, gateway_id, generation, observed_generation, resource_version, public_key, conditions) VALUES ('u1', 'gateway-a', 1, 1, '999', $1, $2)`,
      [KEY_A, JSON.stringify(refused)]);
    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET state = 'idle', due_at = now() + interval '6 hours'`);

    const unchanged = await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    expect(unchanged.status).toBe(200);
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a" }]);
    expect(await keyCondition("u1", "gateway-a", KEY_A)).toMatchObject({ status: "True", observedGeneration: 1 });
  });

  it("parks on a terminal host error and makes no further host call until a retry", async () => {
    harness.chat.host.failNext("ensureUser", "terminal");
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);
    expect((await provisioned("u1")).status.work.state).toBe("parked");
    expect(harness.log.lines.some((line) => line.level === "error" && line.message === "provisioning work parked")).toBe(true);
    const calls = harness.chat.host.calls.length;

    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET due_at = now() - interval '1 day'`);
    await untilSettled(harness);
    expect(harness.chat.host.calls).toHaveLength(calls);

    expect((await harness.request("POST", "/v1/users/u1/provisioning/retry", { body: {} })).status).toBe(202);
    await untilSettled(harness);
    expect((await provisioned("u1")).status.conditions.find((condition: { type: string }) => condition.type === "Ready")).toMatchObject({ status: "True" });
  });

  it("logs no token or credential value", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);
    const logged = JSON.stringify(harness.log.lines);
    for (const { token } of harness.chat.tokens) expect(logged).not.toContain(token);
  });
});
