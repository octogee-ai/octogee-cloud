import { describe, expect, it } from "vitest";
import {
  operationForStore,
  operationInputForStore,
  operationInputFromStored,
} from "../previous-release-operation-input.js";

describe("operation input shared with the previous release", () => {
  it("stores the user slug under the previous release's key as well", () => {
    expect(operationInputForStore({ uid: "u1", userSlug: "ada" })).toEqual({ uid: "u1", userSlug: "ada", builderSlug: "ada" });
    expect(operationForStore({ kind: "migrate-user", input: { userSlug: "ada" } }).input).toEqual({ userSlug: "ada", builderSlug: "ada" });
  });

  it("stores input without a user slug unchanged", () => {
    const input = { uid: "u1" };
    expect(operationInputForStore(input)).toBe(input);
  });

  it("reads the previous release's key as the user slug", () => {
    expect(operationInputFromStored({ uid: "u1", builderSlug: "ada" })).toEqual({ uid: "u1", userSlug: "ada" });
  });

  it("reads back what it stored without the previous release's key", () => {
    expect(operationInputFromStored(operationInputForStore({ uid: "u1", userSlug: "ada" }))).toEqual({ uid: "u1", userSlug: "ada" });
  });

  it("prefers the user slug when both keys are stored", () => {
    expect(operationInputFromStored({ userSlug: "ada", builderSlug: "old" })).toEqual({ userSlug: "ada" });
  });
});
