import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBrokeredLifecycleAdapter } from "../lib/user-lifecycle-broker-adapter.js";
import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";
import type { GatewayRpcClient } from "../lib/gateway-rpc.js";

const runtime = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "octogee-import-preparation-"));
  const previous = { dir: process.env.OPENCLAW_DIR, agents: process.env.OPENCLAW_AGENTS_DIR, state: process.env.OPENCLAW_STATE_DIR, config: process.env.OPENCLAW_CONFIG_PATH };
  process.env.OPENCLAW_DIR = dir;
  process.env.OPENCLAW_AGENTS_DIR = join(dir, "agents");
  process.env.OPENCLAW_STATE_DIR = dir;
  process.env.OPENCLAW_CONFIG_PATH = join(dir, "openclaw.json");
  return { dir, previous };
});

afterAll(async () => {
  if (runtime.previous.dir === undefined) delete process.env.OPENCLAW_DIR;
  else process.env.OPENCLAW_DIR = runtime.previous.dir;
  if (runtime.previous.agents === undefined) delete process.env.OPENCLAW_AGENTS_DIR;
  else process.env.OPENCLAW_AGENTS_DIR = runtime.previous.agents;
  if (runtime.previous.state === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = runtime.previous.state;
  if (runtime.previous.config === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
  else process.env.OPENCLAW_CONFIG_PATH = runtime.previous.config;
  await fs.rm(runtime.dir, { recursive: true, force: true });
});

const factories = {
  broker: () => buildBrokeredLifecycleAdapter({
    client: {} as FleetBrokerClient, rpc: {} as GatewayRpcClient, log: vi.fn(),
  }),
};

for (const [name, buildAdapter] of Object.entries(factories)) {
  describe(`${name} final Shared import preparation`, () => {
    const slug = "import-fixture";
    const agentDir = path.join(runtime.dir, "agents", `octogee-${slug}-coach`, "agent");

    beforeEach(async () => {
      await fs.rm(runtime.dir, { recursive: true, force: true });
      await fs.mkdir(runtime.dir, { recursive: true });
      await fs.writeFile(path.join(runtime.dir, "openclaw.json"), JSON.stringify({ agents: { list: [] } }));
    });

    it("keeps a fresh target unadmitted while its context is staged privately", async () => {
      const adapter = buildAdapter();
      expect(adapter.hasUserAgentRuntime!(slug)).toBe(false);
      await expect(adapter.prepareImportDir(slug, "final")).resolves.toBe(runtime.dir);
      expect(adapter.hasUserAgentRuntime!(slug)).toBe(false);
      expect(adapter.userDefaultAgentWiredInOpenclawConfig!(slug)).toBe(false);
    });

    it.each([false, true])("recognizes runtime state without treating an empty preparation directory as admission (contains state: %s)", async (containsState) => {
      await fs.mkdir(agentDir, { recursive: true });
      if (containsState) await fs.writeFile(path.join(agentDir, "state.json"), "durable-state");
      const adapter = buildAdapter();
      await adapter.prepareImportDir(slug, "final");
      expect(adapter.hasUserAgentRuntime!(slug)).toBe(containsState);
      if (containsState) expect(await fs.readFile(path.join(agentDir, "state.json"), "utf8")).toBe("durable-state");
    });

    it.each(["symlink", "file"])("keeps an unexpected %s path strict", async (kind) => {
      await fs.mkdir(path.dirname(agentDir), { recursive: true });
      if (kind === "symlink") await fs.symlink(runtime.dir, agentDir);
      else await fs.writeFile(agentDir, "unexpected-state");
      expect(buildAdapter().hasUserAgentRuntime!(slug)).toBe(true);
    });

    it("preserves config admission independently of an agent directory", async () => {
      await fs.writeFile(path.join(runtime.dir, "openclaw.json"), JSON.stringify({
        agents: { list: [{ id: `octogee-${slug}-coach` }] },
        channels: { mattermost: { accounts: { [`${slug}-coach`]: {} } } },
        bindings: [{ agentId: `octogee-${slug}-coach`, match: { channel: "mattermost", accountId: `${slug}-coach` } }],
      }));
      const adapter = buildAdapter();
      await adapter.prepareImportDir(slug, "final");
      expect(adapter.userDefaultAgentWiredInOpenclawConfig!(slug)).toBe(true);
    });
  });
}
