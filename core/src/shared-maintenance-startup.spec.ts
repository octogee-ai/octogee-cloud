import { generateKeyPairSync } from "node:crypto";
import type { Server } from "node:http";
import { expect, it, vi } from "vitest";
import { signFleetRequest } from "./fleet-signature.js";
import { allowSharedMaintenanceLaunch, runSharedMaintenanceStartup, type SharedMaintenanceStartupEnrollment } from "./shared-maintenance-startup.js";

const keys = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { format: "pem", type: "spki" }, privateKeyEncoding: { format: "pem", type: "pkcs8" },
});
const scope = { namespace: "octogee-test", gatewayId: "fixture-shared", podUid: "fixture-pod",
  attemptId: "fixture-attempt", buildId: "d".repeat(40), artifactSetId: "d".repeat(64), role: "gateway" } satisfies SharedMaintenanceStartupEnrollment;
type Request = SharedMaintenanceStartupEnrollment & { nonce: string };
const archive = "b".repeat(64);
const issue = (request: Request, restoredArchiveSha256 = archive, expiresAt = Date.now() + 10_000) => {
  const raw = JSON.stringify({ request, restoredArchiveSha256, observedImageId: "sha256:" + "d".repeat(64), expiresAt });
  return { raw, signature: signFleetRequest(keys.privateKey, `shared-maintenance-startup/${request.attemptId}/${request.role}@${request.gatewayId}`, raw) };
};
function port(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not open");
  return address.port;
}

it("does not consult or replace readiness for a non-enrolled Shared role", async () => {
  const launch = vi.fn(), read = vi.fn(), observeProbes = vi.fn();
  await runSharedMaintenanceStartup({ enrollment: scope, local: { ...scope, gatewayId: "another-shared" },
    publicKey: keys.publicKey, signal: new AbortController().signal, launch, read, observeProbes, onUnavailable: vi.fn() });
  expect(launch).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  expect(observeProbes).not.toHaveBeenCalled();
});

it("rejects a signed release for a different pod, role, attempt nonce or archive", () => {
  const request = { ...scope, nonce: "a".repeat(64) }, now = Date.now();
  const validate = (proof: ReturnType<typeof issue>) => allowSharedMaintenanceLaunch({ request, proof, publicKey: keys.publicKey, now });
  expect(validate(issue(request))).toBe(true);
  expect(validate(issue({ ...request, podUid: "foreign" }))).toBe(false);
  expect(validate(issue({ ...request, role: "gateway-edge" }))).toBe(false);
  expect(validate(issue({ ...request, nonce: "f".repeat(64) }))).toBe(false);
  expect(validate(issue(request, "not-restored"))).toBe(false);
  expect(validate(issue(request, archive, now - 1))).toBe(false);
});

