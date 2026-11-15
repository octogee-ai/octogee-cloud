import type { GitRepositoryOutput } from "@octogee/shared/types/provisioning-service";
import type { ProvisioningCredential, ProvisioningCredentialName } from "@octogee/shared/types/provisioning-service";
import type { ChatAgentInput, ChatChannels, ChatChannelsInput, ChatHost, ChatTeamInput, ChatUserInput, IssuedToken } from "./chat-host.js";
import type { CredentialStore } from "./credential-store.js";
import type { AuthorizedGitKey, GitHost, GitRepositoryKind } from "./git-host.js";
import { HostError, type HostErrorKind } from "./host-error.js";

export interface HostCall {
  operation: string;
  key: string;
}

export interface InjectedFault {
  operation: string;
  kind: HostErrorKind;
  times: number;
}

class FakeHostCore {
  readonly calls: HostCall[] = [];
  readonly overlaps: HostCall[] = [];
  private readonly faults: InjectedFault[] = [];
  private readonly inFlight = new Map<string, number>();
  private delayMs = 0;

  failNext(operation: string, kind: HostErrorKind, times = 1): void {
    this.faults.push({ operation, kind, times });
  }

  clearFaults(): void {
    this.faults.length = 0;
  }

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  async call<T>(operation: string, key: string, signal: AbortSignal, body: () => T): Promise<T> {
    this.calls.push({ operation, key });
    const running = this.inFlight.get(key) ?? 0;
    if (running > 0) this.overlaps.push({ operation, key });
    this.inFlight.set(key, running + 1);
    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      if (signal.aborted) throw new HostError("transient", `${operation}: aborted`);
      const fault = this.faults.find((candidate) => candidate.operation === operation && candidate.times > 0);
      if (fault) {
        fault.times -= 1;
        throw new HostError(fault.kind, `${operation}: injected ${fault.kind} fault`);
      }
      return body();
    } finally {
      this.inFlight.set(key, (this.inFlight.get(key) ?? 1) - 1);
    }
  }
}

let nextId = 1;
const id = (prefix: string) => `${prefix}_${nextId++}`;

export class FakeChatHost implements ChatHost {
  readonly host = new FakeHostCore();
  readonly users = new Map<string, { id: string; email: string }>();
  readonly teams = new Map<string, { id: string; members: Set<string> }>();
  readonly channels = new Map<string, { id: string; teamId: string; members: Set<string> }>();
  readonly bots = new Map<string, { id: string }>();
  readonly tokens: { ownerId: string; token: string }[] = [];

  ensureUser(input: ChatUserInput, signal: AbortSignal): Promise<{ userId: string }> {
    return this.host.call("ensureUser", input.slug, signal, () => {
      const existing = this.users.get(input.slug);
      if (existing) return { userId: existing.id };
      const user = { id: id("chat_user"), email: input.email };
      this.users.set(input.slug, user);
      return { userId: user.id };
    });
  }

  ensureTeam(input: ChatTeamInput, signal: AbortSignal): Promise<{ teamId: string }> {
    return this.host.call("ensureTeam", input.slug, signal, () => {
      const team = this.teams.get(input.slug) ?? { id: id("chat_team"), members: new Set<string>() };
      team.members.add(input.userId);
      this.teams.set(input.slug, team);
      return { teamId: team.id };
    });
  }

  ensureChannels(input: ChatChannelsInput, signal: AbortSignal): Promise<ChatChannels> {
    return this.host.call("ensureChannels", input.slug, signal, () => {
      const ensure = (name: string) => {
        const channel = this.channels.get(name) ?? { id: id("chat_channel"), teamId: input.teamId, members: new Set<string>() };
        channel.members.add(input.userId);
        this.channels.set(name, channel);
        return channel.id;
      };
      const general = ensure(`${input.slug}-general`);
      return input.agentChannel ? { general, agent: ensure(`${input.slug}-agent`) } : { general };
    });
  }

