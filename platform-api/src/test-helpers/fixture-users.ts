import type { PlatformUserRecord, Revision, Stored } from "@octogee/core/platform-state";

export function fixtureUser(uid: string, fields: Partial<PlatformUserRecord> = {}): Stored<PlatformUserRecord> {
  return {
    uid,
    slug: null,
    mattermostUserId: null,
    admitted: false,
    persona: null,
    workspaceId: null,
    role: null,
    createdAt: null,
    updatedAt: 0,
    provisioning: {},
    gateway: null,
    openclaw: {},
    agents: { agentIds: [], activatedAgents: [] },
    accountLifecycle: null,
    activationLease: null,
    fences: {},
    home: {},
    ...fields,
    revision: "fixture" as Revision,
  };
}
