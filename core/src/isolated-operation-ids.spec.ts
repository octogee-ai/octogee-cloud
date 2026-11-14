import { describe, expect, it } from "vitest";

import {
  builderActivateOperationId,
  isolatedRecoverOperationId,
  builderReturnOperationId,
  isUserActivateOperationIdFor,
  isUserReturnOperationIdFor,
  placementRetireOperationId,
} from "./isolated-operation-ids.js";

describe("Isolated runtime operation ids", () => {
  it("qualify each runtime operation with the allocation generation", () => {
    expect(builderActivateOperationId("alice-m-1234abcd", 3)).toBe("builder-activate-alice-m-1234abcd-g3");
    expect(builderReturnOperationId("alice-m-1234abcd", 3)).toBe("builder-return-alice-m-1234abcd-g3");
    expect(isolatedRecoverOperationId("alice-m-1234abcd", 3)).toBe("builder-recover-alice-m-1234abcd-g3");
    expect(placementRetireOperationId("uid-alice", "alice-m-1234abcd", 3))
      .toBe("placement-retire-uid-alice-alice-m-1234abcd-g3");
  });

  it("give a reused gateway distinct operations per generation", () => {
    expect(builderReturnOperationId("alice-m-1234abcd", 1))
      .not.toBe(builderReturnOperationId("alice-m-1234abcd", 2));
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects generation %s", (generation) => {
    expect(() => builderActivateOperationId("alice-m-1234abcd", generation)).toThrow(/generation/);
  });

  it("rejects an empty gateway id", () => {
    expect(() => builderReturnOperationId("", 1)).toThrow(/gateway/);
  });
});

describe("Isolated runtime operation id recognition", () => {
  it("recognizes any generation of the exact gateway's operation", () => {
    expect(isUserReturnOperationIdFor("builder-return-alice-m-1234abcd-g7", "alice-m-1234abcd")).toBe(true);
    expect(isUserActivateOperationIdFor("builder-activate-alice-m-1234abcd-g1", "alice-m-1234abcd")).toBe(true);
  });

  it.each([
    ["builder-return-alice-m-1234abcd", "ungenerationed id"],
    ["builder-return-alice-m-1234abcd-g0", "zero generation"],
    ["builder-return-alice-m-1234abcd-g1-g2", "another gateway's suffix"],
    ["builder-activate-alice-m-1234abcd-g1", "another operation kind"],
    ["builder-return-bob-m-1234abcd-g1", "another gateway"],
  ])("rejects %s (%s)", (operationId) => {
    expect(isUserReturnOperationIdFor(operationId, "alice-m-1234abcd")).toBe(false);
  });

  it("rejects a missing gateway id", () => {
    expect(isUserReturnOperationIdFor("builder-return--g1", undefined)).toBe(false);
  });
});
