import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { assertWorkspaceIdentityReady, beginWorkspaceIdentityBoot, bootstrapWorkspaceIdentities, workspaceIdentityReady, workspaceOwnerIdentityReady } from "./openclaw-workspace-bootstrap.js";

interface StoredProfile { id: string; aliases: string[]; role: string | null }

const isEmailAddress = (alias: string) => /^[^\s@/:]+@[^\s@/:]+$/u.test(alias);
const projected = (profile: StoredProfile) => ({
  id: profile.id, emails: profile.aliases.filter(isEmailAddress), ...(profile.role ? { role: profile.role } : {}),
});

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
function writeClaim(dir: string, ownerUid: string, gatewayId = "b-alice"): void {
  fs.writeFileSync(path.join(dir, "builder-claim.json"), JSON.stringify({
    schemaVersion: 1, gatewayId, ownerUid, builderSlug: ownerUid,
    leaseId: null, generation: null, claimedAt: 1, overlayAppliedAt: null,
  }));
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map(close => close()));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-workspace-bootstrap-")); dirs.push(dir);
  const env: NodeJS.ProcessEnv = { OPENCLAW_DIR: dir, GATEWAY_ID: "b-alice", GATEWAY_CLASS: "isolated", OPENCLAW_CONTROL_IDENTITY: "per-user" };
  writeClaim(dir, "alice");
  const profiles: StoredProfile[] = [];
  const signInAs = (uid: string) => {
    const alias = uid.toLowerCase();
    let profile = profiles.find(entry => entry.aliases.includes(alias));
    if (!profile) {
      profile = { id: `native-${uid}`, aliases: [alias], role: null };
      profiles.push(profile);
    }
    return profile;
  };
  const request = vi.fn(async (method: string, params: Record<string, unknown>, options: { scopes: string[] }) => {
    expect(options.scopes).toEqual(["operator.admin"]);
    if (method === "users.list") return { profiles: profiles.map(projected) };
    const profile = profiles.find(entry => entry.id === params.profileId)!;
    profile.role = params.role as string;
    return { profile: projected(profile) };
  });
  const signIn = vi.fn(async (uid: string) => projected(signInAs(uid)));
  const args = { env, request: request as Parameters<typeof bootstrapWorkspaceIdentities>[0]["request"], signIn };
  beginWorkspaceIdentityBoot(env);
  return { env, profiles, request, signIn, signInAs, args };
}

async function nativeGateway(signInAs: (uid: string) => StoredProfile) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const signIns: string[] = [];
  const calls: Array<{ user: string; method: string }> = [];
  wss.on("connection", (ws, req) => {
    const user = String(req.headers["x-octogee-user"]);
    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
    ws.on("message", raw => {
      const frame = JSON.parse(raw.toString()) as { id: string; method: string };
      calls.push({ user, method: frame.method });
      if (frame.method === "connect") {
        signIns.push(user);
        signInAs(user);
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { type: "hello-ok" } }));
      } else if (frame.method === "users.self") {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { profile: projected(signInAs(user)) } }));
      } else {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { message: "unexpected method" } }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise(resolve => {
    for (const client of wss.clients) client.terminate();
    wss.close(() => server.close(() => resolve()));
  }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, signIns, calls };
}

