import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  mattermostAccountSecretRef,
  mattermostAccountSecretsPath,
  mattermostProjectAccountSecretChange,
  readMattermostAccountSecret,
  updateMattermostAccountSecrets,
} from "../lib/mattermost-account-secrets.js";

const dirs: string[] = [];

function tempOpenClawDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-mm-account-secrets-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Mattermost account SecretRefs", () => {
  it("removes disabled and unminted project PATs while setting active accounts", () => {
    expect(mattermostProjectAccountSecretChange("alice", [
      { projectId: "orbit", enabled: true, token: "pat-orbit" },
      { projectId: "nova", enabled: false, token: "pat-nova" },
      { projectId: "empty", enabled: true, token: null },
    ])).toEqual({
      set: { "alice-proj-orbit": "pat-orbit" },
      remove: ["alice-proj-nova", "alice-proj-empty"],
    });
  });

  it("uses JSON Pointer ids with the platform file provider", () => {
    expect(mattermostAccountSecretRef("ceckert/coach~blue")).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/ceckert~1coach~0blue",
    });
  });

  it("atomically persists tokens outside system_config with mode 0600", async () => {
    const openclawDir = tempOpenClawDir();

    await updateMattermostAccountSecrets(openclawDir, {
      set: { "ceckert-coach": "default-agent-pat" },
    });

    const secretPath = mattermostAccountSecretsPath(openclawDir);
    expect(secretPath).not.toContain("system_config");
    expect(JSON.parse(fs.readFileSync(secretPath, "utf8"))).toEqual({
      "ceckert-coach": "default-agent-pat",
    });
    expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(secretPath))).toEqual(["mattermost-accounts.json"]);
  });

  it("serializes overlapping updates without losing either account", async () => {
    const openclawDir = tempOpenClawDir();

    await Promise.all([
      updateMattermostAccountSecrets(openclawDir, { set: { "alice-coach": "pat-a" } }),
      updateMattermostAccountSecrets(openclawDir, { set: { "bob-coach": "pat-b" } }),
    ]);

    expect(JSON.parse(fs.readFileSync(mattermostAccountSecretsPath(openclawDir), "utf8"))).toEqual({
      "alice-coach": "pat-a",
      "bob-coach": "pat-b",
    });
  });

  it("serializes updates from separate processes without losing sibling accounts", async () => {
    const openclawDir = tempOpenClawDir();
    const barrierDir = path.join(openclawDir, "barrier");
    fs.mkdirSync(barrierDir);
    const moduleUrl = pathToFileURL(path.resolve("lib/mattermost-account-secrets.ts")).href;
    const source = `
      import fs from "node:fs";
      import path from "node:path";
      import { updateMattermostAccountSecrets } from ${JSON.stringify(moduleUrl)};
      const [openclawDir, barrierDir, worker] = process.argv.slice(1);
      fs.writeFileSync(path.join(barrierDir, worker + ".ready"), "ready\\n");
      while (!fs.existsSync(path.join(barrierDir, "start"))) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const set = Object.fromEntries(Array.from(
        { length: 512 },
        (_, index) => [worker + "-" + index, worker.repeat(8192)],
      ));
      await updateMattermostAccountSecrets(openclawDir, { set });
    `;
    const run = (worker: string) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", source, openclawDir, barrierDir, worker],
        { cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"] },
      );
      return new Promise<void>((resolve, reject) => {
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`secret worker ${worker} exited ${code}: ${stderr}`));
        });
      });
    };
    const alice = run("alice");
    const bob = run("bob");
    await expect.poll(() => fs.existsSync(path.join(barrierDir, "alice.ready"))).toBe(true);
    await expect.poll(() => fs.existsSync(path.join(barrierDir, "bob.ready"))).toBe(true);
    fs.writeFileSync(path.join(barrierDir, "start"), "start\n");

    await Promise.all([alice, bob]);

    const secrets = JSON.parse(
      fs.readFileSync(mattermostAccountSecretsPath(openclawDir), "utf8"),
    ) as Record<string, string>;
    expect(Object.keys(secrets)).toHaveLength(1_024);
    expect(secrets["alice-0"]).toBe("alice".repeat(8192));
    expect(secrets["bob-511"]).toBe("bob".repeat(8192));
  }, 30_000);

  it("removes retired accounts while preserving siblings", async () => {
    const openclawDir = tempOpenClawDir();
    await updateMattermostAccountSecrets(openclawDir, {
      set: { "alice-coach": "pat-a", "bob-coach": "pat-b" },
    });

    await updateMattermostAccountSecrets(openclawDir, {
      remove: ["alice-coach"],
      removePrefixes: ["alice-proj-"],
    });

    await expect(readMattermostAccountSecret(openclawDir, "alice-coach")).resolves.toBeNull();
    await expect(readMattermostAccountSecret(openclawDir, "bob-coach")).resolves.toBe("pat-b");
  });

  it("prunes a user's stale project tokens before setting its current active tokens", async () => {
    const openclawDir = tempOpenClawDir();
    await updateMattermostAccountSecrets(openclawDir, {
      set: {
        "alice-proj-old": "pat-old",
        "alice-proj-orbit": "pat-stale",
        "bob-proj-keep": "pat-bob",
      },
    });

    await updateMattermostAccountSecrets(openclawDir, {
      removePrefixes: ["alice-proj-"],
      set: { "alice-proj-orbit": "pat-current" },
    });

    await expect(readMattermostAccountSecret(openclawDir, "alice-proj-old")).resolves.toBeNull();
    await expect(readMattermostAccountSecret(openclawDir, "alice-proj-orbit"))
      .resolves.toBe("pat-current");
    await expect(readMattermostAccountSecret(openclawDir, "bob-proj-keep"))
      .resolves.toBe("pat-bob");
  });

  it("reports whether the secrets file content changed", async () => {
    const openclawDir = tempOpenClawDir();

    await expect(updateMattermostAccountSecrets(openclawDir, { set: { "alice-coach": "pat-a" } }))
      .resolves.toEqual({ changed: true });
    await expect(updateMattermostAccountSecrets(openclawDir, { set: { "alice-coach": "pat-a" } }))
      .resolves.toEqual({ changed: false });
    await expect(updateMattermostAccountSecrets(openclawDir, {
      set: { "alice-coach": "pat-a" },
      remove: ["never-set"],
      removePrefixes: ["alice-proj-"],
    })).resolves.toEqual({ changed: false });
    await expect(updateMattermostAccountSecrets(openclawDir, { set: { "alice-coach": "pat-rotated" } }))
      .resolves.toEqual({ changed: true });
    await expect(updateMattermostAccountSecrets(openclawDir, { remove: ["alice-coach"] }))
      .resolves.toEqual({ changed: true });
    await expect(updateMattermostAccountSecrets(openclawDir, { remove: ["alice-coach"] }))
      .resolves.toEqual({ changed: false });
  });
});
