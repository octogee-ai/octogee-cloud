import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { loadOpenClawBundledFunction } from "./openclaw-bundled-runtime.mts";

const packageRoot = process.env.OPENCLAW_PACKAGE_DIR;
const source = packageRoot ?? process.env.OPENCLAW_SOURCE_DIR;
assert.ok(source, "Set OPENCLAW_PACKAGE_DIR for an installed artifact or OPENCLAW_SOURCE_DIR for a local checkout");
assert.equal(process.env.OCTOGEE_ACCEPT_ISOLATED_COMPUTER, "1", "Run only against an isolated acceptance VM");
const phase = process.env.OCTOGEE_ACCEPT_PHASE ?? "seed";
assert.ok(["discover", "seed", "verify"].includes(phase));
const output = process.env.OCTOGEE_ACCEPT_OUTPUT;
assert.ok(output, "OCTOGEE_ACCEPT_OUTPUT must name a dedicated acceptance output directory");
process.env.OPENCLAW_STATE_DIR = `${output}/openclaw-state`;
const require = createRequire(`${source}/package.json`);
const manifest = JSON.parse(await readFile(`${source}/package.json`, "utf8"));
assert.equal(manifest.name, "openclaw");
if (process.env.OCTOGEE_ACCEPT_OPENCLAW_VERSION) assert.equal(manifest.version, process.env.OCTOGEE_ACCEPT_OPENCLAW_VERSION);
const openclawRuntime = { mode: packageRoot ? "installed-artifact" : "source-checkout", version: manifest.version, root: source };
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, specifier.startsWith("openclaw/") ? { ...context, parentURL: pathToFileURL(`${source}/package.json`).href } : context);
} });
const { setRuntimeConfigSnapshot } = await import(pathToFileURL(require.resolve("openclaw/plugin-sdk/runtime-config-snapshot")).href);
const { applyOpenClawComputerBrowserConfig } = await import("../../../scripts/lib/openclaw-computer-browser.ts");
const config = {
  browser: { evaluateEnabled: true, ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } },
  gateway: { mode: "local", port: 19989, nodes: { browser: { mode: "off" } } },
  tools: { profile: "coding" },
  agents: { entries: { "octogee-native-coach": {}, "octogee-native-proj-site-coach": {}, arbitrary: { tools: { profile: "full" } } } },
  plugins: { load: { paths: [`${source}/${packageRoot ? "dist/" : ""}extensions/browser`] } },
};
const { userClaimFromIdentity, writeUserClaim } = await import("../../../shared/server/user-claim.ts");
const claimDir = `${output}/builder-claim`;
await mkdir(claimDir, { recursive: true });
writeUserClaim(claimDir, userClaimFromIdentity({
  gatewayId: "acceptance", state: "claimed", ownerUid: "uid-native", builderSlug: "native", leaseId: null, generation: null,
}, Date.now()));
applyOpenClawComputerBrowserConfig(config, { GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: "gce-vm", OPENCLAW_DIR: claimDir, GATEWAY_ID: "acceptance" });
setRuntimeConfigSnapshot(config);
const resolvedProfile = (config.browser as typeof config.browser & { profiles: { computer: { cdpUrl: string; attachOnly: boolean } } }).profiles.computer;
assert.equal(resolvedProfile.cdpUrl, "http://127.0.0.1:9222");
assert.equal(resolvedProfile.attachOnly, true);
async function runtimeFunction(filePrefix: string, functionName: string, sourcePath: string) {
  if (packageRoot) return (await loadOpenClawBundledFunction(packageRoot, filePrefix, functionName)).fn;
  return (await import(pathToFileURL(`${source}/${sourcePath}`).href))[functionName];
}
const loadOpenClawPlugins = await runtimeFunction("loader-", "loadOpenClawPlugins", "src/plugins/loader-runtime-load.ts");
const resolvePluginTools = await runtimeFunction("tools-", "resolvePluginTools", "src/plugins/tools.ts");
const pickSandboxToolPolicy = await runtimeFunction("sandbox-tool-policy-", "pickSandboxToolPolicy", "src/agents/sandbox-tool-policy.ts");
const filterToolsByPolicy = await runtimeFunction("tool-policy-match-", "filterToolsByPolicy", "src/agents/tool-policy-match.ts");
const registry = loadOpenClawPlugins({ config, onlyPluginIds: ["browser"], cache: false, throwOnLoadError: true });
const plugins = registry.plugins.map((plugin) => ({ id: plugin.id, status: plugin.status }));
assert.deepEqual(plugins, [{ id: "browser", status: "loaded" }]);
const agentTools = Object.entries(config.agents.entries).map(([id, value]) => {
  const agent: { id: string; tools?: { profile: string } } = { id, ...value };
  const discovered = resolvePluginTools({
    context: { config, agentId: agent.id, sessionKey: `agent:${agent.id}:native-cdp-acceptance` },
    toolAllowlist: ["browser"], runtimeRegistry: registry,
  });
  assert.deepEqual(discovered.map((tool) => tool.name), ["browser"]);
  return { agentId: agent.id, tools: filterToolsByPolicy(discovered, pickSandboxToolPolicy(agent.tools)) };
});
const policy = agentTools.map((agent) => ({ agentId: agent.agentId, tools: agent.tools.map((tool) => tool.name) }));
assert.deepEqual(policy, [
  { agentId: "octogee-native-coach", tools: ["browser"] },
  { agentId: "octogee-native-proj-site-coach", tools: [] },
  { agentId: "arbitrary", tools: [] },
]);
const tool = agentTools[0].tools[0];
await mkdir(output, { recursive: true });
await writeFile(`${output}/discovery.json`, JSON.stringify({ openclawRuntime, config, resolvedProfile, plugins, policy }, null, 2));
console.log(JSON.stringify({ openclawRuntime, plugins, policy }));
if (phase === "discover") {
  console.log("PASS actual OpenClaw browser plugin discovery and owner-only tool policy");
  process.exit(0);
}
const results: Array<{ args: Record<string, unknown>; durationMs: number; result: { details: Record<string, unknown>; content: Array<{ type: string; text?: string }> } }> = [];
async function call(args: Record<string, unknown>) {
  const started = performance.now();
  const value = await tool.execute(`acceptance-${results.length}`, { profile: "computer", target: "host", ...args });
  assert.notEqual(value.isError, true, JSON.stringify(value));
  results.push({ args, durationMs: Math.round(performance.now() - started), result: value });
  console.log(JSON.stringify({ action: args.action, durationMs: results.at(-1).durationMs, details: value.details }));
  if (args.action === "snapshot") console.log(JSON.stringify(value.content));
  return value.details;
}
let sawPersistentCookie = false;
const server = createServer((req, res) => {
  sawPersistentCookie ||= (req.headers.cookie ?? "").includes("octogee_native_session=one-visible-browser");
  if (phase === "seed") res.setHeader("set-cookie", "octogee_native_session=one-visible-browser; Max-Age=86400; HttpOnly; SameSite=Lax; Path=/");
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><html><head><title>Octogee visible VM CDP acceptance</title></head><body style="background:#162430;color:white;font:24px sans-serif;padding:80px"><h1>OpenClaw is driving this gateway VM</h1><p>The human and agent share this visible Chromium session.</p><label>Your message <input aria-label="Your message" id="message" style="font:24px sans-serif;width:500px"></label><button id="commit" style="font:24px sans-serif" onclick="document.querySelector('#result').textContent=document.querySelector('#message').value">Show on shared desktop</button><h2 id="result">Waiting for agent action</h2></body></html>`);
});
await new Promise<void>((resolve) => server.listen(18080, "127.0.0.1", resolve));
try {
  await call({ action: "status" });
  const opened = await call({ action: "open", url: "http://127.0.0.1:18080" });
  const targetId = opened.targetId;
  assert.equal(typeof targetId, "string");
  await call({ action: "focus", targetId });
  await call({ action: "snapshot", targetId, snapshotFormat: "ai" });
  const snapshotText = results.at(-1).result.content.map((part) => part.text ?? "").join("\n");
  const inputRef = snapshotText.match(/textbox "Your message" \[ref=(e\d+)\]/)![1];
  const buttonRef = snapshotText.match(/button "Show on shared desktop" \[ref=(e\d+)\]/)![1];
  await call({ action: "act", request: { targetId, kind: "type", ref: inputRef, text: "Eight arms. One visible browser." } });
  await call({ action: "act", request: { targetId, kind: "click", ref: buttonRef } });
  if (phase === "seed") {
    await call({ action: "act", request: { targetId, kind: "evaluate", fn: `() => { localStorage.setItem('octogee-native-persistence', 'same-profile-after-restart'); return true; }` } });
  } else {
    const stored = await call({ action: "act", request: { targetId, kind: "evaluate", fn: `() => localStorage.getItem('octogee-native-persistence')` } });
    assert.equal(stored.result, "same-profile-after-restart");
    assert.equal(sawPersistentCookie, true, "Persistent HttpOnly session cookie must survive restart or replacement");
  }
  const evaluated = await call({ action: "act", request: { targetId, kind: "evaluate", fn: `() => document.querySelector('#result').textContent` } });
  assert.equal(evaluated.result, "Eight arms. One visible browser.");
  await call({ action: "snapshot", targetId, snapshotFormat: "ai" });
  assert.match(JSON.stringify(results.at(-1).result.content), /Eight arms\. One visible browser\./);
  const screenshot = await call({ action: "screenshot", targetId, fullPage: false });
  const human = await fetch("http://127.0.0.1:7777/screenshot");
  assert.equal(human.ok, true);
  await writeFile(`${output}/human-desktop-${phase}.png`, Buffer.from(await human.arrayBuffer()));
  const version = await (await fetch("http://127.0.0.1:9222/json/version")).json();
  const tabs = await call({ action: "tabs" });
  await writeFile(`${output}/results-${phase}.json`, JSON.stringify({ openclawRuntime, plugins, policy, phase, sawPersistentCookie, config, resolvedProfile, version, screenshot, tabs, results }, null, 2));
  console.log(`PASS ${phase}: OpenClaw browser tool drove the visible Chromium session; human screenshot and persistence evidence saved.`);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
process.exit(0);
