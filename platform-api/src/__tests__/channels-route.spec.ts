import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  createSessionChannel: vi.fn(),
  renameSessionChannel: vi.fn(),
  archiveSessionChannel: vi.fn(),
  createProjectSessionChannel: vi.fn(),
  renameProjectSessionChannel: vi.fn(),
  archiveProjectSessionChannel: vi.fn(),
  listArchivedSessionChannels: vi.fn(),
  restoreSessionChannel: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("@octogee/core/http/security", () => ({
  strictRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("@octogee/core/http/logging", () => ({
  logger: h.logger,
}));

vi.mock("../lib/channel-service.js", () => ({
  createSessionChannel: (...args: unknown[]) => h.createSessionChannel(...args),
  renameSessionChannel: (...args: unknown[]) => h.renameSessionChannel(...args),
  archiveSessionChannel: (...args: unknown[]) => h.archiveSessionChannel(...args),
  createProjectSessionChannel: (...args: unknown[]) => h.createProjectSessionChannel(...args),
  renameProjectSessionChannel: (...args: unknown[]) => h.renameProjectSessionChannel(...args),
  archiveProjectSessionChannel: (...args: unknown[]) => h.archiveProjectSessionChannel(...args),
  listArchivedSessionChannels: (...args: unknown[]) => h.listArchivedSessionChannels(...args),
  restoreSessionChannel: (...args: unknown[]) => h.restoreSessionChannel(...args),
}));

const { default: channelsRouter } = await import("../routes/channels/index.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.uid = "owner-1";
    req.user = { username: "mira" };
    req.workspaceSlug = "mira";
    next();
  });
  a.use("/api/channels", channelsRouter);
  return a;
}

beforeEach(() => {
  h.createSessionChannel.mockReset();
  h.renameSessionChannel.mockReset();
  h.archiveSessionChannel.mockReset();
  h.createProjectSessionChannel.mockReset();
  h.renameProjectSessionChannel.mockReset();
  h.archiveProjectSessionChannel.mockReset();
  h.listArchivedSessionChannels.mockReset();
  h.restoreSessionChannel.mockReset();
  h.logger.error.mockReset();
});

describe("project channel routes", () => {
  it("routes POST /proj/:pid to the project create service", async () => {
    h.createProjectSessionChannel.mockResolvedValue({
      status: 200,
      body: { success: true, channelId: "channel-1", name: "patchroll" },
    });

    const resp = await request(app())
      .post("/api/channels/proj/orbit")
      .send({ name: "patchroll", displayName: "OC Patch Upgrade", purpose: "" });

    expect(resp.status).toBe(200);
    expect(h.createProjectSessionChannel).toHaveBeenCalledWith(
      { uid: "owner-1", workspaceId: "mira" },
      "orbit",
      { name: "patchroll", displayName: "OC Patch Upgrade", purpose: "" },
    );
    expect(h.createSessionChannel).not.toHaveBeenCalled();
  });

  it("routes PATCH /proj/:pid/:name to the project rename service", async () => {
    h.renameProjectSessionChannel.mockResolvedValue({ status: 200, body: { success: true } });

    const resp = await request(app())
      .patch("/api/channels/proj/orbit/patchroll")
      .send({ displayName: "New" });

    expect(resp.status).toBe(200);
    expect(h.renameProjectSessionChannel).toHaveBeenCalledWith(
      { uid: "owner-1", workspaceId: "mira" },
      "orbit",
      "patchroll",
      { displayName: "New" },
    );
  });

  it("routes POST /proj/:pid/:name/archive to the project archive service", async () => {
    h.archiveProjectSessionChannel.mockResolvedValue({ status: 200, body: { success: true } });

    const resp = await request(app()).post("/api/channels/proj/orbit/patchroll/archive");

    expect(resp.status).toBe(200);
    expect(h.archiveProjectSessionChannel).toHaveBeenCalledWith(
      { uid: "owner-1", workspaceId: "mira" },
      "orbit",
      "patchroll",
    );
  });

  it("returns 500 and logs when a project service throws", async () => {
    h.createProjectSessionChannel.mockRejectedValue(new Error("boom"));

    const resp = await request(app()).post("/api/channels/proj/orbit").send({});

    expect(resp.status).toBe(500);
    expect(resp.body).toEqual({ error: "Failed to create channel" });
    expect(h.logger.error).toHaveBeenCalled();
  });
});

describe("POST /api/channels", () => {
  it("passes the actor and body to the service and relays its result", async () => {
    h.createSessionChannel.mockResolvedValue({
      status: 200,
      body: { success: true, channelId: "channel-1", name: "patchroll" },
    });

    const resp = await request(app())
      .post("/api/channels")
      .send({ name: "patchroll", displayName: "OC Patch Upgrade", purpose: "Rolls" });

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ success: true, channelId: "channel-1", name: "patchroll" });
    expect(h.createSessionChannel).toHaveBeenCalledWith(
      { uid: "owner-1", workspaceId: "mira" },
      { name: "patchroll", displayName: "OC Patch Upgrade", purpose: "Rolls" },
    );
  });

  it("returns 500 and logs when the service throws", async () => {
    h.createSessionChannel.mockRejectedValue(new Error("boom"));

    const resp = await request(app()).post("/api/channels").send({ name: "x" });

    expect(resp.status).toBe(500);
    expect(resp.body).toEqual({ error: "Failed to create channel" });
    expect(h.logger.error).toHaveBeenCalled();
  });
});

