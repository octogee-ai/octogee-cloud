import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/test-setup/deployment-targets.ts", "./src/test-setup/octogee-entitlements.ts", "./src/test-setup/loopback-listen.ts", "./src/test-setup/public-app-origins.ts"],
    include: ["src/**/*.spec.ts"],
    exclude: ["src/__tests__/**/*.emulator.spec.ts"],
  },
});
