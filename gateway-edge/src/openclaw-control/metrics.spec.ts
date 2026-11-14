import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";

import { createOpenClawControlMetrics } from "./metrics.js";

describe("OpenClaw Dashboard metrics", () => {
  it("records bounded surface and policy outcomes without user or secret labels", async () => {
    const registry = new Registry();
    const metrics = createOpenClawControlMetrics(registry);
    const identity = {
      gatewayId: "walter",
      revisionId: "walter-r7",
      gatewayClass: "isolated",
    };
    metrics.http(identity, "asset", "ok", 0.01);
    metrics.ws(identity, "open", "ok");
    metrics.session(identity, "authorize", "denied");
    metrics.rpc(identity, "tools_invoke", "denied");
    metrics.policy(identity, "tool_denied");
    const output = await registry.metrics();
    expect(output).toContain("openclaw_dashboard_http_total");
    expect(output).toContain("openclaw_dashboard_rpc_total");
    expect(output).toContain('gateway_id="walter"');
    expect(output).toContain('revision_id="walter-r7"');
    expect(output).not.toContain("uid-owner");
    expect(output).not.toContain("gateway-token");
  });
});
