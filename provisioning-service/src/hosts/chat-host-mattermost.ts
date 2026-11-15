import { createHash, randomInt } from "node:crypto";

import { agentChannelPurpose } from "@octogee/core/mattermost/agent-channel-purpose";
import { userChannelMembers, type UserChannelKind } from "@octogee/core/mattermost/channel-members";
import { controlUiCommandSpec } from "@octogee/core/mattermost/control-ui-command";
import { DEFAULT_AGENT_PAT_DESCRIPTION } from "@octogee/core/mattermost/default-agent-pat";
import { USER_PAT_DESCRIPTION } from "@octogee/core/mattermost/user-pat";
import { isPlaceholderEmail, placeholderEmail } from "@octogee/core/placeholder-email";
import { WORKSPACE_CHANNEL_DISPLAY_NAMES } from "@octogee/shared/types/display-names";
import {
  workspaceDefaultAgentChannelName,
  workspaceDefaultAgentMmUsername,
  workspaceGeneralChannelName,
} from "@octogee/shared/types/identity";

import type {
  ChatAgentInput,
  ChatChannels,
  ChatChannelsInput,
  ChatHost,
  ChatTeamInput,
  ChatUserInput,
  IssuedToken,
} from "./chat-host.js";
import { HostError, hostErrorKindForStatus } from "./host-error.js";

