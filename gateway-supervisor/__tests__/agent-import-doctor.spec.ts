import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAgentImportDoctorHandler,
  runAgentImportDoctor,
  type AgentImportDoctorCommandResult,
} from "../lib/agent-import-doctor.js";
import { registerAgentImportDoctor, type StartFleetOptions } from "../lib/fleet-provisioner.js";

const dirs: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-import-doctor-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("runAgentImportDoctor", () => {
  it("runs the pinned OpenClaw doctor in isolated state, reports changed paths, and cleans up", async () => {
    const root = tempRoot();
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run = vi.fn(async (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options.env });
      if (args[0] === "--version") return result(0, "OpenClaw 2026.7.2\n");
      if (args[0] === "doctor") {
        const configPath = options.env.OPENCLAW_CONFIG_PATH!;
        const candidate = JSON.parse(fs.readFileSync(configPath, "utf8"));
        candidate.agents.list[0].verboseDefault = "on";
        fs.writeFileSync(configPath, `${JSON.stringify(candidate)}\n`);
        return result(0);
      }
      return result(0);
    });

    const output = await runAgentImportDoctor(
      { agents: { list: [{ id: "moof", verboseDefault: "full" }] } },
      { tmpRoot: root, env: { PATH: "/bin", SECRET_THAT_MUST_NOT_LEAK: "nope" }, run },
    );

    expect(output).toMatchObject({
      outcome: "migrated",
      doctorVersion: "2026.7.2",
      changedPaths: ["agents.list"],
      repairedCandidate: { agents: { list: [{ id: "moof", verboseDefault: "on" }] } },
    });
    expect(calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["doctor", "--fix", "--non-interactive"],
      ["config", "validate"],
    ]);
    expect(calls[1].env).not.toHaveProperty("SECRET_THAT_MUST_NOT_LEAK");
    expect(calls[1].env.OPENCLAW_STATE_DIR).toBe(calls[1].env.HOME);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("returns unsupported without repaired values when current OpenClaw rejects the source", async () => {
    const root = tempRoot();
    const run = vi.fn(async (_command: string, args: string[]) =>
      args[0] === "--version" ? result(0, "2026.7.2") : result(2, "", "invalid legacy key"),
    );

    await expect(runAgentImportDoctor({ agents: { list: [{ id: "moof" }] } }, { tmpRoot: root, run }))
      .resolves.toEqual({
        outcome: "unsupported",
        doctorVersion: "2026.7.2",
        changedPaths: [],
        diagnostics: ["doctor_exit_2"],
      });
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("rejects credential-shaped candidates before invoking OpenClaw", async () => {
    const run = vi.fn();
    await expect(runAgentImportDoctor({
      agents: { list: [{ id: "moof", clientSecret: "short-secret", accessToken: "short-token" }] },
    }, { tmpRoot: tempRoot(), run }))
      .rejects.toThrow(/credential-bearing/i);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["key", "authKey", "sharedKey", "passphrase"])(
    "rejects the common credential field %s before invoking OpenClaw",
    async (field) => {
      const run = vi.fn();
      await expect(runAgentImportDoctor({
        agents: { list: [{ id: "moof", [field]: "short-but-still-a-secret" }] },
      }, { tmpRoot: tempRoot(), run })).rejects.toThrow(/credential-bearing/i);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("rejects credential fields introduced by Doctor output", async () => {
    const root = tempRoot();
    const run = vi.fn(async (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (args[0] === "--version") return result(0, "OpenClaw 2026.7.2\n");
      if (args[0] === "doctor") {
        const configPath = options.env.OPENCLAW_CONFIG_PATH!;
        const candidate = JSON.parse(fs.readFileSync(configPath, "utf8"));
        candidate.agents.list[0].refreshToken = "short-refresh-token";
        fs.writeFileSync(configPath, `${JSON.stringify(candidate)}\n`);
      }
      return result(0);
    });

    await expect(runAgentImportDoctor(
      { agents: { list: [{ id: "moof" }] } },
      { tmpRoot: root, run },
    )).rejects.toThrow(/credential-bearing/i);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("accepts Doctor-generated skill identifiers that contain credential words", async () => {
    const root = tempRoot();
    const run = vi.fn(async (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (args[0] === "--version") return result(0, "OpenClaw 2026.7.2\n");
      if (args[0] === "doctor") {
        const configPath = options.env.OPENCLAW_CONFIG_PATH!;
        const candidate = JSON.parse(fs.readFileSync(configPath, "utf8"));
        candidate.skills = { entries: { "1password": { enabled: false } } };
        fs.writeFileSync(configPath, `${JSON.stringify(candidate)}\n`);
      }
      return result(0);
    });

    await expect(runAgentImportDoctor({}, { tmpRoot: root, run })).resolves.toMatchObject({
      outcome: "migrated",
      doctorVersion: "2026.7.2",
      repairedCandidate: {
        skills: { entries: { "1password": { enabled: false } } },
      },
    });
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("still rejects credentials beneath a credential-shaped skill identifier", async () => {
    const root = tempRoot();
    const run = vi.fn(async (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (args[0] === "--version") return result(0, "OpenClaw 2026.7.2\n");
      if (args[0] === "doctor") {
        const configPath = options.env.OPENCLAW_CONFIG_PATH!;
        const candidate = JSON.parse(fs.readFileSync(configPath, "utf8"));
        candidate.skills = { entries: { "1password": { accessToken: "still-a-secret" } } };
        fs.writeFileSync(configPath, `${JSON.stringify(candidate)}\n`);
      }
      return result(0);
    });

    await expect(runAgentImportDoctor({}, { tmpRoot: root, run }))
      .rejects.toThrow(/credential-bearing/i);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe("agent import doctor HTTP handler", () => {
  function app() {
    const instance = express();
    instance.use(express.json());
    instance.post("/agent-import/doctor", createAgentImportDoctorHandler({
      token: "pod-token",
      runDoctor: vi.fn(async () => ({
        outcome: "unchanged",
        doctorVersion: "2026.7.2",
        changedPaths: [],
        diagnostics: [],
        repairedCandidate: { agents: { list: [{ id: "moof" }] } },
      })),
    }));
    return instance;
  }

  it("requires the pod-local gateway bearer", async () => {
    const response = await request(app()).post("/agent-import/doctor").send({ candidate: {} }).expect(401, {
      error: "agent import doctor authentication failed",
    });
    expect(response.body).toEqual({ error: "agent import doctor authentication failed" });
  });

  it("returns only the structured doctor result", async () => {
    const response = await request(app())
      .post("/agent-import/doctor")
      .set("authorization", "Bearer pod-token")
      .send({ candidate: { agents: { list: [{ id: "moof" }] } } })
      .expect(200, {
        outcome: "unchanged",
        doctorVersion: "2026.7.2",
        changedPaths: [],
        diagnostics: [],
        repairedCandidate: { agents: { list: [{ id: "moof" }] } },
      });
    expect(response.body).toMatchObject({ outcome: "unchanged", doctorVersion: "2026.7.2" });
  });

  it("keeps health responsive while a doctor command is pending", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const instance = express();
    instance.use(express.json());
    instance.get("/health", (_req, res) => { res.json({ status: "ok" }); });
    instance.post("/agent-import/doctor", createAgentImportDoctorHandler({
      token: "pod-token",
      runDoctor: async () => {
        await pending;
        return {
          outcome: "unchanged", doctorVersion: "2026.7.2", changedPaths: [], diagnostics: [],
        };
      },
    }));
    const doctor = request(instance).post("/agent-import/doctor")
      .set("authorization", "Bearer pod-token").send({ candidate: {} });
    const doctorPromise = doctor.then((response) => response);
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    await request(instance).get("/health").expect(200, { status: "ok" });
    release();
    await doctorPromise;
  });

  it("is mounted by every fleet controller with the pod-shared gateway token", async () => {
    const instance = express();
    instance.use(express.json());
    const runDoctor = vi.fn(async () => ({
      outcome: "unchanged" as const,
      doctorVersion: "2026.7.2",
      changedPaths: [],
      diagnostics: [],
      repairedCandidate: { agents: { list: [{ id: "moof" }] } },
    }));
    registerAgentImportDoctor(instance, {
      agentImportDoctorToken: "pod-token",
      runAgentImportDoctor: runDoctor,
    } as StartFleetOptions);

    await request(instance)
      .post("/agent-import/doctor")
      .set("authorization", "Bearer pod-token")
      .send({ candidate: { agents: { list: [{ id: "moof" }] } } })
      .expect(200);
    expect(runDoctor).toHaveBeenCalledOnce();
  });
});

function result(status: number, stdout = "", stderr = ""): AgentImportDoctorCommandResult {
  return { status, stdout, stderr };
}
