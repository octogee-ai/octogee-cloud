import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../index.ts"), "utf8");

describe("disposable gateway runtime wiring", () => {
  it("does not start the retired claim or wake provisioners", () => {
    expect(source).not.toContain('from "./trial-gateway-provisioner.js"');
    expect(source).not.toContain("startTrialGatewayProvisioner(");
    expect(source).not.toContain('from "./user-activation-sweeper.js"');
    expect(source).not.toContain("startUserActivationLeaseSweeper(");
  });
});