export interface HostLog {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface MattermostChatHostConfig {
  baseUrl: string;
  adminToken: string;
  adminUserId: string | null;
  controlCommandUrl: string;
  log: HostLog;
  fetch?: typeof fetch;
}

export const DEFAULT_TEAM_CHANNELS_TO_ARCHIVE = ["town-square", "off-topic", "general"] as const;
export const AGENT_BOT_DISPLAY_NAME = "Octo";
const UNDELETABLE_CHANNEL_ERROR = "api.channel.delete_channel.cannot.app_error";
const PASSWORD_CHARACTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
const COMMAND_FIELDS = ["id", "team_id", "trigger", "url", "method", "token"] as const;

interface HostResponse {
  status: number;
  json: unknown;
}

interface MmRecord {
  id: string;
  delete_at?: number;
  team_id?: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is MmRecord {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

function isLive(record: MmRecord): boolean {
  return (record.delete_at ?? 0) === 0;
}

function errorId(json: unknown): string {
  if (typeof json !== "object" || json === null) return "";
  const { id } = json as { id?: unknown };
  return typeof id === "string" ? id : "";
}

function generatePassword(): string {
  let password = "";
  for (let i = 0; i < 24; i += 1) password += PASSWORD_CHARACTERS[randomInt(PASSWORD_CHARACTERS.length)];
  return password;
}

export function gravatarUrl(email: string): string {
  // eslint-disable-next-line sonarjs/hashing -- the avatar service addresses images by md5(email)
  const hash = createHash("md5").update(email.toLowerCase().trim()).digest("hex");
  return `https://gravatar.com/avatar/${hash}?d=identicon&s=200`;
}

function accountEmail(input: ChatUserInput): string {
  return input.email || placeholderEmail(input.uid);
}

function avatarSource(input: ChatUserInput): string | null {
  if (input.avatarUrl) return input.avatarUrl;
  if (input.email && !isPlaceholderEmail(input.email)) return gravatarUrl(input.email);
  return null;
}

class MattermostApi {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: MattermostChatHostConfig) {
    this.fetchImpl = config.fetch ?? fetch;
  }

  async send(operation: string, method: string, path: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.config.baseUrl}/api/v4${path}`, {
        ...init,
        method,
        signal,
        redirect: "error",
        headers: { Authorization: `Bearer ${this.config.adminToken}`, ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (error) {
      throw new HostError("transient", `${operation}: chat host unreachable`, { cause: error });
    }
  }

  async request(operation: string, method: string, path: string, signal: AbortSignal, body?: unknown): Promise<HostResponse> {
    const response = await this.send(operation, method, path, signal, body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, json };
  }

  async expect(operation: string, method: string, path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await this.request(operation, method, path, signal, body);
    if (response.status >= 200 && response.status < 300) return response.json;
    throw failure(operation, response);
  }

  async find(operation: string, path: string, signal: AbortSignal): Promise<MmRecord | null> {
    const response = await this.request(operation, "GET", path, signal);
    if (response.status === 404) return null;
    if (response.status !== 200) throw failure(operation, response);
    if (!isRecord(response.json)) throw new HostError("transient", `${operation}: chat host returned an invalid record`);
    return response.json;
  }
}

function failure(operation: string, { status, json }: HostResponse): HostError {
  const id = errorId(json);
  return new HostError(hostErrorKindForStatus(status), `${operation}: ${status} from chat host${id ? ` (${id})` : ""}`);
}

async function createOrAdopt(
  operation: string,
  create: () => Promise<HostResponse>,
  adopt: () => Promise<MmRecord | null>,
  created: (json: unknown) => MmRecord | null,
): Promise<{ record: MmRecord; created: boolean }> {
  const response = await create();
  if (response.status >= 200 && response.status < 300) {
    const record = created(response.json);
    if (!record) throw new HostError("transient", `${operation}: chat host returned an invalid record`);
    return { record, created: true };
  }
  const existing = await adopt();
  if (existing) return { record: existing, created: false };
  throw failure(operation, response);
}

export function createMattermostChatHost(config: MattermostChatHostConfig): ChatHost {
  const api = new MattermostApi(config);
  const { log } = config;

  async function addMember(operation: string, path: string, body: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    await api.expect(operation, "POST", path, signal, body);
  }

  async function uploadAvatar(userId: string, input: ChatUserInput, signal: AbortSignal): Promise<string[]> {
    const source = avatarSource(input);
    if (!source) return [];
    const fetchImpl = config.fetch ?? fetch;
    let warning: string;
    try {
      const image = await fetchImpl(source, { signal, redirect: "follow" });
      if (image.ok) {
        const contentType = image.headers.get("content-type") || "image/png";
        const extension = contentType.includes("jpeg") || contentType.includes("jpg") ? ".jpg" : ".png";
        const form = new FormData();
        form.append("image", new Blob([await image.arrayBuffer()], { type: contentType }), `avatar${extension}`);
        const uploaded = await api.send("upload avatar", "POST", `/users/${userId}/image`, signal, { body: form });
        if (uploaded.ok) return [];
        warning = `avatar upload: ${uploaded.status} from chat host`;
      } else {
        warning = `avatar fetch: ${image.status} from image source`;
      }
    } catch (error) {
      warning = `avatar upload: ${error instanceof Error ? error.message : String(error)}`;
    }
    log.error("[provisioning] chat avatar upload failed", { uid: input.uid, chatUserId: userId, warning });
    return [warning];
  }

  async function findUserByName(username: string, signal: AbortSignal): Promise<MmRecord | null> {
    return api.find("find chat user", `/users/username/${encodeURIComponent(username)}`, signal);
  }

  async function adoptUserByEmail(input: ChatUserInput, signal: AbortSignal): Promise<MmRecord | null> {
    const user = await api.find("find chat user by email", `/users/email/${encodeURIComponent(accountEmail(input))}`, signal);
    if (!user) return null;
    if (!isLive(user)) {
      await api.expect("reactivate chat user", "PUT", `/users/${user.id}/active`, signal, { active: true });
    }
    await api.expect("rename chat user", "PUT", `/users/${user.id}/patch`, signal, {
      username: input.slug,
      first_name: input.displayName.first,
      last_name: input.displayName.last,
    });
    log.info("[provisioning] chat user adopted by email", { uid: input.uid, chatUserId: user.id });
    return user;
  }

  async function ensureUser(input: ChatUserInput, signal: AbortSignal): Promise<{ userId: string; warnings?: string[] }> {
    if (input.knownUserId) {
      const known = await api.find("find chat user", `/users/${input.knownUserId}`, signal);
      if (known) return { userId: known.id };
    }
    let user = await findUserByName(input.slug, signal);
    if (!user) {
      ({ record: user } = await createOrAdopt(
        "create chat user",
        () => api.request("create chat user", "POST", "/users", signal, {
          email: accountEmail(input),
          username: input.slug,
          password: generatePassword(),
          first_name: input.displayName.first,
          last_name: input.displayName.last,
          nickname: input.displayName.first || input.slug,
          roles: "system_user",
        }),
        async () => (await findUserByName(input.slug, signal)) ?? adoptUserByEmail(input, signal),
        (json) => (isRecord(json) ? json : null),
      ));
    }
    const warnings = await uploadAvatar(user.id, input, signal);
    return warnings.length > 0 ? { userId: user.id, warnings } : { userId: user.id };
  }

  async function findTeam(input: ChatTeamInput, signal: AbortSignal): Promise<MmRecord | null> {
    if (input.knownTeamId) {
      const known = await api.find("find chat team", `/teams/${input.knownTeamId}`, signal);
      if (known) return known;
    }
    return api.find("find chat team", `/teams/name/${encodeURIComponent(input.slug)}`, signal);
  }

  async function archiveDefaultChannel(teamId: string, name: string, signal: AbortSignal): Promise<void> {
    const channel = await api.find("find default channel", `/teams/${teamId}/channels/name/${name}`, signal);
    if (!channel || !isLive(channel)) return;
    const response = await api.request("archive default channel", "DELETE", `/channels/${channel.id}`, signal);
    if (response.status >= 200 && response.status < 300) {
      log.info("[provisioning] default chat channel archived", { teamId, channel: name });
      return;
    }
    if (response.status === 400 && errorId(response.json) === UNDELETABLE_CHANNEL_ERROR) return;
    throw failure("archive default channel", response);
  }

  async function ensureControlCommand(teamId: string, signal: AbortSignal): Promise<void> {
    const spec = controlUiCommandSpec(teamId, config.controlCommandUrl);
    const desired = {
      team_id: spec.teamId,
      trigger: spec.trigger,
      method: "P",
      url: spec.url,
      display_name: spec.displayName,
      description: spec.description,
      auto_complete: true,
      auto_complete_desc: spec.autocompleteDescription,
      auto_complete_hint: "",
    };
    const listed = await api.expect("list chat commands", "GET", `/commands?team_id=${encodeURIComponent(teamId)}&custom_only=true`, signal);
    if (!Array.isArray(listed)) throw new HostError("transient", "list chat commands: chat host returned an invalid list");
    const existing = listed.find((entry: unknown): entry is Record<string, unknown> & { id: string } =>
      typeof entry === "object" && entry !== null &&
      COMMAND_FIELDS.every((field) => typeof (entry as Record<string, unknown>)[field] === "string") &&
      (entry as { trigger: string }).trigger === spec.trigger);
    if (!existing) {
      await api.expect("create chat command", "POST", "/commands", signal, desired);
      return;
    }
    if (existing.url === spec.url && existing.method === "P") return;
    await api.expect("update chat command", "PUT", `/commands/${existing.id}`, signal, { ...existing, ...desired });
  }

  async function ensureTeam(input: ChatTeamInput, signal: AbortSignal): Promise<{ teamId: string }> {
    let team = await findTeam(input, signal);
    if (!team) {
      ({ record: team } = await createOrAdopt(
        "create chat team",
        () => api.request("create chat team", "POST", "/teams", signal, {
          name: input.slug,
          display_name: input.displayName,
          type: "I",
        }),
        () => findTeam({ ...input, knownTeamId: undefined }, signal),
        (json) => (isRecord(json) ? json : null),
      ));
    }
    const teamId = team.id;
    await addMember("add user to chat team", `/teams/${teamId}/members`, {
      team_id: teamId,
      user_id: input.userId,
      roles: "team_admin team_user",
    }, signal);
    for (const name of DEFAULT_TEAM_CHANNELS_TO_ARCHIVE) {
      await archiveDefaultChannel(teamId, name, signal);
    }
    if (config.adminUserId) {
      await addMember("add admin to chat team", `/teams/${teamId}/members`, { team_id: teamId, user_id: config.adminUserId }, signal);
    }
    await ensureControlCommand(teamId, signal);
    return { teamId };
  }

  async function findChannel(teamId: string, name: string, knownId: string | undefined, signal: AbortSignal): Promise<MmRecord | null> {
    if (knownId) {
      const known = await api.find("find chat channel", `/channels/${knownId}`, signal);
      if (known && isLive(known) && known.team_id === teamId) return known;
    }
    const byName = await api.find("find chat channel", `/teams/${teamId}/channels/name/${name}?include_deleted=true`, signal);
    if (!byName) return null;
    if (isLive(byName)) return byName;
    const restored = await api.expect("restore chat channel", "POST", `/channels/${byName.id}/restore`, signal);
    if (!isRecord(restored)) throw new HostError("transient", "restore chat channel: chat host returned an invalid record");
    log.info("[provisioning] archived chat channel restored", { teamId, channel: name });
    return restored;
  }

  async function ensureChannel(
    input: ChatChannelsInput,
    kind: Extract<UserChannelKind, "coach" | "general">,
    signal: AbortSignal,
  ): Promise<string> {
    const ownerLabel = input.ownerFirstName || input.slug;
    const spec = kind === "coach"
      ? {
        name: workspaceDefaultAgentChannelName(input.slug),
        displayName: WORKSPACE_CHANNEL_DISPLAY_NAMES.coach,
        purpose: agentChannelPurpose(ownerLabel),
        knownId: input.known?.agent,
      }
      : {
        name: workspaceGeneralChannelName(input.slug),
        displayName: WORKSPACE_CHANNEL_DISPLAY_NAMES.general,
        purpose: `${ownerLabel}'s workspace — general discussion`,
        knownId: input.known?.general,
      };
    let channel = await findChannel(input.teamId, spec.name, spec.knownId, signal);
    if (!channel) {
      ({ record: channel } = await createOrAdopt(
        "create chat channel",
        () => api.request("create chat channel", "POST", "/channels", signal, {
          team_id: input.teamId,
          name: spec.name,
          display_name: spec.displayName,
          type: "P",
          purpose: spec.purpose,
        }),
        () => findChannel(input.teamId, spec.name, undefined, signal),
        (json) => (isRecord(json) ? json : null),
      ));
    }
    const members = userChannelMembers(kind, {
      customerMmUserId: input.userId,
      defaultAgentMmUserId: null,
      adminMmUserId: config.adminUserId,
    });
    for (const memberId of members) {
      await addMember("add member to chat channel", `/channels/${channel.id}/members`, { user_id: memberId }, signal);
    }
    return channel.id;
  }

