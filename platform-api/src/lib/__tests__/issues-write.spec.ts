import { describe, it, expect } from "vitest";
import {
  STATUS_PREFIX,
  STATUS_LABEL_SEED,
  KNOWN_LABEL_SEED,
  computeLabelReplacement,
  isValidColumn,
  isValidLabelName,
  labelForColumn,
  seedForLabel,
  statusLabelsOn,
  targetState,
  computeMove,
} from "../issues-write.js";

describe("isValidColumn", () => {
  it("accepts the five board columns and rejects others", () => {
    for (const k of ["backlog", "todo", "doing", "review", "done"]) expect(isValidColumn(k)).toBe(true);
    expect(isValidColumn("nope")).toBe(false);
    expect(isValidColumn("status:todo")).toBe(false);
  });
});

describe("labelForColumn", () => {
  it("maps labeled columns to a status:* label and backlog/done to null", () => {
    expect(labelForColumn("todo")).toBe(`${STATUS_PREFIX}todo`);
    expect(labelForColumn("doing")).toBe(`${STATUS_PREFIX}doing`);
    expect(labelForColumn("review")).toBe(`${STATUS_PREFIX}review`);
    expect(labelForColumn("backlog")).toBeNull();
    expect(labelForColumn("done")).toBeNull();
  });
});

describe("statusLabelsOn", () => {
  it("returns only the status:* labels", () => {
    expect(statusLabelsOn(["ux", "status:doing", "bug"])).toEqual(["status:doing"]);
    expect(statusLabelsOn(["ux"])).toEqual([]);
  });
});

describe("targetState", () => {
  it("closes for done and opens for everything else", () => {
    expect(targetState("done")).toBe("closed");
    expect(targetState("backlog")).toBe("open");
    expect(targetState("review")).toBe("open");
  });
});

describe("STATUS_LABEL_SEED", () => {
  it("seeds exactly the labeled columns with hex colors (no leading #)", () => {
    expect(STATUS_LABEL_SEED.map((l) => l.name)).toEqual(["status:todo", "status:doing", "status:review"]);
    for (const l of STATUS_LABEL_SEED) expect(l.color).toMatch(/^[0-9a-f]{6}$/);
  });
});

describe("isValidLabelName", () => {
  it("rejects status labels, empty, comma'd, and oversize names", () => {
    expect(isValidLabelName("bug")).toBe(true);
    expect(isValidLabelName("good first issue")).toBe(true);
    expect(isValidLabelName("status:todo")).toBe(false);
    expect(isValidLabelName("")).toBe(false);
    expect(isValidLabelName("a,b")).toBe(false);
    expect(isValidLabelName(" leading")).toBe(false);
    expect(isValidLabelName("x".repeat(51))).toBe(false);
  });
});

describe("computeLabelReplacement", () => {
  it("preserves the status label while replacing editable labels", () => {
    expect(computeLabelReplacement(["status:doing", "bug", "ux"], ["enhancement"])).toEqual([
      "status:doing",
      "enhancement",
    ]);
  });
  it("drops invalid and status-prefixed requests and dedupes", () => {
    expect(computeLabelReplacement(["status:todo"], ["bug", "bug", "status:review", ""])).toEqual([
      "status:todo",
      "bug",
    ]);
  });
  it("clears editable labels when requested is empty", () => {
    expect(computeLabelReplacement(["status:review", "bug"], [])).toEqual(["status:review"]);
  });
});

describe("seedForLabel", () => {
  it("returns the known seed color for bug and a default for unknown labels", () => {
    expect(seedForLabel("bug")).toEqual({ name: "bug", color: "d73a4a" });
    expect(seedForLabel("mystery")).toEqual({ name: "mystery", color: "ededed" });
  });
  it("keeps known seeds as hex colors including Pulse's bug label", () => {
    expect(KNOWN_LABEL_SEED.map((l) => l.name)).toContain("bug");
    for (const l of KNOWN_LABEL_SEED) expect(l.color).toMatch(/^[0-9a-f]{6}$/);
  });
});

describe("computeMove", () => {
  it("swaps the status label and reopens when moving to a labeled column", () => {
    expect(computeMove(["status:doing", "ux"], "review")).toEqual({
      remove: ["status:doing"],
      add: "status:review",
      state: "open",
    });
  });
  it("removes status labels and closes when moving to done", () => {
    expect(computeMove(["status:review"], "done")).toEqual({
      remove: ["status:review"],
      add: null,
      state: "closed",
    });
  });
  it("removes status labels and adds nothing when moving to backlog", () => {
    expect(computeMove(["status:todo"], "backlog")).toEqual({ remove: ["status:todo"], add: null, state: "open" });
  });
  it("handles an issue with no current status labels", () => {
    expect(computeMove(["bug"], "doing")).toEqual({ remove: [], add: "status:doing", state: "open" });
  });
});
