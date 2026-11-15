import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// resolveOne is exported for in-process unit coverage of the broker call; the
// resolver's main() is import-guarded, so this import is inert.
import {
  resolveBatch as resolveBatchRaw,
  resolveOne as resolveOneRaw,
  BROKER_ATTEMPTS,
  BROKER_ATTEMPT_TIMEOUT_MS,
  BROKER_BASE_URL,
  BROKER_CONCURRENCY,
  BROKER_RETRY_BACKOFF_MS,
  BROKER_TOTAL_BUDGET_MS,
  KSA_TOKEN_PATH,
} from "../secret-resolver.mjs";
const resolveBatch = resolveBatchRaw as (
  ids: string[],
  resolve?: (id: string) => Promise<string>,
) => Promise<{
  values: Record<string, string>;
  errors: Record<string, { message: string }>;
}>;
const resolveOne = resolveOneRaw as (
  id: string,
  deps?: {
    token?: string;
    fetchImpl?: (
      url: string,
      init: {
        method: string;
        headers: Record<string, string>;
        body: string;
        signal: AbortSignal;
      },
    ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
    requestTimeoutMs?: number;
    retryBackoffMs?: number;
    budgetMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    expiryDir?: string;
  },
) => Promise<string>;

const RESOLVER = path.join(__dirname, "..", "secret-resolver.mjs");

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runResolver(env: Record<string, string>, stdinPayload: string): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [RESOLVER], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
    child.stdin.end(stdinPayload);
  });
}

interface ResolverResponse {
  protocolVersion: number;
  values: Record<string, string>;
  errors?: Record<string, { message: string }>;
}

