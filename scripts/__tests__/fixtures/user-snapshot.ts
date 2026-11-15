import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";

export function userSnapshot(over: Partial<FleetBrokerUserSnapshot> = {}): FleetBrokerUserSnapshot {
  return {
    uid: "u1",
    slug: "alice",
    contextTemplateKey: "default",
    planInputs: {},
    gatewayId: "default",
    status: "complete",
    agentIds: ["octogee-alice-coach"],
    repoUrl: "https://gitea/alice",
    mattermostUserId: "mm-alice",
    customerMmUserId: "mm-alice",
    channels: [
      { scope: "workspace", kind: "general", channelId: "wsgen" },
      { scope: "project", kind: "general", channelId: "projgen", projectId: "camp" },
    ],
    projects: [],
    projectCheckoutScope: "workspace-and-projects",
    ownerName: "Alice",
    email: "alice@example.com",
    displayName: "Alice",
    lastName: "A",
    photoURL: "",
    persona: null,
    coachToken: "default-agent-pat",
    defaultAgentMmUserId: "mm-coach",
    coachIdentity: { name: "Octo", emoji: "🐙" },
    ...over,
  };
}
