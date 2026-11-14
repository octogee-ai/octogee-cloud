export const JOBS = {
  gatewayEdge: "gateway-edge",
  octogeeApi: "octogee-api",
  glmController: "glm-controller",
  tests: "tests",
  platformTests: "platform-tests",
  acceptance: "acceptance",
  artifactWorker: "artifact-worker",
  scripts: "scripts",
  core: "core",
  shared: "shared",
  productCore: "product-core",
  productShared: "product-shared",
  testHelpers: "test-helpers",
  octogeeActivityTools: "octogee-activity-tools",
  octogeeBrokerTools: "octogee-broker-tools",
  octogeeVoiceTools: "octogee-voice-tools",
  octogeeChatTools: "octogee-chat-tools",
  octogeeAccessTools: "octogee-access-tools",
  octogeeConnectorTools: "octogee-connector-tools",
  octogeeProjectTools: "octogee-project-tools",
  octogeeBoardTools: "octogee-board-tools",
  octogeeWebTools: "octogee-web-tools",
  octogeeWorkspaceTools: "octogee-workspace-tools",
  octogeeStatusTools: "octogee-status-tools",
  octogeeOpsTools: "octogee-ops-tools",
  opsAgent: "ops-agent",
  opsAgentRuntimeTools: "ops-agent-runtime-tools",
  functions: "functions",
  site: "site",
  app: "app",
  obsidianConnect: "obsidian-connect",
  desktop: "desktop",
  desktopPackage: "desktop-package",
  firestoreRules: "firestore-rules",
  userLifecycleEmulator: "customer-lifecycle-emulator",
  functionsEmulator: "functions-emulator",
  gatewayEdgeEmulator: "gateway-edge-emulator",
  glmControllerEmulator: "glm-controller-emulator",
  octogeeApiEmulator: "octogee-api-emulator",
} as const;

export type JobKey = (typeof JOBS)[keyof typeof JOBS];

const TYPECHECK = "npm run typecheck";
const COMMITTED_DIST_TYPECHECK =
  "npm run typecheck && npm run build && node ../scripts/ops/verify-committed-dist.mjs";
const PRODUCT_COMMITTED_DIST_TYPECHECK =
  "npm run typecheck && npm run build && node ../../platform/scripts/ops/verify-committed-dist.mjs";

export interface UnitPackage {
  name: JobKey;
  dir: string;
  typecheck: string;
  nodeVersion?: number;
  matchGatewayImageNpm?: boolean;
}

