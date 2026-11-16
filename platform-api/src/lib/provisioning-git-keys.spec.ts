import { describe, expect, it } from "vitest";
import { provisioningGitKeysFromEnvironment } from "./provisioning-git-keys.js";

describe("provisioningGitKeysFromEnvironment", () => {
  it("is off without a provisioning service URL", () => {
    expect(provisioningGitKeysFromEnvironment({})).toBeNull();
  });

  it("is on with a URL and a token path", () => {
    expect(provisioningGitKeysFromEnvironment({ PROVISIONING_SERVICE_URL: "http://p.test", PROVISIONING_SERVICE_TOKEN_PATH: "/t" })).not.toBeNull();
  });
});
