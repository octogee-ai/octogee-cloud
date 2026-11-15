import { describe, expect, it } from "vitest";
import { applyConnectorApprovalDelivery } from "../lib/openclaw-connector-approvals.js";

describe("native connector approval delivery", () => {
  it("defaults plugin requests to their canonical source channel without enabling exec forwarding", () => {
    const config = {};
    expect(applyConnectorApprovalDelivery(config)).toBe(true);
    expect(config).toEqual({ approvals: { plugin: { enabled: true, mode: "session" } } });
    expect(applyConnectorApprovalDelivery(config)).toBe(false);
  });
  it("preserves explicit native operator forwarding choices", () => {
    const config = { approvals: { plugin: { enabled: false, mode: "targets", targets: [] }, exec: { enabled: false } } };
    expect(applyConnectorApprovalDelivery(config)).toBe(false);
    expect(config.approvals.plugin).toEqual({ enabled: false, mode: "targets", targets: [] });
    expect(config.approvals.exec).toEqual({ enabled: false });
  });
  it("rejects malformed owned config instead of hiding it", () => {
    expect(() => applyConnectorApprovalDelivery({ approvals: [] })).toThrow("must be an object");
    expect(() => applyConnectorApprovalDelivery({ approvals: { plugin: true } })).toThrow("must be an object");
  });
});
