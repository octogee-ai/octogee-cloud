import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Source-text pins: the roll-roster UPGRADE gate must run at every WS attach site.
// A future upgrade path added to the shared handler is covered by construction
// (the gate runs before any dispatch); these pins keep the wiring itself from
// regressing.

const repoRoot = path.resolve(__dirname, "../../..");
const proxySource = readFileSync(
  path.join(repoRoot, "gateway-edge/src/chat-proxy/proxy.ts"),
  "utf8",
);
const indexSource = readFileSync(
  path.join(repoRoot, "gateway-edge/src/index.ts"),
  "utf8",
);

describe("roll-roster upgrade gate wiring (Codex P0)", () => {
  it("the shared upgrade handler gates BEFORE any dispatch", () => {
    const handlerStart = proxySource.indexOf('server.on("upgrade"');
    const gateCall = proxySource.indexOf("guardUpgradeRequest(", handlerStart);
    const firstDispatch = proxySource.indexOf("handleOpenClawWsUpgrade(", handlerStart);
    expect(handlerStart).toBeGreaterThan(-1);
    expect(gateCall).toBeGreaterThan(handlerStart);
    expect(gateCall).toBeLessThan(firstDispatch);
  });

  it("the OpenClaw WS attach re-checks the conversation owner, or the redeemed uid for owner control", () => {
    expect(proxySource).toContain("checkUid(activityScope?.ownerUid ?? uid)");
  });

  it("the MM WS bridge gates at the auth-late seam: rosterVerdict threaded from the SAME shared gate (checkUid), resolving mmUser→uid through the BROKER not direct Firestore", () => {
    // Verdict wired into the bridge deps at the attach call…
    const attach = proxySource.indexOf("attachMmWsBridge(");
    const verdictWire = proxySource.indexOf("rosterVerdict: buildMmRosterVerdict(upgradeGate,");
    expect(attach).toBeGreaterThan(-1);
    expect(verdictWire).toBeGreaterThan(attach);
    // …resolving mmUser→uid through the tenant-bound runtime broker, like every
    // other resolution on this creds-less pod. The direct-Firestore uid query
    // (uidForMmUserId) that hung admission forever on the gateway pod is gone.
    expect(proxySource).toContain("resolveOctogeeUidByMmUser(mmUserId)");
    expect(proxySource).not.toContain("uidForMmUserId");
    expect(proxySource).not.toMatch(/\.where\("mattermost\.userId"/u);
    // …and the verdict is the shared gate policy (mmRosterVerdictFor routes an
    // unresolved lookup to checkUnmappedIdentity, a resolved one to checkUid).
    const helper = proxySource.slice(
      proxySource.indexOf("export function buildMmRosterVerdict"),
      proxySource.indexOf("export function attachChatProxyWsUpgrade"),
    );
    expect(helper).toContain("mmRosterVerdictFor(gate");
  });

  it("the MM bridge defers the upstream dial behind a deadline-bounded verdict (no dial at attach, no silent hang)", () => {
    const wsSource = readFileSync(
      path.join(repoRoot, "gateway-edge/src/chat-proxy/mm-proxy/ws.ts"),
      "utf8",
    );
    // The only openUpstream call lives inside dialUpstream, invoked from
    // runAdmission AFTER the resolved verdict.
    expect(wsSource.match(/deps\.openUpstream\(/g)).toHaveLength(1);
    // The verdict resolution reads the shared roster verdict…
    expect(wsSource).toContain("deps.rosterVerdict(mmUserId)");
    const admission = wsSource.slice(
      wsSource.indexOf("const runAdmission"),
      wsSource.indexOf('browserWs.on("message"'),
    );
    // …raced against a deadline that fails CLOSED, dialing only after a settled,
    // allowed verdict.
    expect(admission).toContain("resolveVerdict()");
    expect(admission).toContain("admission_deadline_exceeded");
    expect(admission).toContain("dialUpstream()");
    expect(admission.indexOf("resolveVerdict()")).toBeLessThan(
      admission.indexOf("dialUpstream()"),
    );
  });

  it("index boot installs one shared upgrade gate over the roster store", () => {
    expect(indexSource).toContain("createRollRosterUpgradeGate(");
    expect(indexSource).toMatch(/attachChatProxyWsUpgrade\(server, \{ upgradeGate/);
  });

  it("loads the revision roster through the tenant-bound broker, never directly from Firestore", () => {
    expect(indexSource).toContain("createBrokerRollRosterSubscription(");
    expect(indexSource).not.toMatch(/collection\("gateways"\)[\s\S]*collection\("assignments"\)/u);
  });
});