it.each(["gateway", "gateway-edge"] as const)("preserves only %s legacy probe behavior and launches only after a fresh gate", async role => {
  const enrollment = { ...scope, role };
  let release = false;
  const launch = vi.fn();
  type Probes = { health: Server; readiness: Server | null };
  let resolve!: (value: Probes) => void;
  const probes = new Promise<Probes>(receive => { resolve = receive; });
  const controller = new AbortController();
  const pending = runSharedMaintenanceStartup({ enrollment, local: enrollment, publicKey: keys.publicKey, signal: controller.signal,
    launch, observeProbes: (health, readiness) => resolve({ health, readiness }),
    probePort: 0, readinessPort: 0, probeHost: "127.0.0.1", retryMs: 3,
    async read(request) {
      return release ? issue(request) : null;
    },
    onUnavailable() { throw new Error("Fixture should remain responsive"); },
  });
  try {
    const { health, readiness } = await probes;
    expect((await fetch(`http://127.0.0.1:${port(health)}${role === "gateway" ? "/healthz" : "/health"}`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port(health)}/workspace`)).status).toBe(503);
    if (readiness) expect((await fetch(`http://127.0.0.1:${port(readiness)}/surge-ready`)).status).toBe(503);
    expect(launch).not.toHaveBeenCalled();
    release = true;
    await pending;
    expect(health.listening).toBe(false);
    expect(readiness?.listening ?? false).toBe(false);
    expect(launch).toHaveBeenCalledOnce();
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
});

it("gives an operator only its socket nonce, refuses foreign permits, and aborts without launching", async () => {
  const { request: httpRequest } = await import("node:http");
  const { stat } = await import("node:fs/promises");
  const { openSharedMaintenancePermitSocket } = await import("./shared-maintenance-startup.js");
  const local = await openSharedMaintenancePermitSocket({ publicKey: keys.publicKey });
  const call = (method: string, path: string, body?: string) => new Promise<{ code: number; body: string }>((resolve, reject) => {
    const request = httpRequest({ socketPath: local.socket, method, path }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ code: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });
  try {
    expect((await stat(local.socket)).mode & 0o777).toBe(0o600);
    const first = new AbortController();
    const initial = { ...scope, nonce: "2".repeat(64) };
    const abandoned = local.read(initial, first.signal);
    const stopped = expect(abandoned).rejects.toThrow();
    expect(await call("GET", "/nonce")).toEqual({ code: 200, body: initial.nonce });
    expect((await call("GET", "/debug")).code).toBe(404);
    expect((await call("POST", "/permit", JSON.stringify(issue({ ...initial, podUid: "foreign" })))).code).toBe(403);
    first.abort(new Error("operator withdrew"));
    await stopped;
    expect((await call("GET", "/nonce")).code).toBe(409);

    const next = { ...scope, nonce: "3".repeat(64) };
    const waiting = local.read(next, new AbortController().signal);
    expect((await call("POST", "/permit", JSON.stringify(issue(initial)))).code).toBe(403);
    expect((await call("POST", "/permit", JSON.stringify(issue(next, archive, Date.now() - 1)))).code).toBe(403);
    const valid = issue(next);
    expect((await call("POST", "/permit", JSON.stringify(valid))).code).toBe(204);
    await expect(waiting).resolves.toEqual(valid);
    expect((await call("POST", "/permit", JSON.stringify(valid))).code).toBe(409);
  } finally {
    await local.close();
  }
});

it("guards the actual entry point with a reviewed regular enrollment file and exact local restart receipt", async () => {
  const { chmod, mkdtemp, rm, symlink, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { sharedMaintenanceCompletionPurpose, waitForInstalledSharedMaintenanceGate } = await import("./shared-maintenance-startup.js");
  const directory = await mkdtemp(join(tmpdir(), "held-shared-entry-"));
  const files = {
    enrollment: join(directory, "enrollment.json"), completion: join(directory, "completed.json"),
    projectedToken: join(directory, "projected"), enrollmentOwnerUid: process.getuid!(),
  };
  const { role, ...scopeOnly } = scope;
  const enrollment = { ...scopeOnly, version: 1, environment: "test", enrolledIssuerPublicKey: keys.publicKey };
  const env = { GATEWAY_CLASS: "shared", K8S_NAMESPACE: scope.namespace, GATEWAY_ID: scope.gatewayId };
  const hold = vi.fn(async () => {});
  const start = (environment = env, paths = files) => waitForInstalledSharedMaintenanceGate(role, environment, { files: paths, hold });
  const token = (uid: string) => "unused." + Buffer.from(JSON.stringify({
    aud: ["octogee-api-gateway-credentials"], "kubernetes.io": { namespace: scope.namespace, pod: { uid } },
  })).toString("base64url") + ".fixture";
  try {
    await start();
    expect(hold).not.toHaveBeenCalled();
    await writeFile(files.enrollment, "not-json");
    await start({ ...env, GATEWAY_CLASS: "isolated" });
    await expect(start()).rejects.toThrow();
    await writeFile(files.enrollment, JSON.stringify(enrollment));
    await start({ ...env, GATEWAY_ID: "ordinary-shared" });
    await start({ ...env, K8S_NAMESPACE: "another-namespace" });
    expect(hold).not.toHaveBeenCalled();
    await expect(start(env, { ...files, enrollmentOwnerUid: files.enrollmentOwnerUid + 1 })).rejects.toThrow(/immutable image file/);
    await chmod(files.enrollment, 0o666);
    await expect(start()).rejects.toThrow(/immutable image file/);
    await chmod(files.enrollment, 0o644);
    const linkName = join(directory, "symlink");
    await symlink(files.enrollment, linkName);
    await expect(start(env, { ...files, enrollment: linkName })).rejects.toThrow(/ELOOP/);

    const raw = JSON.stringify({ scope: scopeOnly, restoredArchiveSha256: archive,
      images: { gateway: "sha256:" + "1".repeat(64), "gateway-edge": "sha256:" + "2".repeat(64) },
      publication: { release: 7, payloadHash: archive, publishedAt: Date.now() - 100 },
    });
    await writeFile(files.completion, JSON.stringify({ raw, signature: signFleetRequest(keys.privateKey,
      sharedMaintenanceCompletionPurpose(scopeOnly), raw) }));
    await writeFile(files.projectedToken, token("foreign-pod"));
    await start();
    expect(hold).toHaveBeenCalledExactlyOnceWith(scope, keys.publicKey);
    await writeFile(files.projectedToken, token(scope.podUid));
    await start();
    expect(hold).toHaveBeenCalledOnce();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
