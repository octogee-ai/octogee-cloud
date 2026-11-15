import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { JOURNAL_FORWARDED_UNITS, ensureJournalForward, planJournalForward } from "../../lib/vm-gateway-agent/journal-forward.js";
import { runningSpec, specVersion } from "../../lib/vm-gateway-agent/plan.js";
import type { DockerEngine } from "../../lib/vm-gateway-agent/docker-engine.js";

const UNIT_DIR = join(__dirname, "../../../desktop/image/rootfs/etc/systemd/system");

interface FakeContainer { config: Record<string, unknown>; running: boolean }

function fakeEngine(): { engine: DockerEngine; containers: Map<string, FakeContainer>; calls: string[] } {
  const containers = new Map<string, FakeContainer>();
  const calls: string[] = [];
  const nameOf = (path: string) => decodeURIComponent(path.split("/")[2].split("?")[0]);
  const engine: DockerEngine = {
    async request(method, path, body) {
      if (method === "GET") {
        const found = containers.get(nameOf(path));
        return found
          ? { status: 200, body: { Id: "x", State: { Running: found.running }, Config: { Labels: found.config.Labels } } as never }
          : { status: 404, body: {} as never };
      }
      calls.push(`${method} ${path.split("?")[0]}`);
      if (method === "DELETE") { containers.delete(nameOf(path)); return { status: 204, body: "" as never }; }
      if (path.startsWith("/containers/create")) {
        containers.set(new URL(`http://x${path}`).searchParams.get("name")!, { config: body as Record<string, unknown>, running: false });
        return { status: 201, body: { Id: "x" } as never };
      }
      containers.get(nameOf(path))!.running = true;
      return { status: 204, body: "" as never };
    },
  };
  return { engine, containers, calls };
}

const spec = planJournalForward("gw-1", "sha256:agent");
const hostConfig = spec.config.HostConfig as Record<string, unknown>;
const command = spec.config.Entrypoint as string[];

describe("the host journal forwarder", () => {
  it("covers every octo service the VM image installs", () => {
    const installed = readdirSync(UNIT_DIR).filter(name => name.startsWith("octo-") && name.endsWith(".service"));
    expect([...JOURNAL_FORWARDED_UNITS].sort()).toEqual(installed.sort());
  });

  it("reads this boot's whole journal from the host through the Cloud Logging driver", () => {
    expect(command.slice(0, 6)).toEqual(["/usr/bin/nsenter", "--target", "1", "--mount", "--", "/usr/bin/journalctl"]);
    expect(command).toEqual(expect.arrayContaining(["--follow", "--boot", "--lines=all"]));
    expect(spec.config.Image).toBe("sha256:agent");
    expect(spec.config.NetworkDisabled).toBe(true);
    expect(hostConfig).toMatchObject({ PidMode: "host", Privileged: true, LogConfig: { Type: "gcplogs" } });
  });

  it("labels entries with the gateway so they can be found without a runtime bundle", () => {
    expect((spec.config.Labels as Record<string, string>)["ai.octogee.gateway-id"]).toBe("gw-1");
    expect((hostConfig.LogConfig as { Config: { labels: string } }).Config.labels.split(",")).toContain("ai.octogee.gateway-id");
  });

  it("keeps service output, service lifecycle, and kernel warnings in separate alternatives", () => {
    const matches = command.slice(command.indexOf("--no-pager") + 1);
    expect(matches.filter(arg => arg === "+")).toHaveLength(2);
    expect(matches).toContain("_SYSTEMD_UNIT=octo-gateway-agent.service");
    expect(matches).toContain("UNIT=octo-gateway-agent.service");
    expect(matches.slice(matches.lastIndexOf("+") + 1)).toEqual(["_TRANSPORT=kernel", "PRIORITY=0", "PRIORITY=1", "PRIORITY=2", "PRIORITY=3", "PRIORITY=4"]);
  });

  it("forwards a once-a-minute unit's output but not its start and finish lines", () => {
    expect(command).toContain("_SYSTEMD_UNIT=octo-metadata-ssh-keys.service");
    expect(command).not.toContain("UNIT=octo-metadata-ssh-keys.service");
  });

  it("starts the forwarder when none exists", async () => {
    const docker = fakeEngine();
    const log: string[] = [];
    await ensureJournalForward(docker.engine, spec, m => log.push(m));
    expect(docker.containers.get(spec.name)?.running).toBe(true);
    expect(runningSpec({ Id: "x", Config: { Labels: docker.containers.get(spec.name)!.config.Labels as Record<string, string> } })).toBe(specVersion(spec));
    expect(log.join("\n")).toContain(spec.name);
  });

  it("leaves a running forwarder alone so it does not replay the journal", async () => {
    const docker = fakeEngine();
    await ensureJournalForward(docker.engine, spec, () => {});
    docker.calls.length = 0;
    await ensureJournalForward(docker.engine, spec, () => {});
    expect(docker.calls).toEqual([]);
  });

  it("replaces a forwarder that stopped", async () => {
    const docker = fakeEngine();
    await ensureJournalForward(docker.engine, spec, () => {});
    docker.containers.get(spec.name)!.running = false;
    await ensureJournalForward(docker.engine, spec, () => {});
    expect(docker.containers.get(spec.name)?.running).toBe(true);
  });

  it("replaces a forwarder running from an older agent image", async () => {
    const docker = fakeEngine();
    await ensureJournalForward(docker.engine, planJournalForward("gw-1", "sha256:older"), () => {});
    await ensureJournalForward(docker.engine, spec, () => {});
    expect(docker.containers.get(spec.name)?.config.Image).toBe("sha256:agent");
  });
});
