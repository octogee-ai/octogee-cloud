import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import type { Request, Response } from "express";

const forward = vi.hoisted(() => {
  process.env.MM_INTERNAL_URL = "http://mattermost.test";
  return vi.fn();
});
vi.mock("../../../gateway-edge/src/chat-proxy/mm-proxy/rest.js", () => ({ forwardMmRest: forward }));

import { createMmRestProxyHandler } from "../routes/mattermost-proxy.js";

const req = { method: "POST", url: "/api/v4/posts", headers: { authorization: "Bearer t" } } as unknown as Request;
const res = {} as Response;

function forwardedOptions() {
  return forward.mock.calls[0]![0] as {
    captureResponse(incoming: { method?: string; url?: string }): boolean;
    onCapturedResponse(captured: { status: number; body: string }): void;
  };
}

describe("Mattermost proxy created-post observer", () => {
  beforeEach(() => forward.mockReset());

  it("does not capture created posts when the platform has no observer", () => {
    createMmRestProxyHandler(createDocumentFixtureStore({}))(req, res);

    expect(forwardedOptions().captureResponse(req)).toBe(false);
  });

  it("hands created posts to the product observer with the caller's authorization", () => {
    const handleCreatedPost = vi.fn(async () => undefined);
    const createPostObserver = vi.fn(() => ({ handleCreatedPost }));

    createMmRestProxyHandler(createDocumentFixtureStore({}), { createPostObserver })(req, res);
    const options = forwardedOptions();
    expect(options.captureResponse(req)).toBe(true);
    options.onCapturedResponse({ status: 201, body: "{}" });

    expect(handleCreatedPost).toHaveBeenCalledWith({ status: 201, body: "{}", authorization: "Bearer t" });
  });
});
