import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { noUserAccounts } from "@octogee/core/user-account";
import type { UserSuspensionDeps } from "../handlers/suspend-user.js";

const captured = vi.hoisted(() => ({ suspend: [] as unknown[] }));

vi.mock("../handlers/suspend-user.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../handlers/suspend-user.js")>()),
  createSuspendUserHandler: (deps: unknown) => {
    captured.suspend.push(deps);
    return async () => ({ steps: [], success: true });
  },
}));

import { buildUserRemovalHandlers } from "../index.js";

function builtSuspensionDeps(): UserSuspensionDeps {
  buildUserRemovalHandlers({
    documents: {} as never,
    store: createDocumentFixtureStore({}),
    logFn: () => undefined,
    kubeOps: {} as never,
    privateKey: "private-key",
    userLifecycle: null,
    accounts: noUserAccounts,
  });
  return captured.suspend.at(-1) as UserSuspensionDeps;
}

let requests: Array<[string, string, string]>;

beforeEach(() => {
  captured.suspend.length = 0;
  requests = [];
  vi.stubEnv("GIT_API_URL", "https://git.example.test/api/v1");
  vi.stubEnv("GIT_API_TOKEN", "git-token");
  vi.stubEnv("MM_URL", "https://mm.example.test");
  vi.stubEnv("MM_ADMIN_TOKEN", "mm-token");
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const headers = init.headers as Record<string, string>;
    requests.push([init.method ?? "GET", String(url), headers.Authorization ?? ""]);
    return new Response("{}", { status: 200 });
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("user suspension sign-in wiring", () => {
  it("blocks chat and git sign-in through the platform's Mattermost and Gitea admin accounts", async () => {
    const deps = builtSuspensionDeps();

    await deps.blockChatSignIn("mm-ada");
    await deps.blockGitSignIn("ada");

    expect(requests).toEqual([
      ["PUT", "https://mm.example.test/api/v4/users/mm-ada/active", "Bearer mm-token"],
      ["POST", "https://mm.example.test/api/v4/users/mm-ada/sessions/revoke/all", "Bearer mm-token"],
      ["PATCH", "https://git.example.test/api/v1/admin/users/ws-ada", "token git-token"],
    ]);
  });
});
