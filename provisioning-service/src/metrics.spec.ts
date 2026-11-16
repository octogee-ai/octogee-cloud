import { describe, expect, it } from "vitest";
import { Metrics } from "./metrics.js";

const SNAPSHOT = { states: { queued: 0, running: 0, retrying: 0, parked: 0, idle: 0 }, oldestDueSeconds: 0, generationLagSeconds: 0 };

describe("the git key gauge", () => {
  it("exports a status or reason outside the shared names as Unrecognized, so stored text cannot add label values", () => {
    const text = new Metrics().render({
      ...SNAPSHOT,
      gitKeys: [
        { status: "False", reason: "GitKeyNotOnHost", count: 2 },
        { status: "Maybe", reason: "user-supplied text", count: 1 },
      ],
    });

    expect(text).toContain('provisioning_git_keys{status="False",reason="GitKeyNotOnHost"} 2');
    expect(text).toContain('provisioning_git_keys{status="Unrecognized",reason="Unrecognized"} 1');
    expect(text).not.toContain("user-supplied text");
  });
});
