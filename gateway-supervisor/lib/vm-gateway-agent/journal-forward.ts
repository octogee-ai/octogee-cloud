import { createContainer, inspectContainer, removeContainer, startContainer, type DockerEngine } from "./docker-engine.js";
import {
  CONTAINER_NAME_LABEL,
  CONTAINER_ROLE_LABEL,
  CONTAINER_SPEC_LABEL,
  GATEWAY_ID_LABEL,
  containerSpecVersion,
  runningSpec,
  specVersion,
  type DockerContainerSpec,
} from "./plan.js";

export const JOURNAL_FORWARD_CONTAINER = "octo-journal-forward";

export const JOURNAL_FORWARDED_UNITS = [
  "octo-desktop-lifecycle.service",
  "octo-desktop.service",
  "octo-gateway-agent.service",
  "octo-grow-root.service",
  "octo-home-disk.service",
  "octo-home-migrate.service",
  "octo-limine-enroll.service",
  "octo-metadata-ssh-keys.service",
  "octo-seatd.service",
] as const;

const UNITS_WITHOUT_LIFECYCLE_LINES = new Set<string>(["octo-metadata-ssh-keys.service"]);
const KERNEL_WARNINGS_AND_WORSE = ["PRIORITY=0", "PRIORITY=1", "PRIORITY=2", "PRIORITY=3", "PRIORITY=4"];

function journalMatches(): string[] {
  return [
    ...JOURNAL_FORWARDED_UNITS.map(unit => `_SYSTEMD_UNIT=${unit}`),
    "+",
    ...JOURNAL_FORWARDED_UNITS.filter(unit => !UNITS_WITHOUT_LIFECYCLE_LINES.has(unit)).map(unit => `UNIT=${unit}`),
    "+",
    "_TRANSPORT=kernel",
    ...KERNEL_WARNINGS_AND_WORSE,
  ];
}

export function planJournalForward(gatewayId: string, image: string): DockerContainerSpec {
  const labels: Record<string, string> = {
    [GATEWAY_ID_LABEL]: gatewayId,
    [CONTAINER_NAME_LABEL]: "journal-forward",
    [CONTAINER_ROLE_LABEL]: "host-journal",
  };
  const config: Record<string, unknown> = {
    Image: image,
    User: "0:0",
    NetworkDisabled: true,
    Entrypoint: [
      "/usr/bin/nsenter", "--target", "1", "--mount", "--",
      "/usr/bin/journalctl", "--follow", "--boot", "--lines=all", "--output=short-iso-precise", "--no-pager",
      ...journalMatches(),
    ],
    HostConfig: {
      PidMode: "host",
      Privileged: true,
      RestartPolicy: { Name: "no" },
      LogConfig: { Type: "gcplogs", Config: { labels: Object.keys(labels).join(",") } },
    },
  };
  config.Labels = { ...labels, [CONTAINER_SPEC_LABEL]: containerSpecVersion(config) };
  return { name: JOURNAL_FORWARD_CONTAINER, config };
}

export async function ensureJournalForward(engine: DockerEngine, spec: DockerContainerSpec, log: (message: string) => void): Promise<void> {
  const current = await inspectContainer(engine, spec.name);
  if (current?.State?.Running && runningSpec(current) === specVersion(spec)) return;
  await removeContainer(engine, spec.name);
  await createContainer(engine, spec.name, spec.config);
  await startContainer(engine, spec.name);
  log(`[vm-agent] forwarding the host journal to Cloud Logging through ${spec.name}`);
}
