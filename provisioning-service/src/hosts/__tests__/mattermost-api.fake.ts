export interface FakeMmUser {
  id: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  nickname: string;
  delete_at: number;
  is_bot: boolean;
  bot_description?: string;
}

export interface FakeMmTeam {
  id: string;
  name: string;
  display_name: string;
  type: string;
  delete_at: number;
  members: Map<string, string>;
}

export interface FakeMmChannel {
  id: string;
  team_id: string;
  name: string;
  display_name: string;
  purpose: string;
  type: string;
  delete_at: number;
  members: Set<string>;
}

export interface FakeMmCommand {
  id: string;
  team_id: string;
  trigger: string;
  url: string;
  method: string;
  token: string;
  [key: string]: unknown;
}

interface Fault {
  method: string;
  path: RegExp;
  status: number;
  times: number;
}

export interface FakeMmRequest {
  method: string;
  path: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const appError = (status: number, id: string) => json(status, { id, message: id, status_code: status });
const notFound = () => appError(404, "app.not_found");

export class FakeMattermostApi {
  readonly baseUrl = "https://chat.invalid";
  readonly users = new Map<string, FakeMmUser>();
  readonly teams = new Map<string, FakeMmTeam>();
  readonly channels = new Map<string, FakeMmChannel>();
  readonly commands = new Map<string, FakeMmCommand>();
  readonly tokens: { id: string; userId: string; description: string; token: string }[] = [];
  readonly avatars = new Map<string, number>();
  readonly requests: FakeMmRequest[] = [];
  readonly imageSources = new Map<string, { status: number; contentType: string; bytes?: number }>();
  readonly imageRequests: string[] = [];
  undeletableChannels = new Set(["town-square"]);
  private readonly faults: Fault[] = [];
  private nextId = 1;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    await new Promise((resolve) => setTimeout(resolve, 0));
    init?.signal?.throwIfAborted();
    if (url.origin !== this.baseUrl) return this.image(url.href);
    const path = url.pathname.replace(/^\/api\/v4/, "");
    this.requests.push({ method, path: `${path}${url.search}` });
    const fault = this.faults.find((candidate) => candidate.times > 0 && candidate.method === method && candidate.path.test(path));
    if (fault) {
      fault.times -= 1;
      if (fault.status === 0) throw new TypeError("fetch failed");
      return json(fault.status, { id: "fake.injected", message: "host echoed request content", status_code: fault.status });
    }
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    return this.route(method, path, url.searchParams, body);
  };

  fail(method: string, path: RegExp, status: number, times = 1): void {
    this.faults.push({ method, path, status, times });
  }

  id(prefix: string): string {
    return `${prefix}${this.nextId++}`;
  }

  addUser(fields: Partial<FakeMmUser> & { username: string }): FakeMmUser {
    const user: FakeMmUser = {
      id: this.id("user"),
      email: `${fields.username}@example.com`,
      first_name: "",
      last_name: "",
      nickname: "",
      delete_at: 0,
      is_bot: false,
      ...fields,
    };
    this.users.set(user.id, user);
    return user;
  }

  addTeam(name: string, fields: Partial<FakeMmTeam> = {}): FakeMmTeam {
    const team: FakeMmTeam = { id: this.id("team"), name, display_name: name, type: "O", delete_at: 0, members: new Map(), ...fields };
    this.teams.set(team.id, team);
    return team;
  }

  addChannel(teamId: string, name: string, fields: Partial<FakeMmChannel> = {}): FakeMmChannel {
    const channel: FakeMmChannel = {
      id: this.id("channel"), team_id: teamId, name, display_name: name, purpose: "", type: "O", delete_at: 0, members: new Set(), ...fields,
    };
    this.channels.set(channel.id, channel);
    return channel;
  }

  userByName(username: string): FakeMmUser | undefined {
    return [...this.users.values()].find((user) => user.username === username);
  }

  teamByName(name: string): FakeMmTeam | undefined {
    return [...this.teams.values()].find((team) => team.name === name);
  }

  channelByName(teamId: string, name: string): FakeMmChannel | undefined {
    return [...this.channels.values()].find((channel) => channel.team_id === teamId && channel.name === name);
  }

  count(method: string, path: RegExp): number {
    return this.requests.filter((request) => request.method === method && path.test(request.path)).length;
  }

