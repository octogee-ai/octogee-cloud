import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    setupFiles: ["./src/test-setup/static-entitlements.ts", "./src/test-setup/loopback-listen.ts"],
    testTimeout: 15000,
  },
});
