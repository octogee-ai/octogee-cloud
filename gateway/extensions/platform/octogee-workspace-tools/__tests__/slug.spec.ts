import { describe, it, expect } from "vitest";
import { extractSlug, resolveSlug,
  resolveLane,
  parseAgentIdentity,
} from "../slug.js";
import { WorkspaceToolError } from "../errors.js";

describe("extractSlug", () => {
  it("pulls the slug from a managed agentId", () => {
    expect(extractSlug("octogee-acme-coach")).toBe("acme");
  });
  it("handles slugs with hyphens", () => {
    expect(extractSlug("octogee-wild-card-coach")).toBe("wild-card");
  });
  it("returns null for an unmanaged agentId", () => {
    expect(extractSlug("octogee-acme-operator")).toBeNull();
    expect(extractSlug("some-random-agent")).toBeNull();
  });
  it("returns null for empty / non-string input", () => {
    expect(extractSlug(undefined)).toBeNull();
    expect(extractSlug("")).toBeNull();
    expect(extractSlug(123 as unknown as string)).toBeNull();
  });
});

describe("resolveSlug", () => {
  it("returns the slug from ctx.agentId", () => {
    expect(resolveSlug({ agentId: "octogee-acme-coach" })).toBe("acme");
  });
  it("throws no-agent when agentId is missing or non-string", () => {
    try {
      resolveSlug({ agentId: 42 });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceToolError);
      expect((err as WorkspaceToolError).code).toBe("no-agent");
    }
  });
  it("throws not-coach when agentId is not a managed agent", () => {
    try {
      resolveSlug({ agentId: "octogee-acme-operator" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as WorkspaceToolError).code).toBe("not-coach");
    }
  });
});

describe("resolveLane — multi-agent project agents", () => {
  it("derives the project lane from the agent identity, workspace slug intact", () => {
    expect(resolveLane({ agentId: "octogee-alice-proj-orbit-coach" })).toEqual({
      slug: "alice",
      project: "orbit",
    });
    expect(resolveLane({ agentId: "octogee-christopher-eckert-coach" })).toEqual({
      slug: "christopher-eckert",
      project: null,
    });
  });

  it("extractSlug returns the workspace slug for project agents (not the greedy body)", () => {
    expect(extractSlug("octogee-alice-proj-orbit-coach")).toBe("alice");
  });

  it("rejects malformed project segments", () => {
    expect(parseAgentIdentity("octogee-alice-proj--coach")).toBeNull();
  });
});
