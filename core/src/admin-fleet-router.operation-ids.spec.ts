import request from "supertest";
import { describe, expect, it } from "vitest";

import { FLEET, harness, send, type ChangingRequest, type Seed } from "@octogee/core-testing/admin-dry-run-app";

const ADMITTED: Seed = {
  "users/uid-bo": { username: "bo", onboardingStep: "complete", provisioning: { status: "complete", openclaw: { slug: "bo" } } },
  "users/uid-cy": {
    username: "cy", onboardingStep: "complete",
    provisioning: { status: "complete", openclaw: { slug: "cy", gatewayId: "shared-a", status: "complete" } },
  },
};

describe("a change the journal records as an audit", () => {
  it.each<[string, ChangingRequest, number, string]>([
    ["a gateway update", { method: "patch", path: "/gateways/shared-b", body: { desiredStatus: "paused" } }, 202, "update gateway desired configuration"],
    ["an assignment", { method: "post", path: "/users/uid-bo/assign", body: { gatewayId: "shared-b" } }, 202, "assign user to gateway"],
    ["a repaired assignment", { method: "post", path: "/users/uid-cy/assign", body: { gatewayId: "shared-a" } }, 200, "assign user to gateway"],
    ["an unassignment", { method: "post", path: "/users/uid-ada/unassign" }, 200, "unassign user from gateway"],
  ])("returns the id of the record for %s", async (_change, call, status, what) => {
    const h = harness({ ...FLEET, ...ADMITTED });

    const applied = await send(h.app, call, false);
    expect(applied.status, JSON.stringify(applied.body)).toBe(status);
    const recorded = await request(h.app).get(`/operations/${applied.body.operationId}`).expect(200);

    expect(recorded.body.operation).toMatchObject({ id: applied.body.operationId, recordType: "audit", what, status: "completed" });
  });
});
