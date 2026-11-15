import type { PlatformStateStore } from "@octogee/core/platform-state";
import { noProvisioningProjection, type ProvisioningProjection } from "@octogee/core/provisionSteps";
import {
  createProvisioningServiceClient,
  provisioningServiceConfigFromEnvironment,
  type ProvisioningServiceClient,
  type ProvisioningServiceRequestOutcome,
} from "@octogee/core/provisioning-service-client";
import { createProvisioningSync, type ProvisioningSync } from "@octogee/core/provisioning-sync";
import type { UserDocuments } from "./user-documents.js";

export type ProvisioningProjectionFactory = (deps: {
  store: PlatformStateStore;
  log: (message: string) => void;
}) => ProvisioningProjection;

export interface ProvisioningServiceRuntime {
  readonly client: ProvisioningServiceClient;
  readonly sync: ProvisioningSync;
  start(): () => void;
  renderMetrics(): string;
}

export interface ProvisioningServiceRuntimeInput {
  readonly env: NodeJS.ProcessEnv;
  readonly store: PlatformStateStore;
  readonly documents: Pick<UserDocuments, "account">;
  readonly projection?: ProvisioningProjectionFactory | undefined;
  readonly log: (message: string) => void;
}

const REQUEST_OUTCOMES: readonly ProvisioningServiceRequestOutcome[] = ["ok", "client-error", "server-error", "unreachable"];

function counterLines(name: string, help: string, label: string, values: Record<string, number>): string[] {
  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} counter`,
    ...Object.entries(values).map(([key, value]) => `${name}{${label}="${key}"} ${value}`),
  ];
}

export function createProvisioningServiceRuntime(input: ProvisioningServiceRuntimeInput): ProvisioningServiceRuntime | null {
  const config = provisioningServiceConfigFromEnvironment(input.env);
  if (config === null) {
    input.log("[provisioning] provisioning service: off (PROVISIONING_SERVICE_URL is not set); no specs are written and nothing is mirrored");
    return null;
  }
  const requests = Object.fromEntries(REQUEST_OUTCOMES.map((outcome) => [outcome, 0])) as Record<ProvisioningServiceRequestOutcome, number>;
  const client = createProvisioningServiceClient({
    baseUrl: config.baseUrl,
    tokenPath: config.tokenPath,
    onRequest: (outcome) => {
      requests[outcome] += 1;
    },
  });
  const projection = input.projection?.({ store: input.store, log: input.log }) ?? noProvisioningProjection;
  const sync = createProvisioningSync({
    store: input.store,
    client,
    documents: input.documents,
    projection,
    proxyUrl: input.env.API_PUBLIC_URL?.trim() || null,
    log: input.log,
  });
  input.log(
    `[provisioning] provisioning service: on at ${config.baseUrl}; product projection ${input.projection ? "installed" : "absent"}`,
  );
  return {
    client,
    sync,
    start: () => sync.start(),
    renderMetrics: () => [
      ...counterLines("glm_provisioning_service_requests_total", "Provisioning service requests by outcome.", "outcome", requests),
      ...counterLines("glm_provisioning_spec_writes_total", "Provisioning spec writes by outcome.", "outcome", sync.counters.specWrites),
      ...counterLines("glm_provisioning_mirrors_total", "Provisioning result mirrors by outcome.", "outcome", sync.counters.mirrors),
      "# HELP glm_provisioning_watch_failures_total Failed provisioning service watch requests.",
      "# TYPE glm_provisioning_watch_failures_total counter",
      `glm_provisioning_watch_failures_total ${sync.counters.watchFailures}`,
      "# HELP glm_provisioning_watch_connected Whether the last provisioning service watch request succeeded.",
      "# TYPE glm_provisioning_watch_connected gauge",
      `glm_provisioning_watch_connected ${sync.counters.watchConnected ? 1 : 0}`,
      "",
    ].join("\n"),
  };
}
