import { defineConfig, configDefaults } from "vitest/config";
import path from "node:path";

const LINUX_HOST_SPECS = [
  "__tests__/user-file-state.spec.ts",
  "__tests__/desktop-browser-start.spec.ts",
  "__tests__/fleet-http-migration.spec.ts",
  "__tests__/project-blob-materialization.spec.ts",
  "__tests__/rsync-staged-symlinks.spec.ts",
  "__tests__/vm-gateway-agent/desktop-control.spec.ts",
  "__tests__/vm-gateway-agent/home-tool-storage-archive.spec.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  test: {
    include: ["__tests__/**/*.spec.ts"],
    exclude: [
      ...configDefaults.exclude,
      "**/*.emulator.spec.ts",
      ...(process.platform === "linux" ? [] : LINUX_HOST_SPECS),
    ],
    setupFiles: ["./test-setup/deployment-targets.ts", "./test-setup/user-entitlements.ts", "./test-setup/loopback-listen.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
