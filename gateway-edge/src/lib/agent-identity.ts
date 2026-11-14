import type { AgentLook } from "@octogee/shared/types/agent-look";

export interface AgentIdentityPatch {
  name?: string;
  persona?: string;
  emoji?: string;
  avatarPng?: Buffer;
  look?: AgentLook;
}

export interface AgentTextIdentity {
  name: string | null;
  persona: string | null;
  emoji: string | null;
}

export interface AgentIdentityRecords {
  read(uid: string): Promise<AgentTextIdentity>;
  sync(uid: string, patch: AgentIdentityPatch, context?: { slug?: string }): Promise<string[]>;
  replaceText(uid: string, identity: AgentTextIdentity): Promise<void>;
}

const agentIdentityUnconfigured = async (): Promise<never> => {
  throw new Error("agent identity needs a product store");
};

export const NO_AGENT_IDENTITY: AgentIdentityRecords = {
  read: async () => ({ name: null, persona: null, emoji: null }),
  sync: agentIdentityUnconfigured,
  replaceText: agentIdentityUnconfigured,
};

let installed: AgentIdentityRecords = NO_AGENT_IDENTITY;

export function installAgentIdentity(records: AgentIdentityRecords): void {
  installed = records;
}

export function agentIdentity(): AgentIdentityRecords {
  return installed;
}
