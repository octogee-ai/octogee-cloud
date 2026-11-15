import { describe, expect, it, vi } from "vitest";

import {
  AGENT_MODEL_TOKEN_ISSUE_CONCURRENCY,
  agentModelTokenIssueKey,
  createAgentModelTokenIssueCoordinator,
  type AgentModelTokenResponse,
} from "./agent-model-token-issue-coordinator.js";

const response = (value: string, expiresAt = 100_000): AgentModelTokenResponse => ({
  value,
  expiresAt,
  provider: "anthropic",
  purpose: "model",
});

describe("agent model token issue coordinator", () => {
  it("shares one exact in-flight and cached token without crossing pod, agent, or provider identity", async () => {
    let now = 1_000;
    const coordinator = createAgentModelTokenIssueCoordinator({ now: () => now });
    const exactKey = agentModelTokenIssueKey({
      gatewayId: "shared-a",
      podName: "shared-a-pod",
      agentId: "octogee-alice-coach",
      provider: "anthropic",
      purpose: "model",
    });
    const task = vi.fn(async () => response("token-a"));

    const values = await Promise.all(
      Array.from({ length: 24 }, () => coordinator.issue(exactKey, task)),
    );
    expect(new Set(values.map((value) => value.value))).toEqual(new Set(["token-a"]));
    expect(task).toHaveBeenCalledOnce();

    await coordinator.issue(exactKey, task);
    expect(task).toHaveBeenCalledOnce();

    now += 60_001;
    await coordinator.issue(exactKey, task);
    expect(task).toHaveBeenCalledTimes(2);

    const otherIdentityKeys = [
      agentModelTokenIssueKey({
        gatewayId: "shared-a",
        podName: "shared-a-next-pod",
        agentId: "octogee-alice-coach",
        provider: "anthropic",
        purpose: "model",
      }),
      agentModelTokenIssueKey({
        gatewayId: "shared-a",
        podName: "shared-a-pod",
        agentId: "octogee-bob-coach",
        provider: "anthropic",
        purpose: "model",
      }),
      agentModelTokenIssueKey({
        gatewayId: "shared-a",
        podName: "shared-a-pod",
        agentId: "octogee-alice-coach",
        provider: "openrouter",
        purpose: "model",
      }),
    ];
    const crossIdentityValues = await Promise.all(
      otherIdentityKeys.map((key, index) =>
        coordinator.issue(key, async () => response(`token-${index}`)),
      ),
    );
    expect(new Set([exactKey, ...otherIdentityKeys])).toHaveLength(4);
    expect(new Set(crossIdentityValues.map((value) => value.value))).toHaveLength(3);
  });

  it("bounds distinct token work below the API's probe-starvation threshold", async () => {
    const coordinator = createAgentModelTokenIssueCoordinator();
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = Array.from({ length: 24 }, (_, index) =>
      coordinator.issue(`identity-${index}`, async () => {
        active++;
        peak = Math.max(peak, active);
        await blocked;
        active--;
        return response(`token-${index}`, Date.now() + 60_000);
      }),
    );

    await vi.waitFor(() => expect(peak).toBe(AGENT_MODEL_TOKEN_ISSUE_CONCURRENCY));
    release();
    await Promise.all(pending);
    expect(peak).toBe(AGENT_MODEL_TOKEN_ISSUE_CONCURRENCY);
  });

  it("clears a failed issue so the exact identity can retry", async () => {
    const coordinator = createAgentModelTokenIssueCoordinator();
    const task = vi
      .fn<() => Promise<AgentModelTokenResponse>>()
      .mockRejectedValueOnce(new Error("assignment unavailable"))
      .mockResolvedValueOnce(response("recovered", Date.now() + 60_000));

    await expect(coordinator.issue("identity", task)).rejects.toThrow("assignment unavailable");
    await expect(coordinator.issue("identity", task)).resolves.toMatchObject({
      value: "recovered",
    });
    expect(task).toHaveBeenCalledTimes(2);
  });
});
