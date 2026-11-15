#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const [sourceArg, expected] = process.argv.slice(2);
if (!sourceArg || !/^[a-f0-9]{40}$/u.test(expected ?? "")) throw new Error("Usage: verify-broker-plugin-runtime.mjs <clean-native-source> <full-sha>");
const source = realpathSync(sourceArg);
const git = (...args) => execFileSync("/usr/bin/git", ["-C", source, ...args], { encoding: "utf8" }).trim();
const assertSource = () => { if (git("rev-parse", "HEAD") !== expected || git("status", "--porcelain")) throw new Error("Native source must remain clean at the exact pin"); };
assertSource();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(path.join(os.tmpdir(), "octogee-broker-installed-"));
const run = (args, options = {}) => {
  const result = spawnSync(process.execPath, args, { stdio: "inherit", timeout: 60_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Broker installed qualification failed: ${result.status ?? result.signal}`);
};
try {
  const extensions = path.join(root, "extensions");
  const plugin = path.join(extensions, "octogee-broker-tools");
  cpSync(path.join(repo, "gateway/extensions/platform/octogee-broker-tools"), plugin, { recursive: true, filter: value => !value.split(path.sep).includes("node_modules") });
  run([path.join(repo, "gateway/build-extensions.mjs"), extensions, path.join(repo, "scripts/node_modules/.bin/esbuild")]);
  run([path.join(repo, "gateway/verify-extension-bundles.mjs"), extensions, source]);
  mkdirSync(path.join(root, "node_modules"));
  symlinkSync(source, path.join(root, "node_modules/openclaw"), "dir");
  const agentDir = path.join(root, "agents/a");
  const probe = path.join(root, "probe.mjs");
  writeFileSync(probe, `import assert from "node:assert/strict";
import { resolvePluginProviders } from "openclaw/plugin-sdk/provider-catalog-runtime";
const config = { agents: {list:[{id:"a",agentDir:${JSON.stringify(agentDir)}}]},
  models:{providers:{"octogee-broker":{baseUrl:"https://broker.example",models:[]},"platform-openai":{baseUrl:"https://broker.example",api:"openai-responses",apiKey:"synthetic-model-token",models:[]}}},
  plugins:{allow:["anthropic","octogee-broker-tools"],load:{paths:[${JSON.stringify(plugin)}]},entries:{anthropic:{enabled:true},"octogee-broker-tools":{enabled:true}}}};
let calls=0;
globalThis.fetch=async (url, init)=>{
  calls++; assert.equal(new URL(url).pathname,"/v1/catalog"); assert.equal(new Headers(init.headers).get("authorization"),"Bearer synthetic-model-token");
  return Response.json({schemaVersion:1,agentId:"a",provider:"openai",purpose:"model",providerCredentialConfigured:true,admission:"request-time",routes:[{method:"POST",path:"/v1/responses"}],models:[{provider:"openai",id:"test",label:"Test",contextTokens:1000,maxOutputTokens:100,reasoning:false,input:["text"],pricing:{inputPerMTok:2,outputPerMTok:8,cacheReadPerMTok:.2,cacheWritePerMTok:2.5}}]});
};
const providers=resolvePluginProviders({config,env:process.env,cache:false});
assert.equal(providers.filter(p=>p.id==="anthropic").length,1);
assert.equal(providers.find(p=>p.id==="anthropic").pluginId,"anthropic");
const broker=providers.find(p=>p.id==="octogee-broker"); assert.ok(broker);
assert.equal(broker.normalizeToolSchemas,undefined); assert.equal(broker.createStreamFn,undefined);
assert.deepEqual(await broker.resolveUsageAuth({}),{handled:true}); assert.equal(await broker.fetchUsageSnapshot({}),null); assert.equal(calls,0);
const result=await broker.catalog.run({config,env:{...process.env,PLATFORM_OPENAI_BASE_URL:"https://broker.example"},agentDir:${JSON.stringify(agentDir)}});
assert.equal(calls,1); assert.deepEqual(result.providers["platform-openai"].models[0].cost,{input:2,output:8,cacheRead:.2,cacheWrite:2.5});
assert.equal(result.providers["platform-openai"].api,"openai-responses");
console.log("[broker-runtime] exact installed SDK registration, transport ownership, scoped catalog and private-usage suppression passed");
`);
  run([probe], { env: { ...process.env, HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state"), OPENCLAW_CONFIG_PATH: path.join(root, "state/openclaw.json") } });
  assertSource();
} finally { rmSync(root, { recursive: true, force: true }); }