function parseResponse(stdout: string): ResolverResponse {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

describe("secret-resolver — defense-in-depth", () => {
  let agentsDir: string;

  beforeAll(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-resolver-test-"));
    fs.mkdirSync(path.join(agentsDir, "octogee-alice-coach", "agent"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "octogee-alice-proj-garden-coach", "agent"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(agentsDir, "octogee-bob-coach", "agent"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "main"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "octogee-ops-gw-test"), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  });

  function envFor(): Record<string, string> {
    return {
      OPENCLAW_AGENTS_DIR: agentsDir,
      GCP_PROJECT_ID: "octogee-resolver-test",
      GOOGLE_APPLICATION_CREDENTIALS: "/dev/null",
    };
  }

  it("uses an absolute Node interpreter when OpenClaw executes the resolver directly", () => {
    expect(fs.readFileSync(RESOLVER, "utf8").split("\n")[0]).toBe(
      "#!/usr/local/bin/node",
    );
  });

  it("rejects ids that don't match the byok-{slug}-{provider} grammar", async () => {
    const stdin = JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids: [
        "../../../../etc/passwd",
        "byok-/anthropic",
        "byok-alice-",
        "byok-alice-anthropic-extra",
        "completely-unrelated-secret",
      ],
    });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);

    for (const id of [
      "../../../../etc/passwd",
      "byok-/anthropic",
      "byok-alice-",
      "byok-alice-anthropic-extra",
      "completely-unrelated-secret",
    ]) {
      expect(res.errors?.[id]?.message).toMatch(/^Refused by resolver:/);
    }
    expect(Object.keys(res.values)).toHaveLength(0);

    expect(out.stderr).toContain("[secret-resolver/audit] reject");
  });

  it("rejects unknown slugs even if the grammar matches", async () => {
    const id = "byok-eve-anthropic/latest";
    const stdin = JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids: [id],
    });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);

    expect(res.errors?.[id]?.message).toMatch(/no provisioned agent dir/);
    expect(out.stderr).toContain(`reject id="${id}"`);
  });

  function userClaimEnv(slug: string): { env: Record<string, string>; cleanup: () => void } {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-resolver-claim-"));
    fs.writeFileSync(path.join(openclawDir, "builder-claim.json"), JSON.stringify({
      schemaVersion: 1, gatewayId: "gw-alice", ownerUid: `uid-${slug}`, builderSlug: slug,
      leaseId: null, generation: null, claimedAt: 1, overlayAppliedAt: null,
    }));
    return {
      env: { OPENCLAW_DIR: openclawDir, GATEWAY_ID: "gw-alice" },
      cleanup: () => fs.rmSync(openclawDir, { recursive: true, force: true }),
    };
  }

  it("does not take the user slug from the environment", async () => {
    const ownId = "byok-alice-anthropic/latest";
    const out = await runResolver({
      ...envFor(),
      OPENCLAW_AGENTS_DIR: "/nonexistent/path/octogee-user-resolver-test",
      GATEWAY_BUILDER_SLUG: "alice",
    }, JSON.stringify({ protocolVersion: 1, provider: "gcp-secret-manager", ids: [ownId] }));

    expect(out.stderr).toContain(`reject id="${ownId}"`);
  });

  it("accepts the validated user's BYOK ref without a canonical agent dir and rejects a foreign user", async () => {
    const userAgentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-resolver-user-"));
    const claim = userClaimEnv("alice");
    try {
      fs.mkdirSync(path.join(userAgentsDir, "discord-helper", "agent"), { recursive: true });
      const ownId = "byok-alice-openai/latest";
      const foreignId = "byok-eve-openai/latest";
      const out = await runResolver({
        ...envFor(),
        OPENCLAW_AGENTS_DIR: userAgentsDir,
        ...claim.env,
      }, JSON.stringify({
        protocolVersion: 1,
        provider: "gcp-secret-manager",
        ids: [ownId, foreignId],
      }));
      const response = parseResponse(out.stdout);

      expect(out.stderr).toContain(`accept id="${ownId}"`);
      expect(out.stderr).toContain(`reject id="${foreignId}"`);
      if (response.errors?.[ownId]) {
        expect(response.errors[ownId].message).not.toMatch(/^Refused by resolver:/);
      }
      expect(response.errors?.[foreignId]?.message).toMatch(/^Refused by resolver:/);
    } finally {
      fs.rmSync(userAgentsDir, { recursive: true, force: true });
      claim.cleanup();
    }
  });

  it("keeps the validated user slug when its custom runtime directory is not present yet", async () => {
    const ownId = "byok-alice-anthropic/latest";
    const foreignId = "byok-eve-anthropic/latest";
    const claim = userClaimEnv("alice");
    const out = await runResolver({
      ...envFor(),
      OPENCLAW_AGENTS_DIR: "/nonexistent/path/octogee-user-resolver-test",
      ...claim.env,
    }, JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids: [ownId, foreignId],
    }));
    claim.cleanup();
    const response = parseResponse(out.stdout);

    expect(out.stderr).toContain(`accept id="${ownId}"`);
    expect(out.stderr).toContain(`reject id="${foreignId}"`);
    if (response.errors?.[ownId]) {
      expect(response.errors[ownId].message).not.toMatch(/^Refused by resolver:/);
    }
    expect(response.errors?.[foreignId]?.message).toMatch(/^Refused by resolver:/);
  });

  it("rejects unsupported providers", async () => {
    const id = "byok-alice-mistral/latest";
    const stdin = JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids: [id],
    });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);
    expect(res.errors?.[id]?.message).toMatch(/Refused by resolver:/);
  });

  it("accepts a known slug + provider and forwards to the broker (which fails without a KSA token here → errors, not a Refusal)", async () => {
    const id = "byok-alice-anthropic/latest";
    const stdin = JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids: [id],
    });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);

    expect(out.stderr).toContain(`accept id="${id}"`);
    expect(out.stderr).not.toContain(`reject id="${id}"`);
    if (res.errors?.[id]) {
      expect(res.errors[id].message).not.toMatch(/^Refused by resolver:/);
    }
  });

  it("fails closed when AGENTS_DIR can't be read — every id with a slug check is refused", async () => {
    const id = "byok-alice-anthropic/latest";
    const stdin = JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids: [id],
    });
    const out = await runResolver(
      { ...envFor(), OPENCLAW_AGENTS_DIR: "/nonexistent/path/octogee-fail-closed-test" },
      stdin,
    );
    const res = parseResponse(out.stdout);
    expect(res.errors?.[id]?.message).toMatch(/no provisioned agent dir/);
    expect(out.stderr).toContain("could not enumerate AGENTS_DIR");
  });

  it("caps audit-log volume on rejection floods (no log-bill DoS, no haystack hide)", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `byok-attacker${i}-anthropic/latest`);
    const stdin = JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids,
    });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);

    expect(Object.keys(res.errors || {})).toHaveLength(25);

    const rejectLines = (out.stderr.match(/\[secret-resolver\/audit\] reject id=/g) || []).length;
    expect(rejectLines).toBe(10);
    expect(out.stderr).toContain("reject-summary suppressed=15");
  });

  it("partially resolves a mixed batch — accepts known slugs, rejects unknown ones in the same call", async () => {
    const stdin = JSON.stringify({
      protocolVersion: 1,
      provider: "gcp-secret-manager",
      ids: [
        "byok-alice-anthropic/latest",
        "byok-eve-anthropic/latest",
        "byok-bob-openai/latest",
      ],
    });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);

    expect(res.errors?.["byok-eve-anthropic/latest"]?.message).toMatch(/^Refused by resolver:/);
    if (res.errors?.["byok-alice-anthropic/latest"]) {
      expect(res.errors["byok-alice-anthropic/latest"].message).not.toMatch(/^Refused by resolver:/);
    }
  });

  it.each([
    "agent-model-token-octogee-alice-coach",
    "agent-model-token-openrouter-octogee-alice-coach",
    "agent-model-token-openai-octogee-alice-coach",
    "agent-embedding-token-openai-octogee-alice-coach",
    "agent-model-token-octogee-alice-proj-garden-coach",
    "agent-model-token-openrouter-octogee-alice-proj-garden-coach",
    "agent-model-token-openai-octogee-alice-proj-garden-coach",
    "agent-embedding-token-openai-octogee-alice-proj-garden-coach",
    "agent-model-token-vertex-octogee-alice-coach",
    "agent-model-token-vertex-octogee-alice-proj-garden-coach",
  ])("accepts the known ref %s", async (id) => {
    const stdin = JSON.stringify({ protocolVersion: 1, provider: "gcp-secret-manager", ids: [id] });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);
    expect(out.stderr).toContain(`accept id="${id}"`);
    if (res.errors?.[id]) {
      expect(res.errors[id].message).not.toMatch(/^Refused by resolver:/);
    }
  });

  it("refuses an agent-model-token ref for an unknown slug (same allowlist as byok)", async () => {
    const id = "agent-model-token-octogee-eve-coach";
    const stdin = JSON.stringify({ protocolVersion: 1, provider: "gcp-secret-manager", ids: [id] });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);
    expect(res.errors?.[id]?.message).toMatch(/no provisioned agent dir/);
  });

  it("refuses a canonical project-agent ref that is not in this gateway roster", async () => {
    const id = "agent-model-token-octogee-alice-proj-foreign-coach";
    const stdin = JSON.stringify({ protocolVersion: 1, provider: "gcp-secret-manager", ids: [id] });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);
    expect(res.errors?.[id]?.message).toMatch(/not provisioned on this gateway/);
  });

  it.each([
    "agent-model-token-octogee-alice-proj-garden-extra-coach",
    "agent-model-token-octogee-alice-proj-gar-den-coach",
    "agent-model-token-octogee-proj-garden-coach",
  ])("refuses malformed project-agent ref %s", async (id) => {
    const stdin = JSON.stringify({ protocolVersion: 1, provider: "gcp-secret-manager", ids: [id] });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);
    expect(res.errors?.[id]?.message).toMatch(/does not match/);
  });

  it("refuses the retired platform embedding ref grammar", async () => {
    const id = "platform-openai-embedding-octogee-eve-coach";
    const stdin = JSON.stringify({ protocolVersion: 1, provider: "gcp-secret-manager", ids: [id] });
    const out = await runResolver(envFor(), stdin);
    const res = parseResponse(out.stdout);
    expect(res.errors?.[id]?.message).toMatch(/does not match/);
  });
});

