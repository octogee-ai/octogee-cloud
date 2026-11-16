import { createHash } from "node:crypto";

import { describe, it, expect } from "vitest";
import {
  WORKSPACE_REPO,
  SYSTEM_CONFIG_REPO,
  workspaceGiteaOrg,
  workspaceRepoName,
  systemConfigRepoName,
  projectRepoName,
  gatewayKeyOwnerId,
  gatewayKeyTitle,
  isManagedGatewayKeyTitle,
  publicKeyIdentity,
} from "./gitea-naming.js";

describe("gitea-naming", () => {
  it("org is the bare workspace slug (1:1 with MM team)", () => {
    expect(workspaceGiteaOrg("acme")).toBe("acme");
  });

  it("workspace repo is the bare name 'workspace' — no slug prefix", () => {
    expect(workspaceRepoName()).toBe("workspace");
    expect(WORKSPACE_REPO).toBe("workspace");
    expect(workspaceRepoName()).not.toContain("acme");
  });

  it("system config repo is the fixed per-user runtime-config repo", () => {
    expect(systemConfigRepoName()).toBe("system_config");
    expect(SYSTEM_CONFIG_REPO).toBe("system_config");
  });

  it("project repo is the bare project slug — org provides the namespace", () => {
    expect(projectRepoName("landing")).toBe("landing");
    expect(projectRepoName("landing")).not.toMatch(/^acme-/);
    expect(projectRepoName("landing")).not.toContain("-proj-");
  });
});

describe("gateway SSH key titles", () => {
  it("names the owner as gateway id and pod name", () => {
    expect(gatewayKeyOwnerId("shared-0", "octogee-gateway-shared-0-abc12-xyz")).toBe(
      "shared-0/octogee-gateway-shared-0-abc12-xyz",
    );
  });

  it("titles a key by the sha256 prefix of its owner identity", () => {
    expect(gatewayKeyTitle("shared-0/octogee-gateway-shared-0-abc12-xyz")).toBe(
      `octogee-gateway-${createHash("sha256")
        .update("shared-0/octogee-gateway-shared-0-abc12-xyz")
        .digest("hex")
        .slice(0, 16)}`,
    );
  });

  it("recognizes only platform gateway titles as managed", () => {
    expect(isManagedGatewayKeyTitle("octogee-gateway")).toBe(true);
    expect(isManagedGatewayKeyTitle(gatewayKeyTitle("g/p"))).toBe(true);
    expect(isManagedGatewayKeyTitle("my laptop")).toBe(false);
    expect(isManagedGatewayKeyTitle("octogee-gatewayish")).toBe(false);
  });
});

describe("public key identity", () => {
  it("is the key type and material, whatever the comment and spacing", () => {
    expect(publicKeyIdentity("  ssh-ed25519   AAAAlin   lin@gateway one \n")).toBe("ssh-ed25519 AAAAlin");
    expect(publicKeyIdentity("ssh-ed25519 AAAAlin")).toBe(publicKeyIdentity("ssh-ed25519 AAAAlin other comment"));
    expect(publicKeyIdentity("ssh-ed25519 AAAAlin")).not.toBe(publicKeyIdentity("ssh-rsa AAAAlin"));
  });
});
