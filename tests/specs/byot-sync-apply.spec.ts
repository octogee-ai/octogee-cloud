import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { DatabaseSync } from "node:sqlite";
import {
  readAuthProfileStore,
  resolveAuthDbPath,
} from "../../core/src/auth-profile-sqlite";

let TMP_ROOT: string;

beforeEach(async () => {
  TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "byot-sync-test-"));
  process.env.OPENCLAW_AGENTS_DIR = path.join(TMP_ROOT, "agents");
  vi.resetModules();
});

afterEach(() => {
  delete process.env.OPENCLAW_AGENTS_DIR;
  if (TMP_ROOT && fs.existsSync(TMP_ROOT)) {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

async function loadModule() {
  return await import("../../scripts/lib/byot-sync");
}

function agentDirFor(slug: string): string {
  return path.join(TMP_ROOT, "agents", `octogee-${slug}-coach`, "agent");
}

// The gateway stands up every rostered agent's database at startup; BYOT sync
// only updates it. Fixtures create the same thing openclaw would have — a bare
// agent dir is state the gateway itself refuses to boot behind.
function mkAgentDir(slug: string): string {
  const dir = agentDirFor(slug);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(resolveAuthDbPath(dir));
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
       CREATE TABLE IF NOT EXISTS auth_profile_state (state_key TEXT NOT NULL PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
       PRAGMA user_version = 16;`,
    );
  } finally {
    db.close();
  }
  return dir;
}

function authDbPath(slug: string): string {
  return resolveAuthDbPath(agentDirFor(slug));
}

function authProfilesStored(slug: string): unknown | null {
  return readAuthProfileStore(agentDirFor(slug));
}

describe("applyByotState — agent-dir guard", () => {
  test("refuses to write when the agent dir does not exist (no orphan dirs)", async () => {
    const { applyByotState } = await loadModule();
    const slug = "no-agent-yet";
    const changed = await applyByotState(slug, { slug, provider: "anthropic" });
    expect(changed).toBe(false);
    expect(fs.existsSync(agentDirFor(slug))).toBe(false);
    expect(fs.existsSync(authDbPath(slug))).toBe(false);
  });

  test("disable on a slug with no agent dir is a quiet no-op (no false 'changed')", async () => {
    const { applyByotState } = await loadModule();
    expect(await applyByotState("no-agent-yet", null)).toBe(false);
  });
});

describe("applyByotState — enabled write path", () => {
  test("writes the auth_profile_store row into openclaw-agent.sqlite when agent dir exists", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    mkAgentDir(slug);

    const changed = await applyByotState(slug, { slug, provider: "anthropic" });
    expect(changed).toBe(true);

    expect(fs.existsSync(authDbPath(slug))).toBe(true);
    expect(authProfilesStored(slug)).not.toBeNull();
  });

  test("idempotent — second call returns false when stored profile already matches", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    mkAgentDir(slug);

    expect(await applyByotState(slug, { slug, provider: "anthropic" })).toBe(true);
    expect(await applyByotState(slug, { slug, provider: "anthropic" })).toBe(false);
  });

  test("stored payload has the expected SecretRef shape", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    mkAgentDir(slug);

    await applyByotState(slug, { slug, provider: "anthropic" });

    const stored = authProfilesStored(slug) as {
      profiles: Record<string, { type: string; provider: string; keyRef: object }>;
    };
    expect(stored.profiles["anthropic:default"].type).toBe("api_key");
    expect(stored.profiles["anthropic:default"].provider).toBe("anthropic");
    expect(stored.profiles["anthropic:default"].keyRef).toEqual({
      source: "exec",
      provider: "gcp-secret-manager",
      id: `byok-${slug}-anthropic/latest`,
    });
  });

  test("never embeds plaintext key (defense-in-depth — only SecretRef)", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    mkAgentDir(slug);

    await applyByotState(slug, { slug, provider: "anthropic" });
    const raw = JSON.stringify(authProfilesStored(slug));
    expect(raw).not.toContain("sk-ant-");
    expect(raw).not.toMatch(/"key"\s*:/);
  });

  test("no auth-profiles.json file is written — SQLite is the only durable target", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    mkAgentDir(slug);

    await applyByotState(slug, { slug, provider: "anthropic" });
    expect(fs.existsSync(path.join(agentDirFor(slug), "auth-profiles.json"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(agentDirFor(slug), "auth-profiles.json.tmp"))).toBe(
      false,
    );
  });
});

describe("applyByotState — provider switch reconciliation (Phase 2)", () => {
  test("anthropic → openai-compatible clears the auth_profile_store row AND writes models.json", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    mkAgentDir(slug);

    await applyByotState(slug, { slug, provider: "anthropic" });
    const modelsPath = path.join(agentDirFor(slug), "models.json");
    expect(authProfilesStored(slug)).not.toBeNull();
    expect(fs.existsSync(modelsPath)).toBe(false);

    const changed = await applyByotState(slug, {
      slug,
      provider: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-3.5-sonnet",
    });
    expect(changed).toBe(true);

    expect(authProfilesStored(slug)).toBeNull();
    expect(fs.existsSync(modelsPath)).toBe(true);

    const mj = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    expect(mj.providers[`custom-${slug}`].api).toBe("openai-completions");
    expect(mj.providers[`custom-${slug}`].apiKey.source).toBe("exec");
    expect(mj.providers[`custom-${slug}`].models).toEqual([
      { id: "anthropic/claude-3.5-sonnet", name: "anthropic/claude-3.5-sonnet" },
    ]);
  });

  test("openai-compatible → anthropic removes models.json AND writes the auth_profile_store row", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    mkAgentDir(slug);

    await applyByotState(slug, { slug, provider: "openai-compatible", baseUrl: "https://x/v1", model: "a/b" });
    const modelsPath = path.join(agentDirFor(slug), "models.json");
    expect(fs.existsSync(modelsPath)).toBe(true);

    await applyByotState(slug, { slug, provider: "anthropic" });
    expect(fs.existsSync(modelsPath)).toBe(false);
    expect(authProfilesStored(slug)).not.toBeNull();
  });

  test("openai → openai-compatible clears the auth_profile_store row AND writes models.json", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    mkAgentDir(slug);

    await applyByotState(slug, { slug, provider: "openai", model: "openai/gpt-4o" });
    expect(authProfilesStored(slug)).not.toBeNull();

    await applyByotState(slug, { slug, provider: "openai-compatible", baseUrl: "https://x/v1", model: "a/b" });
    expect(authProfilesStored(slug)).toBeNull();
    expect(fs.existsSync(path.join(agentDirFor(slug), "models.json"))).toBe(true);
  });

  test("disable from any provider removes BOTH BYOT artifacts (models.json file + auth_profile_store row)", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    mkAgentDir(slug);

    await applyByotState(slug, { slug, provider: "openai-compatible", baseUrl: "https://x/v1", model: "a/b" });
    expect(fs.existsSync(path.join(agentDirFor(slug), "models.json"))).toBe(true);

    await applyByotState(slug, null);
    expect(authProfilesStored(slug)).toBeNull();
    expect(fs.existsSync(path.join(agentDirFor(slug), "models.json"))).toBe(false);
  });
});

describe("applyByotState — disabled remove path", () => {
  test("clears the auth_profile_store row when disabled and the row existed", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    mkAgentDir(slug);
    await applyByotState(slug, { slug, provider: "anthropic" });
    expect(authProfilesStored(slug)).not.toBeNull();

    expect(await applyByotState(slug, null)).toBe(true);
    expect(authProfilesStored(slug)).toBeNull();
  });

  test("disable when no row present is a no-op (returns false)", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    mkAgentDir(slug);
    expect(await applyByotState(slug, null)).toBe(false);
  });
});

describe("applyByotState — `.byot-managed` marker (auth-profile collision guard)", () => {
  function markerPath(slug: string): string {
    return path.join(agentDirFor(slug), ".byot-managed");
  }

  test("disable WITHOUT a marker leaves a pre-existing auth_profile_store row untouched (openclaw owns the doctor-migrated row)", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    const dir = mkAgentDir(slug);

    // Pre-existing payload (post-doctor cache, owned by openclaw).
    const openclawCacheBody = { profiles: { sample: { type: "oauth" } } };
    const { writeAuthProfileStore } = await import("../../core/src/auth-profile-sqlite");
    writeAuthProfileStore(dir, openclawCacheBody);
    expect(fs.existsSync(markerPath(slug))).toBe(false);

    expect(await applyByotState(slug, null)).toBe(false);
    expect(authProfilesStored(slug)).toEqual(openclawCacheBody);
  });

  test("BYOT-on writes the marker file alongside the auth_profile_store row", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    mkAgentDir(slug);

    expect(await applyByotState(slug, { slug, provider: "anthropic" })).toBe(true);
    expect(fs.existsSync(markerPath(slug))).toBe(true);

    const markerContent = JSON.parse(fs.readFileSync(markerPath(slug), "utf8"));
    expect(typeof markerContent.managedSince).toBe("string");
  });

  test("BYOT-on idempotent: second call does NOT rewrite the marker", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    mkAgentDir(slug);

    await applyByotState(slug, { slug, provider: "anthropic" });
    const firstMarker = fs.readFileSync(markerPath(slug), "utf8");

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await applyByotState(slug, { slug, provider: "anthropic" })).toBe(false);
    const secondMarker = fs.readFileSync(markerPath(slug), "utf8");
    expect(secondMarker).toBe(firstMarker);
  });

  test("disable WITH the marker present clears both BYOT artifacts AND the marker", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    mkAgentDir(slug);

    await applyByotState(slug, { slug, provider: "anthropic" });
    expect(authProfilesStored(slug)).not.toBeNull();
    expect(fs.existsSync(markerPath(slug))).toBe(true);

    expect(await applyByotState(slug, null)).toBe(true);
    expect(authProfilesStored(slug)).toBeNull();
    expect(fs.existsSync(markerPath(slug))).toBe(false);
  });

  test("re-enable after disable rewrites both the auth_profile_store row AND the marker", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    mkAgentDir(slug);

    await applyByotState(slug, { slug, provider: "anthropic" });
    await applyByotState(slug, null);
    expect(authProfilesStored(slug)).toBeNull();
    expect(fs.existsSync(markerPath(slug))).toBe(false);

    expect(await applyByotState(slug, { slug, provider: "anthropic" })).toBe(true);
    expect(authProfilesStored(slug)).not.toBeNull();
    expect(fs.existsSync(markerPath(slug))).toBe(true);
  });

  test("BYOT-on writes marker even when content already matches (pre-marker rollouts)", async () => {
    const { applyByotState } = await loadModule();
    const slug = "smile-wring-011b";
    mkAgentDir(slug);

    await applyByotState(slug, { slug, provider: "anthropic" });
    fs.unlinkSync(markerPath(slug));
    expect(authProfilesStored(slug)).not.toBeNull();
    expect(fs.existsSync(markerPath(slug))).toBe(false);

    const changed = await applyByotState(slug, { slug, provider: "anthropic" });
    expect(changed).toBe(false);
    expect(fs.existsSync(markerPath(slug))).toBe(true);

    expect(await applyByotState(slug, null)).toBe(true);
    expect(authProfilesStored(slug)).toBeNull();
    expect(fs.existsSync(markerPath(slug))).toBe(false);
  });
});
