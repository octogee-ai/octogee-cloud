import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADD_GATEWAY_DEPLOYMENT_READY_TIMEOUT_MS,
  bootstrapGlmGateways,
  versionFromImageTag,
} from "../index";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import type { AuthSecretEnsurer } from "../auth-secret-ensurer";
import { createLoggingHelmRunner } from "../helm-runner";
import { operationHandlers } from "./fixtures/operation-handlers";

function controllerDeps() {
  const log = vi.fn();
  const helm = createLoggingHelmRunner(log);
  return {
    store: createDocumentFixtureStore({}),
    helm: { ...helm, readDeployedInstances: vi.fn(helm.readDeployedInstances) },
    handlers: operationHandlers(),
    log,
    ensureGatewayAuthSecret: vi.fn<AuthSecretEnsurer["ensureAuthSecret"]>(async () => {}),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("legacy bootstrap is disabled", () => {
  it("does not inspect Helm or create bare desired documents", async () => {
    const deps = controllerDeps();

    await bootstrapGlmGateways(deps);

    expect(deps.helm.readDeployedInstances).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("bootstrap disabled"));
  });
});

describe("versionFromImageTag", () => {
  it("publishes the complete OpenClaw-qualified tag as the operator observed version", () => {
    expect(versionFromImageTag("cf36a88-oc2026.7.1")).toBe("cf36a88-oc2026.7.1");
  });

  it("preserves an unqualified immutable tag exactly", () => {
    expect(versionFromImageTag("cf36a88")).toBe("cf36a88");
  });

  it("uses the immutable tag name for a digest-pinned candidate heartbeat", () => {
    expect(versionFromImageTag(`8c356bb-oc2026.7.1@sha256:${"a".repeat(64)}`)).toBe(
      "8c356bb-oc2026.7.1",
    );
  });
});

describe("cold gateway provisioning window", () => {
  it("allows a Spot scale-up and first image pull to run for thirty minutes", () => {
    expect(ADD_GATEWAY_DEPLOYMENT_READY_TIMEOUT_MS).toBe(30 * 60_000);
  });
});