describe("resolveOne — brokered byok materialization (unit, injected deps)", () => {
  it("bounds broker fan-out without dropping a large shared-gateway batch", async () => {
    const ids = Array.from({ length: 84 }, (_, index) => `id-${index}`);
    let active = 0;
    let peak = 0;

    const result = await resolveBatch(ids, async (id) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      if (id === "id-83") throw new Error("broker refused final id");
      return `value-${id}`;
    });

    expect(peak).toBe(BROKER_CONCURRENCY);
    expect(Object.keys(result.values)).toHaveLength(ids.length - 1);
    expect(result.errors).toEqual({ "id-83": { message: "broker refused final id" } });
  });

  it("POSTs { id } to /internal/byok/api-key with the KSA token and returns the value", async () => {
    let seen:
      | {
          url: string;
          init: { headers: Record<string, string>; body: string; signal: AbortSignal };
        }
      | undefined;
    const v = await resolveOne("byok-tester5-grok", {
      token: "ksa-tok",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, json: async () => ({ value: "xai-key-tester5" }) };
      },
    });
    expect(v).toBe("xai-key-tester5");
    expect(seen?.url).toBe(`${BROKER_BASE_URL}/internal/byok/api-key`);
    expect(seen?.init.headers["x-k8s-sa-token"]).toBe("ksa-tok");
    expect(seen?.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(seen!.init.body)).toEqual({ id: "byok-tester5-grok" });
  });

  it("aborts a stalled broker request within the configured resolver deadline", async () => {
    let attempts = 0;
    await expect(
      resolveOne("byok-tester5-grok", {
        token: "ksa-tok",
        requestTimeoutMs: 10,
        sleep: async () => {},
        fetchImpl: async (_url, init) => {
          attempts++;
          return await new Promise<never>((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          });
        },
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(attempts).toBe(2);
  });

  it("routes an agent-model-token id to /internal/byok/agent-model-token with the embedded agentId", async () => {
    let seen: { url: string; init: { body: string } } | undefined;
    const v = await resolveOne("agent-model-token-octogee-tester5-coach", {
      token: "ksa-tok",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, json: async () => ({ value: "ogk_shared-1_abc" }) };
      },
    });
    expect(v).toBe("ogk_shared-1_abc");
    expect(seen?.url).toBe(`${BROKER_BASE_URL}/internal/byok/agent-model-token`);
    expect(JSON.parse(seen!.init.body)).toEqual({ agentId: "octogee-tester5-coach" });
  });

  it("atomically records only an agent broker ref and its exact expiry metadata", async () => {
    const expiryDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-token-expiry-"));
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const token = "ogk_shared-1_dont-persist-me";
    try {
      await expect(
        resolveOne("agent-model-token-octogee-tester5-coach", {
          token: "ksa-tok",
          expiryDir,
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ value: token, expiresAt }),
          }),
        }),
      ).resolves.toBe(token);

      const files = fs.readdirSync(expiryDir);
      expect(files).toHaveLength(1);
      const filename = path.join(expiryDir, files[0]!);
      expect(JSON.parse(fs.readFileSync(filename, "utf8"))).toEqual({
        refId: "agent-model-token-octogee-tester5-coach",
        expiresAt,
      });
      expect(fs.readFileSync(filename, "utf8")).not.toContain(token);
      expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
      expect(files.some((file) => file.includes("tmp"))).toBe(false);
    } finally {
      fs.rmSync(expiryDir, { recursive: true, force: true });
    }
  });

  it("routes a canonical project-agent model token with the exact embedded agentId", async () => {
    let seen: { url: string; init: { body: string } } | undefined;
    const agentId = "octogee-tester5-proj-garden-coach";
    const v = await resolveOne(`agent-model-token-${agentId}`, {
      token: "ksa-tok",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, json: async () => ({ value: "ogk_shared-1_project" }) };
      },
    });
    expect(v).toBe("ogk_shared-1_project");
    expect(seen?.url).toBe(`${BROKER_BASE_URL}/internal/byok/agent-model-token`);
    expect(JSON.parse(seen!.init.body)).toEqual({ agentId });
  });

  it("routes an OpenRouter agent-model-token id with an explicit provider", async () => {
    let seen: { url: string; init: { body: string } } | undefined;
    const v = await resolveOne("agent-model-token-openrouter-octogee-tester5-coach", {
      token: "ksa-tok",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, json: async () => ({ value: "ogk_shared-1_glm" }) };
      },
    });
    expect(v).toBe("ogk_shared-1_glm");
    expect(seen?.url).toBe(`${BROKER_BASE_URL}/internal/byok/agent-model-token`);
    expect(JSON.parse(seen!.init.body)).toEqual({
      agentId: "octogee-tester5-coach",
      provider: "openrouter",
    });
  });

  it("routes an OpenAI agent-model-token id with an explicit provider", async () => {
    let seen: { url: string; init: { body: string } } | undefined;
    const v = await resolveOne("agent-model-token-openai-octogee-tester5-coach", {
      token: "ksa-tok",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, json: async () => ({ value: "ogk_shared-1_oai" }) };
      },
    });
    expect(v).toBe("ogk_shared-1_oai");
    expect(seen?.url).toBe(`${BROKER_BASE_URL}/internal/byok/agent-model-token`);
    expect(JSON.parse(seen!.init.body)).toEqual({
      agentId: "octogee-tester5-coach",
      provider: "openai",
    });
  });

  it("routes a Vertex agent-model-token id with an explicit provider", async () => {
    let seen: { url: string; init: { body: string } } | undefined;
    const v = await resolveOne("agent-model-token-vertex-octogee-tester5-coach", {
      token: "ksa-tok",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, json: async () => ({ value: "ogk_shared-1_vtx" }) };
      },
    });
    expect(v).toBe("ogk_shared-1_vtx");
    expect(seen?.url).toBe(`${BROKER_BASE_URL}/internal/byok/agent-model-token`);
    expect(JSON.parse(seen!.init.body)).toEqual({
      agentId: "octogee-tester5-coach",
      provider: "vertex",
    });
  });

  it("routes an OpenAI embedding token with an explicit purpose", async () => {
    let seen: { url: string; init: { body: string } } | undefined;
    const v = await resolveOne("agent-embedding-token-openai-octogee-tester5-coach", {
      token: "ksa-tok",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, json: async () => ({ value: "ogk_shared-1_embed" }) };
      },
    });
    expect(v).toBe("ogk_shared-1_embed");
    expect(seen?.url).toBe(`${BROKER_BASE_URL}/internal/byok/agent-model-token`);
    expect(JSON.parse(seen!.init.body)).toEqual({
      agentId: "octogee-tester5-coach",
      provider: "openai",
      purpose: "embeddings",
    });
  });


  it("throws on a non-ok broker response (fail loud → surfaces as errors[id], never a silent empty)", async () => {
    await expect(
      resolveOne("byok-tester5-grok", {
        token: "t",
        fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
      }),
    ).rejects.toThrow(/403/);
  });

  it("throws on a malformed broker response with no value", async () => {
    await expect(
      resolveOne("byok-tester5-grok", {
        token: "t",
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      }),
    ).rejects.toThrow(/malformed/);
  });

  // OpenClaw's exec-resolver protocol is batch-fatal: ANY entry in the errors{}
  // response makes it discard the WHOLE batch and cold every owner on the
  // provider. One retry per id is therefore worth far more than it costs — but
  // the whole budget has to land inside the provider's timeoutMs or the gateway
  // kills the resolver mid-retry and every id in the batch is lost. That budget
  // is read from the shipped template so the two cannot drift.
  describe("per-id retry", () => {
    function countingFetch(
      outcomes: Array<{ ok: boolean; status: number; body?: unknown } | "throw">,
    ) {
      const calls: number[] = [];
      const fetchImpl = async () => {
        const outcome = outcomes[calls.length] ?? outcomes[outcomes.length - 1]!;
        calls.push(1);
        if (outcome === "throw") throw new Error("ECONNRESET");
        return {
          ok: outcome.ok,
          status: outcome.status,
          json: async () => outcome.body ?? {},
        };
      };
      return { calls, fetchImpl };
    }

    it("keeps the whole per-id budget inside the provider's configured timeoutMs", () => {
      const template = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "../../gateway/openclaw.template.json"),
          "utf8",
        ),
      ) as { secrets: { providers: Record<string, { timeoutMs?: number }> } };
      const providerTimeoutMs = template.secrets.providers["gcp-secret-manager"]?.timeoutMs;

      expect(BROKER_ATTEMPTS).toBe(2);
      expect(
        BROKER_ATTEMPTS * BROKER_ATTEMPT_TIMEOUT_MS + BROKER_RETRY_BACKOFF_MS,
      ).toBeLessThanOrEqual(BROKER_TOTAL_BUDGET_MS);
      expect(providerTimeoutMs).toBeDefined();
      expect(BROKER_TOTAL_BUDGET_MS).toBeLessThan(providerTimeoutMs!);
    });

    it("keeps an 84-ref shared roster inside the provider timeout", () => {
      const template = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "../../gateway/openclaw.template.json"),
          "utf8",
        ),
      ) as { secrets: { providers: Record<string, { timeoutMs?: number }> } };
      const providerTimeoutMs = template.secrets.providers["gcp-secret-manager"]!.timeoutMs!;

      const worstCaseBrokerBudget =
        Math.ceil(84 / BROKER_CONCURRENCY) * BROKER_TOTAL_BUDGET_MS;
      expect(worstCaseBrokerBudget).toBeLessThan(providerTimeoutMs);
    });

    it("retries a 5xx once and returns the second attempt's value", async () => {
      const { calls, fetchImpl } = countingFetch([
        { ok: false, status: 503 },
        { ok: true, status: 200, body: { value: "recovered" } },
      ]);

      await expect(
        resolveOne("byok-tester5-grok", { token: "t", fetchImpl, sleep: async () => {} }),
      ).resolves.toBe("recovered");
      expect(calls).toHaveLength(2);
    });

    it("retries a network error once", async () => {
      const { calls, fetchImpl } = countingFetch([
        "throw",
        { ok: true, status: 200, body: { value: "recovered" } },
      ]);

      await expect(
        resolveOne("byok-tester5-grok", { token: "t", fetchImpl, sleep: async () => {} }),
      ).resolves.toBe("recovered");
      expect(calls).toHaveLength(2);
    });

    it("does NOT retry a 403 — the broker already decided", async () => {
      const { calls, fetchImpl } = countingFetch([{ ok: false, status: 403 }]);

      await expect(
        resolveOne("byok-tester5-grok", { token: "t", fetchImpl, sleep: async () => {} }),
      ).rejects.toThrow(/403/);
      expect(calls).toHaveLength(1);
    });

    it("does NOT retry a malformed 200 — a broken contract does not heal on retry", async () => {
      const { calls, fetchImpl } = countingFetch([{ ok: true, status: 200, body: {} }]);

      await expect(
        resolveOne("byok-tester5-grok", { token: "t", fetchImpl, sleep: async () => {} }),
      ).rejects.toThrow(/malformed/);
      expect(calls).toHaveLength(1);
    });

    it("gives up rather than starting a second attempt the budget cannot fund", async () => {
      const { calls, fetchImpl } = countingFetch([{ ok: false, status: 503 }]);
      let clock = 0;

      await expect(
        resolveOne("byok-tester5-grok", {
          token: "t",
          fetchImpl,
          sleep: async () => {},
          budgetMs: 100,
          now: () => (clock += 90),
        }),
      ).rejects.toThrow(/503/);
      expect(calls).toHaveLength(1);
    });

    it("backs off between attempts", async () => {
      const slept: number[] = [];
      const { fetchImpl } = countingFetch([
        { ok: false, status: 500 },
        { ok: true, status: 200, body: { value: "v" } },
      ]);

      await resolveOne("byok-tester5-grok", {
        token: "t",
        fetchImpl,
        sleep: async (ms) => {
          slept.push(ms);
        },
      });

      expect(slept).toEqual([BROKER_RETRY_BACKOFF_MS]);
    });
  });

  it("defaults (no broker env) to same-namespace short DNS + the mounted gateway-broker token — existing-config compatible (#1730 P1)", () => {
    // Existing gateways preserve a pre-broker passEnv, so the resolver must work
    // without FLEET_BROKER_URL / OCTOGEE_API_SA_TOKEN_PATH being forwarded.
    if (!process.env.FLEET_BROKER_URL && !process.env.OCTOGEE_API_URL) {
      expect(BROKER_BASE_URL).toBe("http://octogee-api:3001");
    }
    if (!process.env.OCTOGEE_API_SA_TOKEN_PATH) {
      expect(KSA_TOKEN_PATH).toBe("/var/run/secrets/octogee-gateway-broker/token");
    }
  });
});
