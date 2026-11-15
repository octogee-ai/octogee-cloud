import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  provisionProjectAgent: vi.fn(),
  docs: new Map<string, Record<string, any>>(),
  beforeRun: null as (() => void) | null,
  owner: true, archived: false,
  logger: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("@octogee/core/http/security", () => ({
  strictRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("@octogee/core/http/logging", () => ({ logger: h.logger }));

vi.mock("../lib/project-agent-service.js", () => ({
  provisionProjectAgent: (...args: unknown[]) => h.provisionProjectAgent(...args),
}));

vi.mock('../lib/withProject.js', () => ({ withProject: async (req: any, res: any, wid: string, pid: string, options: any, run: any) => {
  if (options.ownerOnly && !h.owner) { res.status(403).json({ error: 'owner required' }); return; }
  if (options.requireActive && h.archived) { res.status(409).json({ error: 'archived' }); return; }
  h.beforeRun?.();
  await run({ project: { agent: {} } });
} }));
vi.mock('@octogee/core/identity/platform-state-store', async () => {
  const { createDocumentFixtureStore } = await import('@octogee/core-testing/journal-store');
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});
const { default: agentRouter } = await import("../routes/projects/agent.js");

const PROJECT_PATH = 'workspaces/mira/projects/orbit';

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.uid = "owner-1";
    req.user = { username: "mira" };
    req.workspaceSlug = "mira";
    next();
  });
  a.use("/api/projects", agentRouter);
  return a;
}

beforeEach(() => {
  h.provisionProjectAgent.mockReset();
  h.owner = true; h.archived = false; h.beforeRun = null;
  h.docs.clear();
  h.docs.set(PROJECT_PATH, { ownerUid: 'owner-1', provisioningState: 'active', agent: { mode: 'scoped', identity: { name: 'orbit' } } });
  h.logger.error.mockReset();
});

describe("POST /api/projects/:wid/:pid/agent", () => {
  it("provisions the project agent for the caller's own workspace", async () => {
    h.provisionProjectAgent.mockResolvedValue({
      status: 200,
      body: { success: true, status: "provisioning", provisioned: true },
    });

    const resp = await request(app()).post("/api/projects/mira/orbit/agent").send({});

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ success: true, status: "provisioning", provisioned: true });
    expect(h.provisionProjectAgent).toHaveBeenCalledWith({ uid: "owner-1", workspaceId: "mira" }, "orbit");
  });

  it("refuses provisioning against another workspace", async () => {
    const resp = await request(app()).post("/api/projects/victim/orbit/agent").send({});

    expect(resp.status).toBe(403);
    expect(h.provisionProjectAgent).not.toHaveBeenCalled();
  });

  it("returns 500 and logs when the service throws", async () => {
    h.provisionProjectAgent.mockRejectedValue(new Error("boom"));

    const resp = await request(app()).post("/api/projects/mira/orbit/agent").send({});

    expect(resp.status).toBe(500);
    expect(h.logger.error).toHaveBeenCalled();
  });
});

describe('project agent voice settings', () => {
  it('stores and clears only the project voice', async () => {
    const api = app();
    expect((await request(api).put('/api/projects/mira/orbit/agent/voice').send({ voice: 'cedar' })).body).toEqual({ voice: 'cedar' });
    expect(h.docs.get(PROJECT_PATH)).toMatchObject({ agent: { mode: 'scoped', identity: { name: 'orbit' }, voice: 'cedar' }, updatedAt: expect.any(Number) });
    expect((await request(api).put('/api/projects/mira/orbit/agent/voice').send({ voice: '' })).status).toBe(200);
    expect(h.docs.get(PROJECT_PATH)?.agent).toMatchObject({ mode: 'scoped', voice: '' });
  });
  it('keeps agent fields another writer committed after the route loaded the project', async () => {
    h.beforeRun = () => { h.docs.get(PROJECT_PATH)!.agent.handoff = { status: 'pending' }; };

    expect((await request(app()).put('/api/projects/mira/orbit/agent/voice').send({ voice: 'cedar' })).status).toBe(200);

    expect(h.docs.get(PROJECT_PATH)?.agent).toMatchObject({ voice: 'cedar', handoff: { status: 'pending' } });
  });
  it('returns 409 and writes nothing when the agent was removed before the voice commit', async () => {
    h.beforeRun = () => { h.docs.set(PROJECT_PATH, { ownerUid: 'owner-1', provisioningState: 'active' }); };

    expect((await request(app()).put('/api/projects/mira/orbit/agent/voice').send({ voice: 'cedar' })).status).toBe(409);

    expect(h.docs.get(PROJECT_PATH)).not.toHaveProperty('agent');
  });
  it.each([{ voice: '<script>' }, { voice: 'cedar', agentId: 'foreign' }, {}])('rejects invalid settings %j', async body => {
    expect((await request(app()).put('/api/projects/mira/orbit/agent/voice').send(body)).status).toBe(400);
    expect(h.docs.get(PROJECT_PATH)?.agent).not.toHaveProperty('voice');
  });
  it.each(['owner', 'configured', 'archived'] as const)('rejects unavailable %s authority', async kind => {
    if (kind === 'archived') h.archived = true;
    else if (kind === 'owner') h.owner = false;
    else h.docs.set(PROJECT_PATH, { ownerUid: 'owner-1', provisioningState: 'active' });
    expect((await request(app()).put('/api/projects/mira/orbit/agent/voice').send({ voice: 'cedar' })).status).toBe(kind === 'owner' ? 403 : 409);
    expect(h.docs.get(PROJECT_PATH)?.agent ?? {}).not.toHaveProperty('voice');
  });
});
