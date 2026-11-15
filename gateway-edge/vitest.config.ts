import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    server: {
      deps: {
        inline: [/@octogee\/core/],
      },
    },
    exclude: ['dist/**', 'node_modules/**'],
    setupFiles: ["./src/test-setup/deployment-targets.ts", "./src/test-setup/octogee-entitlements.ts", './src/test-setup/loopback-listen.ts', './src/test-setup/public-app-origins.ts'],
    // Subprocess-heavy specs (real git, tsx boot) fit 5s only on an idle
    // machine; parallel suites on a loaded Mac starve them into timeouts.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
