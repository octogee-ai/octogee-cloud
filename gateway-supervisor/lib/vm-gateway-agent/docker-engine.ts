import http from "node:http";

export const DOCKER_API_PREFIX = "/v1.45";

export interface DockerResponse<T> {
  status: number;
  body: T;
}

export interface DockerEngine {
  request<T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>, signal?: AbortSignal): Promise<DockerResponse<T>>;
}

export class DockerEngineError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "DockerEngineError";
  }
}

function parseBody(text: string): unknown {
  if (!text) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function collectResponse<T>(res: http.IncomingMessage, resolve: (value: DockerResponse<T>) => void): void {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => {
    resolve({ status: res.statusCode ?? 0, body: parseBody(Buffer.concat(chunks).toString("utf8")) as T });
  });
}

export function createDockerEngine(opts: { socketPath?: string } = {}): DockerEngine {
  const socketPath = opts.socketPath ?? "/var/run/docker.sock";
  return {
    request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<DockerResponse<T>> {
      return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request(
          {
            socketPath,
            signal,
            method,
            path: `${DOCKER_API_PREFIX}${path}`,
            headers: {
              ...headers,
              ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
            },
          },
          (res) => collectResponse<T>(res, resolve),
        );
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
      });
    },
  };
}

export function registryHostOf(imageRef: string): string {
  const first = imageRef.split("/")[0];
  return first.includes(".") || first.includes(":") ? first : "docker.io";
}

