import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, dsn, spec, TOKENS, untilSettled, type Harness } from "../__tests__/harness.js";

const KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA gateway-a";
const KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB gateway-a";
const KEY_C = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC gateway-a";

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
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    const registered = await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    expect(registered.status).toBe(200);
    expect(registered.body.status.conditions[0]).toMatchObject({ type: "Registered", status: "True", observedGeneration: 1 });

    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_B } } });
    await untilSettled(harness);
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_B, holder: "gateway-a/pod-a" }]);

    expect((await harness.request("DELETE", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi })).status).toBe(202);
    await untilSettled(harness);
    expect(harness.git.keys.get("lin")).toEqual([]);
    const { rowCount } = await harness.service.db.pool.query(`SELECT 1 FROM ${harness.service.db.table("git_keys")}`);
    expect(rowCount).toBe(0);
  });

  it("releases every user's key for a retired gateway, keeps other gateways' keys, and answers how many rows remain", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await harness.request("PUT", "/v1/users/u2/provisioning", { body: { spec: spec("mei") } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await harness.request("PUT", "/v1/users/u2/git-keys/gateway-a%2Fpod-c", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_C } } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-b%2Fpod-b", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_B } } });
    await untilSettled(harness);

    const retired = await harness.request("DELETE", "/v1/gateways/gateway-a/git-keys", { token: TOKENS.writer });

    expect(retired.status).toBe(202);
    expect(retired.body).toEqual({ remaining: 2 });
    await untilSettled(harness);
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_B, holder: "gateway-b/pod-b" }]);
    expect(harness.git.keys.get("mei")).toEqual([]);
    expect((await harness.request("DELETE", "/v1/gateways/gateway-a/git-keys", { token: TOKENS.writer })).body).toEqual({ remaining: 0 });
    const { rows } = await harness.service.db.pool.query(`SELECT uid, gateway_id FROM ${harness.service.db.table("git_keys")}`);
    expect(rows).toEqual([{ uid: "u1", gateway_id: "gateway-b" }]);
  });

  it("keeps a key for each pod of one gateway, as two pods hold during a surge roll, and releases one pod's key alone", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-old", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-new", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_B } } });
    await untilSettled(harness);
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_B, holder: "gateway-a/pod-new" }, { publicKey: KEY_A, holder: "gateway-a/pod-old" }]);

    expect((await harness.request("DELETE", "/v1/users/u1/git-keys/gateway-a%2Fpod-old", { token: TOKENS.platformApi, body: { expectedPublicKey: KEY_A } })).status).toBe(202);
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_B, holder: "gateway-a/pod-new" }]);
  });

  it("lists holders and releases every user's key for one holder that is gone", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await harness.request("PUT", "/v1/users/u2/provisioning", { body: { spec: spec("mei") } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-old", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await harness.request("PUT", "/v1/users/u2/git-keys/gateway-a%2Fpod-old", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_C } } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-new", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_B } } });
    await untilSettled(harness);
    expect(harness.git.keys.get("mei")).toEqual([{ publicKey: KEY_C, holder: "gateway-a/pod-old" }]);

    const listed = await harness.request("GET", "/v1/git-key-holders", { token: TOKENS.writer });
    expect(listed.status).toBe(200);
    expect(listed.body.holders).toEqual([
      { holder: "gateway-a/pod-new", gatewayId: "gateway-a" },
      { holder: "gateway-a/pod-old", gatewayId: "gateway-a" },
    ]);
    const released = await harness.request("DELETE", "/v1/git-key-holders/gateway-a%2Fpod-old", { token: TOKENS.writer });
    expect(released.status).toBe(202);
    expect(released.body).toEqual({ remaining: 2 });
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_B, holder: "gateway-a/pod-new" }]);
    expect(harness.git.keys.get("mei")).toEqual([]);
    expect((await harness.request("DELETE", "/v1/git-key-holders/gateway-a%2Fpod-old", { token: TOKENS.writer })).body).toEqual({ remaining: 0 });
  });

  it("releases a parked user's key for a holder that is gone and leaves the user parked", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET state = 'parked', last_error_reason = 'ChatUserFailed' WHERE uid = 'u1'`);
    const chatCalls = harness.chat.host.calls.length;

    expect((await harness.request("DELETE", "/v1/gateways/gateway-a/git-keys", { token: TOKENS.writer })).body).toEqual({ remaining: 1 });
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([]);
    expect((await harness.request("DELETE", "/v1/gateways/gateway-a/git-keys", { token: TOKENS.writer })).body).toEqual({ remaining: 0 });
    expect((await provisioned("u1")).status.work.state).toBe("parked");
    expect(harness.chat.host.calls).toHaveLength(chatCalls);
  });

  it("records a failed release on a parked user's key row and keeps the row until a later release succeeds", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);
    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET state = 'parked', last_error_reason = 'ChatUserFailed' WHERE uid = 'u1'`);
    harness.git.host.failNext("releaseKey", "transient");

    await harness.request("DELETE", "/v1/git-key-holders/gateway-a%2Fpod-a", { token: TOKENS.writer });
    await untilSettled(harness);

    const { rows } = await harness.service.db.pool.query(`SELECT conditions, retry_after FROM ${harness.service.db.table("git_keys")} WHERE uid = 'u1'`);
    expect(rows[0].conditions).toContainEqual(expect.objectContaining({ type: "Registered", status: "Unknown", reason: "GitKeyFailed", message: expect.stringContaining("release failed") }));
    expect(rows[0].retry_after).toBeInstanceOf(Date);
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    expect(harness.log.lines.some((line) => line.level === "error" && line.message.startsWith("releasing a parked user's git key failed"))).toBe(true);
    expect((await provisioned("u1")).status.work.state).toBe("parked");

    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("git_keys")} SET retry_after = now() WHERE uid = 'u1'`);
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([]);
    expect((await harness.request("DELETE", "/v1/git-key-holders/gateway-a%2Fpod-a", { token: TOKENS.writer })).body).toEqual({ remaining: 0 });
    expect((await provisioned("u1")).status.work.state).toBe("parked");
  });

  async function keyCondition(uid: string, gatewayId: string, publicKey: string) {
    const key = await harness.request("PUT", `/v1/users/${uid}/git-keys/${encodeURIComponent(`${gatewayId}/pod-${gatewayId.slice(-1)}`)}`, { token: TOKENS.platformApi, body: { spec: { publicKey } } });
    return key.body.status.conditions.find((condition: { type: string }) => condition.type === "Registered");
  }

  it("adopts the identical public key the user's account holds under a title it does not manage, as its own holder's key", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    harness.git.owners.add("lin");
    harness.git.keys.set("lin", [{ publicKey: KEY_A, holder: "gateway-a/pod-1" }]);
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    expect((await provisioned("u1")).status.work.state).toBe("idle");
    expect(await keyCondition("u1", "gateway-a", KEY_A)).toMatchObject({ status: "True", reason: "Converged", observedGeneration: 1 });
  });

  it("keeps a moved key with the previous build's pod when the source row reconciles, and the source's release leaves only that key", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    harness.git.keys.set("lin", [{ publicKey: KEY_A, holder: "gateway-b/pod-previous" }]);

    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-c%2Fpod-c", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_B } } });
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-b/pod-previous" }, { publicKey: KEY_B, holder: "gateway-c/pod-c" }]);
    const { rows } = await harness.service.db.pool.query(`SELECT conditions FROM ${harness.service.db.table("git_keys")} WHERE uid = 'u1' AND holder = 'gateway-a/pod-a'`);
    expect(rows[0].conditions).toContainEqual(expect.objectContaining({ type: "Registered", status: "False", reason: "GitKeyHeldElsewhere" }));

    await harness.request("DELETE", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi });
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-b/pod-previous" }, { publicKey: KEY_B, holder: "gateway-c/pod-c" }]);
  });

  it("takes the key from the previous build's pod when this build's pod puts it, leaving one key under the new holder", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);
    harness.git.keys.set("lin", [{ publicKey: KEY_A, holder: "gateway-b/pod-previous" }]);

    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    expect(await keyCondition("u1", "gateway-a", KEY_A)).toMatchObject({ status: "True", reason: "Converged" });
  });

  it("adds a different public key beside an unmanaged one and leaves that one alone", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    harness.git.owners.add("lin");
    harness.git.keys.set("lin", [{ publicKey: KEY_B, holder: "gateway-a/pod-1" }]);
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_B, holder: "gateway-a/pod-1" }, { publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    expect(await keyCondition("u1", "gateway-a", KEY_A)).toMatchObject({ status: "True" });
  });

  async function putKey(uid: string, holder: string, publicKey: string) {
    return harness.request("PUT", `/v1/users/${uid}/git-keys/${encodeURIComponent(holder)}`, { token: TOKENS.platformApi, body: { spec: { publicKey } } });
  }

  async function readKey(uid: string, holder: string) {
    return (await harness.request("GET", `/v1/users/${uid}/git-keys/${encodeURIComponent(holder)}`, { token: TOKENS.platformApi })).body;
  }

  function registered(key: { status: { conditions: { type: string; status: string }[]; observedPutSequence: number } }, putSequence: number): boolean {
    return key.status.observedPutSequence >= putSequence && key.status.conditions.some((condition) => condition.type === "Registered" && condition.status === "True");
  }

  it("processes a put that lands after the key is written registered but before the attempt ends, and never adopts for it later", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    const queue = harness.service.queue;
    const finish = queue.finish.bind(queue);
    let late: number | null = null;
    vi.spyOn(queue, "finish").mockImplementation(async (...args) => {
      if (late === null) late = (await putKey("u1", "gateway-a/pod-a", KEY_A)).body.putSequence;
      return finish(...args);
    });

    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);

    expect(late).toEqual(expect.any(Number));
    expect(registered(await readKey("u1", "gateway-a/pod-a"), late!)).toBe(true);
    vi.mocked(queue.finish).mockRestore();
    harness.git.keys.set("lin", [{ publicKey: KEY_A, holder: "gateway-b/pod-previous" }]);
    await putKey("u1", "gateway-c/pod-c", KEY_B);
    await untilSettled(harness);
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-b/pod-previous" }, { publicKey: KEY_B, holder: "gateway-c/pod-c" }]);
  });

  it("attempts a key promptly when its gateway puts it again during the refusal backoff", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    harness.git.owners.add("ada");
    harness.git.keys.set("ada", [{ publicKey: KEY_A, holder: "gateway-x/pod-1" }]);
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    expect((await readKey("u1", "gateway-a/pod-a")).status.nextAttemptAt).toEqual(expect.any(String));
    harness.git.keys.set("ada", []);

    const put = await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    expect(registered(await readKey("u1", "gateway-a/pod-a"), put.body.putSequence)).toBe(true);
  });

  it("does not report a key registered from its stored status when the git host lost it, and registers it again for the put", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    harness.git.keys.set("lin", []);

    const put = await putKey("u1", "gateway-a/pod-a", KEY_A);

    expect(put.status).toBe(200);
    expect(registered(put.body, put.body.putSequence)).toBe(false);
    await untilSettled(harness);
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    expect(registered(await readKey("u1", "gateway-a/pod-a"), put.body.putSequence)).toBe(true);
  });

  function condition(key: { status: { conditions: { type: string; status: string; reason: string; message: string }[] } }) {
    return key.status.conditions.find((entry) => entry.type === "Registered");
  }

  it("keeps the backoff a put cleared when an attempt that read the key before the put refuses it, and adopts for the put", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    harness.git.keys.set("lin", [{ publicKey: KEY_A, holder: "gateway-b/pod-previous" }]);
    const list = harness.git.listKeys.bind(harness.git);
    let late: number | null = null;
    vi.spyOn(harness.git, "listKeys").mockImplementation(async (...args) => {
      const listed = await list(...args);
      if (late === null) late = (await putKey("u1", "gateway-a/pod-a", KEY_A)).body.putSequence;
      return listed;
    });

    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin", { displayName: { first: "Lin", last: "Again" } }) } });
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    expect(registered(await readKey("u1", "gateway-a/pod-a"), late!)).toBe(true);
  });

  it("does not write a key registered under its own title after another row of the user took that key in the same attempt", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-z/pod-z", KEY_A);
    await untilSettled(harness);

    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    expect(condition(await readKey("u1", "gateway-z/pod-z"))).toMatchObject({ status: "False", reason: "GitKeyHeldElsewhere" });
  });

  it("releases a deleted row's key before reconciling the user's other rows, so a put row needing that key registers it without adopting it", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-z/pod-z", KEY_A);
    await untilSettled(harness);

    await harness.request("DELETE", "/v1/users/u1/git-keys/gateway-z%2Fpod-z", { token: TOKENS.platformApi });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    expect(condition(await readKey("u1", "gateway-a/pod-a"))).toMatchObject({ status: "True" });
    expect(harness.log.lines.some((line) => line.message.startsWith("adopting the identical git key"))).toBe(false);
  });

  it("registers a parked user's key for a new pod at its put and leaves the user parked with its attempts", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET state = 'parked', attempts = 12, last_error_reason = 'ChatUserFailed' WHERE uid = 'u1'`);
    const chatCalls = harness.chat.host.calls.length;

    const put = await putKey("u1", "gateway-a/pod-b", KEY_B);
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }, { publicKey: KEY_B, holder: "gateway-a/pod-b" }]);
    expect(registered(await readKey("u1", "gateway-a/pod-b"), put.body.putSequence)).toBe(true);
    expect((await provisioned("u1")).status.work).toMatchObject({ state: "parked", attempts: 12 });
    expect(harness.chat.host.calls).toHaveLength(chatCalls);
  });

  it("still processes a put that marked a running attempt dirty when that attempt's lease expires on its last attempt", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);
    await harness.service.db.pool.query(
      `UPDATE ${harness.service.db.table("provisioning_work")} SET state = 'running', attempts = 11, lease_token = 'gone', lease_expires_at = now() - interval '1 second', due_at = now() WHERE uid = 'u1'`);
    const put = await putKey("u1", "gateway-a/pod-a", KEY_A);
    expect((await provisioned("u1")).status.work.state).toBe("running");

    await untilSettled(harness);

    expect((await provisioned("u1")).status.work.state).toBe("parked");
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    expect(registered(await readKey("u1", "gateway-a/pod-a"), put.body.putSequence)).toBe(true);
  });

  it("leaves a different key the pod registered under its own title when the row reconciles without a put, and reports it replaced", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    harness.git.keys.set("lin", [{ publicKey: KEY_B, holder: "gateway-a/pod-a" }]);
    const registers = () => harness.git.host.calls.filter((call) => call.operation === "registerKey").length;
    const before = registers();

    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin", { displayName: { first: "Lin", last: "Again" } }) } });
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_B, holder: "gateway-a/pod-a" }]);
    expect(registers()).toBe(before);
    const key = await readKey("u1", "gateway-a/pod-a");
    expect(condition(key)).toMatchObject({ status: "False", reason: "GitKeyReplacedOnHost" });
    expect(key.status.nextAttemptAt).toEqual(expect.any(String));
    expect(harness.log.lines.some((line) => line.level === "warn" && line.message.startsWith("the git host does not hold the row's key under its title"))).toBe(true);
  });

  it("reports a key deleted from the git host behind a registered row without registering it again until its gateway puts it", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    harness.git.keys.set("lin", []);

    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin", { displayName: { first: "Lin", last: "Again" } }) } });
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([]);
    expect(condition(await readKey("u1", "gateway-a/pod-a"))).toMatchObject({ status: "False", reason: "GitKeyNotOnHost" });

    const put = await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    expect(registered(await readKey("u1", "gateway-a/pod-a"), put.body.putSequence)).toBe(true);
  });

  const table = (name: string) => harness.service.db.table(name);
  const parkUser = () => harness.service.db.pool.query(`UPDATE ${table("provisioning_work")} SET state = 'parked', attempts = 12, last_error_reason = 'ChatUserFailed' WHERE uid = 'u1'`);
  const backoffPasses = () => harness.service.db.pool.query(
    `UPDATE ${table("git_keys")} SET retry_after = now() - interval '1 second' WHERE retry_after IS NOT NULL; UPDATE ${table("provisioning_work")} SET due_at = now() - interval '1 second'`);

  it("reports a row it wrote registered as held elsewhere when a later row of the same attempt adopted its key", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await putKey("u1", "gateway-a/pod-b", KEY_A);
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-b" }]);
    expect(condition(await readKey("u1", "gateway-a/pod-a"))).toMatchObject({ status: "False", reason: "GitKeyHeldElsewhere" });
    expect(condition(await readKey("u1", "gateway-a/pod-b"))).toMatchObject({ status: "True" });
  });

  it("refuses a put for a parked user whose git account does not exist yet, once, with GitNotReady", async () => {
    harness.git.host.failNext("ensureOwner", "terminal");
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);
    expect((await provisioned("u1")).status.work.state).toBe("parked");

    const put = await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);

    const key = await readKey("u1", "gateway-a/pod-a");
    expect(condition(key)).toMatchObject({ status: "False", reason: "GitNotReady" });
    expect(key.status.observedPutSequence).toBe(put.body.putSequence);
    expect(harness.log.lines.some((line) => line.message.startsWith("the user's git account does not exist yet"))).toBe(true);
    expect(await harness.service.worker.tick()).toBe(0);
    await harness.service.db.pool.query(`UPDATE ${table("provisioning_work")} SET due_at = now() - interval '1 second'`);
    expect(await harness.service.worker.tick()).toBe(0);
  });

  it("does not advance the observed put sequence when registering the put key fails transiently, in its register or its host listing", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);
    harness.git.host.failNext("registerKey", "transient");
    const first = await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    expect((await readKey("u1", "gateway-a/pod-a")).status.observedPutSequence).toBeLessThan(first.body.putSequence);

    harness.git.host.failNext("listKeys", "transient");
    const second = await putKey("u1", "gateway-a/pod-b", KEY_B);
    await untilSettled(harness);
    expect((await readKey("u1", "gateway-a/pod-b")).status.observedPutSequence).toBeLessThan(second.body.putSequence);
  });

  it("keeps a parked pass's put that landed during the pass due when the pass's register fails", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);
    await parkUser();
    harness.git.host.failNext("registerKey", "transient");
    const list = harness.git.listKeys.bind(harness.git);
    let late: number | null = null;
    vi.spyOn(harness.git, "listKeys").mockImplementation(async (...args) => {
      const listed = await list(...args);
      if (late === null) late = (await putKey("u1", "gateway-a/pod-a", KEY_A)).body.putSequence;
      return listed;
    });

    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    expect(registered(await readKey("u1", "gateway-a/pod-a"), late!)).toBe(true);
  });

  it("observes a parked user's registered row and reports a key deleted from the git host", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    await parkUser();
    harness.git.keys.set("lin", []);

    await harness.service.db.pool.query(`UPDATE ${table("provisioning_work")} SET due_at = now() - interval '1 second'`);
    await untilSettled(harness);

    expect(condition(await readKey("u1", "gateway-a/pod-a"))).toMatchObject({ status: "False", reason: "GitKeyNotOnHost" });
    expect(harness.git.keys.get("lin")).toEqual([]);
    expect((await provisioned("u1")).status.work).toMatchObject({ state: "parked", attempts: 12 });
  });

  it("logs a mismatch at warning when first seen and at error once it survives a second observation", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    harness.git.keys.set("lin", []);
    const mismatches = (level: string) => harness.log.lines.filter((line) => line.level === level && line.message.startsWith("the git host does not hold the row's key under its title")).length;

    await backoffPasses();
    await untilSettled(harness);
    expect([mismatches("warn"), mismatches("error")]).toEqual([1, 0]);

    await backoffPasses();
    await untilSettled(harness);
    expect([mismatches("warn"), mismatches("error")]).toEqual([1, 1]);
  });

  it("counts git key rows by registered status and reason in its metrics, so a mismatch can alert", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await putKey("u1", "gateway-a/pod-b", KEY_B);
    await untilSettled(harness);
    harness.git.keys.set("lin", [{ publicKey: KEY_B, holder: "gateway-a/pod-b" }]);
    await backoffPasses();
    await untilSettled(harness);

    await harness.service.probes.refresh();
    const text = await (await fetch(`${harness.service.url}/metrics`)).text();

    expect(text).toContain('provisioning_git_keys{status="False",reason="GitKeyNotOnHost"} 1');
    expect(text).toContain('provisioning_git_keys{status="True",reason="Converged"} 1');
  });

  const keyRow = async (holder: string) => (await harness.service.db.pool.query(
    `SELECT k.refusals, k.retry_after, k.conditions, k.put_sequence, k.observed_put_sequence, w.due_at, w.state
       FROM ${table("git_keys")} k JOIN ${table("provisioning_work")} w USING (uid) WHERE k.uid = 'u1' AND k.holder = $1`, [holder])).rows[0];
  const hostCalls = (operation: string) => harness.git.host.calls.filter((call) => call.operation === operation).length;

  it("claims a parked user once, not on every tick, while the git host listing fails, and lengthens the wait with each failed listing", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    await parkUser();
    harness.git.keys.set("lin", []);
    await backoffPasses();
    await untilSettled(harness);
    expect(await keyRow("gateway-a/pod-a")).toMatchObject({ refusals: 1, conditions: [expect.objectContaining({ reason: "GitKeyNotOnHost" })] });
    harness.git.host.failNext("listKeys", "transient", 2);

    await backoffPasses();
    expect(await harness.service.worker.tick()).toBe(1);
    await harness.service.worker.drain();
    expect(await harness.service.worker.tick()).toBe(0);

    const first = await keyRow("gateway-a/pod-a");
    expect(first).toMatchObject({ state: "parked", refusals: 2, conditions: [expect.objectContaining({ status: "False", reason: "GitKeyNotOnHost" })] });
    expect(first.retry_after.getTime() - Date.now()).toBeGreaterThan(90_000);
    expect(Math.abs(first.due_at.getTime() - first.retry_after.getTime())).toBeLessThan(5);
    expect(harness.log.lines.some((line) => line.level === "error" && line.message.startsWith("listing a parked user's git keys failed"))).toBe(true);

    await backoffPasses();
    expect(await harness.service.worker.tick()).toBe(1);
    await harness.service.worker.drain();
    expect(await harness.service.worker.tick()).toBe(0);
    const second = await keyRow("gateway-a/pod-a");
    expect(second.refusals).toBe(3);
    expect(second.retry_after.getTime() - Date.now()).toBeGreaterThan(200_000);
  });

  it("never observes a parked user again sooner than one key backoff, even when a row's backoff has already passed", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    await parkUser();
    const queue = harness.service.queue;
    const finishParkedKeys = queue.finishParkedKeys.bind(queue);
    vi.spyOn(queue, "finishParkedKeys").mockImplementation(async (...args) => {
      await harness.service.db.pool.query(`UPDATE ${table("git_keys")} SET retry_after = now() - interval '1 second'`);
      return finishParkedKeys(...args);
    });

    await harness.service.db.pool.query(`UPDATE ${table("provisioning_work")} SET due_at = now() - interval '1 second'`);
    expect(await harness.service.worker.tick()).toBe(1);
    await harness.service.worker.drain();

    expect(await harness.service.worker.tick()).toBe(0);
    const row = await keyRow("gateway-a/pod-a");
    expect(row.due_at.getTime() - Date.now()).toBeGreaterThan(50_000);
    expect(row.due_at.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
  });

  it("observes a parked user again at the earliest key backoff, not only at the resync time", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    await parkUser();
    harness.git.keys.set("lin", []);
    await backoffPasses();
    await untilSettled(harness);

    await backoffPasses();
    await untilSettled(harness);

    const row = await keyRow("gateway-a/pod-a");
    expect(row.refusals).toBe(2);
    expect(row.retry_after.getTime() - Date.now()).toBeGreaterThan(90_000);
    expect(row.retry_after.getTime() - Date.now()).toBeLessThan(130_000);
    expect(Math.abs(row.due_at.getTime() - row.retry_after.getTime())).toBeLessThan(5);
  });

  it("backs off each row a parked pass could not list: an observed row keeps its condition, a put row reports the failure, and a row already backing off is left alone", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await putKey("u1", "gateway-a/pod-b", KEY_B);
    await untilSettled(harness);
    await parkUser();
    harness.git.keys.set("lin", [{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    await harness.service.db.pool.query(`UPDATE ${table("provisioning_work")} SET due_at = now() - interval '1 second'`);
    await untilSettled(harness);
    expect(await keyRow("gateway-a/pod-b")).toMatchObject({ refusals: 1, retry_after: expect.any(Date) });
    harness.git.host.failNext("listKeys", "transient");

    const put = await putKey("u1", "gateway-a/pod-c", KEY_C);
    expect(await harness.service.worker.tick()).toBe(1);
    await harness.service.worker.drain();
    expect(await harness.service.worker.tick()).toBe(0);

    expect(await keyRow("gateway-a/pod-a")).toMatchObject({ refusals: 1, retry_after: expect.any(Date), conditions: [expect.objectContaining({ status: "True", reason: "Converged" })] });
    expect(await keyRow("gateway-a/pod-b")).toMatchObject({ refusals: 1, conditions: [expect.objectContaining({ status: "False", reason: "GitKeyNotOnHost" })] });
    const pending = await keyRow("gateway-a/pod-c");
    expect(pending).toMatchObject({ refusals: 1, retry_after: expect.any(Date), conditions: [expect.objectContaining({ status: "Unknown", reason: "GitKeyFailed", message: expect.stringContaining("registration failed") })] });
    expect(pending.observed_put_sequence).toBeLessThan(put.body.putSequence);

    await backoffPasses();
    await untilSettled(harness);
    expect(await keyRow("gateway-a/pod-a")).toMatchObject({ refusals: 0, retry_after: null });
    expect(registered(await readKey("u1", "gateway-a/pod-c"), put.body.putSequence)).toBe(true);
  });

  async function loserReportedRegisteredWhileTheWinnerRegisters(): Promise<boolean[]> {
    const seen: boolean[] = [];
    const register = harness.git.registerKey.bind(harness.git);
    const list = harness.git.listKeys.bind(harness.git);
    let loserSequence = 0;
    const read = async () => seen.push(registered(await readKey("u1", "gateway-a/pod-a"), loserSequence));
    let winnerRegistered = false;
    vi.spyOn(harness.git, "registerKey").mockImplementation(async (...args) => {
      if (args[0].holder === "gateway-a/pod-b") {
        await read();
        winnerRegistered = true;
      }
      return register(...args);
    });
    vi.spyOn(harness.git, "listKeys").mockImplementation(async (...args) => {
      if (winnerRegistered) await read();
      return list(...args);
    });
    const loser = await putKey("u1", "gateway-a/pod-a", KEY_A);
    loserSequence = loser.body.putSequence;
    const winner = await putKey("u1", "gateway-a/pod-b", KEY_A);
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-b" }]);
    const lost = await readKey("u1", "gateway-a/pod-a");
    expect(condition(lost)).toMatchObject({ status: "False", reason: "GitKeyHeldElsewhere" });
    expect(lost.status.observedPutSequence).toBe(loser.body.putSequence);
    expect(registered(await readKey("u1", "gateway-a/pod-b"), winner.body.putSequence)).toBe(true);
    return seen;
  }

  it("never reports registered, even between the two rows' writes, the row that loses its key to a later put row of the same attempt", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);

    const seen = await loserReportedRegisteredWhileTheWinnerRegisters();

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen).not.toContain(true);
  });

  it("does not report a put again registered for a row that already held its key when a later put row of the same attempt takes that key", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);

    const seen = await loserReportedRegisteredWhileTheWinnerRegisters();

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen).not.toContain(true);
  });

  it("never reports the losing row registered in a parked user's key pass either, and writes it held elsewhere once the pass has checked the host", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);
    await parkUser();

    const seen = await loserReportedRegisteredWhileTheWinnerRegisters();

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen).not.toContain(true);
    expect((await provisioned("u1")).status.work).toMatchObject({ state: "parked", attempts: 12 });
  });

  it("rewrites a registered row held elsewhere in a parked user's key pass when a later put row adopted its key", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    await parkUser();

    const put = await putKey("u1", "gateway-a/pod-b", KEY_A);
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-b" }]);
    expect(condition(await readKey("u1", "gateway-a/pod-a"))).toMatchObject({ status: "False", reason: "GitKeyHeldElsewhere" });
    expect(registered(await readKey("u1", "gateway-a/pod-b"), put.body.putSequence)).toBe(true);
  });

  it("reports a put key the git host no longer lists after registering it as not on the host, with the put observed", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);
    const register = harness.git.registerKey.bind(harness.git);
    vi.spyOn(harness.git, "registerKey").mockImplementation(async (...args) => {
      await register(...args);
      harness.git.keys.set("lin", []);
    });

    const put = await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);

    const key = await readKey("u1", "gateway-a/pod-a");
    expect(condition(key)).toMatchObject({ status: "False", reason: "GitKeyNotOnHost" });
    expect(key.status.observedPutSequence).toBe(put.body.putSequence);
  });

  it("backs off a parked user's put row when the host listing that confirms its registration fails, then confirms it without registering again", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);
    await parkUser();
    const list = harness.git.listKeys.bind(harness.git);
    let listings = 0;
    vi.spyOn(harness.git, "listKeys").mockImplementation(async (...args) => {
      listings += 1;
      if (listings === 2) harness.git.host.failNext("listKeys", "transient");
      return list(...args);
    });

    const put = await putKey("u1", "gateway-a/pod-a", KEY_A);
    expect(await harness.service.worker.tick()).toBe(1);
    await harness.service.worker.drain();
    expect(await harness.service.worker.tick()).toBe(0);

    const failed = await keyRow("gateway-a/pod-a");
    expect(failed).toMatchObject({ refusals: 1, retry_after: expect.any(Date), conditions: [expect.objectContaining({ status: "Unknown", reason: "GitKeyFailed" })] });
    expect(failed.observed_put_sequence).toBeLessThan(put.body.putSequence);
    expect(harness.log.lines.some((line) => line.level === "error" && line.message.startsWith("confirming a parked user's git keys on the git host failed"))).toBe(true);

    await backoffPasses();
    await untilSettled(harness);
    expect(registered(await readKey("u1", "gateway-a/pod-a"), put.body.putSequence)).toBe(true);
    expect(hostCalls("registerKey")).toBe(1);
  });

  it("waits for a row's backoff before releasing its old key again after that release failed", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    await parkUser();
    harness.git.host.failNext("releaseKey", "transient");
    const changed = await putKey("u1", "gateway-a/pod-a", KEY_B);
    await untilSettled(harness);
    expect(hostCalls("releaseKey")).toBe(1);
    expect(await keyRow("gateway-a/pod-a")).toMatchObject({ refusals: 1, retry_after: expect.any(Date) });

    await putKey("u1", "gateway-a/pod-b", KEY_C);
    await untilSettled(harness);

    expect(hostCalls("releaseKey")).toBe(1);
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }, { publicKey: KEY_C, holder: "gateway-a/pod-b" }]);

    await backoffPasses();
    await untilSettled(harness);
    expect(hostCalls("releaseKey")).toBe(2);
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_C, holder: "gateway-a/pod-b" }, { publicKey: KEY_B, holder: "gateway-a/pod-a" }]);
    expect(registered(await readKey("u1", "gateway-a/pod-a"), changed.body.putSequence)).toBe(true);
  });

  it("says a later put is processed next, not a next attempt time, in a refusal written while a later put had cleared the backoff", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    harness.git.keys.set("lin", [{ publicKey: KEY_A, holder: "gateway-b/pod-previous" }]);
    const list = harness.git.listKeys.bind(harness.git);
    let late = false;
    vi.spyOn(harness.git, "listKeys").mockImplementation(async (...args) => {
      const listed = await list(...args);
      if (!late) {
        late = true;
        await putKey("u1", "gateway-a/pod-a", KEY_A);
      }
      return listed;
    });
    const queue = harness.service.queue;
    const finish = queue.finish.bind(queue);
    const messages: string[] = [];
    vi.spyOn(queue, "finish").mockImplementation(async (...args) => {
      messages.push(condition(await readKey("u1", "gateway-a/pod-a"))!.message);
      return finish(...args);
    });

    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin", { displayName: { first: "Lin", last: "Again" } }) } });
    await untilSettled(harness);

    expect(messages[0]).toContain("a later put is processed next");
    expect(messages[0]).not.toContain("null");
  });

  it("leaves rows marked for release out of the git key counts", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    await parkUser();
    harness.git.host.failNext("releaseKey", "transient");
    await harness.request("DELETE", "/v1/git-key-holders/gateway-a%2Fpod-a", { token: TOKENS.writer });
    await untilSettled(harness);
    expect((await harness.service.db.pool.query(`SELECT 1 FROM ${table("git_keys")} WHERE deletion_requested_at IS NOT NULL`)).rowCount).toBe(1);

    await harness.service.probes.refresh();
    const text = await (await fetch(`${harness.service.url}/metrics`)).text();

    expect(text).toContain("# TYPE provisioning_git_keys gauge");
    expect(text).not.toContain("provisioning_git_keys{");
  });

  it("stays ready and exports no git key counts when a row's conditions cannot be counted, and logs the failure", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    await harness.service.db.pool.query(`UPDATE ${table("git_keys")} SET conditions = '{}'::jsonb`);

    await harness.service.probes.refresh();

    expect(harness.service.probes.ready).toBe(true);
    const text = await (await fetch(`${harness.service.url}/metrics`)).text();
    expect(text).toContain('provisioning_work{state="idle"} 1');
    expect(text).not.toContain("provisioning_git_keys{");
    expect(harness.log.lines.some((line) => line.level === "error" && line.message.startsWith("counting git key rows failed"))).toBe(true);
  });

  it("caps the refusal backoff however many refusals a row has", async () => {
    harness.git.owners.add("ada");
    harness.git.keys.set("ada", [{ publicKey: KEY_A, holder: "gateway-x/pod-1" }]);
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    await harness.service.db.pool.query(`UPDATE ${table("git_keys")} SET refusals = 5000`);

    await backoffPasses();
    await untilSettled(harness);

    const key = await readKey("u1", "gateway-a/pod-a");
    expect(Date.parse(key.status.nextAttemptAt) - Date.now()).toBeGreaterThan(5 * 60 * 60_000);
    expect(Date.parse(key.status.nextAttemptAt) - Date.now()).toBeLessThanOrEqual(6 * 60 * 60_000);
  });

  it("leaves the old key a pod registered again under its title after a refused key change when the row reconciles without a put", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);
    harness.git.owners.add("ada");
    harness.git.keys.set("ada", [{ publicKey: KEY_B, holder: "gateway-x/pod-1" }]);
    await putKey("u1", "gateway-a/pod-a", KEY_B);
    await untilSettled(harness);
    expect(condition(await readKey("u1", "gateway-a/pod-a"))).toMatchObject({ status: "False", reason: "GitKeyHeldElsewhere" });
    harness.git.keys.set("lin", [{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);

    await backoffPasses();
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
  });

  it("never adopts a public key another user's account holds", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    harness.git.owners.add("ada");
    harness.git.keys.set("ada", [{ publicKey: KEY_A, holder: "gateway-x/pod-1" }]);
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);

    expect(harness.git.keys.get("ada")).toEqual([{ publicKey: KEY_A, holder: "gateway-x/pod-1" }]);
    expect(harness.git.keys.get("lin") ?? []).toEqual([]);
    expect(await keyCondition("u1", "gateway-a", KEY_A)).toMatchObject({ status: "False", reason: "GitKeyHeldElsewhere" });
  });

  it("records a key another account holds on the key alone, and finishes the rest of the user's attempt", async () => {
    harness.git.owners.add("ada");
    harness.git.keys.set("ada", [{ publicKey: KEY_A, holder: "gateway-x/pod-1" }]);
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);

    const resource = await provisioned("u1");
    expect(resource.status.work.state).toBe("idle");
    expect(Object.fromEntries(resource.status.conditions.map((condition: { type: string; status: string }) => [condition.type, condition.status])))
      .toEqual({ ChatReady: "True", GitReady: "True", CredentialsIssued: "True", Ready: "True" });
    expect(await keyCondition("u1", "gateway-a", KEY_A)).toMatchObject({ status: "False", reason: "GitKeyHeldElsewhere", message: expect.stringContaining("422") });
    expect(harness.log.lines.some((line) => line.level === "error" && line.message === "the git host refused the git key; recorded on the key and the rest of the attempt continues")).toBe(true);
  });

  it("parks the attempt when releasing a key being deleted fails terminally and still releases the key while the user stays parked", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);
    harness.git.host.failNext("releaseKey", "terminal");

    await harness.request("DELETE", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi });
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([]);
    const { rows } = await harness.service.db.pool.query(`SELECT deletion_requested_at FROM ${harness.service.db.table("git_keys")} WHERE uid = 'u1'`);
    expect(rows).toEqual([]);
    expect((await provisioned("u1")).status.work.state).toBe("parked");
    const events = (await harness.request("GET", "/v1/users/u1/provisioning/events")).body.items;
    expect(events[0]).toMatchObject({ result: "parked", reason: "GitKeyFailed" });
  });

  it("fails the attempt on a terminal git host error other than a key held elsewhere, such as a refused admin token", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    harness.git.host.failNext("registerKey", "terminal", 2);
    const put = await putKey("u1", "gateway-a/pod-a", KEY_A);
    await untilSettled(harness);

    expect((await provisioned("u1")).status.work.state).toBe("parked");
    const { rows } = await harness.service.db.pool.query(`SELECT refusals, retry_after, conditions FROM ${harness.service.db.table("git_keys")}`);
    expect(rows).toEqual([{ refusals: 1, retry_after: expect.any(Date), conditions: [expect.objectContaining({ status: "Unknown", reason: "GitKeyFailed", message: expect.stringContaining("registration failed") })] }]);

    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("git_keys")} SET retry_after = now()`);
    await untilSettled(harness);
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    expect(registered(await readKey("u1", "gateway-a/pod-a"), put.body.putSequence)).toBe(true);
    expect((await provisioned("u1")).status.work.state).toBe("parked");
  });

  it("reads a refused key again when its backoff passes, without any put, and registers it only at its gateway's next put", async () => {
    harness.git.owners.add("ada");
    harness.git.keys.set("ada", [{ publicKey: KEY_A, holder: "gateway-x/pod-1" }]);
    const registers = () => harness.git.host.calls.filter((call) => call.operation === "registerKey").length;
    const table = (name: string) => harness.service.db.table(name);
    const schedule = async () => (await harness.service.db.pool.query(
      `SELECT k.retry_after, w.due_at, w.state FROM ${table("git_keys")} k JOIN ${table("provisioning_work")} w USING (uid)`)).rows[0];
    const backoffPasses = () => harness.service.db.pool.query(
      `UPDATE ${table("git_keys")} SET retry_after = now() - interval '1 second'; UPDATE ${table("provisioning_work")} SET due_at = now() - interval '1 second'`);
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);

    const first = await schedule();
    expect(first.state).toBe("idle");
    expect(first.due_at).toEqual(first.retry_after);
    await untilSettled(harness);
    expect(registers()).toBe(1);

    await backoffPasses();
    await untilSettled(harness);
    expect(registers()).toBe(1);
    const second = await schedule();
    expect(second.due_at).toEqual(second.retry_after);
    expect(second.retry_after.getTime() - Date.now()).toBeGreaterThan(90_000);

    harness.git.keys.set("ada", []);
    await backoffPasses();
    await untilSettled(harness);
    expect(registers()).toBe(1);
    expect(await keyCondition("u1", "gateway-a", KEY_A)).toMatchObject({ status: "False", reason: "GitKeyHeldElsewhere" });
    await untilSettled(harness);
    expect(registers()).toBe(2);
    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
    const settled = await schedule();
    expect(settled.retry_after).toBeNull();
    expect(settled.due_at.getTime() - Date.now()).toBeGreaterThan(60 * 60_000);
  });

  it("puts the refusal of a key in the attempt's git-keys step", async () => {
    harness.git.owners.add("ada");
    harness.git.keys.set("ada", [{ publicKey: KEY_A, holder: "gateway-x/pod-1" }]);
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);

    const events = (await harness.request("GET", "/v1/users/u1/provisioning/events")).body.items;
    expect(events[0].steps.find((record: { step: string }) => record.step === "git-keys"))
      .toMatchObject({ outcome: "succeeded", message: expect.stringContaining("gateway-a/pod-a: register git key: 422") });
  });

  it("reads a refused key again on its own only after the backoff, which doubles, and registers it again at once whenever its gateway puts it", async () => {
    harness.git.owners.add("ada");
    harness.git.keys.set("ada", [{ publicKey: KEY_A, holder: "gateway-x/pod-1" }]);
    const registers = () => harness.git.host.calls.filter((call) => call.operation === "registerKey").length;
    const put = (publicKey: string) => harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey } } });
    const stored = async () => (await harness.request("GET", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi })).body;
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await put(KEY_A);
    await untilSettled(harness);
    expect(registers()).toBe(1);
    const refused = await stored();
    expect(Date.parse(refused.status.nextAttemptAt) - Date.now()).toBeGreaterThan(30_000);
    expect(refused.status.conditions[0]).toMatchObject({ status: "False", reason: "GitKeyHeldElsewhere" });

    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin", { displayName: { first: "Lin", last: "Again" } }) } });
    await untilSettled(harness);
    expect(registers()).toBe(1);

    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("git_keys")} SET retry_after = now() - interval '1 second'`);
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);
    expect(registers()).toBe(1);
    expect(Date.parse((await stored()).status.nextAttemptAt) - Date.now()).toBeGreaterThan(90_000);

    await put(KEY_A);
    await untilSettled(harness);
    expect(registers()).toBe(2);
    expect(Date.parse((await stored()).status.nextAttemptAt) - Date.now()).toBeLessThan(90_000);

    await put(KEY_B);
    await untilSettled(harness);
    expect(registers()).toBe(3);
    expect((await stored()).status).toMatchObject({ nextAttemptAt: null, conditions: [{ status: "True" }] });
  });

  it("records a key the user added to their own account by hand on the key alone, and leaves that key there", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    harness.git.owners.add("lin");
    harness.git.keys.set("lin", [{ publicKey: KEY_A, holder: "laptop", managed: false }]);
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "laptop", managed: false }]);
    expect((await provisioned("u1")).status.work.state).toBe("idle");
    expect(await keyCondition("u1", "gateway-a", KEY_A)).toMatchObject({ status: "False", reason: "GitKeyHeldElsewhere" });
  });

  it("recognises a key it holds whose stored comment differs, and releases it when its row is deleted", async () => {
    const stored = KEY_A.replace(/ gateway-a$/u, " stored-by-the-host");
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    harness.git.owners.add("lin");
    harness.git.keys.set("lin", [{ publicKey: stored, holder: "gateway-a/pod-a" }]);
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: stored, holder: "gateway-a/pod-a" }]);
    expect(harness.git.host.calls.filter((call) => call.operation === "registerKey")).toEqual([]);
    expect(await keyCondition("u1", "gateway-a", KEY_A)).toMatchObject({ status: "True" });

    await harness.request("DELETE", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi });
    await untilSettled(harness);
    expect(harness.git.keys.get("lin")).toEqual([]);
  });

  it("keeps the key registered when only its comment changes", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await untilSettled(harness);
    const renamed = KEY_A.replace(/ gateway-a$/u, " renamed");

    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: renamed } } });
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")?.map((key) => key.holder)).toEqual(["gateway-a/pod-a"]);
    expect(await keyCondition("u1", "gateway-a", renamed)).toMatchObject({ status: "True", observedGeneration: 2 });
  });

  it("keeps two gateways' different keys for one user registered across a resync without another host write", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    await harness.request("PUT", "/v1/users/u1/git-keys/gateway-b%2Fpod-b", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_B } } });
    await untilSettled(harness);
    const writes = () => harness.git.host.calls.filter((call) => call.operation === "registerKey" || call.operation === "releaseKey").length;
    const before = writes();

    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET due_at = now()`);
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }, { publicKey: KEY_B, holder: "gateway-b/pod-b" }]);
    expect(writes()).toBe(before);
  });

  it("retries, on the next PUT of the same key, a row an earlier build refused while its work sat idle", async () => {
    await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    await untilSettled(harness);
    harness.git.keys.set("lin", [{ publicKey: KEY_A, holder: "gateway-a/pod-1" }]);
    const refused = [{ type: "Registered", status: "False", reason: "GitKeyFailed", message: "registered under a holder this service does not manage; left unchanged", lastTransitionTime: new Date().toISOString(), observedGeneration: 1 }];
    await harness.service.db.pool.query(
      `INSERT INTO ${harness.service.db.table("git_keys")} (uid, gateway_id, holder, generation, observed_generation, resource_version, public_key, conditions) VALUES ('u1', 'gateway-a', 'gateway-a/pod-a', 1, 1, '999', $1, $2)`,
      [KEY_A, JSON.stringify(refused)]);
    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET state = 'idle', due_at = now() + interval '6 hours'`);

    const unchanged = await harness.request("PUT", "/v1/users/u1/git-keys/gateway-a%2Fpod-a", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY_A } } });
    expect(unchanged.status).toBe(200);
    await untilSettled(harness);

    expect(harness.git.keys.get("lin")).toEqual([{ publicKey: KEY_A, holder: "gateway-a/pod-a" }]);
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