describe("PATCH /api/channels/:name", () => {
  it("relays the rename to the service", async () => {
    h.renameSessionChannel.mockResolvedValue({ status: 200, body: { success: true } });

    const resp = await request(app())
      .patch("/api/channels/patchroll")
      .send({ displayName: "New Name" });

    expect(resp.status).toBe(200);
    expect(h.renameSessionChannel).toHaveBeenCalledWith(
      { uid: "owner-1", workspaceId: "mira" },
      "patchroll",
      { displayName: "New Name" },
    );
  });

  it("returns 500 and logs when the service throws", async () => {
    h.renameSessionChannel.mockRejectedValue(new Error("boom"));

    const resp = await request(app()).patch("/api/channels/patchroll").send({});

    expect(resp.status).toBe(500);
    expect(resp.body).toEqual({ error: "Failed to update channel" });
    expect(h.logger.error).toHaveBeenCalled();
  });
});

describe("POST /api/channels/:name/archive", () => {
  it("relays the archive to the service", async () => {
    h.archiveSessionChannel.mockResolvedValue({ status: 200, body: { success: true } });

    const resp = await request(app()).post("/api/channels/patchroll/archive");

    expect(resp.status).toBe(200);
    expect(h.archiveSessionChannel).toHaveBeenCalledWith(
      { uid: "owner-1", workspaceId: "mira" },
      "patchroll",
    );
  });

  it("returns 500 and logs when the service throws", async () => {
    h.archiveSessionChannel.mockRejectedValue(new Error("boom"));

    const resp = await request(app()).post("/api/channels/patchroll/archive");

    expect(resp.status).toBe(500);
    expect(resp.body).toEqual({ error: "Failed to archive channel" });
    expect(h.logger.error).toHaveBeenCalled();
  });
});

describe("GET /api/channels/archived", () => {
  it("relays the caller's archived tasks from the service", async () => {
    const channels = [{ name: "patchroll", displayName: "Patch Roll", archivedAt: 1_700_000_000_000 }];
    h.listArchivedSessionChannels.mockResolvedValue({ status: 200, body: { channels } });

    const resp = await request(app()).get("/api/channels/archived");

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ channels });
    expect(h.listArchivedSessionChannels).toHaveBeenCalledWith({ uid: "owner-1", workspaceId: "mira" });
  });

  it("returns 500 and logs when the service throws", async () => {
    h.listArchivedSessionChannels.mockRejectedValue(new Error("boom"));

    const resp = await request(app()).get("/api/channels/archived");

    expect(resp.status).toBe(500);
    expect(resp.body).toEqual({ error: "Failed to list archived channels" });
    expect(h.logger.error).toHaveBeenCalled();
  });
});

describe("POST /api/channels/:name/restore", () => {
  it("relays the restore to the service", async () => {
    h.restoreSessionChannel.mockResolvedValue({
      status: 200,
      body: { success: true, channelId: "channel-1", name: "patchroll" },
    });

    const resp = await request(app()).post("/api/channels/patchroll/restore");

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ success: true, channelId: "channel-1", name: "patchroll" });
    expect(h.restoreSessionChannel).toHaveBeenCalledWith(
      { uid: "owner-1", workspaceId: "mira" },
      "patchroll",
    );
  });

  it("relays the service's refusal of a non-owner", async () => {
    h.restoreSessionChannel.mockResolvedValue({
      status: 403,
      body: { error: "Only the task's owner can restore it" },
    });

    const resp = await request(app()).post("/api/channels/patchroll/restore");

    expect(resp.status).toBe(403);
    expect(resp.body).toEqual({ error: "Only the task's owner can restore it" });
  });

  it("returns 500 and logs when the service throws", async () => {
    h.restoreSessionChannel.mockRejectedValue(new Error("boom"));

    const resp = await request(app()).post("/api/channels/patchroll/restore");

    expect(resp.status).toBe(500);
    expect(resp.body).toEqual({ error: "Failed to restore channel" });
    expect(h.logger.error).toHaveBeenCalled();
  });
});