export function registryAuthHeader(registryHost: string, accessToken: string): string {
  return Buffer.from(JSON.stringify({ username: "oauth2accesstoken", password: accessToken, serveraddress: registryHost }))
    .toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

export function imagePullPath(imageRef: string): string {
  const at = imageRef.indexOf("@");
  if (at >= 0) return `/images/create?fromImage=${encodeURIComponent(imageRef.slice(0, at))}&tag=${encodeURIComponent(imageRef.slice(at + 1))}`;
  const lastSlash = imageRef.lastIndexOf("/");
  const colon = imageRef.lastIndexOf(":");
  if (colon > lastSlash) {
    return `/images/create?fromImage=${encodeURIComponent(imageRef.slice(0, colon))}&tag=${encodeURIComponent(imageRef.slice(colon + 1))}`;
  }
  return `/images/create?fromImage=${encodeURIComponent(imageRef)}&tag=latest`;
}

function assertOk(res: DockerResponse<unknown>, what: string, allowed: number[] = []): void {
  if ((res.status >= 200 && res.status < 300) || allowed.includes(res.status)) return;
  const message = typeof res.body === "object" && res.body && "message" in res.body
    ? String((res.body as { message: unknown }).message)
    : String(res.body);
  throw new DockerEngineError(res.status, `${what}: HTTP ${res.status} ${message}`);
}

export async function hasImmutableImage(engine: DockerEngine, imageRef: string): Promise<boolean> {
  const match = /^(.*)@(sha256:[a-f0-9]{64})$/.exec(imageRef);
  if (!match) return false;
  const tag = match[1].lastIndexOf(":");
  const repository = tag > match[1].lastIndexOf("/") ? match[1].slice(0, tag) : match[1];
  const reference = `${repository}@${match[2]}`;
  const res = await engine.request<{ RepoDigests?: string[] }>("GET", `/images/${encodeURIComponent(reference)}/json`);
  if (res.status === 404) return false;
  assertOk(res, `inspect ${reference}`);
  if (!res.body.RepoDigests?.includes(reference)) throw new Error(`Local image does not match ${reference}`);
  return true;
}

export async function pullImage(engine: DockerEngine, imageRef: string, accessToken: string): Promise<void> {
  const res = await engine.request("POST", imagePullPath(imageRef), undefined, {
    "X-Registry-Auth": registryAuthHeader(registryHostOf(imageRef), accessToken),
  });
  assertOk(res, `pull ${imageRef}`);
  const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
  if (/"error"\s*:/.test(text)) throw new DockerEngineError(res.status, `pull ${imageRef}: ${text.slice(-300)}`);
}

export interface ContainerInspection {
  Id: string;
  State?: { Status?: string; Running?: boolean; Paused?: boolean; ExitCode?: number };
  Config?: { Labels?: Record<string, string>; Image?: string };
  Image?: string;
}

export async function inspectContainer(engine: DockerEngine, name: string, signal?: AbortSignal): Promise<ContainerInspection | null> {
  const res = await engine.request<ContainerInspection>("GET", `/containers/${encodeURIComponent(name)}/json`, undefined, undefined, signal);
  if (res.status === 404) return null;
  assertOk(res, `inspect ${name}`);
  return res.body;
}

export async function inspectImageDigests(engine: DockerEngine, imageId: string, signal: AbortSignal): Promise<string[]> {
  const res = await engine.request<{ RepoDigests?: string[] | null }>("GET", `/images/${encodeURIComponent(imageId)}/json`, undefined, undefined, signal);
  assertOk(res, "inspect container image");
  return res.body.RepoDigests ?? [];
}

export async function containerPathExists(engine: DockerEngine, name: string, path: string): Promise<boolean> {
  const res = await engine.request("HEAD", `/containers/${encodeURIComponent(name)}/archive?path=${encodeURIComponent(path)}`);
  if (res.status === 404) return false;
  assertOk(res, `stat ${path} in ${name}`);
  return true;
}

export async function removeContainer(engine: DockerEngine, name: string): Promise<void> {
  const res = await engine.request("DELETE", `/containers/${encodeURIComponent(name)}?force=true&v=false`);
  assertOk(res, `remove ${name}`, [404]);
}

export async function createContainer(engine: DockerEngine, name: string, config: Record<string, unknown>): Promise<string> {
  const res = await engine.request<{ Id: string }>("POST", `/containers/create?name=${encodeURIComponent(name)}`, config);
  assertOk(res, `create ${name}`);
  return res.body.Id;
}

export async function startContainer(engine: DockerEngine, name: string): Promise<void> {
  const res = await engine.request("POST", `/containers/${encodeURIComponent(name)}/start`);
  assertOk(res, `start ${name}`, [304]);
}

export async function waitContainer(engine: DockerEngine, name: string): Promise<number> {
  const res = await engine.request<{ StatusCode: number }>("POST", `/containers/${encodeURIComponent(name)}/wait`);
  assertOk(res, `wait ${name}`);
  return res.body.StatusCode;
}

export async function setContainerPaused(engine: DockerEngine, name: string, paused: boolean): Promise<void> {
  const action = paused ? "pause" : "unpause";
  assertOk(await engine.request("POST", `/containers/${encodeURIComponent(name)}/${action}`), `${action} ${name}`);
}

export async function setContainerRestartPolicy(engine: DockerEngine, name: string, policy: "no" | "on-failure"): Promise<void> {
  assertOk(await engine.request("POST", `/containers/${encodeURIComponent(name)}/update`, { RestartPolicy: { Name: policy } }), `restart policy ${name}`);
}

export interface ImagePruneResult {
  imagesDeleted: number;
  spaceReclaimed: number;
}

export async function pruneUnusedImages(engine: DockerEngine): Promise<ImagePruneResult> {
  const filters = encodeURIComponent(JSON.stringify({ dangling: ["false"] }));
  const res = await engine.request<{ ImagesDeleted?: Array<{ Deleted?: string }> | null; SpaceReclaimed?: number }>("POST", `/images/prune?filters=${filters}`);
  assertOk(res, "prune images");
  return {
    imagesDeleted: (res.body.ImagesDeleted ?? []).filter((entry) => entry.Deleted).length,
    spaceReclaimed: res.body.SpaceReclaimed ?? 0,
  };
}
