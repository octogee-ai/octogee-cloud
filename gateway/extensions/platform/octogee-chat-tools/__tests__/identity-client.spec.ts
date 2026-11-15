import { lstat, mkdir, mkdtemp, open, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createIdentityClient,
  IDENTITY_PATH,
  resolveAvatarPath,
  IdentityToolError,
  resolveIdentitySlug,
  readWorkspaceAvatarBase64,
  type AvatarFileOps,
} from "../identity-client.js";

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(res: { ok: boolean; status: number; payload: unknown; text?: string }) {
  const calls: FakeCall[] = [];
  const impl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: res.ok,
      status: res.status,
      json: async () => res.payload,
      text: async () => res.text ?? JSON.stringify(res.payload),
    };
  };
  return { impl, calls };
}

describe("identity-client", () => {
  it("POSTs set-coach-identity with the projected service-account token", async () => {
    const { impl, calls } = fakeFetch({
      ok: true,
      status: 200,
      payload: { updated: ["name", "persona", "avatar"] },
    });
    const client = createIdentityClient({
      brokerUrl: "http://octogee-api:3001",
      fetchImpl: impl,
      tokenProvider: async () => "gateway-sa-token",
    });

    await expect(
      client.setDefaultAgentIdentity({
        workspaceSlug: "alice",
        agentId: "octogee-alice-coach",
        name: "Scout",
        vibe: "Calm and direct",
        avatarBase64: "iVBORw0KGgo=",
      }),
    ).resolves.toEqual({ updated: ["name", "persona", "avatar"] });

    expect(calls).toEqual([
      {
        url: `http://octogee-api:3001${IDENTITY_PATH}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-K8s-Sa-Token": "gateway-sa-token",
        },
        body: {
          workspaceSlug: "alice",
          agentId: "octogee-alice-coach",
          name: "Scout",
          vibe: "Calm and direct",
          avatarBase64: "iVBORw0KGgo=",
        },
      },
    ]);
  });

  it("fails closed when the service-account token is unavailable", async () => {
    const { impl, calls } = fakeFetch({ ok: true, status: 200, payload: { updated: [] } });
    const client = createIdentityClient({
      brokerUrl: "http://octogee-api:3001",
      fetchImpl: impl,
      tokenProvider: async () => null,
    });

    await expect(
      client.setDefaultAgentIdentity({ workspaceSlug: "alice", agentId: "octogee-alice-coach", name: "Scout" }),
    ).rejects.toMatchObject({ code: "auth-unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("maps broker failures to bounded tool errors", async () => {
    const { impl } = fakeFetch({
      ok: false,
      status: 403,
      payload: { error: "forbidden" },
      text: '{"error":"forbidden"}',
    });
    const client = createIdentityClient({
      brokerUrl: "http://octogee-api:3001",
      fetchImpl: impl,
      tokenProvider: async () => "gateway-sa-token",
    });

    await expect(
      client.setDefaultAgentIdentity({ workspaceSlug: "alice", agentId: "octogee-alice-coach", name: "Scout" }),
    ).rejects.toMatchObject({ code: "control-error" });
  });
});

describe("resolveAvatarPath", () => {
  it("resolves a relative avatar path inside the current workspace root", () => {
    expect(resolveAvatarPath("/customers", "alice", ".octogee/avatar.svg")).toBe(
      "/customers/alice/.octogee/avatar.svg",
    );
  });

  it("rejects absolute paths and traversal", () => {
    for (const value of ["/etc/passwd", "../bob/avatar.svg", ".octogee/../../x.png", "a\0b"]) {
      expect(() => resolveAvatarPath("/customers", "alice", value)).toThrow(IdentityToolError);
    }
  });
});

describe("readWorkspaceAvatarBase64", () => {
  it("rejects final and intermediate symlinks instead of reading another workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "octogee-avatar-"));
    await mkdir(path.join(root, "alice", ".octogee"), { recursive: true });
    await mkdir(path.join(root, "mike", ".octogee"), { recursive: true });
    await writeFile(path.join(root, "mike", ".octogee", "avatar.png"), "mike-secret");
    await symlink(path.join(root, "mike", ".octogee", "avatar.png"), path.join(root, "alice", ".octogee", "final.png"));
    await symlink(path.join(root, "mike", ".octogee"), path.join(root, "alice", "foreign"));

    await expect(readWorkspaceAvatarBase64(root, "alice", ".octogee/final.png"))
      .rejects.toMatchObject({ code: "bad-avatar-path" });
    await expect(readWorkspaceAvatarBase64(root, "alice", "foreign/avatar.png"))
      .rejects.toMatchObject({ code: "bad-avatar-path" });
  });

  it("rejects a component swapped to another workspace between validation and open", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "octogee-avatar-race-"));
    const safeDir = path.join(root, "alice", ".octogee");
    const movedDir = path.join(root, "alice", ".octogee-safe");
    const foreignDir = path.join(root, "mike", ".octogee");
    await mkdir(safeDir, { recursive: true });
    await mkdir(foreignDir, { recursive: true });
    await writeFile(path.join(safeDir, "avatar.png"), "alice-safe");
    await writeFile(path.join(foreignDir, "avatar.png"), "mike-secret");
    let swapped = false;
    const ops: AvatarFileOps = {
      lstat,
      realpath,
      stat,
      open: async (filePath, flags) => {
        if (!swapped) {
          swapped = true;
          await rename(safeDir, movedDir);
          await symlink(foreignDir, safeDir);
        }
        return open(filePath, flags);
      },
    };
    await expect(readWorkspaceAvatarBase64(root, "alice", ".octogee/avatar.png", ops))
      .rejects.toMatchObject({ code: "bad-avatar-path" });
  });
});

describe("resolveIdentitySlug — multi-agent project agents", () => {
  it("resolves the workspace for a project agent’s own identity", () => {
    expect(resolveIdentitySlug("octogee-alice-proj-orbit-coach")).toBe("alice");
  });
});

it('routes a project agent identity update to its scoped endpoint', async () => {
  const { impl, calls } = fakeFetch({ ok: true, status: 200, payload: { updated: ['name', 'emoji'] } });
  const client = createIdentityClient({ brokerUrl: 'http://broker', fetchImpl: impl, tokenProvider: async () => 'sa' });
  await client.setDefaultAgentIdentity({ workspaceSlug: 'alice', agentId: 'octogee-alice-proj-orbit-coach', name: 'Chip', emoji: '⛳' });
  expect(calls[0].url).toBe('http://broker/internal/agent-projects/identity');
});