  private image(href: string): Response {
    this.imageRequests.push(href);
    const source = this.imageSources.get(href);
    if (!source) return new Response("missing", { status: 404 });
    return new Response(new Uint8Array(source.bytes ?? 3), { status: source.status, headers: { "Content-Type": source.contentType } });
  }

  private userJson(user: FakeMmUser) {
    const { bot_description: _description, ...rest } = user;
    return rest;
  }

  private teamJson(team: FakeMmTeam) {
    const { members: _members, ...rest } = team;
    return rest;
  }

  private channelJson(channel: FakeMmChannel) {
    const { members: _members, ...rest } = channel;
    return rest;
  }

  private route(method: string, path: string, query: URLSearchParams, body: Record<string, unknown>): Response {
    let match: RegExpMatchArray | null;
    if (method === "POST" && path === "/users") return this.createUser(body);
    if (method === "POST" && path === "/bots") return this.createBot(body);
    if (method === "POST" && path === "/teams") return this.createTeam(body);
    if (method === "POST" && path === "/channels") return this.createChannel(body);
    if (method === "GET" && path === "/commands") {
      return json(200, [...this.commands.values()].filter((command) => command.team_id === query.get("team_id")));
    }
    if (method === "POST" && path === "/commands") {
      const command = { ...body, id: this.id("command"), token: this.id("command-token") } as FakeMmCommand;
      this.commands.set(command.id, command);
      return json(201, command);
    }
    if ((match = path.match(/^\/commands\/([^/]+)$/)) && method === "PUT") {
      const command = { ...body, id: match[1] } as FakeMmCommand;
      this.commands.set(command.id, command);
      return json(200, command);
    }
    if ((match = path.match(/^\/users\/username\/([^/]+)$/)) && method === "GET") {
      const user = this.userByName(decodeURIComponent(match[1]));
      return user ? json(200, this.userJson(user)) : notFound();
    }
    if ((match = path.match(/^\/users\/email\/([^/]+)$/)) && method === "GET") {
      const email = decodeURIComponent(match[1]);
      const user = [...this.users.values()].find((candidate) => candidate.email === email);
      return user ? json(200, this.userJson(user)) : notFound();
    }
    if ((match = path.match(/^\/users\/([^/]+)\/active$/)) && method === "PUT") {
      const user = this.users.get(match[1]);
      if (!user) return notFound();
      user.delete_at = body.active ? 0 : Date.now();
      return json(200, { status: "OK" });
    }
    if ((match = path.match(/^\/users\/([^/]+)\/patch$/)) && method === "PUT") {
      const user = this.users.get(match[1]);
      if (!user) return notFound();
      Object.assign(user, body);
      return json(200, this.userJson(user));
    }
    if ((match = path.match(/^\/users\/([^/]+)\/image$/)) && method === "POST") {
      if (!this.users.has(match[1])) return notFound();
      this.avatars.set(match[1], (this.avatars.get(match[1]) ?? 0) + 1);
      return json(200, { status: "OK" });
    }
    if (method === "POST" && path === "/users/tokens/revoke") {
      const index = this.tokens.findIndex((token) => token.id === body.token_id);
      if (index < 0) return notFound();
      this.tokens.splice(index, 1);
      return json(200, { status: "OK" });
    }
    if ((match = path.match(/^\/users\/([^/]+)\/tokens$/)) && method === "GET") {
      return json(200, this.tokens.filter((token) => token.userId === match![1]).map(({ id, userId, description }) => ({ id, user_id: userId, description })));
    }
    if ((match = path.match(/^\/users\/([^/]+)\/tokens$/)) && method === "POST") {
      if (!this.users.has(match[1])) return notFound();
      const token = { id: this.id("token"), userId: match[1], description: String(body.description), token: this.id("secret-token-") };
      this.tokens.push(token);
      return json(200, { id: token.id, user_id: match[1], token: token.token, description: token.description });
    }
    if ((match = path.match(/^\/users\/([^/]+)$/)) && method === "GET") {
      const user = this.users.get(match[1]);
      return user ? json(200, this.userJson(user)) : notFound();
    }
    if ((match = path.match(/^\/teams\/name\/([^/]+)$/)) && method === "GET") {
      const team = this.teamByName(decodeURIComponent(match[1]));
      return team ? json(200, this.teamJson(team)) : notFound();
    }
    if ((match = path.match(/^\/teams\/([^/]+)\/members$/)) && method === "POST") {
      const team = this.teams.get(match[1]);
      const userId = String(body.user_id);
      if (!team || !this.users.has(userId)) return notFound();
      team.members.set(userId, team.members.get(userId) ?? "team_user");
      return json(201, { team_id: team.id, user_id: userId });
    }
    if ((match = path.match(/^\/teams\/([^/]+)\/channels\/name\/([^/]+)$/)) && method === "GET") {
      const channel = this.channelByName(match[1], decodeURIComponent(match[2]));
      if (!channel) return notFound();
      if (channel.delete_at > 0 && query.get("include_deleted") !== "true") return notFound();
      return json(200, this.channelJson(channel));
    }
    if ((match = path.match(/^\/teams\/([^/]+)$/)) && method === "GET") {
      const team = this.teams.get(match[1]);
      return team ? json(200, this.teamJson(team)) : notFound();
    }
    if ((match = path.match(/^\/channels\/([^/]+)\/restore$/)) && method === "POST") {
      const channel = this.channels.get(match[1]);
      if (!channel) return notFound();
      channel.delete_at = 0;
      return json(200, this.channelJson(channel));
    }
    if ((match = path.match(/^\/channels\/([^/]+)\/members$/)) && method === "POST") {
      const channel = this.channels.get(match[1]);
      const userId = String(body.user_id);
      if (!channel || !this.users.has(userId)) return notFound();
      channel.members.add(userId);
      return json(201, { channel_id: channel.id, user_id: userId });
    }
    if ((match = path.match(/^\/channels\/([^/]+)$/)) && method === "GET") {
      const channel = this.channels.get(match[1]);
      return channel ? json(200, this.channelJson(channel)) : notFound();
    }
    if ((match = path.match(/^\/channels\/([^/]+)$/)) && method === "DELETE") {
      const channel = this.channels.get(match[1]);
      if (!channel) return notFound();
      if (this.undeletableChannels.has(channel.name)) return appError(400, "api.channel.delete_channel.cannot.app_error");
      channel.delete_at = Date.now();
      return json(200, { status: "OK" });
    }
    return appError(501, `fake.unrouted ${method} ${path}`);
  }

