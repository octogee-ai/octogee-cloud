import { describe, it, expect, vi } from "vitest";
import { gatewayScopedJobId, signFleetRequest, sourceActivationReadinessJobId, verifyFleetRequest } from "./fleet-signature.js";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";
import {
  CONFIG_PATCH_DEADLINE_MS,
  SIGNATURE_HEADER,
  MIGRATION_QUIESCE_TIMEOUT_MS,
  MIGRATION_UNMOUNT_TIMEOUT_MS,
  MIGRATION_VERIFY_TIMEOUT_MS,
} from "@octogee/shared/types/fleet-controller";
import {
  createMigrationClient,
  reportMigrationProgress,
  isDefinitiveConfigRpcRejection,
  MigrationTransportError,
} from "./fleet-migration-client.js";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function captureFetch(handler: (call: CapturedCall) => Response | Promise<Response>) {
  const calls: CapturedCall[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
    }
    let body: string | null = null;
    if (typeof init?.body === "string") body = init.body;
    const call: CapturedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fakeFetch };
}

const PRIVATE_KEY = FLEET_KEY_PAIR.privateKey;

describe("MigrationClient Native source activation readiness", () => {
  const scope = { migrationId: "mig-1", gatewayId: "source", slug: "alice" };
  const acknowledgement = { migrationId: "mig-1", slug: "alice", exportable: true };
  const url = "http://source/source-activation-ready/source";

  it("requests a scoped boolean using a signature that cannot authorize the manifest endpoint", async () => {
    const { calls, fakeFetch } = captureFetch(() => Response.json(acknowledgement));
    const client = createMigrationClient({ privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "http://source", fetch: fakeFetch, transferState: transferNotUnderTest });
    expect(await client.sourceActivationReadiness(scope)).toBe("ready");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url });
    const body = calls[0].body!;
    const signature = calls[0].headers[SIGNATURE_HEADER.toLowerCase()];
    expect(JSON.parse(body)).toEqual({ migrationId: "mig-1", slug: "alice" });
    expect(verifyFleetRequest(FLEET_KEY_PAIR.publicKey, sourceActivationReadinessJobId("mig-1", "source"), body, signature)).toBe(true);
    expect(verifyFleetRequest(FLEET_KEY_PAIR.publicKey, gatewayScopedJobId("mig-1", "source"), body, signature)).toBe(false);
  });

  it("distinguishes the old Express route absence and makes no manifest or transfer fallback request", async () => {
    const { calls, fakeFetch } = captureFetch(() => new Response(
      `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Error</title>
</head>
<body>
<pre>Cannot POST /source-activation-ready/source</pre>
</body>
</html>
`,
      { status: 404, headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" } },
    ));
    const client = createMigrationClient({ privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "http://source", fetch: fakeFetch, transferState: transferNotUnderTest });
    expect(await client.sourceActivationReadiness(scope)).toBe("unsupported");
    expect(calls).toEqual([expect.objectContaining({ url })]);
  });

  it.each([
    () => Response.json({ ...acknowledgement, exportable: false }),
    () => Response.json({ ...acknowledgement, migrationId: "other" }),
    () => Response.json({ ...acknowledgement, slug: "other" }),
    () => Response.json({ ...acknowledgement, exportable: "true" }),
    () => Response.json({ ...acknowledgement, manifest: { credential: "mock-secret" } }),
    () => new Response("mock-secret", { status: 500 }),
    () => new Response("malformed mock-secret", { status: 200 }),
    () => new Response("missing", { status: 404 }),
    () => new Response(JSON.stringify(acknowledgement), { status: 200 }),
    () => Response.json(acknowledgement, { status: 202 }),
    () => new Response("<pre>Cannot POST /source-activation-ready/foreign</pre>", { status: 404, headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" } }),
    () => { throw new Error("transport timed out"); },
  ])("rejects missing, mismatched and failed proofs without logging or falling back", async response => {
    const log = vi.fn();
    const { calls, fakeFetch } = captureFetch(response);
    const client = createMigrationClient({ privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "http://source", fetch: fakeFetch, transferState: transferNotUnderTest, log });
    expect(await client.sourceActivationReadiness(scope)).toBe("unavailable");
    expect(calls).toEqual([expect.objectContaining({ url })]);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("MigrationClient abandoned import cleanup", () => {
  it("resolves abandoned attempt ownership before signing recovery cleanup", async () => {
    const { calls, fakeFetch } = captureFetch(() => Response.json({ migrationId: "mig-1", slug: "alice", imported: false }));
    const resolveTransferAttemptForCleanup = vi.fn(async () => "abandoned-attempt");
    const client = createMigrationClient({ privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "http://target", fetch: fakeFetch,
      transferState: transferNotUnderTest, resolveTransferAttemptForCleanup });
    await client.abortImport({ gatewayId: "target", migrationId: "mig-1", slug: "alice", mode: "final" });
    expect(resolveTransferAttemptForCleanup).toHaveBeenCalledWith({ gatewayId: "target", migrationId: "mig-1", slug: "alice", mode: "final" });
    expect(JSON.parse(calls[0].body!)).toMatchObject({ transferAttemptId: "abandoned-attempt" });
    resolveTransferAttemptForCleanup.mockRejectedValueOnce(new Error("newer owner is running"));
    await expect(client.abortImport({ gatewayId: "target", migrationId: "mig-1", slug: "alice", mode: "final" })).rejects.toThrow("newer owner");
    expect(calls).toHaveLength(1);
  });
  it("does not accept an unmount acknowledgement for another migration", async () => {
    const client = createMigrationClient({ privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "http://target", fetch: captureFetch(() => Response.json({ migrationId: "other", slug: "alice", unmounted: true })).fakeFetch, transferState: transferNotUnderTest });
    await expect(client.unmount({ gatewayId: "target", migrationId: "mig-1", slug: "alice" })).rejects.toThrow(/acknowledgement/);
  });
  it.each(["keys", "pre", "final"] as const)("signs and checks the exact %s import acknowledgement", async (mode) => {
    const { calls, fakeFetch } = captureFetch(() => Response.json({ migrationId: "mig-1", slug: "alice", imported: false }));
    const client = createMigrationClient({ privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "http://target", fetch: fakeFetch, transferState: transferNotUnderTest });
    await client.abortImport({ gatewayId: "target", migrationId: "mig-1", slug: "alice", mode });
    expect(calls[0].url).toBe("http://target/abort-rsync-import/target");
    expect(JSON.parse(calls[0].body!)).toMatchObject({ migrationId: "mig-1", slug: "alice", mode, rpcPhase: "abort-rsync-import" });
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBeTruthy();
  });

  it.each([
    { migrationId: "other", slug: "alice", imported: false },
    { migrationId: "mig-1", slug: "other", imported: false },
    { migrationId: "mig-1", slug: "alice", imported: true },
  ])("rejects a mismatched acknowledgement %j", async (response) => {
    const client = createMigrationClient({ privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "http://target", fetch: captureFetch(() => Response.json(response)).fakeFetch, transferState: transferNotUnderTest });
    await expect(client.abortImport({ gatewayId: "target", migrationId: "mig-1", slug: "alice", mode: "final" })).rejects.toThrow(/acknowledgement/);
  });
});
const transferNotUnderTest = async (): Promise<never> => {
  throw new Error("state transfer is not under test");
};
const SNAPSHOT: FleetBrokerUserSnapshot = {
  uid: "uid-alice",
  slug: "alice",
  contextTemplateKey: "default",
  planInputs: {},
  gatewayId: "gw-blue",
  status: "complete",
  agentIds: ["octogee-alice-coach"],
  repoUrl: "git@gitea:octogee/alice.git",
  mattermostUserId: "mm-alice",
  customerMmUserId: "mm-alice",
  channels: [],
  projects: [],
  ownerName: "Alice",
  email: "alice@example.com",
  displayName: "Alice",
  lastName: "",
  photoURL: "",
  persona: null,
  coachToken: "coach-token",
  coachMmUserId: "mm-coach",
};

describe("isDefinitiveConfigRpcRejection", () => {
  it("treats non-retryable 4xx and 501 as terminal but retries availability", () => {
    expect(isDefinitiveConfigRpcRejection({ status: 501 })).toBe(true);
    expect(isDefinitiveConfigRpcRejection({ status: 400 })).toBe(true);
    expect(isDefinitiveConfigRpcRejection({ status: 409 })).toBe(true);
    expect(isDefinitiveConfigRpcRejection({ status: 503 })).toBe(false);
    expect(isDefinitiveConfigRpcRejection({ status: 429 })).toBe(false);
    expect(isDefinitiveConfigRpcRejection({ status: 408 })).toBe(false);
  });
});

describe("MigrationClient transport normalization", () => {
  it.each([
    new TypeError("fetch failed"),
    Object.assign(new Error("socket terminated"), { code: "UND_ERR_SOCKET" }),
    Object.assign(new Error("premature close"), { code: "ECONNRESET" }),
  ])("normalizes raw fetch transport failures as retryable", async (failure) => {
    const client = createMigrationClient({
      transferState: transferNotUnderTest,
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://source.example.com",
      fetch: vi.fn(async () => { throw failure; }),
    });

    await expect(client.quiesce({
      migrationId: "mig-1",
      gatewayId: "source",
      slug: "alice",
    })).rejects.toBeInstanceOf(MigrationTransportError);
  });

  it("normalizes a truncated successful JSON response as retryable transport loss", async () => {
    const client = createMigrationClient({
      transferState: transferNotUnderTest,
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://source.example.com",
      fetch: vi.fn(async () => new Response('{"migrationId":"mig-1"', {
        status: 200,
        headers: { "content-type": "application/json" },
      })),
    });

    await expect(client.quiesce({
      migrationId: "mig-1",
      gatewayId: "source",
      slug: "alice",
    })).rejects.toMatchObject({
      name: "MigrationTransportError",
      retryable: true,
    });
  });
});

describe("MigrationClient.quiesce", () => {
  it("POSTs JSON to /quiesce/{gatewayId} signed by the fleet controller private key", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      transferState: transferNotUnderTest,
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet-test.example.com`,
      fetch: fakeFetch,
    });
    const res = await client.quiesce({
      migrationId: "m1",
      gatewayId: "gw-source",
      slug: "alice",
      timeoutMs: 30_000,
    });
    expect(res).toMatchObject({ migrationId: "m1", slug: "alice", drained: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://fleet-test.example.com/quiesce/gw-source");
    expect(calls[0].method).toBe("POST");
    const expectedSig = signFleetRequest(
      PRIVATE_KEY,
      gatewayScopedJobId("m1", "gw-source"),
      calls[0].body!,
    );
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBe(expectedSig);
    const parsed = JSON.parse(calls[0].body!);
    expect(parsed).toMatchObject({ migrationId: "m1", slug: "alice", timeoutMs: 30_000 });
  });

  it("throws on non-2xx response with the gateway's error body in the message", async () => {
    const { fakeFetch } = captureFetch(() =>
      new Response(JSON.stringify({ error: "invalid signature" }), { status: 401 }),
    );
    const client = createMigrationClient({
      transferState: transferNotUnderTest,
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    await expect(
      client.quiesce({ migrationId: "m1", gatewayId: "gw", slug: "alice" }),
    ).rejects.toThrow(/quiesce.*401.*invalid signature/i);
  });

  it("throws when the gateway returns drained=false with a runningCount", async () => {
    const { fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", drained: false, runningCount: 2 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      transferState: transferNotUnderTest,
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    await expect(
      client.quiesce({ migrationId: "m1", gatewayId: "gw", slug: "alice" }),
    ).rejects.toThrow(/did not drain.*2 still running/i);
  });
});

describe("MigrationClient — transport/tenant split", () => {
  it("quiesce: URL uses transportId (revision service), path uses bare gatewayId", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      transferState: transferNotUnderTest,
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: (id) =>
        id === "default-r1" ? "https://rev1.example.com" : `https://${id}.example.com`,
      fetch: fakeFetch,
    });
    await client.quiesce({
      migrationId: "m1",
      gatewayId: "default",
      transportId: "default-r1",
      slug: "alice",
    });
    expect(calls[0].url).toBe("https://rev1.example.com/quiesce/default");
  });

  it("verifyTarget + restoreTarget + unmount: transport for URL, bare for path", async () => {
    const { calls, fakeFetch } = captureFetch((call) => {
      if (call.url.includes("/verify/")) {
        return new Response(
          JSON.stringify({
            migrationId: "m1",
            slug: "alice",
            ready: true,
            checks: { customerDir: true, coachWired: true, mountMarked: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (call.url.includes("/restore/")) {
        return new Response(
          JSON.stringify({ migrationId: "m1", slug: "alice", restored: true, steps: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", unmounted: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createMigrationClient({
      transferState: transferNotUnderTest,
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: (id) => `https://${id}.example.com`,
      fetch: fakeFetch,
    });
    await client.verifyTarget({ migrationId: "m1", gatewayId: "default", transportId: "default-r2", slug: "alice" });
    await client.restoreTarget({
      migrationId: "m1",
      gatewayId: "default",
      transportId: "default-r2",
      uid: "uid-alice",
      slug: "alice",
      snapshot: SNAPSHOT,
    });
    await client.unmount({ migrationId: "m1", gatewayId: "default", transportId: "default-r1", slug: "alice" });
    expect(calls[0].url).toBe("https://default-r2.example.com/verify/default");
    expect(calls[1].url).toBe("https://default-r2.example.com/restore/default");
    expect(calls[2].url).toBe("https://default-r1.example.com/unmount/default");
  });

});

describe("MigrationClient.flushGateway", () => {
  it("binds the source's accepted system-config commit into the signed target converge request", async () => {
    const acceptedCommit = "a".repeat(40);
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({
          migrationId: "m1",
          slug: "alice",
          ok: true,
          durationMs: 1,
          steps: [],
          systemConfigCommit: acceptedCommit,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      transferState: transferNotUnderTest,
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://target.example.com",
      fetch: fakeFetch,
    });

    await client.flushGateway({
      migrationId: "m1",
      gatewayId: "target",
      slug: "alice",
      reason: "migration-converge",
      expectedSystemConfigCommit: acceptedCommit,
    });

    expect(JSON.parse(calls[0].body!)).toEqual({
      migrationId: "m1",
      slug: "alice",
      reason: "migration-converge",
      expectedSystemConfigCommit: acceptedCommit,
    });
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()])
      .toBe(signFleetRequest(PRIVATE_KEY, gatewayScopedJobId("m1", "target"), calls[0].body!));
  });
});

describe("MigrationClient.unmount", () => {
  it("POSTs JSON to /unmount/{gatewayId} signed identically to quiesce", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", unmounted: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      transferState: transferNotUnderTest,
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    const res = await client.unmount({ migrationId: "m1", gatewayId: "gw-source", slug: "alice" });
    expect(res.unmounted).toBe(true);
    expect(calls[0].url).toBe("https://fleet.example.com/unmount/gw-source");
    const parsed = JSON.parse(calls[0].body!);
    expect(parsed).toMatchObject({ migrationId: "m1", slug: "alice" });
    const expectedSig = signFleetRequest(PRIVATE_KEY, gatewayScopedJobId("m1", "gw-source"), calls[0].body!);
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBe(expectedSig);
  });

  it("treats unmounted=false as success (idempotent — already gone)", async () => {
    const { fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", unmounted: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      transferState: transferNotUnderTest,
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    const res = await client.unmount({ migrationId: "m1", gatewayId: "gw-source", slug: "alice" });
    expect(res.unmounted).toBe(false); 
  });
});

describe("MigrationClient verification errors", () => {
  it("retains structured readiness details for scoped recovery without parsing error messages", async () => {
    const details = {
      migrationId: "m1", slug: "alice", ready: false,
      checks: { customerDir: true, coachWired: true, mountMarked: false },
    };
    const { fakeFetch } = captureFetch(() => new Response(JSON.stringify(details), { status: 409 }));
    const client = createMigrationClient({
      transferState: transferNotUnderTest, privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://fleet.example.com", fetch: fakeFetch,
    });
    await expect(client.verifyTarget({ migrationId: "m1", gatewayId: "gw-green", slug: "alice" }))
      .rejects.toMatchObject({ status: 409, details });
  });

  it.each([
    [{ error: "scheduler migration failed", message: "socket closed before cron.migration response", retryable: true }, true],
    [{ error: "scheduler migration failed", message: "Cron migration requires an explicit owner", retryable: false }, false],
    [{ error: "scheduler migration failed", message: "socket closed before cron.migration response" }, undefined],
    [{ error: "scheduler migration failed", message: "socket closed before cron.migration response", retryable: "yes" }, undefined],
  ])("carries the gateway's verdict on whether a refused request may yet succeed, when it gives one: %o", async (reply, retryable) => {
    const { fakeFetch } = captureFetch(() => new Response(JSON.stringify(reply), { status: 500 }));
    const client = createMigrationClient({
      transferState: transferNotUnderTest, privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://fleet.example.com", fetch: fakeFetch,
    });
    await expect(client.scheduler({ migrationId: "m1", gatewayId: "gw-green", slug: "alice", phase: "activate" }))
      .rejects.toMatchObject({ name: "MigrationRpcError", status: 500, retryable });
  });
});

describe("MigrationClient.restoreTarget", () => {
  it.each([false, true])("POSTs the durable snapshot to the signed native restore endpoint (resume=%s)", async (resume) => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({
          migrationId: "m1",
          slug: "alice",
          restored: true,
          steps: ["clone-workspace-repo"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    let ownershipPrepared = false;
    const client = createMigrationClient({
      prepareAgentStores: async (gatewayId, slug) => {
        expect({ gatewayId, slug }).toEqual({ gatewayId: "gw-green", slug: "alice" });
        expect(calls).toHaveLength(0);
        ownershipPrepared = true;
      },
      transferState: transferNotUnderTest,
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    const res = await client.restoreTarget({
      migrationId: "m1",
      gatewayId: "gw-green",
      uid: "uid-alice",
      slug: "alice",
      snapshot: SNAPSHOT,
      resume,
    });
    expect(ownershipPrepared).toBe(true);
    expect(res.restored).toBe(true);
    expect(calls[0].url).toBe(`https://fleet.example.com/${resume ? "resume-restore" : "restore"}/gw-green`);
    const parsed = JSON.parse(calls[0].body!);
    expect(parsed).toMatchObject({
      migrationId: "m1",
      uid: "uid-alice",
      slug: "alice",
      snapshot: { uid: "uid-alice", slug: "alice", coachToken: "coach-token" },
    });
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBe(
      signFleetRequest(PRIVATE_KEY, gatewayScopedJobId("m1", "gw-green"), calls[0].body!),
    );
  });
});

describe("MigrationClient.transferState", () => {
  it("hands every state transfer to the injected transport", async () => {
    const transferState = vi.fn(async () => ({ migrationId: "mig-1", slug: "alice", imported: true }));
    const client = createMigrationClient({
      privateKey: FLEET_KEY_PAIR.privateKey,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: vi.fn() as unknown as typeof fetch,
      transferState,
    });
    const request = { migrationId: "mig-1", fromGatewayId: "gw-a", toGatewayId: "gw-b", slug: "alice", mode: "final" as const };

    await expect(client.transferState(request)).resolves.toEqual({ migrationId: "mig-1", slug: "alice", imported: true });
    expect(transferState).toHaveBeenCalledWith(request);
  });
});

describe("MigrationClient.verifyTarget", () => {
  it("POSTs signed JSON to /verify/{gatewayId} and returns the ready result", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({
          migrationId: "m1",
          slug: "alice",
          ready: true,
          checks: {
            customerDir: true,
            coachWired: true,
            mountMarked: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      transferState: transferNotUnderTest,
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    const res = await client.verifyTarget({
      migrationId: "m1",
      gatewayId: "gw-green",
      slug: "alice",
    });
    expect(res.ready).toBe(true);
    expect(calls[0].url).toBe("https://fleet.example.com/verify/gw-green");
    expect(JSON.parse(calls[0].body!)).toEqual({ migrationId: "m1", slug: "alice" });
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBe(
      signFleetRequest(PRIVATE_KEY, gatewayScopedJobId("m1", "gw-green"), calls[0].body!),
    );
  });

  it("throws when the target reports ready=false", async () => {
    const { fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({
          migrationId: "m1",
          slug: "alice",
          ready: false,
          checks: {
            customerDir: true,
            coachWired: true,
            mountMarked: false,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      transferState: transferNotUnderTest,
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    await expect(
      client.verifyTarget({ migrationId: "m1", gatewayId: "gw-green", slug: "alice" }),
    ).rejects.toThrow(/target verify failed.*mountMarked/i);
  });
});

describe("MigrationClient — per-RPC AbortSignal timeouts", () => {
  function captureSignal(): {
    fakeFetch: typeof fetch;
    seenSignal: () => AbortSignal | undefined;
  } {
    let lastSignal: AbortSignal | undefined;
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      lastSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ drained: true, runningCount: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { fakeFetch, seenSignal: () => lastSignal };
  }

  it("passes an AbortSignal on quiesce derived from MIGRATION_QUIESCE_TIMEOUT_MS", async () => {
    const { fakeFetch, seenSignal } = captureSignal();
    const client = createMigrationClient({
      transferState: transferNotUnderTest,
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://fleet.example.com",
      fetch: fakeFetch,
    });
    await client.quiesce({ migrationId: "m1", gatewayId: "gw", slug: "alice" });
    expect(seenSignal()).toBeInstanceOf(AbortSignal);
    expect(MIGRATION_QUIESCE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it.each([undefined, 120_000])("lets the bounded drain return before the HTTP deadline: %s", async (timeoutMs) => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      const { fakeFetch } = captureSignal();
      const client = createMigrationClient({
        transferState: transferNotUnderTest, privateKey: PRIVATE_KEY,
        resolveGatewayUrl: () => "https://fleet.example.com", fetch: fakeFetch,
      });
      await client.quiesce({ migrationId: "m1", gatewayId: "gw", slug: "alice", timeoutMs });
      expect(timer).toHaveBeenCalledWith(expect.any(Function), (timeoutMs ?? MIGRATION_QUIESCE_TIMEOUT_MS) + 30_000);
    } finally {
      timer.mockRestore();
    }
  });

  it("aborts and reports a path-tagged timeout when the server stalls past the deadline", async () => {
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener(
            "abort",
            () => reject((signal as AbortSignal).reason ?? new Error("aborted")),
            { once: true },
          );
        }
      });
    }) as typeof fetch;

    const client = createMigrationClient({
      transferState: transferNotUnderTest,
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://fleet.example.com",
      fetch: fakeFetch,
      timeouts: {
        quiesceMs: 25,
        transferMs: 25,
        unmountMs: 25,
        verifyMs: 25,
      },
    });

    await expect(
      client.unmount({ migrationId: "m1", gatewayId: "gw", slug: "alice" }),
    ).rejects.toThrow(/unmount.*timed out.*25ms/i);
  });

  it("gives source unmount enough time for agent deletion and its config cleanup", () => {
    expect(CONFIG_PATCH_DEADLINE_MS).toBe(120_000);
    expect(MIGRATION_UNMOUNT_TIMEOUT_MS).toBe(2 * CONFIG_PATCH_DEADLINE_MS + 30_000);
  });

  it("passes the AbortSignal on /verify inside verifyTarget", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Response(JSON.stringify({
        migrationId: "m1",
        slug: "alice",
        ready: true,
        checks: {
          customerDir: true,
          coachWired: true,
          mountMarked: true,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = createMigrationClient({
      transferState: transferNotUnderTest,
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://fleet.example.com",
      fetch: fakeFetch,
    });
    await client.verifyTarget({
      migrationId: "m1",
      gatewayId: "gw-green",
      slug: "alice",
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(MIGRATION_VERIFY_TIMEOUT_MS).toBeGreaterThan(0);
  });
});


it("signs destination progress for its target gateway and preserves HTTP failure", async () => {
  const event = { migrationId: "m1", slug: "alice", source: "gw-old", phase: "quiesce-source", status: "done" as const, elapsedMs: 12 };
  const { calls, fakeFetch } = captureFetch(() => new Response(JSON.stringify({ ok: true })));
  await reportMigrationProgress({ privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "http://gw-new", fetch: fakeFetch }, "gw-new", event);
  expect(calls[0].url).toBe("http://gw-new/migration-progress/gw-new");
  expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBe(signFleetRequest(PRIVATE_KEY, gatewayScopedJobId("m1", "gw-new"), JSON.stringify(event)));
  const failed = captureFetch(() => new Response("offline", { status: 503 }));
  await expect(reportMigrationProgress({ privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "http://gw-new", fetch: failed.fakeFetch }, "gw-new", event)).rejects.toThrow();
});

describe("MigrationClient.resume", () => {
  it.each([true, false])("restores source ownership before resuming ingress (ownership succeeds=%s)", async succeeds => {
    const { calls, fakeFetch } = captureFetch(() => new Response(JSON.stringify({ resumed: true }), { status: 200 }));
    const prepareAgentStores = async (gatewayId: string, slug: string) => {
      expect({ gatewayId, slug }).toEqual({ gatewayId: "source", slug: "alice" });
      expect(calls).toHaveLength(0);
      if (!succeeds) throw new Error("ownership failed");
    };
    const client = createMigrationClient({ transferState: transferNotUnderTest, privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "https://source.example.com", fetch: fakeFetch, prepareAgentStores });
    const result = client.resume({ migrationId: "m1", gatewayId: "source", slug: "alice" });
    if (succeeds) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow("ownership failed");
    expect(calls).toHaveLength(succeeds ? 1 : 0);
  });

  it.each([true, false])("requires an acknowledged restart (resumed=%s)", async (resumed) => {
    const { calls, fakeFetch } = captureFetch(() => new Response(JSON.stringify({ resumed }), { status: 200 }));
    const client = createMigrationClient({ privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "https://source.example.com", fetch: fakeFetch, transferState: transferNotUnderTest });
    const result = client.resume({ migrationId: "m1", gatewayId: "source", slug: "alice" });
    if (resumed) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow("did not resume");
    expect(calls[0].url).toBe("https://source.example.com/resume/source");
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBeTruthy();
  });
});

describe("MigrationClient.schedules", () => {
  const record = { sourceJobId: "job-1", agentId: "octogee-alice-coach", job: { name: "standup", schedule: { kind: "cron", expr: "0 9 * * *" } } };

  function schedulesClient(response: unknown) {
    const { calls, fakeFetch } = captureFetch(() => new Response(JSON.stringify(response), { status: 200 }));
    const client = createMigrationClient({ transferState: transferNotUnderTest, privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "https://fleet-test.example.com", fetch: fakeFetch });
    return { calls, client };
  }

  it("signs a snapshot for its exact gateway and returns the captured records", async () => {
    const result = { migrationId: "m1", slug: "alice", op: "snapshot", records: [record], skipped: [] };
    const { calls, client } = schedulesClient(result);

    await expect(client.schedules({ migrationId: "m1", slug: "alice", gatewayId: "gw-source", op: "snapshot" })).resolves.toEqual(result);

    expect(calls[0].url).toBe("https://fleet-test.example.com/schedules/gw-source");
    expect(JSON.parse(calls[0].body!)).toEqual({ migrationId: "m1", slug: "alice", op: "snapshot" });
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBe(signFleetRequest(PRIVATE_KEY, gatewayScopedJobId("m1", "gw-source"), calls[0].body!));
  });

  it("sends the records to restore and returns the target's tally", async () => {
    const result = { migrationId: "m1", slug: "alice", op: "restore", created: 1, existing: 0, failed: [] };
    const { calls, client } = schedulesClient(result);

    await expect(client.schedules({ migrationId: "m1", slug: "alice", gatewayId: "gw-target", op: "restore", records: [record] })).resolves.toEqual(result);

    expect(calls[0].url).toBe("https://fleet-test.example.com/schedules/gw-target");
    expect(JSON.parse(calls[0].body!)).toEqual({ migrationId: "m1", slug: "alice", op: "restore", records: [record] });
  });

  it("asks the source to remove the saved jobs and returns its tally", async () => {
    const result = { migrationId: "m1", slug: "alice", op: "remove", removed: 1, failed: [] };
    const { calls, client } = schedulesClient(result);

    await expect(client.schedules({ migrationId: "m1", slug: "alice", gatewayId: "gw-source", op: "remove", jobIds: ["job-1"] })).resolves.toEqual(result);

    expect(JSON.parse(calls[0].body!)).toEqual({ migrationId: "m1", slug: "alice", op: "remove", jobIds: ["job-1"] });
  });

  it("asks a gateway which records would collide by name with a live schedule", async () => {
    const result = { migrationId: "m1", slug: "alice", op: "check", conflicts: [{ name: "standup", agentId: "octogee-alice-coach", sourceJobId: "job-1", jobId: "job-9" }] };
    const { calls, client } = schedulesClient(result);

    await expect(client.schedules({ migrationId: "m1", slug: "alice", gatewayId: "gw-target", op: "check", records: [record] })).resolves.toEqual(result);

    expect(calls[0].url).toBe("https://fleet-test.example.com/schedules/gw-target");
    expect(JSON.parse(calls[0].body!)).toEqual({ migrationId: "m1", slug: "alice", op: "check", records: [record] });
  });

  it("refuses a check acknowledgement without a conflict list", async () => {
    const { client } = schedulesClient({ migrationId: "m1", slug: "alice", op: "check", failed: [] });

    await expect(client.schedules({ migrationId: "m1", slug: "alice", gatewayId: "gw-target", op: "check", records: [record] })).rejects.toThrow("schedules check acknowledgement mismatch");
  });

  it.each([
    { migrationId: "m1", slug: "alice", op: "remove", failed: [] },
    { migrationId: "m1", slug: "alice", op: "remove", removed: 1 },
    { migrationId: "m1", slug: "alice", op: "restore", created: 0, existing: 0, failed: [] },
  ])("refuses a remove acknowledgement that does not match the request %j", async (payload) => {
    const { client } = schedulesClient(payload);

    await expect(client.schedules({ migrationId: "m1", slug: "alice", gatewayId: "gw-source", op: "remove", jobIds: ["job-1"] })).rejects.toThrow("schedules remove acknowledgement mismatch");
  });

  it.each([
    { migrationId: "other", slug: "alice", op: "snapshot", records: [], skipped: [] },
    { migrationId: "m1", slug: "bob", op: "snapshot", records: [], skipped: [] },
    { migrationId: "m1", slug: "alice", op: "restore", created: 0, existing: 0, failed: [] },
    { migrationId: "m1", slug: "alice", op: "snapshot", skipped: [] },
  ])("refuses a snapshot acknowledgement that does not match the request %j", async (payload) => {
    const { client } = schedulesClient(payload);

    await expect(client.schedules({ migrationId: "m1", slug: "alice", gatewayId: "gw-source", op: "snapshot" })).rejects.toThrow("schedules snapshot acknowledgement mismatch");
  });

  it("refuses a restore acknowledgement without a failure list", async () => {
    const { client } = schedulesClient({ migrationId: "m1", slug: "alice", op: "restore", created: 1, existing: 0 });

    await expect(client.schedules({ migrationId: "m1", slug: "alice", gatewayId: "gw-target", op: "restore", records: [record] })).rejects.toThrow("schedules restore acknowledgement mismatch");
  });
});

describe("MigrationClient.scheduler", () => {
  it("asks the source to retain host-bound jobs only inside a scheduler handoff", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(JSON.stringify({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 }), { status: 200 }));
    const client = createMigrationClient({ transferState: transferNotUnderTest, privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "https://fleet-test.example.com", fetch: fakeFetch });
    await client.quiesce({ migrationId: "m1", gatewayId: "gw-source", slug: "alice", schedulerHandoff: true, schedulerMigrationId: "m1:scheduler:1", retainNonportable: true });
    expect(JSON.parse(calls[0].body!)).toEqual({ migrationId: "m1", slug: "alice", schedulerHandoff: true, schedulerMigrationId: "m1:scheduler:1", retainNonportable: true });
    await client.quiesce({ migrationId: "m1", gatewayId: "gw-source", slug: "alice", retainNonportable: true });
    expect(JSON.parse(calls[1].body!)).toEqual({ migrationId: "m1", slug: "alice" });
  });

  it("carries the partial-handoff flag on a scheduler command", async () => {
    const result = { operationId: "handoff-1", phase: "export", agentIds: ["octogee-alice-coach"], drained: true, snapshot: { retainedJobIds: ["desktop-watch"] } };
    const { fakeFetch, calls } = captureFetch(() => new Response(JSON.stringify(result), { status: 200 }));
    const client = createMigrationClient({ privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "https://fleet-test.example.com", fetch: fakeFetch, transferState: transferNotUnderTest });
    await expect(client.scheduler({ migrationId: "handoff-1", slug: "alice", gatewayId: "gw-source", phase: "export", retainNonportable: true })).resolves.toEqual(result);
    expect(JSON.parse(calls[0].body!)).toEqual({ migrationId: "handoff-1", slug: "alice", phase: "export", retainNonportable: true });
  });

  it("signs the scheduler command for its exact gateway and operation", async () => {
    const result = { operationId: "handoff-1", phase: "hold", agentIds: ["octogee-alice-coach"], drained: true };
    const { fakeFetch, calls } = captureFetch(() => new Response(JSON.stringify(result), { status: 200 }));
    const client = createMigrationClient({ privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "https://fleet-test.example.com", fetch: fakeFetch, transferState: transferNotUnderTest });
    await expect(client.scheduler({ migrationId: "handoff-1", slug: "alice", gatewayId: "gw-source", phase: "hold" })).resolves.toEqual(result);
    expect(calls[0].url).toBe("https://fleet-test.example.com/scheduler/gw-source");
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBe(signFleetRequest(PRIVATE_KEY, gatewayScopedJobId("handoff-1", "gw-source"), calls[0].body!));
  });

  it.each([
    { operationId: "wrong", phase: "hold", agentIds: [], drained: true },
    { operationId: "handoff-1", phase: "hold", agentIds: [], drained: true },
    { operationId: "handoff-1", phase: "hold", agentIds: [], drained: false },
    { operationId: "handoff-1", phase: "stage", agentIds: [], drained: true },
  ])("refuses an unproven scheduler acknowledgement %j", async (payload) => {
    const { fakeFetch } = captureFetch(() => new Response(JSON.stringify(payload), { status: 200 }));
    const client = createMigrationClient({ privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "https://fleet-test.example.com", fetch: fakeFetch, transferState: transferNotUnderTest });
    await expect(client.scheduler({ migrationId: "handoff-1", slug: "alice", gatewayId: "gw-source", phase: "hold" })).rejects.toThrow("did not prove");
  });

  const requesterProbe = { migrationId: "handoff-1", slug: "alice", gatewayId: "gw-target", phase: "stage-requester" as const };
  const requesterResult = { operationId: requesterProbe.migrationId, phase: requesterProbe.phase, agentIds: [], drained: true };
  it.each(["shared-operator", null])("reads the staging requester over the fleet transport (%s)", async stageRequesterProfileId => {
    const result = { ...requesterResult, stageRequesterProfileId };
    const { fakeFetch } = captureFetch(() => new Response(JSON.stringify(result)));
    const client = createMigrationClient({ privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "https://fleet-test.example.com", fetch: fakeFetch, transferState: transferNotUnderTest });
    await expect(client.scheduler(requesterProbe)).resolves.toEqual(result);
  });

  it.each([
    ["agent scope", { agentIds: ["octogee-alice-coach"] }],
    ["missing requester", { stageRequesterProfileId: undefined }],
    ["empty requester", { stageRequesterProfileId: "" }],
    ["oversized requester", { stageRequesterProfileId: "x".repeat(513) }],
    ["non-string requester", { stageRequesterProfileId: 42 }],
  ] as const)("rejects a fleet staging requester acknowledgement with %s", async (_label, invalid) => {
    const result = { ...requesterResult, stageRequesterProfileId: "shared-operator", ...invalid };
    const { fakeFetch } = captureFetch(() => new Response(JSON.stringify(result)));
    const client = createMigrationClient({ privateKey: PRIVATE_KEY, resolveGatewayUrl: () => "https://fleet-test.example.com", fetch: fakeFetch, transferState: transferNotUnderTest });
    await expect(client.scheduler(requesterProbe)).rejects.toThrow("did not prove");
  });
});
