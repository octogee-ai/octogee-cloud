import { describe, expect, it } from "vitest";
import type { Agent } from "./agent.js";
import type { Channel } from "./channel.js";
import {
  CONNECTOR_CATALOG,
  MICROSOFT_SCOPES,
  type ConnectorId,
  type IntegrationStatusDoc,
} from "./connectors.js";
import { IMAGE_TAG_PATTERN } from "./image-tag.js";
import type { Member } from "./member.js";
import { OPENCLAW_PROTOCOL_VERSION } from "./openclaw-wire.js";
import type { Workspace } from "./workspace.js";

describe("connector catalog", () => {
  it("keeps connector ids unique and typed for consumers", () => {
    const ids: ConnectorId[] = CONNECTOR_CATALOG.map((connector) => connector.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("github");
    expect(ids).toContain("gemini");
    expect(ids).toContain("openai-compatible");
  });

  it("pins Microsoft offline access for refreshable OAuth captures", () => {
    expect(MICROSOFT_SCOPES).toContain("offline_access");
  });

  it("requires field-capture connectors to declare capture fields", () => {
    for (const connector of CONNECTOR_CATALOG) {
      if (connector.captureMethods.includes("fields")) {
        expect(connector.captureFields?.length, connector.id).toBeGreaterThan(0);
      }
    }
  });
});

describe("shared document shapes", () => {
  it("type-checks core Firestore documents used across packages", () => {
    const workspace = {
      id: "workspace-1",
      ownerUid: "uid-owner",
      slug: "alive-fired",
      name: "Alive Fired",
      ownerDisplayName: "Chris",
      visibility: "public",
      vibe: "garage",
      mattermost: { teamId: "team-1" },
      gitea: { orgName: "alive-fired", repoName: "workspace" },
      createdAt: "server-time",
      updatedAt: "server-time",
    } satisfies Workspace;
    const channel = {
      id: "general",
      kind: "general",
      name: "General",
      mattermost: { channelId: "channel-1" },
      createdAt: "server-time",
    } satisfies Channel;
    const member = {
      id: "uid-member",
      role: "member",
      joinedAt: "server-time",
    } satisfies Member;
    const agent = {
      id: "agent-1",
      name: "Scout",
      persona: "user agent",
      mattermost: { userId: "mm-agent-1" },
      createdAt: "server-time",
      updatedAt: "server-time",
    } satisfies Agent;
    const integration = {
      provider: "github",
      status: "connected",
      captureMethod: "oauth-web",
      scopes: ["repo"],
      connectedAt: 1,
      updatedAt: 1,
      verifiedAt: null,
    } satisfies IntegrationStatusDoc;

    expect(workspace.visibility).toBe("public");
    expect(channel.mattermost.channelId).toBe("channel-1");
    expect(member.role).toBe("member");
    expect(agent.mattermost.userId).toBe("mm-agent-1");
    expect(integration.status).toBe("connected");
  });
});

describe("shared runtime constants", () => {
  it("accepts generated image tags and rejects unsafe tags", () => {
    expect(IMAGE_TAG_PATTERN.test("60535e46")).toBe(true);
    expect(IMAGE_TAG_PATTERN.test("60535e46-ocgw1.2")).toBe(true);
    expect(IMAGE_TAG_PATTERN.test(`60535e46-ocgw1.2@sha256:${"a".repeat(64)}`)).toBe(true);
    expect(IMAGE_TAG_PATTERN.test(`preview-8c356bb1@sha256:${"a".repeat(64)}`)).toBe(false);
    expect(IMAGE_TAG_PATTERN.test("latest")).toBe(false);
    expect(IMAGE_TAG_PATTERN.test("60535e46_OC")).toBe(false);
  });

  it("pins the OpenClaw wire protocol version", () => {
    expect(OPENCLAW_PROTOCOL_VERSION).toBe(4);
  });
});
