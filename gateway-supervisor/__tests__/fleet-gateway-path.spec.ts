import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import {
  pathGatewayIdMatchesPod,
  rejectMisaddressedGateway,
} from "../lib/fleet-gateway-path.js";

function mkResponse(): { res: Response; status: () => number | undefined; body: () => unknown } {
  let status: number | undefined;
  let payload: unknown;
  const res = {
    status: (code: number) => {
      status = code;
      return { json: (value: unknown) => { payload = value; } };
    },
  } as unknown as Response;
  return { res, status: () => status, body: () => payload };
}

describe("in-pod migration path guard (transport/tenant split)", () => {
  it("accepts the bare gateway id that matches the pod's GATEWAY_ID", () => {
    expect(pathGatewayIdMatchesPod("default", "default")).toBe(true);
  });

  it("REJECTS a revision id in the path — transport is addressed by Service, not the tenant path", () => {
    expect(pathGatewayIdMatchesPod("default-r2", "default")).toBe(false);
  });

  it("rejects a mismatched gateway id and an absent path param", () => {
    expect(pathGatewayIdMatchesPod("other", "default")).toBe(false);
    expect(pathGatewayIdMatchesPod(undefined, "default")).toBe(false);
  });
});

describe("rejectMisaddressedGateway", () => {
  it("passes a request addressed to this pod", () => {
    const { res, status } = mkResponse();

    expect(rejectMisaddressedGateway(
      { params: { gatewayId: "builder-jack" } } as unknown as Request,
      res,
      "builder-jack",
      vi.fn(),
    )).toBe(false);
    expect(status()).toBeUndefined();
  });

  it("rejects another gateway's id without naming this pod in the response", () => {
    const { res, status, body } = mkResponse();
    const log = vi.fn();

    expect(rejectMisaddressedGateway(
      { params: { gatewayId: "shared-a" } } as unknown as Request,
      res,
      "builder-jack",
      log,
    )).toBe(true);
    expect(status()).toBe(400);
    expect(JSON.stringify(body())).not.toContain("builder-jack");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("builder-jack"));
  });
});