describe("native workspace identity initialization", () => {
  it("initializes an empty native profile store before admitting users or services", async () => {
    const { env, profiles, args } = fixture();
    expect(() => assertWorkspaceIdentityReady(env)).toThrow("not initialized");
    expect(workspaceIdentityReady(env)).toBe(false);
    await bootstrapWorkspaceIdentities(args);
    expect(profiles.map(profile => profile.role)).toEqual(["service", "service", "admin"]);
    expect(() => assertWorkspaceIdentityReady(env)).not.toThrow();
    expect(workspaceIdentityReady(env)).toBe(true);
  });

  it("reads each identity's profile from users.self on a connection signed in as that identity", async () => {
    const { env, profiles, request, signInAs } = fixture();
    vi.spyOn(os, "networkInterfaces").mockReturnValue({ eth0: [{ address: "10.8.0.4", family: "IPv4", internal: false } as os.NetworkInterfaceInfo] });
    const gateway = await nativeGateway(signInAs);
    const wired = { ...env, OPENCLAW_GATEWAY_URL: gateway.url, API_PUBLIC_URL: "https://api.example.com" };
    await bootstrapWorkspaceIdentities({ env: wired, request: request as Parameters<typeof bootstrapWorkspaceIdentities>[0]["request"] });
    expect(gateway.signIns).toEqual(["svc:gateway-edge", "svc:octogee-provisioner", "alice"]);
    expect(gateway.calls.filter(call => call.method === "users.self").map(call => call.user)).toEqual(gateway.signIns);
    expect(profiles.map(profile => [profile.aliases, profile.role])).toEqual([
      [["svc:gateway-edge"], "service"], [["svc:octogee-provisioner"], "service"], [["alice"], "admin"],
    ]);
    expect(workspaceIdentityReady(wired)).toBe(true);
  });

  it("forces the owner back to admin on later boots", async () => {
    const { env, profiles, request, args } = fixture();
    await bootstrapWorkspaceIdentities(args);
    profiles[2].role = "member";
    request.mockClear();
    beginWorkspaceIdentityBoot(env);
    expect(() => assertWorkspaceIdentityReady(env)).toThrow("not initialized");
    await bootstrapWorkspaceIdentities(args);
    expect(profiles[2].role).toBe("admin");
    expect(request).toHaveBeenCalledWith("users.setRole", { profileId: profiles[2].id, role: "admin" }, expect.anything());
  });

  it("leaves correctly assigned roles untouched", async () => {
    const { env, args, request } = fixture();
    await bootstrapWorkspaceIdentities(args);
    request.mockClear();
    beginWorkspaceIdentityBoot(env);
    await bootstrapWorkspaceIdentities(args);
    expect(request).not.toHaveBeenCalledWith("users.setRole", expect.anything(), expect.anything());
  });

  it("resumes after a crash between native profile creation and role assignment", async () => {
    const { env, profiles, signIn, args } = fixture();
    signIn.mockImplementationOnce(async uid => {
      profiles.push({ id: "created-before-crash", aliases: [uid], role: null });
      throw new Error("interrupted");
    });
    await expect(bootstrapWorkspaceIdentities(args)).rejects.toThrow("interrupted");
    expect(() => assertWorkspaceIdentityReady(env)).toThrow("not initialized");
    beginWorkspaceIdentityBoot(env);
    await bootstrapWorkspaceIdentities(args);
    expect(profiles.map(profile => profile.role)).toEqual(["service", "service", "admin"]);
    expect(profiles[0].id).toBe("created-before-crash");
  });

  it("restores the same owner's identities on a replacement gateway with the owner as admin", async () => {
    const { env, profiles, args, request } = fixture();
    await bootstrapWorkspaceIdentities(args);
    profiles[2].role = "custom";
    env.GATEWAY_ID = "b-alice-replacement";
    writeClaim(env.OPENCLAW_DIR!, "alice", "b-alice-replacement");
    beginWorkspaceIdentityBoot(env);
    request.mockClear();
    await bootstrapWorkspaceIdentities(args);
    expect(() => assertWorkspaceIdentityReady(env)).not.toThrow();
    expect(profiles[2].role).toBe("admin");
  });

  it("assigns roles to platform and owner identities restored without one", async () => {
    const { profiles, args } = fixture();
    profiles.push(
      { id: "restored-edge", aliases: ["svc:gateway-edge"], role: null },
      { id: "restored-provisioner", aliases: ["svc:octogee-provisioner"], role: null },
      { id: "restored-owner", aliases: ["alice"], role: null },
    );
    await bootstrapWorkspaceIdentities(args);
    expect(profiles.map(profile => [profile.id, profile.role])).toEqual([
      ["restored-edge", "service"],
      ["restored-provisioner", "service"],
      ["restored-owner", "admin"],
    ]);
  });

  it("restores the service role of a platform identity on a later boot", async () => {
    const { env, profiles, args } = fixture();
    await bootstrapWorkspaceIdentities(args);
    profiles[1].role = "member";
    beginWorkspaceIdentityBoot(env);
    await bootstrapWorkspaceIdentities(args);
    expect(profiles.map(profile => profile.role)).toEqual(["service", "service", "admin"]);
    expect(() => assertWorkspaceIdentityReady(env)).not.toThrow();
  });

  it("rejects an identity journal belonging to a different owner", async () => {
    const { env, args } = fixture();
    await bootstrapWorkspaceIdentities(args);
    writeClaim(env.OPENCLAW_DIR!, "bob");
    beginWorkspaceIdentityBoot(env);
    await expect(bootstrapWorkspaceIdentities(args)).rejects.toThrow("does not match");
    expect(() => assertWorkspaceIdentityReady(env)).toThrow("not initialized");
  });

  it("refuses to admit an owner that is not the user claim's", async () => {
    const { env, profiles, args, signIn } = fixture();
    fs.rmSync(path.join(env.OPENCLAW_DIR!, "builder-claim.json"));
    await expect(bootstrapWorkspaceIdentities({ ...args, env: { ...env, GATEWAY_OWNER_UID: "mallory" } })).rejects.toThrow("claimed owner");
    expect(signIn).not.toHaveBeenCalled();
    expect(profiles).toEqual([]);
    expect(() => assertWorkspaceIdentityReady(env)).toThrow("not initialized");
  });

  it("refuses to initialize identities for a user with no claim", async () => {
    const { env, profiles, args, signIn } = fixture();
    fs.rmSync(path.join(env.OPENCLAW_DIR!, "builder-claim.json"));
    await expect(bootstrapWorkspaceIdentities(args)).rejects.toThrow("claimed owner");
    expect(signIn).not.toHaveBeenCalled();
    expect(profiles).toEqual([]);
    expect(workspaceIdentityReady(env)).toBe(false);
  });

  it("marks the owner identity ready only after the owner is admin", async () => {
    const { env, args, request } = fixture();
    request.mockImplementation(async (method: string) => {
      if (method === "users.setRole") throw new Error("role write refused");
      return { profiles: [] };
    });
    await expect(bootstrapWorkspaceIdentities(args)).rejects.toThrow();
    expect(workspaceOwnerIdentityReady(env, "alice")).toBe(false);
  });

  it("forces a preexisting owner to admin and does nothing on shared gateways", async () => {
    const { env, profiles, args, request } = fixture();
    profiles.push({ id: "existing-owner", aliases: ["alice"], role: "custom" });
    await bootstrapWorkspaceIdentities(args);
    expect(profiles[0].role).toBe("admin");
    request.mockClear();
    await bootstrapWorkspaceIdentities({ ...args, env: { ...env, GATEWAY_CLASS: "shared" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("initializes identities on a gateway whose class is isolated the same as builder", async () => {
    const { env, profiles, args } = fixture();
    const isolatedEnv = { ...env, GATEWAY_CLASS: "isolated" };
    beginWorkspaceIdentityBoot(isolatedEnv);
    await bootstrapWorkspaceIdentities({ ...args, env: isolatedEnv });
    expect(profiles.map(profile => profile.role)).toEqual(["service", "service", "admin"]);
    expect(workspaceIdentityReady(isolatedEnv)).toBe(true);
  });

  it("does nothing on a gateway with an unknown class", async () => {
    const { env, args, request } = fixture();
    await bootstrapWorkspaceIdentities({ ...args, env: { ...env, GATEWAY_CLASS: "operator" } });
    expect(request).not.toHaveBeenCalled();
  });
});