  private createUser(body: Record<string, unknown>): Response {
    if (this.userByName(String(body.username))) return appError(400, "app.user.save.username_exists.app_error");
    if ([...this.users.values()].some((user) => user.email === body.email)) return appError(400, "app.user.save.email_exists.app_error");
    const user = this.addUser({
      username: String(body.username),
      email: String(body.email),
      first_name: String(body.first_name ?? ""),
      last_name: String(body.last_name ?? ""),
      nickname: String(body.nickname ?? ""),
    });
    return json(201, this.userJson(user));
  }

  private createBot(body: Record<string, unknown>): Response {
    if (this.userByName(String(body.username))) return appError(400, "app.user.save.username_exists.app_error");
    const user = this.addUser({
      username: String(body.username),
      email: `${String(body.username)}@bots.invalid`,
      first_name: String(body.display_name ?? ""),
      is_bot: true,
      bot_description: String(body.description ?? ""),
    });
    return json(201, { user_id: user.id, username: user.username, display_name: body.display_name, description: body.description });
  }

  private createTeam(body: Record<string, unknown>): Response {
    if (this.teamByName(String(body.name))) return appError(400, "store.sql_team.save_team.existing.app_error");
    const team = this.addTeam(String(body.name), { display_name: String(body.display_name), type: String(body.type) });
    this.addChannel(team.id, "town-square");
    this.addChannel(team.id, "off-topic");
    return json(201, this.teamJson(team));
  }

  private createChannel(body: Record<string, unknown>): Response {
    const teamId = String(body.team_id);
    if (!this.teams.has(teamId)) return notFound();
    if (this.channelByName(teamId, String(body.name))) return appError(400, "store.sql_channel.save_channel.exists.app_error");
    const channel = this.addChannel(teamId, String(body.name), {
      display_name: String(body.display_name),
      purpose: String(body.purpose ?? ""),
      type: String(body.type),
    });
    return json(201, this.channelJson(channel));
  }
}