  ensureAgentBot(input: ChatAgentInput, signal: AbortSignal): Promise<{ botUserId: string }> {
    return this.host.call("ensureAgentBot", input.slug, signal, () => {
      const bot = this.bots.get(input.slug) ?? { id: id("chat_bot") };
      this.bots.set(input.slug, bot);
      return { botUserId: bot.id };
    });
  }

  issueAgentToken(input: { botUserId: string }, signal: AbortSignal): Promise<IssuedToken> {
    return this.host.call("issueAgentToken", input.botUserId, signal, () => this.issue(input.botUserId));
  }

  issueUserToken(input: { userId: string }, signal: AbortSignal): Promise<IssuedToken> {
    return this.host.call("issueUserToken", input.userId, signal, () => this.issue(input.userId));
  }

  private issue(ownerId: string): IssuedToken {
    const token = id("token");
    this.tokens.push({ ownerId, token });
    return { token };
  }
}

export class FakeGitHost implements GitHost {
  readonly host = new FakeHostCore();
  readonly owners = new Set<string>();
  readonly repositories = new Map<string, GitRepositoryOutput>();
  readonly keys = new Map<string, AuthorizedGitKey[]>();

  ensureOwner(input: { slug: string; knownOwner?: string }, signal: AbortSignal): Promise<{ owner: string }> {
    return this.host.call("ensureOwner", input.slug, signal, () => {
      this.owners.add(input.slug);
      return { owner: input.slug };
    });
  }

  ensureRepository(input: { owner: string; kind: GitRepositoryKind }, signal: AbortSignal): Promise<GitRepositoryOutput> {
    return this.host.call("ensureRepository", input.owner, signal, () => {
      if (!this.owners.has(input.owner)) throw new HostError("terminal", `owner ${input.owner} does not exist`);
      const name = `${input.owner}-${input.kind}`;
      const repository = this.repositories.get(name) ?? {
        cloneUrl: `https://git.invalid/${input.owner}/${name}.git`,
        sshUrl: `ssh://git@git.invalid/${input.owner}/${name}.git`,
      };
      this.repositories.set(name, repository);
      return repository;
    });
  }

  listKeys(input: { owner: string; holders: string[] }, signal: AbortSignal): Promise<AuthorizedGitKey[]> {
    return this.host.call("listKeys", input.owner, signal, () => (this.keys.get(input.owner) ?? []).map((key) => ({
      publicKey: key.publicKey,
      holder: key.holder !== null && input.holders.includes(key.holder) ? key.holder : null,
    })));
  }

  registerKey(input: { owner: string; publicKey: string; holder: string }, signal: AbortSignal): Promise<void> {
    return this.host.call("registerKey", input.owner, signal, () => {
      const keys = this.keys.get(input.owner) ?? [];
      if (!keys.some((key) => key.publicKey === input.publicKey && key.holder === input.holder)) {
        keys.push({ publicKey: input.publicKey, holder: input.holder });
      }
      this.keys.set(input.owner, keys);
    });
  }

  releaseKey(input: { owner: string; publicKey: string; holder: string }, signal: AbortSignal): Promise<void> {
    return this.host.call("releaseKey", input.owner, signal, () => {
      const keys = this.keys.get(input.owner) ?? [];
      this.keys.set(input.owner, keys.filter((key) => !(key.publicKey === input.publicKey && key.holder === input.holder)));
    });
  }
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, ProvisioningCredential>();

  async read(uid: string, name: ProvisioningCredentialName): Promise<ProvisioningCredential | null> {
    return this.values.get(`${uid}/${name}`) ?? null;
  }

  async names(uid: string): Promise<ProvisioningCredentialName[]> {
    return [...this.values.entries()].filter(([key]) => key.startsWith(`${uid}/`)).map(([, credential]) => credential.name).sort();
  }

  async write(uid: string, name: ProvisioningCredentialName, value: string): Promise<{ version: number }> {
    const version = (this.values.get(`${uid}/${name}`)?.version ?? 0) + 1;
    this.values.set(`${uid}/${name}`, { name, value, version });
    return { version };
  }
}