export const UNIT_PACKAGES: readonly UnitPackage[] = [
  {
    name: JOBS.core,
    dir: "platform/core",
    typecheck: COMMITTED_DIST_TYPECHECK,
  },
  {
    name: JOBS.shared,
    dir: "platform/shared",
    typecheck: COMMITTED_DIST_TYPECHECK,
  },
  {
    name: JOBS.productCore,
    dir: "product/core",
    typecheck: PRODUCT_COMMITTED_DIST_TYPECHECK,
  },
  {
    name: JOBS.productShared,
    dir: "product/shared",
    typecheck: PRODUCT_COMMITTED_DIST_TYPECHECK,
  },
  {
    name: JOBS.testHelpers,
    dir: "product/test-helpers",
    typecheck: PRODUCT_COMMITTED_DIST_TYPECHECK,
  },
  { name: JOBS.gatewayEdge, dir: "platform/gateway-edge", typecheck: TYPECHECK },
  {
    name: JOBS.octogeeApi,
    dir: "platform/octogee-api",
    typecheck: TYPECHECK,
    matchGatewayImageNpm: true,
  },
  { name: JOBS.glmController, dir: "platform/glm-controller", typecheck: TYPECHECK },
  { name: JOBS.opsAgent, dir: "ops-agent", typecheck: TYPECHECK },
  {
    name: JOBS.opsAgentRuntimeTools,
    dir: "ops-agent/extensions/octogee-ops-runtime-tools",
    typecheck: 'echo "ops-agent-runtime-tools — no tsconfig; vitest is the gate"',
  },
  { name: JOBS.tests, dir: "tests", typecheck: TYPECHECK },
  { name: JOBS.platformTests, dir: "platform/tests", typecheck: TYPECHECK },
  { name: JOBS.acceptance, dir: "acceptance", typecheck: TYPECHECK },
  { name: JOBS.artifactWorker, dir: "artifact-worker", typecheck: TYPECHECK },
  { name: JOBS.scripts, dir: "platform/scripts", typecheck: "npx tsc --noEmit", matchGatewayImageNpm: true },
  {
    name: JOBS.octogeeVoiceTools,
    dir: "platform/infra/gateway/extensions/platform/octogee-voice-tools",
    typecheck: 'echo "Voice SDK types run during native packaging; this job runs behavioral tests"',
  },
  {
    name: JOBS.octogeeBrokerTools,
    dir: "platform/infra/gateway/extensions/platform/octogee-broker-tools",
    typecheck: 'echo "Broker SDK types run against the pinned Native source; behavioral tests run here"',
  },
  {
    name: JOBS.octogeeActivityTools,
    dir: "platform/infra/gateway/extensions/platform/octogee-activity-tools",
    typecheck: "npm run typecheck --silent",
  },
  {
    name: JOBS.octogeeAccessTools,
    dir: "platform/infra/gateway/extensions/platform/octogee-access-tools",
    typecheck: 'echo "octogee-access-tools — no tsconfig; vitest is the gate"',
  },
  {
    name: JOBS.octogeeChatTools,
    dir: "platform/infra/gateway/extensions/platform/octogee-chat-tools",
    typecheck: 'echo "octogee-chat-tools — no tsconfig; vitest is the gate"',
  },
  {
    name: JOBS.octogeeConnectorTools,
    dir: "product/infra/gateway/extensions/octogee-connector-tools",
    typecheck: 'echo "octogee-connector-tools — no tsconfig; vitest is the gate"',
  },
  {
    name: JOBS.octogeeProjectTools,
    dir: "product/infra/gateway/extensions/octogee-project-tools",
    typecheck: 'echo "octogee-project-tools — no tsconfig; vitest is the gate"',
  },
  {
    name: JOBS.octogeeBoardTools,
    dir: "product/infra/gateway/extensions/octogee-board-tools",
    typecheck: 'echo "octogee-board-tools — no tsconfig; vitest is the gate"',
  },
  {
    name: JOBS.octogeeWebTools,
    dir: "platform/infra/gateway/extensions/platform/octogee-web-tools",
    typecheck: 'echo "octogee-web-tools — no tsconfig; vitest is the gate"',
  },
  {
    name: JOBS.octogeeWorkspaceTools,
    dir: "platform/infra/gateway/extensions/platform/octogee-workspace-tools",
    typecheck: 'echo "octogee-workspace-tools — no tsconfig; vitest is the gate"',
  },
  {
    name: JOBS.octogeeStatusTools,
    dir: "platform/infra/gateway/extensions/platform/octogee-status-tools",
    typecheck: 'echo "octogee-status-tools — no tsconfig; vitest is the gate"',
  },
  {
    name: JOBS.octogeeOpsTools,
    dir: "product/infra/gateway/extensions/octogee-ops-tools",
    typecheck: 'echo "octogee-ops-tools — no tsconfig; vitest is the gate"',
  },
  { name: JOBS.functions, dir: "functions", typecheck: TYPECHECK, nodeVersion: 22 },
  { name: JOBS.site, dir: "site", typecheck: TYPECHECK },
  { name: JOBS.desktop, dir: "desktop", typecheck: TYPECHECK },
  {
    name: JOBS.obsidianConnect,
    dir: "obsidian-connect",
    typecheck: 'echo "obsidian-connect — plain ESM; node:test is the gate"',
    matchGatewayImageNpm: true,
  },
] as const;

export const STANDALONE_JOBS: readonly JobKey[] = [
  JOBS.app,
  JOBS.desktopPackage,
  JOBS.firestoreRules,
  JOBS.userLifecycleEmulator,
  JOBS.functionsEmulator,
  JOBS.gatewayEdgeEmulator,
  JOBS.glmControllerEmulator,
  JOBS.octogeeApiEmulator,
] as const;

export const ALL_JOBS: readonly JobKey[] = [
  ...UNIT_PACKAGES.map((p) => p.name),
  ...STANDALONE_JOBS,
];

export interface Ownership {
  dir: string;
  jobs: readonly JobKey[];
}

