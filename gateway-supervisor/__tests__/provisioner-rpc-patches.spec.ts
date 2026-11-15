import { describe, it, expect, vi } from "vitest";
import {
  buildDefaultAgentEntry,
  buildDefaultAgentBindings,
  type ProvisioningContext,
} from "@octogee/core/provisionSteps";

vi.mock("../lib/config.js", async () => {
  const actual: any = await vi.importActual("../lib/config.js");
  return { ...actual, log: vi.fn() };
});

const SLUG = "marie";
const AGENT_ID = `octogee-${SLUG}-coach`;
const ACCOUNT_ID = `${SLUG}-coach`;

function mkCtx(): ProvisioningContext {
  return {
    uid: "uid-marie",
    slug: SLUG,
    contextTemplateKey: "default",
    provisionedProductFields: {},
    ownerName: SLUG,
    customerDir: "/var/empty/customers/marie",
    today: "2026-04-16",
    username: SLUG,
    templateVars: {},
    userData: {},
  };
}

function mkMmUpdate(extra: Record<string, any> = {}): Record<string, any> {
  return {
    "mattermost.userId": "mm-marie",
    "mattermost.channelId": "ch-coach-dm",
    "mattermost.generalChannelId": "ch-general",
    "mattermost.adminChannelId": "ch-admin",
    _coachPersonalToken: "tok-marie",
    ...extra,
  };
}

describe("buildDefaultAgentEntry", () => {
  it("produces an agent entry keyed by octogee-{slug}-coach", () => {
    const entry = buildDefaultAgentEntry(mkCtx()) as Record<string, unknown>;
    expect(entry.id).toBe(AGENT_ID);
    expect(entry.workspace).toBe("/var/empty/customers/marie");
    expect((entry.identity as any).name).toBeTruthy();
    expect((entry.tools as any).fs.workspaceOnly).toBe(true);
  });

  it("is pure — repeated calls on the same ctx produce equal output", () => {
    const a = buildDefaultAgentEntry(mkCtx());
    const b = buildDefaultAgentEntry(mkCtx());
    expect(a).toEqual(b);
  });
});

describe("buildDefaultAgentBindings", () => {
  it("emits bindings only for User-facing Agent and General channels", () => {
    const bindings = buildDefaultAgentBindings({ bindings: [] }, AGENT_ID, SLUG, mkMmUpdate());
    expect(bindings).toHaveLength(2);
    for (const b of bindings) {
      expect(b.agentId).toBe(AGENT_ID);
      expect(b.match.channel).toBe("mattermost");
      expect(b.match.accountId).toBe(ACCOUNT_ID);
      expect(b.match.peer.kind).toBe("group");
    }
  });

  it("preserves bindings for other agents", () => {
    const existing = {
      bindings: [
        { agentId: "octogee-other-coach", match: { channel: "mattermost", accountId: "other-coach", peer: { kind: "group", id: "other-ch" } } },
      ],
    };
    const bindings = buildDefaultAgentBindings(existing, AGENT_ID, SLUG, mkMmUpdate());
    const otherAgentEntries = bindings.filter((b: any) => b.agentId === "octogee-other-coach");
    expect(otherAgentEntries).toHaveLength(1);
    expect(existing.bindings).toHaveLength(1);
  });

  it("REPLACES a pre-existing binding that matches on (agentId, peer.id)", () => {
    const existing = {
      bindings: [
        { agentId: AGENT_ID, match: { channel: "mattermost", peer: { kind: "group", id: "ch-coach-dm" } } },
      ],
    };
    const bindings = buildDefaultAgentBindings(existing, AGENT_ID, SLUG, mkMmUpdate());
    const defaultAgentDmBindings = bindings.filter((b: any) => b.agentId === AGENT_ID && b.match?.peer?.id === "ch-coach-dm");
    expect(defaultAgentDmBindings).toHaveLength(1);
    expect(defaultAgentDmBindings[0].match.accountId).toBe(ACCOUNT_ID);
  });

  it("does not mutate the `current` snapshot", () => {
    const existing = { bindings: [] };
    buildDefaultAgentBindings(existing, AGENT_ID, SLUG, mkMmUpdate());
    expect(existing.bindings).toEqual([]);
  });
});

