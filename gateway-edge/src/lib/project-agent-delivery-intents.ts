export type DeliveryKind = "handoff" | "kickoff";

export interface ProjectDeliveryTarget {
  workspaceId: string;
  projectSlug: string;
}

export interface DeliveryIntent {
  startedAt: number;
  postAttempted: boolean;
  recoveryBefore?: string;
}

export interface DeliveryIntentPatch {
  startedAt?: number;
  postAttempted?: true;
  recoveryBefore?: string | null;
}

export interface OpenedDeliveryIntent extends DeliveryIntent {
  created: boolean;
  update(patch: DeliveryIntentPatch): Promise<void>;
}

export interface QueuedProjectHandoff {
  message: string;
  identity: { name: string; emoji: string; persona: string };
  generation: number;
}

export class DeliveryIntentReplacedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Project delivery intent changed after it was opened", options);
    this.name = "DeliveryIntentReplacedError";
  }
}

export interface ProjectAgentDeliveryIntents {
  readonly recordsIntents: boolean;
  openIntent(target: ProjectDeliveryTarget, kind: DeliveryKind, initial: { startedAt: number }): Promise<OpenedDeliveryIntent>;
  readIntent(target: ProjectDeliveryTarget, kind: DeliveryKind): Promise<DeliveryIntent | null>;
  readHandoff(target: ProjectDeliveryTarget): Promise<QueuedProjectHandoff | null>;
  writeHandoff(target: ProjectDeliveryTarget, handoff: QueuedProjectHandoff): Promise<void>;
}

function noIntentStore(): never {
  throw new Error("No project agent delivery intent store is installed");
}

export const NO_PROJECT_AGENT_DELIVERY_INTENTS: ProjectAgentDeliveryIntents = {
  recordsIntents: false,
  openIntent: async () => noIntentStore(),
  readIntent: async () => noIntentStore(),
  readHandoff: async () => noIntentStore(),
  writeHandoff: async () => noIntentStore(),
};

let active: ProjectAgentDeliveryIntents = NO_PROJECT_AGENT_DELIVERY_INTENTS;

export function installProjectAgentDeliveryIntents(intents: ProjectAgentDeliveryIntents): void {
  active = intents;
}

export function projectAgentDeliveryIntents(): ProjectAgentDeliveryIntents {
  return active;
}
