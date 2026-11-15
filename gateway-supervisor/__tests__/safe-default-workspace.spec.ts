import { afterEach, expect, it, vi } from "vitest";
import { configuredUserPortableStatePlanFromConfig } from "@octogee/core/local-default-agent-wired";
import { buildSafeDefaultAgent, SAFE_DEFAULT_AGENT_ID } from "../lib/openclaw-config-users.js";

afterEach(() => vi.unstubAllEnvs());

it.each(["/home/node/.openclaw", "/tmp/user-state"])(
  "keeps the generated safe agent portable in a native roster rooted at %s without legacy default flags",
  (stateDir) => {
    vi.stubEnv("OPENCLAW_DIR", stateDir);
    const agent = buildSafeDefaultAgent();
    const plan = configuredUserPortableStatePlanFromConfig({
      agents: {
        defaults: { workspace: `${stateDir}/workspace` },
        entries: {
          main: { workspace: `${stateDir}/workspace` },
          [SAFE_DEFAULT_AGENT_ID]: agent,
        },
      },
    }, stateDir);
    expect(plan.paths).toContainEqual({
      relativePath: `workspace-${SAFE_DEFAULT_AGENT_ID}`,
      kind: "directory",
    });
  },
);
