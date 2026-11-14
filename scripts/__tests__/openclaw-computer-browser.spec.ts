import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOpenClawComputerBrowserConfig } from "../lib/openclaw-computer-browser.js";
import { buildSafeDefaultAgent, gatewayAgentRoster, SAFE_DEFAULT_AGENT_ID } from "../lib/openclaw-config-users.js";
import { applyPreBootPatches } from "../entrypoints/pre-boot-config.js";
import { withUserClaim } from "./helpers/user-claim.js";

const vmEnv = withUserClaim({ GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: "gce-vm" }, "owner");
const template = (): Record<string, any> => JSON.parse(readFileSync(
  new URL("../../infra/gateway/openclaw.isolated.template.json", import.meta.url), "utf8",
));

describe("computer browser runtime", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("builds the neutral anchor with the desktop denial the computer pass gives it", () => {
    const { id: _id, ...anchor } = buildSafeDefaultAgent(vmEnv);
    const config = template();
    config.agents.entries = { [SAFE_DEFAULT_AGENT_ID]: structuredClone(anchor) };
    applyOpenClawComputerBrowserConfig(config, vmEnv);
    expect(config.agents.entries[SAFE_DEFAULT_AGENT_ID]).toEqual(anchor);
    expect(anchor.tools).toMatchObject({ deny: expect.arrayContaining(["browser", "computer", "nodes"]) });
  });

  it("enables Hobby's GKE X11 desktop with the same owner-only browser policy", () => {
    const config = template();
    config.agents.entries = { "octogee-owner-coach": {}, "octogee-owner-proj-site-coach": {} };
    config.skills = { load: { extraDirs: ["/opt/octogee/skills/computer", "/home/node/custom-skills"] } };
    expect(applyOpenClawComputerBrowserConfig(config, { ...vmEnv, GATEWAY_RUNTIME_KIND: "cluster", GATEWAY_COMPUTER_DESKTOP: "x11" })).toBe(true);
    expect(config.browser.profiles.computer.attachOnly).toBe(true);
    expect(config.desktop.host.passwordFile).toBe("/run/user/1000/octogee-openclaw-vnc/password");
    expect(config.skills.load.extraDirs).toEqual(["/home/node/custom-skills", "/opt/octogee/skills/computer-x11"]);
    expect(config.tools.profile).toBe("full");
    expect(config.agents.entries["octogee-owner-proj-site-coach"].tools.deny).toContain("computer");
  });

  it("enables the built-in browser on the same attach-only desktop CDP profile", () => {
    const config = template();
    config.agents.list = [{ id: "octogee-owner-coach" }, { id: "octogee-owner-proj-site-coach" }];
    expect(applyOpenClawComputerBrowserConfig(config, vmEnv)).toBe(true);
    expect(config.browser).toMatchObject({
      enabled: true, defaultProfile: "computer", headless: false, attachOnly: true,
      cdpUrl: "http://127.0.0.1:9222",
      profiles: { computer: { driver: "openclaw", cdpUrl: "http://127.0.0.1:9222", attachOnly: true } },
    });
    expect(config.plugins.entries.browser.enabled).toBe(true);
    expect(config.plugins.allow).toContain("browser");
    expect(config.gateway.nodes.browser).toEqual({ mode: "off" });
    expect(config.gateway.nodes.commands.allow).toContain("file.write");
    expect(config.tools.profile).toBe("full");
    expect(config.skills.load.extraDirs).toEqual(["/opt/octogee/skills/computer"]);
    expect(config.gateway.nodes.commands.deny).toBeUndefined();
    expect(config.agents.list[0]).not.toHaveProperty("tools");
    expect(config.agents.list[1].tools.deny).toEqual(expect.arrayContaining(["browser", "computer"]));
    expect(applyOpenClawComputerBrowserConfig(config, vmEnv)).toBe(false);
  });

  it("uses the full owner profile instead of an incremental tool allowlist, preserving explicit exec restrictions", () => {
    const config = {
      tools: { profile: "coding", alsoAllow: ["workspace_commit"] },
      agents: {
        entries: {
          "octogee-owner-coach": { tools: { profile: "coding", allow: ["read"], deny: ["exec", "browser"] } },
          "octogee-owner-proj-site-coach": { tools: { profile: "minimal", alsoAllow: ["read"] } },
        },
      },
    };
    applyOpenClawComputerBrowserConfig(config, vmEnv);
    expect(config.agents.entries["octogee-owner-coach"].tools).toEqual({
      profile: "full",
      deny: ["exec"],
    });
    expect(config.agents.entries["octogee-owner-proj-site-coach"].tools).toEqual({
      profile: "minimal",
      alsoAllow: ["read"],
      deny: ["browser", "computer", "nodes", "file-transfer", "ollama"],
    });
    expect(applyOpenClawComputerBrowserConfig(config, vmEnv)).toBe(false);
  });

  it("keeps explicit optional tools when switching to the full profile", () => {
    const config = {
      tools: { profile: "coding", alsoAllow: ["workspace_commit", "computer"] },
      agents: { entries: { "octogee-owner-coach": {} } },
    };
    applyOpenClawComputerBrowserConfig(config, vmEnv);
    expect(config.tools.profile).toBe("full");
    expect(config.tools.alsoAllow).toEqual(["workspace_commit", "computer"]);
    expect(applyOpenClawComputerBrowserConfig(config, vmEnv)).toBe(false);
  });

  it("restricts later provisioned project agents before they enter the live roster", () => {
    for (const [key, value] of Object.entries(vmEnv)) vi.stubEnv(key, value);
    const agents = [
      { id: "octogee-owner-coach" },
      { id: "octogee-owner-proj-site-coach" },
      { id: "another-agent", tools: { profile: "full" } },
    ];
    const before = structuredClone(agents);
    expect(gatewayAgentRoster(agents)).toEqual([
      { id: "octogee-owner-coach" },
      { id: "octogee-owner-proj-site-coach", tools: { deny: ["browser", "computer", "nodes", "file-transfer", "ollama"] } },
      { id: "another-agent", tools: { profile: "full", deny: ["browser", "computer", "nodes", "file-transfer", "ollama"] } },
    ]);
    expect(agents).toEqual(before);
  });

  it("applies the visible browser profile on the real pre-boot path", () => {
    const config = template();
    applyPreBootPatches(config, vmEnv);
    expect(config.browser.defaultProfile).toBe("computer");
    expect(config.plugins.entries.browser.enabled).toBe(true);
    expect(config.tools.profile).toBe("full");
  });

  it("opens the user node surface at pre-boot without granting exec or file approvals", () => {
    const config = template();
    config.gateway.nodes = { commands: { allow: ["desktop.stream"], deny: [
      "system.run", "system.run.prepare", "system.which", "system.execApprovals.get",
      "system.execApprovals.set", "terminal.upload", "fs.listDir", "browser.proxy",
      "browser.proxy.upload.v1", "mcp.tools.call.v1",
    ] } };
    config.tools.exec = { mode: "allowlist", ask: "always" };
    applyPreBootPatches(config, vmEnv);
    expect(config.gateway.nodes.commands).toEqual({ allow: [
      "desktop.stream", "file.stat", "file.fetch", "dir.list", "dir.fetch",
      "file.create", "file.write", "workspace.memory", "workspace.skills",
    ] });
    expect(config.plugins.allow).toEqual(expect.arrayContaining(["browser", "cua-computer", "file-transfer", "ollama"]));
    expect(config.plugins.entries["file-transfer"]).toMatchObject({
      enabled: true, config: { nodes: { "octogee-desktop": { ask: "on-miss" } } },
    });
    expect(config.plugins.entries.ollama.enabled).toBe(true);
    expect(config.plugins.entries.ollama.config.discovery.enabled).toBe(false);
    expect(config.plugins.entries["cua-computer"]?.enabled).toBeUndefined();
    expect(config.tools.exec).toEqual({ mode: "allowlist", ask: "always" });
    expect(config.tools.toolSearch).toBeUndefined();
    expect(applyOpenClawComputerBrowserConfig(config, vmEnv)).toBe(false);
  });

  it("attaches the native gateway desktop to Omarchy during pre-boot so local sessions select it automatically", () => {
    const config = template();
    config.desktop = { host: { enabled: false, managed: true, port: 5999 } };
    applyPreBootPatches(config, vmEnv);
    expect(config.desktop.host).toEqual({
      enabled: true,
      managed: false,
      port: 5901,
      passwordFile: "/run/octogee-desktop-vnc/password",
    });
    expect(applyOpenClawComputerBrowserConfig(config, vmEnv)).toBe(false);
  });

  it("denies the desktop tools for every agent when the VM has no assigned owner", () => {
    const config = { agents: { entries: { "octogee-owner-coach": {} } } };
    applyOpenClawComputerBrowserConfig(config, { ...vmEnv, OPENCLAW_DIR: `${vmEnv.OPENCLAW_DIR}-unclaimed` });
    expect(config.agents.entries["octogee-owner-coach"]).toEqual({ tools: { deny: ["browser", "computer", "nodes", "file-transfer", "ollama"] } });
  });

  it.each([
    { GATEWAY_CLASS: "isolated" },
    { GATEWAY_CLASS: "shared", GATEWAY_RUNTIME_KIND: "gce-vm" },
    { GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: "k8s" },
  ])("leaves browser and tool permissions unchanged outside a gateway VM: %j", (env) => {
    const config = template();
    const before = structuredClone(config);
    expect(applyOpenClawComputerBrowserConfig(config, env)).toBe(false);
    expect(config).toEqual(before);
  });

  it("keeps custom browser profiles and explicit agent tool restrictions", () => {
    const config = template();
    config.browser.profiles = { custom: { cdpUrl: "http://127.0.0.1:9444", attachOnly: true } };
    config.tools.deny = ["browser"];
    config.agents.list = [{ id: "octogee-owner-proj-site-coach", tools: { deny: ["computer", "browser"] } }];
    config.skills = { load: { extraDirs: ["/home/node/user-skills"] } };
    const nativePolicy = { ask: "always", denyPaths: ["/private/**"] };
    config.plugins.entries["file-transfer"] = { config: { nodes: { "octogee-desktop": nativePolicy } } };
    config.plugins.entries.ollama = { config: { discovery: { enabled: true } } };
    applyOpenClawComputerBrowserConfig(config, vmEnv);
    expect(config.skills.load.extraDirs).toEqual(["/home/node/user-skills", "/opt/octogee/skills/computer"]);
    expect(config.browser.profiles.custom).toEqual({ cdpUrl: "http://127.0.0.1:9444", attachOnly: true });
    expect(config.tools.deny).toEqual(["browser"]);
    expect(config.plugins.entries["file-transfer"].config.nodes["octogee-desktop"]).toEqual(nativePolicy);
    expect(config.plugins.entries.ollama.config.discovery.enabled).toBe(true);
    expect(config.agents.list[0].tools.deny).toEqual(["computer", "browser", "nodes", "file-transfer", "ollama"]);
  });

  it("rejects malformed owned config rather than silently replacing it", () => {
    expect(() => applyOpenClawComputerBrowserConfig({ browser: [] }, vmEnv)).toThrow("browser");
    expect(() => applyOpenClawComputerBrowserConfig({ plugins: { allow: "browser" } }, vmEnv)).toThrow("allow");
  });
});