export const OWNERSHIP: readonly Ownership[] = [
  { dir: "platform/core/", jobs: [JOBS.core] },
  { dir: "platform/gateway-edge/", jobs: [JOBS.gatewayEdge, JOBS.gatewayEdgeEmulator] },
  { dir: "platform/octogee-api/", jobs: [JOBS.octogeeApi, JOBS.octogeeApiEmulator] },
  {
    dir: "platform/glm-controller/",
    jobs: [JOBS.glmController, JOBS.glmControllerEmulator],
  },
  {
    dir: "ops-agent/extensions/octogee-ops-runtime-tools/",
    jobs: [JOBS.opsAgentRuntimeTools, JOBS.tests],
  },
  { dir: "ops-agent/", jobs: [JOBS.opsAgent, JOBS.tests] },
  { dir: "tests/", jobs: [JOBS.tests] },
  { dir: "platform/tests/", jobs: [JOBS.platformTests] },
  { dir: "acceptance/", jobs: [JOBS.acceptance] },
  { dir: "desktop/", jobs: [JOBS.desktop, JOBS.desktopPackage] },
  { dir: "platform/scripts/", jobs: [JOBS.scripts, JOBS.userLifecycleEmulator] },
  {
    dir: "platform/infra/gateway/extensions/platform/octogee-voice-tools/",
    jobs: [JOBS.octogeeVoiceTools, JOBS.tests],
  },
  {
    dir: "platform/infra/gateway/extensions/platform/octogee-broker-tools/",
    jobs: [JOBS.octogeeBrokerTools],
  },
  {
    dir: "platform/infra/gateway/extensions/platform/octogee-activity-tools/",
    jobs: [JOBS.octogeeActivityTools],
  },
  {
    dir: "platform/infra/gateway/extensions/platform/octogee-access-tools/",
    jobs: [JOBS.octogeeAccessTools],
  },
  {
    dir: "platform/infra/gateway/extensions/platform/octogee-chat-tools/",
    jobs: [JOBS.octogeeChatTools],
  },
  {
    dir: "platform/infra/gateway/extensions/octogee-connector-tools/",
    jobs: [JOBS.octogeeConnectorTools, JOBS.tests],
  },
  {
    dir: "platform/infra/gateway/extensions/octogee-project-tools/",
    jobs: [JOBS.octogeeProjectTools],
  },
  {
    dir: "platform/infra/gateway/extensions/octogee-board-tools/",
    jobs: [JOBS.octogeeBoardTools],
  },
  {
    dir: "platform/infra/gateway/extensions/platform/octogee-web-tools/",
    jobs: [JOBS.octogeeWebTools],
  },
  {
    dir: "platform/infra/gateway/extensions/platform/octogee-workspace-tools/",
    jobs: [JOBS.octogeeWorkspaceTools],
  },
  {
    dir: "platform/infra/gateway/extensions/platform/octogee-status-tools/",
    jobs: [JOBS.octogeeStatusTools],
  },
  {
    dir: "platform/infra/gateway/extensions/octogee-ops-tools/",
    jobs: [JOBS.octogeeOpsTools, JOBS.tests],
  },
  { dir: "functions/", jobs: [JOBS.functions, JOBS.functionsEmulator] },
  { dir: "site/", jobs: [JOBS.site] },
  { dir: "app/", jobs: [JOBS.app] },
  { dir: "obsidian-connect/", jobs: [JOBS.obsidianConnect, JOBS.tests] },
  { dir: "firestore-rules-tests/", jobs: [JOBS.firestoreRules] },
  { dir: "platform/shared/", jobs: [JOBS.shared] },
  { dir: "product/core/", jobs: [JOBS.productCore] },
  { dir: "product/shared/", jobs: [JOBS.productShared] },
  { dir: "product/test-helpers/", jobs: [JOBS.testHelpers] },
  { dir: "artifact-worker/", jobs: [JOBS.artifactWorker] },
  { dir: "platform/infra/gateway/", jobs: [JOBS.scripts, JOBS.tests, JOBS.platformTests, JOBS.octogeeApi, JOBS.gatewayEdge, JOBS.core, JOBS.acceptance] },
  { dir: "platform/infra/desktop/", jobs: [JOBS.scripts, JOBS.tests, JOBS.glmController] },
  { dir: "platform/infra/vm-bridge/", jobs: [JOBS.tests] },
  { dir: "platform/infra/cloud-sql/", jobs: [] },
  { dir: "platform/helm/", jobs: [JOBS.scripts, JOBS.tests, JOBS.platformTests] },
  { dir: "platform/terraform/", jobs: [JOBS.scripts, JOBS.tests, JOBS.platformTests] },
  { dir: "platform/templates/", jobs: [JOBS.scripts, JOBS.tests, JOBS.platformTests, JOBS.gatewayEdge, JOBS.glmController, JOBS.octogeeApi] },
  { dir: "design-system/", jobs: [JOBS.app, JOBS.site, JOBS.scripts, JOBS.tests] },
  { dir: ".github/", jobs: [JOBS.scripts, JOBS.tests] },
  { dir: ".github/ISSUE_TEMPLATE/", jobs: [] },
  { dir: ".files/", jobs: [] },
  { dir: "storage.rules", jobs: [JOBS.firestoreRules] },
  { dir: "firebase.json", jobs: [JOBS.scripts, JOBS.tests] },
  { dir: "firebase-app.json", jobs: [] },
  { dir: ".firebaserc", jobs: [JOBS.tests] },
  { dir: ".terraform-version", jobs: [JOBS.tests] },
  { dir: ".dockerignore", jobs: [JOBS.scripts, JOBS.tests] },
  { dir: "platform/.dockerignore", jobs: [JOBS.scripts, JOBS.tests] },
  { dir: "platform/deploy/", jobs: [JOBS.scripts, JOBS.tests, JOBS.platformTests] },
  { dir: "platform/install.sh", jobs: [JOBS.scripts] },
  { dir: "platform/.github/", jobs: [JOBS.tests, JOBS.platformTests] },
  { dir: "platform/.github/ISSUE_TEMPLATE/", jobs: [] },
  { dir: "platform/.gitattributes", jobs: [] },
  { dir: "platform/.gitignore", jobs: [] },
  { dir: "platform/.gitleaks.toml", jobs: [] },
  { dir: "platform/LICENSE", jobs: [] },
  { dir: "product/", jobs: [JOBS.scripts, JOBS.tests] },
  { dir: ".env.example", jobs: [JOBS.scripts] },
  { dir: ".gitattributes", jobs: [JOBS.scripts] },
  { dir: ".gitignore", jobs: [JOBS.scripts, JOBS.tests] },
  { dir: ".nvmrc", jobs: [] },
  { dir: "LICENSE", jobs: [JOBS.app, JOBS.scripts, JOBS.tests] },
  { dir: "eslint.config.mjs", jobs: [] },
  { dir: "knip.json", jobs: [JOBS.tests] },
  { dir: "osv-scanner.toml", jobs: [JOBS.tests] },
  { dir: ".gitleaks.toml", jobs: [JOBS.tests] },
  { dir: ".gitleaksignore", jobs: [] },
];

