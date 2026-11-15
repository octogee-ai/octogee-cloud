import { describe, expect, it, vi } from "vitest";
import { createImagePrepuller } from "../image-prepuller.js";

const image = {
  repository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
  tag: "def5678",
};

describe("createImagePrepuller", () => {
  it("applies a short-lived DaemonSet, waits for every node, and deletes it", async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const runKubectl = vi.fn(async (args: string[], opts?: { stdin?: string }) => {
      calls.push({ args, stdin: opts?.stdin });
      return { stdout: "", stderr: "", code: 0 };
    });
    const prepull = createImagePrepuller({ runKubectl, log: vi.fn() });

    await prepull({ namespace: "octogee-test", images: [image] });

    expect(calls.map((call) => call.args[0])).toEqual(["apply", "rollout", "delete"]);
    expect(calls[0]?.stdin).toContain(`${image.repository}:${image.tag}`);
    const daemonSet = JSON.parse(calls[0]?.stdin ?? "{}") as {
      spec?: { template?: { spec?: { tolerations?: unknown } } };
    };
    expect(daemonSet.spec?.template?.spec?.tolerations).toEqual([{ operator: "Exists" }]);
    expect(calls[1]?.args).toContain("daemonset/octogee-gateway-image-prepull");
    expect(calls[2]?.args).toContain("--ignore-not-found");
    expect(calls[2]?.args).not.toContain("--wait=false");
  });

  it("still deletes the DaemonSet and propagates a rollout failure", async () => {
    const runKubectl = vi.fn(async (args: string[]) => ({
      stdout: "",
      stderr: args[0] === "rollout" ? "timed out" : "",
      code: args[0] === "rollout" ? 1 : 0,
    }));
    const prepull = createImagePrepuller({ runKubectl, log: vi.fn() });

    await expect(prepull({ namespace: "octogee", images: [image] })).rejects.toThrow(
      "timed out",
    );
    expect(runKubectl.mock.calls.at(-1)?.[0]?.[0]).toBe("delete");
  });
});
