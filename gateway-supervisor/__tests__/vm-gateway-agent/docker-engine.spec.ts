import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DockerEngineError,
  containerPathExists,
  createContainer,
  createDockerEngine,
  imagePullPath,
  inspectContainer,
  hasImmutableImage,
  pullImage,
  registryAuthHeader,
  registryHostOf,
  removeContainer,
  type DockerEngine,
} from "../../lib/vm-gateway-agent/docker-engine";

it("inspects containers through a Docker 29 daemon that rejects retired API versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "octogee-docker-api-"));
  const socketPath = join(root, "docker.sock");
  const server = createServer((req, res) => {
    const minor = Number(/^\/v1\.(\d+)\//u.exec(req.url ?? "")?.[1]);
    res.setHeader("content-type", "application/json");
    if (minor < 44 || !Number.isFinite(minor)) {
      res.writeHead(400).end(JSON.stringify({ message: "Minimum supported API version is 1.44" }));
    } else {
      res.end(JSON.stringify({ Id: "container-on-docker-29" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    expect(await inspectContainer(createDockerEngine({ socketPath }), "octogee-gateway")).toEqual({ Id: "container-on-docker-29" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("creates a project mount through the Docker API that supports volume subpaths", async () => {
  const root = await mkdtemp(join(tmpdir(), "octogee-docker-subpath-"));
  const socketPath = join(root, "docker.sock");
  const server = createServer((req, res) => {
    const minor = Number(/^\/v1\.(\d+)\//u.exec(req.url ?? "")?.[1]);
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const config = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.setHeader("content-type", "application/json");
      if (config.HostConfig.Mounts[0].VolumeOptions.Subpath !== "projects" || minor < 45) {
        res.writeHead(400).end(JSON.stringify({ message: "VolumeOptions.Subpath needs API v1.45 or newer" }));
      } else {
        res.writeHead(201).end(JSON.stringify({ Id: "gateway-with-project-subpath" }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try {
    await expect(createContainer(createDockerEngine({ socketPath }), "octogee-gateway", {
      HostConfig: { Mounts: [{ Type: "volume", Source: "project-materializations", Target: "/work/materialized", VolumeOptions: { Subpath: "projects", NoCopy: true } }] },
    })).resolves.toBe("gateway-with-project-subpath");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("aborts a stalled Docker inspection at the caller's observation deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "octogee-docker-timeout-"));
  const socketPath = join(root, "docker.sock");
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(() => {});
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try {
    await expect(inspectContainer(createDockerEngine({ socketPath }), "octogee-gateway", AbortSignal.timeout(20))).rejects.toThrow(/aborted/i);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

describe("image references", () => {
  it("derives the registry host and the pull query for tagged, digest, and bare references", () => {
    expect(registryHostOf("us-central1-docker.pkg.dev/octogee/octogee/gateway:main.abc")).toBe("us-central1-docker.pkg.dev");
    expect(registryHostOf("localhost:5000/x")).toBe("localhost:5000");
    expect(registryHostOf("nginx")).toBe("docker.io");
    expect(imagePullPath("us-central1-docker.pkg.dev/octogee/octogee/gateway:main.abc"))
      .toBe("/images/create?fromImage=us-central1-docker.pkg.dev%2Foctogee%2Foctogee%2Fgateway&tag=main.abc");
    expect(imagePullPath("r/x@sha256:abc")).toBe("/images/create?fromImage=r%2Fx&tag=sha256%3Aabc");
    expect(imagePullPath("localhost:5000/x")).toBe("/images/create?fromImage=localhost%3A5000%2Fx&tag=latest");
  });

  it.each(["ya29.x", "ya29.xy", "ya29.xyz", "token>with?symbols"])("encodes a padded URL-safe Docker registry credential for %s", (token) => {
    const encoded = registryAuthHeader("us-central1-docker.pkg.dev", token);
    expect(encoded).toMatch(/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}==|[A-Za-z0-9_-]{3}=)?$/);
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString());
    expect(decoded).toEqual({ username: "oauth2accesstoken", password: token, serveraddress: "us-central1-docker.pkg.dev" });
  });
});

describe("engine helpers", () => {
  function engine(responses: Array<{ status: number; body: unknown }>): DockerEngine & { calls: Array<{ method: string; path: string; headers?: Record<string, string> }> } {
    const calls: Array<{ method: string; path: string; headers?: Record<string, string> }> = [];
    return {
      calls,
      request: vi.fn(async (method: string, path: string, _body?: unknown, headers?: Record<string, string>) => {
        calls.push({ method, path, headers });
        const next = responses.shift();
        if (!next) throw new Error("no scripted response");
        return next as { status: number; body: never };
      }),
    };
  }

  it("pulls with the registry auth header and surfaces a streamed pull error", async () => {
    const ok = engine([{ status: 200, body: '{"status":"Pulling"}\n{"status":"Downloaded"}' }]);
    await pullImage(ok, "us-central1-docker.pkg.dev/o/o/gateway:t", "tok");
    expect(ok.calls[0].headers?.["X-Registry-Auth"]).toBe(registryAuthHeader("us-central1-docker.pkg.dev", "tok"));

    const failed = engine([{ status: 200, body: '{"status":"Pulling"}\n{"error":"manifest unknown"}' }]);
    await expect(pullImage(failed, "r/x:t", "tok")).rejects.toThrow(/manifest unknown/);

    const denied = engine([{ status: 401, body: { message: "unauthorized" } }]);
    await expect(pullImage(denied, "r/x:t", "tok")).rejects.toThrow(DockerEngineError);
  });

  it("stats a path inside a container: present, absent, or a failure it surfaces", async () => {
    const present = engine([{ status: 200, body: "" }]);
    expect(await containerPathExists(present, "octogee-host-probe", "/octogee-host-bin/x")).toBe(true);
    expect(present.calls[0]).toMatchObject({ method: "HEAD", path: "/containers/octogee-host-probe/archive?path=%2Foctogee-host-bin%2Fx" });
    expect(await containerPathExists(engine([{ status: 404, body: "" }]), "octogee-host-probe", "/x")).toBe(false);
    await expect(containerPathExists(engine([{ status: 500, body: { message: "boom" } }]), "octogee-host-probe", "/x")).rejects.toThrow(/stat \/x in octogee-host-probe: HTTP 500 boom/);
  });

  it("treats a missing container as null on inspect and as done on remove", async () => {
    expect(await inspectContainer(engine([{ status: 404, body: { message: "no such container" } }]), "octogee-gateway")).toBeNull();
    expect(await inspectContainer(engine([{ status: 200, body: { Id: "abc" } }]), "octogee-gateway")).toEqual({ Id: "abc" });
    await expect(removeContainer(engine([{ status: 404, body: {} }]), "octogee-gateway")).resolves.toBeUndefined();
    await expect(removeContainer(engine([{ status: 500, body: { message: "boom" } }]), "octogee-gateway")).rejects.toThrow(/boom/);
  });
});

it.each([200, 404, 500])("checks preloaded digest identity without treating Docker errors as cache misses (%s)", async status => {
  const reference = `registry.example/image@sha256:${"a".repeat(64)}`;
  const request = vi.fn(async () => ({ status, body: { RepoDigests: [reference], message: "unavailable" } }));
  const result = hasImmutableImage({ request } as DockerEngine, reference.replace("@", ":deadbee@"));
  if (status === 500) await expect(result).rejects.toThrow("HTTP 500");
  else await expect(result).resolves.toBe(status === 200);
  expect(request).toHaveBeenCalledExactlyOnceWith("GET", `/images/${encodeURIComponent(reference)}/json`);
});

it("refuses a mismatched local digest and refreshes mutable tags", async () => {
  const request = vi.fn(async () => ({ status: 200, body: { RepoDigests: [] } }));
  const engine = { request } as DockerEngine;
  await expect(hasImmutableImage(engine, "registry.example/image:latest")).resolves.toBe(false);
  expect(request).not.toHaveBeenCalled();
  await expect(hasImmutableImage(engine, `registry.example/image@sha256:${"a".repeat(64)}`)).rejects.toThrow("does not match");
});
