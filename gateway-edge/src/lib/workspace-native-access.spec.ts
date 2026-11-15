import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchInternal = vi.hoisted(() => vi.fn());
vi.mock("@octogee/core/internal-fetch", () => ({ internalFetch: fetchInternal }));
import { resolveWorkspaceNativeIdentity } from "./workspace-native-access.js";

const args = {
  gatewayId: "b-alice", authorization: "Bearer firebase-user", targetUid: "member",
  baseUrl: "http://octogee-api:3001", env: {},
};
const identity = { uid: "caller", gatewayId: "b-alice", workspaceSlug: "alice", targetUid: "member" };

beforeEach(() => vi.clearAllMocks());

describe("workspace native identity broker", () => {
  it("binds the verified caller and target to the local gateway through projected service authentication", async () => {
    fetchInternal.mockResolvedValue(new Response(JSON.stringify(identity)));
    expect(await resolveWorkspaceNativeIdentity(args)).toEqual(identity);
    expect(fetchInternal).toHaveBeenCalledWith(
      "http://octogee-api:3001/internal/openclaw-control/workspace-access",
      expect.objectContaining({ body: JSON.stringify({ gatewayId: "b-alice", targetUid: "member" }),
        headers: { authorization: "Bearer firebase-user", "content-type": "application/json" }, redirect: "error" }),
      expect.objectContaining({ requireProjectedToken: true, timeoutMs: 5000 }),
    );
  });

  it.each([
    { gatewayId: "other" }, { uid: "" }, { workspaceSlug: "" }, { targetUid: "other" }, { targetUid: undefined },
  ])("rejects a mismatched or incomplete broker identity: %j", async patch => {
    fetchInternal.mockResolvedValue(new Response(JSON.stringify({ ...identity, ...patch })));
    await expect(resolveWorkspaceNativeIdentity(args)).rejects.toThrow("invalid identity");
  });

  it("requires the user's bearer before reaching the broker", async () => {
    await expect(resolveWorkspaceNativeIdentity({ ...args, authorization: undefined })).rejects.toMatchObject({ status: 401 });
    expect(fetchInternal).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 500])("retains access denials and reports broker outages: %s", async status => {
    fetchInternal.mockResolvedValue(new Response(null, { status }));
    await expect(resolveWorkspaceNativeIdentity(args)).rejects.toMatchObject({ status: status === 500 ? 503 : status });
  });
});
