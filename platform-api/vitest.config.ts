import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    server: {
      deps: {
        inline: [/@octogee\/core/],
      },
    },
    setupFiles: ["./src/test-setup/deployment-targets.ts", "./src/test-setup/octogee-entitlements.ts", './src/test-setup/loopback-listen.ts', './src/test-setup/runtime-env.ts'],
    // Run files serially: under concurrent file execution the forks pool
    // intermittently drops a spec's own vi.mock, so specs that pass in
    // isolation flake in-suite. Serial is the reliable fix (tests within a file
    // still run together).
    fileParallelism: false,
    // Serial integration specs drive real HTTP via supertest; 5s is tight under
    // load.
    testTimeout: 15000,
    exclude: [
      'dist/**',
      'node_modules/**',
      // Don't run gateway-edge's own specs from here — gateway-edge
      // is the owner of those. We pull in gateway-edge/src/ for route
      // handler reuse only.
      '../gateway-edge/**',
    ],
  },
});