export interface ScopeEdge {
  when: string;
  jobs: readonly JobKey[];
  reason: string;
}

export const EDGES: readonly ScopeEdge[] = [
  {
    when: "platform/core/",
    jobs: [
      JOBS.productCore,
      JOBS.scripts,
      JOBS.userLifecycleEmulator,
      JOBS.octogeeApi,
      JOBS.octogeeApiEmulator,
      JOBS.gatewayEdge,
      JOBS.gatewayEdgeEmulator,
      JOBS.glmController,
      JOBS.tests,
      JOBS.platformTests,
    ],
    reason:
      "@octogee/core is consumed by scripts + octogee-api (via scripts/lib re-export shims) + gateway-edge + glm-controller (direct package import); tests/specs' readSrc() helpers (model-credential-materializer, byot-sync-apply, gateway-rpc-local-exceptions specs) also fall back to reading core/src directly for logic that moved out of scripts/lib, and the byot-sync-apply and usage-log-line specs import core/src modules",
  },
  {
    when: "product/test-helpers/",
    jobs: [
      JOBS.userLifecycleEmulator,
      JOBS.gatewayEdgeEmulator,
      JOBS.glmControllerEmulator,
      JOBS.octogeeApiEmulator,
      JOBS.functions,
      JOBS.functionsEmulator,
      JOBS.tests,
    ],
    reason:
      "@octogee/test-helpers holds the product's Firebase emulator runner, firebase-tools and firestore-emulator helpers, which every package emulator suite runs on; functions installs it as a directory dependency; test-helpers/package.json's firebase-admin range is also swept by tests/specs/firebase-admin-major-alignment.spec.ts",
  },
  {
    when: "platform/gateway-edge/",
    jobs: [JOBS.octogeeApi, JOBS.octogeeApiEmulator, JOBS.tests, JOBS.platformTests],
    reason:
      "octogee-api compiles gateway-edge route Routers (cross-package imports) and its emulator specs mount them via createApp(); tests/specs also imports gateway-edge/src/model-credentials/provider-key-format.js directly (byok-provider-registry-parity.spec.ts) and sweeps gateway-edge/package.json's firebase-admin range (firebase-admin-major-alignment.spec.ts)",
  },
  {
    when: "site/firestore.rules",
    jobs: [JOBS.firestoreRules],
    reason: "the rules file lives under site/ but gates the firestore-rules suite",
  },
  {
    when: "site/firestore.indexes.json",
    jobs: [JOBS.firestoreRules],
    reason: "index shape drives rules-test expectations",
  },
  {
    when: "app/src/",
    jobs: [JOBS.tests],
    reason:
      "tests/specs imports app/src source directly (app-route-helpers.spec.ts → routes/appRoutes, context-channel-selection.spec.ts → lib/contextChannelSelection, deferred-action.spec.ts → lib/deferredAction, sizing-cost-lockstep.spec.ts → lib/sizing, activity-wire-contract.spec.ts → hooks/useActivityChannel + activity-rows/ActivityRow)",
  },
  {
    when: "app/openclaw-",
    jobs: [JOBS.tests],
    reason:
      "tests/specs/openclaw-native-islands-pin.spec.ts digests the island adapter sources under app/openclaw-*/ against the committed vendor provenance",
  },
  {
    when: "app/public/",
    jobs: [JOBS.tests],
    reason:
      "tests/specs/first-party-assets.spec.ts verifies the founder-avatar asset names and first-party provenance",
  },
  {
    when: "site/",
    jobs: [JOBS.tests],
    reason:
      "tests/specs reads site/ source directly: site/src/lib/* (explore-loader, public-builder-loader, public-jsonld, site-pricing-parity specs; site-hosting-security.spec.ts pins security-headers.ts against the root firebase.json site target) and site/package.json's firebase-admin range (firebase-admin-major-alignment.spec.ts)",
  },
  {
    when: "platform/scripts/",
    jobs: [JOBS.tests, JOBS.platformTests],
    reason:
      "tests/specs reads scripts/ source directly beyond lib/: scripts/lib/* (byot-sync, model-credential-materializer specs), scripts/secret-resolver.mjs + scripts/entrypoints/fleet-controller.ts (byok-provider-registry-parity, gateway-entrypoint, gateway-rpc-local-exceptions specs), scripts/setup-secrets.sh + scripts/verify-secrets.sh (byot-sync-secret-management, openrouter-platform-secret-management specs), and internal-routing-guard.spec.ts walks the entire scripts/ tree",
  },
  {
    when: "platform/scripts/lib/vite-third-party-licenses.",
    jobs: [JOBS.app, JOBS.site],
    reason:
      "the app and site production builds both import the shared third-party license artifact plugin",
  },
  {
    when: "functions/",
    jobs: [JOBS.tests],
    reason:
      "tests/specs reads functions/ source directly: functions/src/social/aggregators + functions/src/triggers/social.ts (social-edges, internal-routing-guard specs) and functions/package.json's firebase-admin range (firebase-admin-major-alignment.spec.ts)",
  },
  {
    when: "platform/octogee-api/",
    jobs: [JOBS.tests, JOBS.platformTests],
    reason:
      "tests/specs reads octogee-api/src source directly: routes/byok-broker.ts (byok-provider-registry-parity.spec.ts), src/index.ts (helm-octogee-api-ingress.spec.ts), routes/fleet-broker.ts (model-credential-snapshot-projection.spec.ts); octogee-api/package.json's firebase-admin range is also swept (firebase-admin-major-alignment.spec.ts)",
  },
  {
    when: "platform/glm-controller/",
    jobs: [JOBS.tests, JOBS.platformTests],
    reason:
      "tests/specs/firebase-admin-major-alignment.spec.ts sweeps glm-controller/package.json's firebase-admin range — the exact regression (#1521) that spec exists to catch",
  },
  {
    when: "platform/tests/fixtures/",
    jobs: [JOBS.tests],
    reason:
      "tests/specs reads the platform conformance fixtures: openclaw-template-tools.spec.ts imports openclaw-coding-tools.json and third-party-notices.spec.ts pins the attributed agent-conversation references",
  },
  {
    when: "platform/tests/fixtures/agent-conversation/",
    jobs: [JOBS.app, JOBS.gatewayEdge],
    reason:
      "app's chat reference specs import the agent-conversation references and gateway-edge's activity-intake.spec.ts parses agent-activity-envelopes.json",
  },
  {
    when: "acceptance/",
    jobs: [JOBS.tests],
    reason:
      "tests/specs/firebase-admin-major-alignment.spec.ts sweeps acceptance/package.json's firebase-admin range",
  },
  {
    when: "firestore-rules-tests/",
    jobs: [JOBS.tests],
    reason:
      "tests/specs/transitive-security.spec.ts verifies the Firebase tooling dependency overrides recorded in firestore-rules-tests/package-lock.json",
  },
  {
    when: "platform/shared/",
    jobs: [
      JOBS.productCore,
      JOBS.productShared,
      JOBS.acceptance,
      JOBS.app,
      JOBS.artifactWorker,
      JOBS.core,
      JOBS.functions,
      JOBS.functionsEmulator,
      JOBS.gatewayEdge,
      JOBS.gatewayEdgeEmulator,
      JOBS.glmController,
      JOBS.glmControllerEmulator,
      JOBS.octogeeApi,
      JOBS.octogeeApiEmulator,
      JOBS.opsAgent,
      JOBS.opsAgentRuntimeTools,
      JOBS.scripts,
      JOBS.userLifecycleEmulator,
      JOBS.site,
      JOBS.tests,
      JOBS.platformTests,
    ],
    reason:
      "@octogee/shared is imported by acceptance, app, artifact-worker, core, product-core, product-shared, gateway-edge, glm-controller, octogee-api, ops-agent, scripts, site and tests, and installed for functions; desktop, obsidian-connect and the gateway extension packages do not consume it",
  },
  {
    when: "product/core/",
    jobs: [
      JOBS.octogeeApi,
      JOBS.octogeeApiEmulator,
      JOBS.gatewayEdge,
      JOBS.gatewayEdgeEmulator,
      JOBS.glmController,
      JOBS.glmControllerEmulator,
      JOBS.tests,
    ],
    reason: "@octogee/product-core is installed by gateway-edge, glm-controller and octogee-api; tests compiles their sources",
  },
  {
    when: "product/shared/",
    jobs: [
      JOBS.productCore,
      JOBS.acceptance,
      JOBS.app,
      JOBS.functions,
      JOBS.functionsEmulator,
      JOBS.gatewayEdge,
      JOBS.gatewayEdgeEmulator,
      JOBS.glmController,
      JOBS.glmControllerEmulator,
      JOBS.octogeeApi,
      JOBS.octogeeApiEmulator,
      JOBS.scripts,
      JOBS.userLifecycleEmulator,
      JOBS.tests,
    ],
    reason:
      "@octogee/product-shared is installed by product-core, functions, gateway-edge, glm-controller and octogee-api, staged into the product scripts overlay, aliased to source by app and tests, and imported by acceptance",
  },
  {
    when: "platform/infra/gateway/extensions/",
    jobs: [JOBS.tests],
    reason: "tests specs read every gateway extension's entry, manifest and package for the template hooks, tool guidance and image inventory",
  },
  {
    when: "artifact-worker/",
    jobs: [JOBS.core, JOBS.octogeeApi, JOBS.scripts, JOBS.tests],
    reason:
      "core, octogee-api, scripts and tests specs read artifact-worker source and packaging files directly",
  },
];

export const GLOBAL_EXACT: ReadonlySet<string> = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.base.json",
  ".github/workflows/checks.yml",
  ".github/workflows/test.yml",
  ".gitmodules",
]);
export const GLOBAL_PREFIX: readonly string[] = [".github/actions/setup-ci/", "platform/scripts/lib/scope/", "platform/scripts/lib/ci-", "platform/scripts/ops/ci-", "platform/scripts/ci/", "ci/"];

export function isInert(path: string): boolean {
  if (path.startsWith("docs/") || path.startsWith("platform/docs/")) return true;
  if (/^(?:platform\/)?[^/]+\.md$/.test(path)) return true;
  return false;
}
