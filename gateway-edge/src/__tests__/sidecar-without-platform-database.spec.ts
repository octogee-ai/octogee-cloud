import { beforeEach, describe, expect, it, vi } from "vitest";

const PLATFORM_ENV = /^PLATFORM_DB_/;

describe("gateway-edge sidecar without platform database settings", () => {
  beforeEach(() => {
    for (const name of Object.keys(process.env)) {
      if (PLATFORM_ENV.test(name)) vi.stubEnv(name, undefined);
    }
    vi.stubEnv("GATEWAY_ID", "walter");
    vi.stubEnv("OPENCLAW_RUNTIME_BROKER_URL", "http://octogee-api:3001");
  });

  it("loads its entry module graph", async () => {
    await expect(import("../main.js")).resolves.toBeDefined();
  });

  it("fails loudly at the first platform-state use", async () => {
    const { platformStateStore } = await import("@octogee/core/identity/platform-state-store");
    expect(() => platformStateStore.users).toThrow(/PLATFORM_DB_\w+ is required/);
  });
});
