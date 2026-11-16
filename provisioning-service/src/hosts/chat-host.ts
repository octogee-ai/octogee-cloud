export interface ChatUserInput {
  uid: string;
  slug: string;
  email: string;
  displayName: { first: string; last: string };
  avatarUrl: string | null;
  knownUserId?: string;
}

export interface ChatTeamInput {
  slug: string;
  displayName: string;
  userId: string;
  knownTeamId?: string;
}

export interface ChatChannelsInput {
  slug: string;
  ownerFirstName: string;
  teamId: string;
  userId: string;
  agentChannel: boolean;
  known?: { general?: string; agent?: string };
}

export interface ChatChannels {
  general: string;
  agent?: string;
}

export interface ChatAgentInput {
  slug: string;
  ownerFirstName: string;
  teamId: string;
  generalChannelId?: string;
  agentChannelId?: string;
  knownBotUserId?: string;
  existingBotUserId?: string;
}

export interface IssuedToken {
  token: string;
}

export interface ChatHost {
  ensureUser(input: ChatUserInput, signal: AbortSignal): Promise<{ userId: string; warnings?: string[] }>;
  ensureTeam(input: ChatTeamInput, signal: AbortSignal): Promise<{ teamId: string }>;
  ensureChannels(input: ChatChannelsInput, signal: AbortSignal): Promise<ChatChannels>;
  ensureAgentBot(input: ChatAgentInput, signal: AbortSignal): Promise<{ botUserId: string }>;
  issueAgentToken(input: { botUserId: string }, signal: AbortSignal): Promise<IssuedToken>;
  issueUserToken(input: { userId: string }, signal: AbortSignal): Promise<IssuedToken>;
}