  async function ensureChannels(input: ChatChannelsInput, signal: AbortSignal): Promise<ChatChannels> {
    const agent = input.agentChannel ? await ensureChannel(input, "coach", signal) : undefined;
    const general = await ensureChannel(input, "general", signal);
    return agent ? { general, agent } : { general };
  }

  async function findBot(username: string, knownId: string | undefined, signal: AbortSignal): Promise<MmRecord | null> {
    if (knownId) {
      const known = await api.find("find agent bot", `/users/${knownId}`, signal);
      if (known) return known;
    }
    return findUserByName(username, signal);
  }

  async function ensureAgentBot(input: ChatAgentInput, signal: AbortSignal): Promise<{ botUserId: string }> {
    const username = workspaceDefaultAgentMmUsername(input.slug);
    let bot = await findBot(username, input.knownBotUserId, signal);
    if (!bot) {
      ({ record: bot } = await createOrAdopt(
        "create agent bot",
        () => api.request("create agent bot", "POST", "/bots", signal, {
          username,
          display_name: AGENT_BOT_DISPLAY_NAME,
          description: `Coach for ${input.ownerFirstName || input.slug}`,
        }),
        () => findUserByName(username, signal),
        (json) => {
          const userId = (json as { user_id?: unknown } | null)?.user_id;
          return typeof userId === "string" && userId.length > 0 ? { id: userId } : null;
        },
      ));
    }
    const botUserId = bot.id;
    await addMember("add agent bot to chat team", `/teams/${input.teamId}/members`, { team_id: input.teamId, user_id: botUserId }, signal);
    const generalChannelId = input.generalChannelId
      ?? (await api.find("find chat channel", `/teams/${input.teamId}/channels/name/${workspaceGeneralChannelName(input.slug)}`, signal))?.id;
    for (const channelId of [input.agentChannelId, generalChannelId]) {
      if (!channelId) continue;
      await addMember("add agent bot to chat channel", `/channels/${channelId}/members`, { user_id: botUserId }, signal);
    }
    return { botUserId };
  }

  async function issueToken(operation: string, userId: string, description: string, signal: AbortSignal): Promise<IssuedToken> {
    const issued = await api.expect(operation, "POST", `/users/${userId}/tokens`, signal, { description });
    const token = (issued as { token?: unknown } | null)?.token;
    if (typeof token !== "string" || token.length === 0) {
      throw new HostError("transient", `${operation}: chat host returned no token`);
    }
    return { token };
  }

  return {
    ensureUser,
    ensureTeam,
    ensureChannels,
    ensureAgentBot,
    issueAgentToken: ({ botUserId }, signal) => issueToken("issue agent chat token", botUserId, DEFAULT_AGENT_PAT_DESCRIPTION, signal),
    issueUserToken: ({ userId }, signal) => issueToken("issue user chat token", userId, USER_PAT_DESCRIPTION, signal),
  };
}
