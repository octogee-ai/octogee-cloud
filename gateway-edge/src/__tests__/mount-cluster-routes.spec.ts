import type { Express, RequestHandler } from "express";
import { Router } from "express";
import { describe, expect, it, vi } from "vitest";

import { mountClusterRoutes } from "../routes/mount-cluster-routes.js";

type MountCall = {
  method: "all" | "use";
  path: string;
  handlers: unknown[];
};

function recordingApp(): Express & { calls: MountCall[] } {
  const calls: MountCall[] = [];
  return {
    calls,
    all: vi.fn((path: string, ...handlers: unknown[]) => {
      calls.push({ method: "all", path, handlers });
    }),
    use: vi.fn((path: string, ...handlers: unknown[]) => {
      calls.push({ method: "use", path, handlers });
    }),
  } as unknown as Express & { calls: MountCall[] };
}

function useCalls(app: { calls: MountCall[] }, path: string): MountCall[] {
  return app.calls.filter((c) => c.method === "use" && c.path === path);
}

describe("mountClusterRoutes", () => {
  it("mounts the Mattermost REST proxy before all cluster routes when provided", () => {
    const app = recordingApp();
    const mmRestProxyHandler: RequestHandler = vi.fn();

    mountClusterRoutes(app, { mmRestProxyHandler });

    expect(app.calls[0]).toMatchObject({
      method: "all",
      path: "/api/v4/*splat",
      handlers: [mmRestProxyHandler],
    });
  });

  it("keeps workspace auth in front of every workspace route", () => {
    const app = recordingApp();

    mountClusterRoutes(app);

    const workspace = useCalls(app, "/api/workspace");
    expect(workspace).toHaveLength(11);
    expect((workspace[0].handlers[0] as { name?: string }).name).toBe("requireAuth");
  });

  it("keeps channel auth in front of every channel route", () => {
    const app = recordingApp();

    mountClusterRoutes(app);

    const channels = useCalls(app, "/api/channels");
    expect(channels).toHaveLength(2);
    expect((channels[0].handlers[0] as { name?: string }).name).toBe("requireAuth");
  });

  it("keeps public project reads before project auth and omits product deletion by default", () => {
    const app = recordingApp();

    mountClusterRoutes(app);

    const projects = useCalls(app, "/api/projects");
    expect(projects).toHaveLength(11);
    expect((projects[1].handlers[0] as { name?: string }).name).toBe("requireAuth");
  });

  it("prefers the injected project routers over the fail-closed defaults", () => {
    const app = recordingApp();
    const projectsCreateRoutes = Router();
    const projectsDeleteRoutes = Router();
    const projectsRepoSourceRoutes = Router();

    mountClusterRoutes(app, { projectsCreateRoutes, projectsDeleteRoutes, projectsRepoSourceRoutes });

    const projects = useCalls(app, "/api/projects");
    expect(projects[1].handlers).toEqual([projectsDeleteRoutes]);
    expect(projects[3].handlers).toEqual([projectsCreateRoutes]);
    expect(projects[9].handlers).toEqual([projectsRepoSourceRoutes]);
  });

  it("mounts the injected admin router in place of the platform default", () => {
    const app = recordingApp();
    const adminRoutes = Router();

    mountClusterRoutes(app, { adminRoutes });

    expect(useCalls(app, "/api/admin")[0].handlers).toEqual([adminRoutes]);
  });

  it("mounts the optional Mattermost mint route at the browser credential path", () => {
    const app = recordingApp();
    const mattermostMintRoutes = Router();

    mountClusterRoutes(app, { mattermostMintRoutes });

    expect(useCalls(app, "/api/auth/mattermost")[0].handlers).toEqual([mattermostMintRoutes]);
  });

  it("keeps internal cluster routes as the final mount tail", () => {
    const app = recordingApp();

    mountClusterRoutes(app);

    const tail = app.calls.slice(-2).map((c) => c.path);
    expect(tail).toEqual(["/internal/agents", "/internal/workspace"]);
  });

  it("mounts injected product routes after the platform table and before the internal tail", () => {
    const app = recordingApp();
    const billing = Router();
    const posts = Router();

    mountClusterRoutes(app, { productRoutes: [["/api/billing", billing], ["/api/posts", posts]] });

    const paths = app.calls.map((c) => c.path);
    expect(paths.slice(-4)).toEqual(["/api/billing", "/api/posts", "/internal/agents", "/internal/workspace"]);
    expect(useCalls(app, "/api/billing")[0].handlers).toEqual([billing]);
    expect(paths.indexOf("/api/voice")).toBeLessThan(paths.indexOf("/api/billing"));
  });

  it("mounts no product route when none is injected", () => {
    const app = recordingApp();

    mountClusterRoutes(app);

    const paths = app.calls.map((c) => c.path);
    for (const path of ["/api/billing", "/api/sharing", "/api/posts", "/api/profile", "/api/notifications", "/internal/notifications"]) {
      expect(paths).not.toContain(path);
    }
  });

  it("mounts the public API table in the intended order", () => {
    const app = recordingApp();

    mountClusterRoutes(app);

    expect(app.calls.map((c) => c.path)).toEqual([
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/channels",
      "/api/channels",
      "/api/projects",
      "/api/projects",
      "/api/projects",
      "/api/projects",
      "/api/projects",
      "/api/projects",
      "/api/projects",
      "/api/projects",
      "/api/projects",
      "/api/projects",
      "/api/projects",
      "/api/entities",
      "/api/mattermost",
      "/api/openclaw",
      "/api/agent-models",
      "/api/channel-session-models",
      "/api/model-credentials",
      "/api/admin",
      "/api/connect",
      "/api/agents",
      "/api/builder",
      "/api/productivity-approvals",
      "/api/voice",
      "/internal/agents",
      "/internal/workspace",
    ]);
  });
});
