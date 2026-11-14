import { defineConfig, configDefaults } from "vitest/config";
import { existsSync } from "node:fs";
import path from "node:path";

const LINUX_HOST_SPECS = [
  "__tests__/cleanup-agents.spec.ts",
  "__tests__/user-file-state.spec.ts",
  "__tests__/desktop-browser-start.spec.ts",
  "__tests__/fleet-http-migration.spec.ts",
  "__tests__/native-computer-acceptance.spec.ts",
  "__tests__/project-blob-materialization.spec.ts",
  "__tests__/rsync-staged-symlinks.spec.ts",
  "__tests__/vm-gateway-agent/desktop-control.spec.ts",
  "__tests__/vm-gateway-agent/home-tool-storage-archive.spec.ts",
];

const PRODUCT_CHECKOUT_SPECS = [
  "__tests__/ci-install-tools.spec.ts",
  "__tests__/deploy-workflow-log-level.spec.ts",
  "__tests__/deployment-target-contract.spec.ts",
  "__tests__/desktop-image-build.spec.ts",
  "__tests__/directory-dependency-contract.spec.ts",
  "__tests__/firebase-deploy-hosting.spec.ts",
  "__tests__/image-fingerprint-reuse.spec.ts",
  "__tests__/mattermost-capability-artifact.spec.ts",
  "__tests__/platform-boundary.spec.ts",
  "__tests__/release-digest-manifest-contract.spec.ts",
  "__tests__/release-digest-manifest.spec.ts",
  "__tests__/release-digest-tag-lookup.spec.ts",
  "__tests__/setup-secrets-env-loader.spec.ts",
  "__tests__/vite-third-party-licenses.spec.ts",
];

const STANDALONE_PLATFORM_SPECS = [
  "__tests__/firebase-reach.spec.ts",
];

const GIT_CHECKOUT_SPECS = [
  "__tests__/publish-plugin.spec.ts",
];

const insideProductCheckout = existsSync(path.resolve(__dirname, "../../product"));
const insideGitCheckout = existsSync(path.resolve(__dirname, "../.git"));

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
      ...(insideProductCheckout ? STANDALONE_PLATFORM_SPECS : PRODUCT_CHECKOUT_SPECS),
      ...(insideGitCheckout ? [] : GIT_CHECKOUT_SPECS),
    ],
    setupFiles: ["./test-setup/deployment-targets.ts", "./test-setup/user-entitlements.ts", "./test-setup/loopback-listen.ts"],
    // Operator-tooling specs spawn real subprocesses (kubectl shims, tsx
    // children); 5s fits only an idle machine, and the full parallel suite
    // on a loaded Mac starves them into timeouts.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
