import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ activate: vi.fn(), deliver: vi.fn(), error: vi.fn() }));
vi.mock("./project-agent-readiness.js", () => ({ completeProjectAgentActivations: h.activate }));
vi.mock("../../../gateway-edge/src/lib/project-agent-onboarding.js", () => ({ deliverProjectAgentOnboarding: h.deliver }));
vi.mock("../../../gateway-edge/src/middleware/logging.js", () => ({ logger: { error: h.error } }));
import { completeProjectAgentReadiness } from "./project-agent-readiness-delivery.js";

const input = { uid: "u", slug: "alice", gatewayId: "gw-1", projects: ["golf", "garden"].map(projectId => ({
  projectId, activationId: "activation", tokenHash: "a".repeat(64), channelIds: [projectId],
})) };
beforeEach(() => { vi.resetAllMocks(); h.activate.mockResolvedValue(true); });

it("accepts readiness and continues other deliveries after a project handoff fails", async () => {
  const error = new Error("Gitea unavailable");
  h.deliver.mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
  await expect(completeProjectAgentReadiness({} as never, input)).resolves.toBe(true);
  expect(h.deliver.mock.calls).toEqual([["u", "alice", "golf"], ["u", "alice", "garden"]]);
  expect(h.error).toHaveBeenCalledWith("Project onboarding delivery failed", expect.objectContaining({ projectId: "golf", error }));
});

it("does not deliver a stale readiness report", async () => {
  h.activate.mockResolvedValue(false);
  await expect(completeProjectAgentReadiness({} as never, input)).resolves.toBe(false);
  expect(h.deliver).not.toHaveBeenCalled();
});

it("propagates activation failures before accepting readiness", async () => {
  h.activate.mockRejectedValue(new Error("Firestore unavailable"));
  await expect(completeProjectAgentReadiness({} as never, input)).rejects.toThrow("Firestore unavailable");
  expect(h.deliver).not.toHaveBeenCalled();
});
