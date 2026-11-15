export type AgentRunOrigin = "human" | "followup" | "retry" | "scheduled" | "subagent";

export type AgentActivityKind =
  | "commentary"
  | "tool"
  | "plan"
  | "patch"
  | "checkpoint"
  | "compaction"
  | "fallback"
  | "approval"
  | "error";

export interface AgentActivityIngressRef {
  conversationId: string;
  turnId: string;
  runId: string;
  parentRunId?: string;
  retryOfRunId?: string;
  agentId: string;
  sessionKey: string;
  requesterSessionKey?: string;
  origin: AgentRunOrigin;
  mainChannelId: string;
  mainRootPostId: string;
  inputPostId?: string;
  itemId: string;
  ordinal: number;
  semanticVersion: number;
}

export interface AgentActivityAttachment {
  filename: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  multipartField: "detail";
}

export type AgentAnswerTerminalOutcome = "completed" | "failed" | "stopped";
export type AgentAnswerDeliveryOutcome =
  | "delivered"
  | "partial"
  | "failed"
  | "suppressed"
  | "not-attempted";
export type AgentAnswerPartKind =
  | "text"
  | "media"
  | "voice"
  | "poll"
  | "card"
  | "preview"
  | "unknown";

export interface AgentAnswerPart {
  postId: string;
  kind: AgentAnswerPartKind;
  index: number;
  rootPostId?: string;
  threadId?: string;
}

export interface AgentAnswerCommit {
  terminalOutcome: AgentAnswerTerminalOutcome;
  deliveryOutcome: AgentAnswerDeliveryOutcome;
  postIds: string[];
  parts: AgentAnswerPart[];
}

interface AgentActivityEnvelopeBase {
  schemaVersion: 1;
  eventKey: string;
  emittedAt: string;
  ref: AgentActivityIngressRef;
  redaction: { policy: "octogee-v1"; appliedAt: "producer" };
}

export type AgentActivityEnvelopeV1 =
  | (AgentActivityEnvelopeBase & { type: "turn.started" })
  | (AgentActivityEnvelopeBase & {
      type: "item.completed";
      item: {
        kind: AgentActivityKind;
        status: "completed" | "failed" | "waiting";
        summary: string;
        detail?: { format: "text" | "markdown" | "json"; text: string };
        attachment?: AgentActivityAttachment;
      };
    })
  | (AgentActivityEnvelopeBase & {
      type: "answer.committed";
      answer: AgentAnswerCommit;
    })
  | (AgentActivityEnvelopeBase & {
      type: "turn.finalized";
      outcome: "completed" | "failed" | "stopped";
    });

export interface AgentActivityAppend {
  envelope: AgentActivityEnvelopeV1;
  attachmentBody?: string;
}

export interface ActivityRunTarget {
  conversationId: string;
  turnId: string;
  runId: string;
  parentRunId?: string;
  retryOfRunId?: string;
  agentId: string;
  sessionKey: string;
  requesterSessionKey?: string;
  origin: AgentRunOrigin;
  mainChannelId: string;
  mainRootPostId: string;
  inputPostId?: string;
}

export interface SourceAgentEvent {
  runId: string;
  seq: number;
  stream: string;
  ts?: number;
  sessionKey?: string;
  agentId?: string;
  data: Record<string, unknown>;
}
