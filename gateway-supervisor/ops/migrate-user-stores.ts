#!/usr/bin/env tsx
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createSurgeOpenClawProcessSupervisorClient } from "../lib/surge-openclaw-process-gate.js";
import { openclawStateRoot } from "../lib/openclaw-state-store.js";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

export async function migrateUserStores(args = process.argv.slice(2), env = process.env): Promise<void> {
  const { values } = parseArgs({ args, options: { "expected-pod-uid": { type: "string" }, apply: { type: "boolean", default: false }, resume: { type: "boolean", default: false } } });
  if (!values.apply || !values["expected-pod-uid"] || !isIsolatedGatewayClassValue(env.GATEWAY_CLASS)) {
    throw new Error("Run on the retained source user: migrate-user-stores.ts --expected-pod-uid=<source UID> --apply");
  }
  const client = createSurgeOpenClawProcessSupervisorClient(openclawStateRoot(env));
  const held = await client.migrateUserStores(values["expected-pod-uid"]);
  const state = values.resume ? await client.permitNormal() : held;
  console.log(JSON.stringify({ gatewayId: env.GATEWAY_ID, podUid: state.podUid, mode: state.mode, phase: state.phase,
    next: values.resume ? "Migration complete; user resumed." : "Migration complete. user remains held; rerun with --resume to start it." }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateUserStores().catch((error: unknown) => {
    console.error(`User store migration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
