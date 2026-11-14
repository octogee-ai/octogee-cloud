#!/usr/bin/env tsx
import "../src/main.js";

import {
  applicationDefault,
  cert,
  initializeApp,
  type ServiceAccount,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isValidGatewayId,
  type GatewayDesiredStatus,
  type GatewayProfile,
} from "../../shared/types/glm.js";
import { projectGatewayDesiredRootForGateway } from "../../shared/types/gateway-releases.js";
import {
  readGatewayAuthorizationInStore,
  readGatewayRuntimeHeartbeat,
  type GatewayStateReader,
} from "@octogee/core/gateway-live-release";
import { firestoreUserAccountReader } from "@octogee/core/user-account";
import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import {
  runNormalFleetMutation,
  type NormalFleetMutationInput,
} from "@octogee/core/normal-fleet-mutation";
import {
  type PlatformUserRecord,
  type PlatformStateStore,
  type Stored,
} from "@octogee/core/platform-state";
import { operatorPlatformStateStore } from "../lib/platform-state-store.js";
import {
  enqueueOperation,
  awaitOperation,
} from "../lib/glm-operations.js";
import { readReleaseStatus, summarizeReleaseStatus, type ReleaseStatusSnapshot } from "@octogee/core/release-status";
import { readForceMigrationPlan, readForceMigrationSource } from "./fleet-force-migration.js";
import { readForcedMigrationRecovery, runForcedMigration } from "./fleet-force-migration-executor.js";
import { createForceMigrationTransport } from "./fleet-force-migration-transport.js";
import {
  createAdminFleetClient,
  exchangeAdminFleetCustomToken,
  resolveFirebaseWebApiKey,
  type AdminFleetClient,
  type AdminFleetRequest,
} from "../lib/admin-fleet-client.js";

import { runDesktopImagePublication } from "../lib/desktop-image-publication.js";
import { commitAddUserPlacement } from "../lib/fleet-place-user.js";
import { planOperatorPlacement } from "@octogee/core/operator-placement";
import { runFleetLogsCommand } from "../lib/fleet-logs-command.js";
import { requireOperatorEmail } from "../lib/operator-email.js";
import { resolveForcedGatewayRestart } from "./fleet-resolve-forced-restart.js";

const COLOR_ENABLED =
  process.stdout.isTTY === true &&
  (process.env.NO_COLOR === undefined || process.env.NO_COLOR === "");
const ESC = "\x1b[";
const c = {
  reset: COLOR_ENABLED ? `${ESC}0m` : "",
  bold: COLOR_ENABLED ? `${ESC}1m` : "",
  dim: COLOR_ENABLED ? `${ESC}2m` : "",
  red: COLOR_ENABLED ? `${ESC}31m` : "",
  green: COLOR_ENABLED ? `${ESC}32m` : "",
  yellow: COLOR_ENABLED ? `${ESC}33m` : "",
  cyan: COLOR_ENABLED ? `${ESC}36m` : "",
};
const bold = (s: string) => `${c.bold}${s}${c.reset}`;
const dim = (s: string) => `${c.dim}${s}${c.reset}`;
const red = (s: string) => `${c.red}${s}${c.reset}`;
const green = (s: string) => `${c.green}${s}${c.reset}`;
const yellow = (s: string) => `${c.yellow}${s}${c.reset}`;
const cyan = (s: string) => `${c.cyan}${s}${c.reset}`;

const CHECK = COLOR_ENABLED ? "✓" : "[ok]";
const CROSS = COLOR_ENABLED ? "✗" : "[x]";
const ARROW = COLOR_ENABLED ? "→" : "->";

const VERSION = readVersion();

function readVersion(): string {

try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const BANNER = `${bold("fleet")} ${dim("v" + VERSION)} ${dim("— Octogee gateway fleet operations")}`;

interface VerbHelp {
  verb: string;
  summary: string;
  args: string;
  description: string;
  examples: readonly string[];
  
  writes: boolean;
}

const VERBS: readonly VerbHelp[] = [
  {
    verb: "ls gateways",
    summary: "List gateways with pod status + user count.",
    args: "",
    description:
      "Joins Firestore `gateways/*` with `kubectl get pods -l app=octogee-gateway`. Surfaces stuck pods + heartbeat age that are otherwise invisible without dropping into kubectl directly.",
    examples: ["fleet --env=prod ls gateways"],
    writes: false,
  },
  {
    verb: "ls customers",
    summary: "List users; optionally filter by gateway. Reports drift in both directions.",
    args: "[--gateway=<gw-id>]",
    description:
      "MISSING = Firestore says assigned, gateway doesn't claim mounted.\nORPHANS = mounted on a gateway but not assigned in Firestore (separate table at the bottom).",
    examples: [
      "fleet --env=prod ls customers",
      "fleet --env=prod ls customers --gateway=default",
    ],
    writes: false,
  },
  {
    verb: "inspect customer",
    summary: "Full diagnostic for one user.",
    args: "<slug>",
    description:
      "Shows user state, gateway state focused on this slug, drift verdict, and gateways/{id}.lastError when it names this slug. The verb-shaped version of the ad-hoc fix-ceckert.ts triage script.",
    examples: ["fleet --env=prod inspect customer ceckert"],
    writes: false,
  },
  {
    verb: "inspect gateway",
    summary: "Full diagnostic for one gateway.",
    args: "<gw-id>",
    description:
      "Mounted set, lastError, pod status. Single-screen state dump.",
    examples: ["fleet --env=prod inspect gateway default"],
    writes: false,
  },
  {
    verb: "release status",
    summary: "Show the fleet controller's one-shot release convergence view.",
    args: "",
    description:
      "Reads Firestore desired roots, selected immutable release payloads, and the fleet controller runtime observations once. Reports desired/live/runtime release state and heartbeat status/version; it never waits for convergence or changes fleet state.",
    examples: ["fleet --env=test release status"],
    writes: false,
  },
  {
    verb: "logs",
    summary: "Tail shared (GKE) and isolated (GCE VM) gateway logs together, live.",
    args: "[--level=<level>] [--service=<names>] [--builder=<slugs>] [--migration=<id>] [options]",
    description:
      "Streams Cloud Logging from GKE and isolated gateway VMs using your gcloud credentials.\n--level=<level> Minimum severity (default info); --level-exact=<levels> selects exact levels.\n--service=<names> and --builder=<slugs> accept comma lists (OR within a list, AND between filters).\nServices: api, cowboy, gateway, gateway-edge, provisioner, mattermost, gitea, nginx, or emitted service name.\nUser filtering matches structured builderSlug or explicit dedicated VM labels; untagged events are excluded.\n--gateway=<id> / --container=<name> narrow the Cloud Logging query.\n--migration=<id> keeps only lines mentioning that operation id: the fleet controller tags every migrate-customer and surge-handoff line with op=<id>, and gateway-side migration ids embed it.\n--no-follow reads recent history; --since=10m and --limit=1000 control the fetched records, before local filters.\n--format=pretty|json (JSON Lines); --timestamps=short|full; --color=auto|always|never.\n--buffer-window=2s sets live arrival ordering (0s–60s). DEFAULT entries remain visible at info.\nLive tail requires gcloud alpha and its gRPC prerequisites: https://cloud.google.com/logging/docs/reference/tools/gcloud-logging#live-tailing",
    examples: [
      "fleet --env=prod logs",
      "fleet --env=prod logs --gateway=shared-0",
      "fleet --env=test logs --service=api,gateway-edge --level=warn",
      "fleet --env=prod logs --builder=ceckert",
      "fleet --env=prod logs --migration=Ab12cd34 --no-follow --since=2h",
      "fleet --env=prod logs --no-follow --since=30m --format=json",
    ],
    writes: false,
  },
  {
    verb: "gw ls",
    summary: "List gateways (alias for ls gateways).",
    args: "[--all]",
    description:
      "Alias for `ls gateways`, retaining the established Firestore and Kubernetes diagnostic read. Retired gateways are hidden unless --all is passed.",
    examples: ["fleet --env=prod gw ls", "fleet --env=prod gw ls --all"],
    writes: false,
  },
  {
    verb: "gw inspect",
    summary: "Inspect one gateway (alias for inspect gateway).",
    args: "<gw-id>",
    description:
      "Alias for `inspect gateway <gw-id>`, including durable state, heartbeat, and pod diagnostics.",
    examples: ["fleet --env=prod gw inspect shared-a"],
    writes: false,
  },
  {
    verb: "gw add",
    summary: "Add a gateway through the Admin API.",
    args: "--gateway-id=<id> [--sha=<full-main-sha>] [--gateway-class=<class>] [--apply]",
    description:
      "Uses POST /api/admin/gateways so the operations journal matches the Admin UI. The gateway and gateway-edge images come from the named build's manifest; without --sha the gateway runs the build the platform is running. Dry-run by default; pass --apply to send the request.",
    examples: [
      "fleet --env=test gw add --gateway-id=shared-canary",
      "fleet --env=test gw add --gateway-id=shared-canary --sha=<full-main-sha> --apply",
    ],
    writes: true,
  },
  {
    verb: "desktop-image publish",
    summary: "Publish the tested desktop image from an immutable build manifest.",
    args: "--sha=<full-main-sha> [--apply]",
    description: "Deploy platform build runs this for its SHA; use it directly for a desktop-only rollback or retry. Dry-run by default. A no-op when the family already serves that image; otherwise copies the tested image when needed and journals publication. VMs pick up the new image on their next boot.",
    examples: ["fleet --env=test desktop-image publish --sha=0123456789abcdef0123456789abcdef01234567 --apply"],
    writes: true,
  },
  {
    verb: "gw deploy",
    summary: "Deploy an existing immutable build to one gateway.",
    args: "<gw-id> --sha=<full-main-sha> [--idempotency-key=<key>] [--apply]",
    description:
      "Selects the build's immutable digest manifest and asks the fleet controller to converge only the named gateway. Building and deployment are independent. Dry-run by default; pass --apply to send the instruction.",
    examples: [
      "fleet --env=test gw deploy canary --sha=0123456789abcdef0123456789abcdef01234567",
      "fleet --env=test gw deploy canary --sha=0123456789abcdef0123456789abcdef01234567 --apply",
    ],
    writes: true,
  },
  {
    verb: "gw recover-source",
    summary: "Repair a Shared source after database export failures while retaining its pod storage.",
    args: "<gw-id> --sha=<full-main-sha> [--supersede-recovery=<failed-recovery-id>] [--idempotency-key=<key>] [--apply]",
    description: "Journals a fleet controller recovery using an immutable build. The API verifies current assignments and failed exports; the fleet controller updates the existing pod images and requires Doctor to repair the affected stores before completion. Briefly interrupts the pod's tenants. Dry-run by default.",
    examples: ["fleet --env=test gw recover-source shared-example --sha=0123456789abcdef0123456789abcdef01234567 --apply"],
    writes: true,
  },
  {
    verb: "gw recover-restore",
    summary: "Upgrade a fenced Shared restore target without replacing its pod storage.",
    args: "<gw-id> --sha=<full-main-sha> --operation=<return-operation-id> [--reauthorize-attempt=<retained-attempt-id>] [--supersede-recovery=<failed-recovery-id>] [--idempotency-key=<key>] [--apply]",
    description: "Journals a fleet controller recovery that changes only the images of the exact existing Shared pod. Requires a paired pending return fence; never clears user state or changes release policy. An explicit failed predecessor can transfer its retained runtime fence to this new recovery when the paired restore attempt is reauthorized. Briefly interrupts the pod's tenants. Dry-run by default.",
    examples: ["fleet --env=test gw recover-restore shared-example --sha=0123456789abcdef0123456789abcdef01234567 --operation=return-example --apply"],
    writes: true,
  },
  {
    verb: "gw park",
    summary: "Pause a gateway through the Admin API.",
    args: "<gw-id> [--apply]",
    description:
      "Uses PATCH /api/admin/gateways/:id with desiredStatus=paused. Dry-run by default; pass --apply to send the request.",
    examples: ["fleet --env=test gw park canary", "fleet --env=test gw park canary --apply"],
    writes: true,
  },
  {
    verb: "gw retire",
    summary: "Retire an empty gateway through the Admin API.",
    args: "<gw-id> [--apply]",
    description:
      "Uses DELETE /api/admin/gateways/:id. The Admin API enforces retirement preconditions and journaling. Dry-run by default; pass --apply to send the request.",
    examples: ["fleet --env=test gw retire canary", "fleet --env=test gw retire canary --apply"],
    writes: true,
  },
  {
    verb: "gw replace-computer",
    summary: "Replace the VM behind a VM gateway with a fresh one from the current image family.",
    args: "<gw-id> | --owner-uid=<uid> [--force --accept-boot-data-loss] [--idempotency-key=<key>] [--apply]",
    description:
      "Uses the gateway or parked-owner VM replacement API. The owner form normally requires a fresh checkpoint and recovery proof. Break-glass --force --accept-boot-data-loss may delete unpublished project work and other boot-disk data; the exact home is retained. Stopped-VM and ownership checks still apply. Dry-run by default; pass --apply to send the request.",
    examples: [
      "fleet --env=test gw replace-computer ceckert-test-s-19a28b9e",
      "fleet --env=test gw replace-computer ceckert-test-s-19a28b9e --apply",
      "fleet --env=test gw replace-computer --owner-uid=USER_UID --apply",
      "fleet --env=test gw replace-computer --owner-uid=USER_UID --force --accept-boot-data-loss --apply",
    ],
    writes: true,
  },
  {
    verb: "gw restart",
    summary: "Restart through the Admin API, or force-delete an exact isolated pod.",
    args: "<gw-id> [--force | --resolve-force=<audit-id>] [--idempotency-key=<key>] [--apply]",
    description:
      "Normally uses POST /api/admin/gateways/:id/restart so the operations journal matches the Admin UI. --force requires an authoritative isolated gateway; Shared gateways are rejected. With --force --apply, it journals a break-glass operation, selects exactly one fresh gateway pod, verifies its UID again, and deletes only that pod without waiting; the fleet controller keeps reconciling the gateway throughout, so the deployment recreates the pod on its own. --resolve-force=<completed-audit-id> observes that exact replacement and journals resolution of its matching failed process restart fence, without restarting. Requires unchanged release images, native health and no active custody. Dry-run by default.",
    examples: [
      "fleet --env=test gw restart canary",
      "fleet --env=test gw restart canary --apply",
      "fleet --env=test gw restart canary --force --apply",
      "fleet --env=test gw restart canary --resolve-force=audit-completed-force --apply",
    ],
    writes: true,
  },
  {
    verb: "add-customer",
    summary: "Override placement: assign user to a specific gateway.",
    args: "<slug> --to=<gw-id> [--apply]",
    description:
      "Writes `users/{uid}.provisioning.openclaw.gatewayId` and the mirrored `gatewayProfile` to place an unassigned user (canary placement, repair). Refuses what `assign-user-gateway` refuses: a missing, retired, paused or isolated gateway; a user under a restore, source-transfer or migration fence, closed or not admitted; and a user with an assignment on any other gateway, which moves with `migrate-customer`. A user held by the operator is assigned and stays held. A gateway that is not ready yet takes the user, who is served once it comes up.\n\nDry-run by default. Pass `--apply` to commit.",
    examples: [
      "fleet --env=prod add-customer ceckert --to=canary",
      "fleet --env=prod add-customer ceckert --to=canary --apply",
    ],
    writes: true,
  },
  {
    verb: "migrate-customer",
    summary: "Move a user between gateways through a journaled migration.",
    args: "<slug> --to=<gw-id> [--source-transfer=retained-pod | --force --operation=<existing-operation-id>] [--apply]",
    description:
      "Plans (or executes with --apply) a journaled migration: prepare target → quiesce source → transfer and verify state → commit placement → release source. Before final transfer, the controller can safely abort; once schema upgrades may begin it recovers forward using the same handoff.\n\nDry-run by default — pass --apply to execute. Ordinary migrations run server-side in glm-controller; the CLI enqueues the operation and streams its reported steps. Forced recovery runs the native restart from Fleet, then the fleet controller continues the same migration. --source-transfer=retained-pod explicitly selects the bounded transfer helper on a retained Shared pod; ambiguous target preparation or helper execution keeps the durable safety fence until its outcome is proven. --force requires the exact existing pending drain operation. It recovers the source gateway on that same operation, preserving disk and migration history. Repeating the same forced command observes an accepted restart without dispatching it again. Force recovery is restricted to the assigned user’s dedicated isolated gateway on Kubernetes; Shared sources are always rejected and GCE VM transport is not available. Native acknowledgement and target verification remain required.",
    examples: [
      "fleet --env=test migrate-customer ceckert --to=canary",
      "fleet --env=test migrate-customer ceckert --to=canary --apply",
    ],
    writes: true,
  },
];

const verbsByName = new Map<string, VerbHelp>(VERBS.map((v) => [v.verb, v]));

export function fleetServiceAccountCredential(
  value: unknown,
  projectId: string,
): ServiceAccount | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const credential = value as Record<string, unknown>;
  if (
    credential.type !== "service_account" ||
    typeof credential.client_email !== "string" ||
    typeof credential.private_key !== "string"
  ) {
    return null;
  }
  return {
    projectId,
    clientEmail: credential.client_email,
    privateKey: credential.private_key,
  };
}

export function fleetFirebaseSignerServiceAccountId(projectId: string): string {
  return `firebase-deployer@${projectId}.iam.gserviceaccount.com`;
}

function applicationDefaultServiceAccountCredential(
  credentialPath: string | undefined,
  projectId: string,
): ServiceAccount | null {
  if (!credentialPath) return null;
  try {
    return fleetServiceAccountCredential(
      JSON.parse(fs.readFileSync(credentialPath, "utf-8")),
      projectId,
    );
  } catch {
    return null;
  }
}

export function resolveFleetDeploymentTarget(environment: "test" | "prod"): {
  targetId: string;
  projectId: string;
  clusterProjectId: string;
  namespace: string;
  kubeContext: string;
} {
  const target = deploymentEnvironmentSettings(environment);
  if (target.targetId !== `${environment}-central` || target.region !== "us-central1") {
    throw new Error(`fleet only supports the active CENTRAL target for ${environment}`);
  }
  return {
    targetId: target.targetId,
    projectId: target.firebaseProjectId,
    clusterProjectId: target.clusterProjectId,
    namespace: target.namespace,
    kubeContext: target.kubeContext,
  };
}

export function resolveFleetVerb(args: ParsedFleetArgs): VerbHelp | null {
  const [verb, sub] = args.positional;
  return verbsByName.get(`${verb ?? ""} ${sub ?? ""}`.trim()) ?? verbsByName.get(verb ?? "") ?? null;
}

function renderTopHelp(): string {
  const readVerbs = VERBS.filter((v) => !v.writes);
  const writeVerbs = VERBS.filter((v) => v.writes);
  const fmtVerb = (v: VerbHelp) => {
    const name = v.verb.padEnd(20);
    const args = v.args ? ` ${dim(v.args)}` : "";
    return `  ${cyan(name)}${args}\n      ${v.summary}`;
  };
  return [
    BANNER,
    "",
    bold("USAGE"),
    "  fleet --env=test|prod <verb> [args]",
    "",
    bold("READ VERBS"),
    ...readVerbs.map(fmtVerb),
    "",
    bold("WRITE VERBS") + dim(" (dry-run by default; --apply commits)"),
    ...writeVerbs.map(fmtVerb),
    "",
    bold("OPTIONS"),
    `  ${cyan("--env=test|prod")}      ${dim("Required.")} Targets PROD or TEST Firestore + cluster.`,
    `  ${cyan("--apply")}              Commit changes (write verbs only). Without it, runs as dry-run.`,
    `  ${cyan("--help")}               Show this help.`,
    `  ${cyan("--version")}            Print version (${VERSION}).`,
    "",
    bold("LEARN MORE"),
    `  fleet help <verb>      Detailed help, args, and examples for one verb.`,
    "",
  ].join("\n");
}

function renderVerbHelp(verb: VerbHelp): string {
  const command = `fleet --env=<env> ${verb.verb}${verb.args ? " " + verb.args : ""}`;
  return [
    BANNER,
    "",
    bold(verb.verb.toUpperCase()) + dim(verb.writes ? " (write — requires --apply)" : " (read-only)"),
    "",
    bold("SUMMARY"),
    "  " + verb.summary,
    "",
    bold("USAGE"),
    "  " + cyan(command),
    "",
    bold("DESCRIPTION"),
    ...verb.description.split("\n").map((l) => "  " + l),
    "",
    bold("EXAMPLES"),
    ...verb.examples.map((e) => "  " + e),
    "",
  ].join("\n");
}

export interface ParsedFleetArgs {
  env: "test" | "prod" | "";
  positional: string[];
  flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set([
  "env",
  "to",
  "gateway",
  "gateway-id",
  "profile",
  "gateway-class",
  "image-profile",
  "sizing-tier",
  "owner-uid",
  "builder-slug",
  "idempotency-key",
  "resolve-force",
  "sha",
  "container",
  "level",
  "level-exact",
  "service",
  "builder",
  "since",
  "limit",
  "format",
  "timestamps",
  "color",
  "buffer-window",
]);

export function parseFleetArgs(argv: readonly string[]): ParsedFleetArgs {
  const out: ParsedFleetArgs = { env: "", positional: [], flags: {} };
  const seenFlags = new Set<string>();
  const setFlag = (name: string, value: string | true) => {
    if (seenFlags.has(name)) throw new Error(`duplicate --${name} flag`);
    seenFlags.add(name);
    if (name === "env") {
      out.env = typeof value === "string" ? value as "test" | "prod" : "";
      return;
    }
    out.flags[name] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out.positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      const k = a.slice(2, eq);
      const v = a.slice(eq + 1);
      setFlag(k, v);
      continue;
    }
    const k = a.slice(2);

if (VALUE_FLAGS.has(k) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      const v = argv[++i];
      setFlag(k, v);
      continue;
    }
    setFlag(k, true);
  }
  return out;
}

function stringFlag(args: ParsedFleetArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredFlag(
  args: ParsedFleetArgs,
  name: string,
  command: string,
  valueName: string,
): string {
  const value = stringFlag(args, name);
  if (!value) throw new Error(`${command} requires --${name}=<${valueName}>`);
  return value;
}

function requiredGatewayId(args: ParsedFleetArgs, command: string): string {
  const gatewayId = args.positional[2];
  if (!gatewayId) throw new Error(`${command} requires <gw-id>`);
  if (!isValidGatewayId(gatewayId)) {
    throw new Error(`${command} received an invalid gateway id: ${gatewayId}`);
  }
  return gatewayId;
}

export function resolveFleetGatewayTarget(args: ParsedFleetArgs, command: string): { gatewayId: string; idempotencyKey?: string } {
  if (args.positional.length !== 3 || args.positional[0] !== "gw" || args.positional[1] !== command.slice(3)) {
    throw new Error(`${command} requires exactly <gw-id> and no extra positional arguments`);
  }
  const allowedFlags = new Set(["apply", "idempotency-key"]);
  for (const name of Object.keys(args.flags)) {
    if (!allowedFlags.has(name)) throw new Error(`${command} does not accept --${name}`);
  }
  if (args.flags.apply !== undefined && args.flags.apply !== true) {
    throw new Error(`${command} --apply must be a bare flag`);
  }
  const idempotency = args.flags["idempotency-key"];
  if (idempotency !== undefined && (typeof idempotency !== "string" || idempotency.length === 0)) {
    throw new Error(`${command} --idempotency-key requires a non-empty value`);
  }
  return {
    gatewayId: requiredGatewayId(args, command),
    ...(typeof idempotency === "string" ? { idempotencyKey: idempotency } : {}),
  };
}

export interface FleetGatewayRestart {
  gatewayId: string;
  force: boolean;
  apply: boolean;
  idempotencyKey?: string;
  resolveForceAuditId?: string;
}

export function resolveFleetGatewayRestart(args: ParsedFleetArgs): FleetGatewayRestart {
  if (
    args.positional.length !== 3 ||
    args.positional[0] !== "gw" ||
    args.positional[1] !== "restart"
  ) {
    throw new Error("gw restart requires exactly <gw-id> and no extra positional arguments");
  }
  const allowedFlags = new Set(["force", "apply", "idempotency-key", "resolve-force"]);
  for (const name of Object.keys(args.flags)) {
    if (!allowedFlags.has(name)) {
      throw new Error(`gw restart does not accept --${name}`);
    }
  }
  if (args.flags.force !== undefined && args.flags.force !== true) {
    throw new Error("gw restart --force must be a bare flag");
  }
  if (args.flags.apply !== undefined && args.flags.apply !== true) {
    throw new Error("gw restart --apply must be a bare flag");
  }
  const idempotency = args.flags["idempotency-key"];
  const resolveForceAuditId = args.flags["resolve-force"];
  if (resolveForceAuditId !== undefined && (typeof resolveForceAuditId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(resolveForceAuditId))) {
    throw new Error("gw restart --resolve-force requires an exact audit ID");
  }
  if (resolveForceAuditId !== undefined && args.flags.force) throw new Error("gw restart --resolve-force cannot be combined with --force");
  if (
    idempotency !== undefined &&
    (typeof idempotency !== "string" || idempotency.length === 0)
  ) {
    throw new Error("gw restart --idempotency-key requires a non-empty value");
  }
  return {
    gatewayId: requiredGatewayId(args, "gw restart"),
    force: args.flags.force === true,
    apply: args.flags.apply === true,
    ...(typeof resolveForceAuditId === "string" ? { resolveForceAuditId } : {}),
    ...(typeof idempotency === "string" ? { idempotencyKey: idempotency } : {}),
  };
}

export function resolveFleetGatewayMutation(args: ParsedFleetArgs): AdminFleetRequest {
  const action = args.positional[1];
  const idempotencyKey = stringFlag(args, "idempotency-key");
  const withIdempotency = (request: Omit<AdminFleetRequest, "idempotencyKey">): AdminFleetRequest => ({
    ...request,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  switch (action) {
    case "add": {
      const command = "gw add";
      if (args.flags["image-tag"] !== undefined || args.flags["image-repository"] !== undefined) {
        throw new Error("gw add takes a build: name it with --sha; the images come from that build's manifest");
      }
      const body: Record<string, unknown> = { gatewayId: requiredFlag(args, "gateway-id", command, "id") };
      const sourceSha = stringFlag(args, "sha");
      if (sourceSha !== undefined) {
        if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("gw add takes --sha=<full-lowercase-main-sha>");
        body.sourceSha = sourceSha;
      }
      const optionalFields: ReadonlyArray<readonly [string, string]> = [
        ["profile", "profile"],
        ["gateway-class", "gatewayClass"],
        ["image-profile", "imageProfile"],
        ["sizing-tier", "sizingTier"],
        ["owner-uid", "ownerUid"],
        ["builder-slug", "builderSlug"],
      ];
      for (const [flag, field] of optionalFields) {
        const value = stringFlag(args, flag);
        if (value) body[field] = value;
      }
      return withIdempotency({ method: "POST", path: "/api/admin/gateways", body });
    }
    case "recover-source": {
      const gatewayId = requiredGatewayId(args, "gw recover-source");
      const sourceSha = requiredFlag(args, "sha", "gw recover-source", "full-main-sha");
      if (!/^[a-f0-9]{40}$/.test(sourceSha)) {
        throw new Error("gw recover-source requires --sha=<full-lowercase-main-sha>");
      }
      const supersedeRecoveryId = args.flags["supersede-recovery"] === undefined ? undefined :
        requiredFlag(args, "supersede-recovery", "gw recover-source", "failed-recovery-id");
      if (supersedeRecoveryId?.includes("/")) {
        throw new Error("gw recover-source requires --supersede-recovery=<failed-recovery-id>");
      }
      return withIdempotency({
        method: "POST",
        path: `/api/admin/gateways/${gatewayId}/recover-source`,
        body: { sourceSha, ...(supersedeRecoveryId ? { supersedeRecoveryId } : {}) },
      });
    }
    case "recover-restore": {
      const gatewayId = requiredGatewayId(args, "gw recover-restore");
      const sourceSha = requiredFlag(args, "sha", "gw recover-restore", "full-main-sha");
      const operationId = requiredFlag(args, "operation", "gw recover-restore", "return-operation-id");
      const reauthorizeAttemptId = args.flags['reauthorize-attempt'] === undefined ? undefined :
        requiredFlag(args, 'reauthorize-attempt', 'gw recover-restore', 'retained-attempt-id');
      const supersedeRecoveryId = args.flags['supersede-recovery'] === undefined ? undefined :
        requiredFlag(args, 'supersede-recovery', 'gw recover-restore', 'predecessor-recovery-id');
      if (!/^[a-f0-9]{40}$/.test(sourceSha) || operationId.includes("/") || supersedeRecoveryId?.includes("/")) throw new Error("invalid restore recovery build or operation");
      return withIdempotency({ method: "POST", path: `/api/admin/gateways/${gatewayId}/recover-restore`,
        body: { sourceSha, operationId, ...(reauthorizeAttemptId ? { reauthorizeAttemptId } : {}), ...(supersedeRecoveryId ? { supersedeRecoveryId } : {}) } });
    }
    case "deploy": {
      const gatewayId = requiredGatewayId(args, "gw deploy");
      const sourceSha = requiredFlag(args, "sha", "gw deploy", "full-main-sha");
      if (!/^[a-f0-9]{40}$/.test(sourceSha)) {
        throw new Error("gw deploy requires --sha=<full-lowercase-main-sha>");
      }
      return withIdempotency({
        method: "POST",
        path: `/api/admin/gateways/${gatewayId}/deploy`,
        body: { sourceSha },
      });
    }
    case "park": {
      const gatewayId = requiredGatewayId(args, "gw park");
      return withIdempotency({
        method: "PATCH",
        path: `/api/admin/gateways/${gatewayId}`,
        body: { desiredStatus: "paused" },
      });
    }
    case "retire": {
      const gatewayId = requiredGatewayId(args, "gw retire");
      return withIdempotency({ method: "DELETE", path: `/api/admin/gateways/${gatewayId}` });
    }
    case "replace-computer": {
      if (args.flags["owner-uid"] !== undefined) {
        const uid = args.flags["owner-uid"];
        const force = args.flags.force === true && args.flags["accept-boot-data-loss"] === true;
        if (args.positional.length !== 2 || typeof uid !== "string" || !uid || uid.length > 256 || uid.includes("/") || uid === "." || uid === ".." ||
          Object.keys(args.flags).some(flag => !["owner-uid", "idempotency-key", "apply", "force", "accept-boot-data-loss"].includes(flag)) ||
          ((args.flags.force !== undefined || args.flags["accept-boot-data-loss"] !== undefined) && !force) ||
          (args.flags.apply !== undefined && args.flags.apply !== true) ||
          (args.flags["idempotency-key"] !== undefined && !idempotencyKey)) {
          throw new Error("gw replace-computer requires exactly --owner-uid=<uid> and optional --idempotency-key and --apply");
        }
        return withIdempotency({ method: "POST", path: `/api/admin/users/${encodeURIComponent(uid)}/vm/replace`, body: force ? { force: true, acceptBootDataLoss: true } : {} });
      }
      const target = resolveFleetGatewayTarget(args, "gw replace-computer");
      return {
        method: "POST",
        path: `/api/admin/gateways/${target.gatewayId}/vm/replace`,
        body: {},
        ...(target.idempotencyKey ? { idempotencyKey: target.idempotencyKey } : {}),
      };
    }
    case "restart": {
      const restart = resolveFleetGatewayRestart(args);
      if (restart.resolveForceAuditId) throw new Error("gw restart resolution bypasses the Admin API");
      if (restart.force) {
        throw new Error("gw restart --force bypasses the Admin API");
      }
      return withIdempotency({
        method: "POST",
        path: `/api/admin/gateways/${restart.gatewayId}/restart`,
      });
    }
    default:
      throw new Error(`Unknown gateway mutation: gw ${action ?? ""}`.trim());
  }
}

export async function executeFleetAdminMutation(
  client: Pick<AdminFleetClient, "request">,
  request: AdminFleetRequest,
  apply: boolean,
): Promise<{ applied: boolean; response: unknown }> {
  if (!apply) return { applied: false, response: null };
  return { applied: true, response: await client.request(request) };
}

export async function executeFleetGatewayMutation(
  client: Pick<AdminFleetClient, "request">,
  request: AdminFleetRequest,
  apply: boolean,
): Promise<{ applied: boolean; response: unknown }> {
  return executeFleetAdminMutation(client, request, apply);
}

export interface ForceRestartPod {
  name: string;
  uid: string;
}

interface ForceRestartPodDocument {
  metadata?: {
    name?: unknown;
    uid?: unknown;
    deletionTimestamp?: unknown;
  };
}

interface ForceRestartPodList {
  items?: ForceRestartPodDocument[];
}

export interface FleetKubectlResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type FleetKubectlRunner = (args: string[], input?: string, timeoutMs?: number) => FleetKubectlResult;

export type ForcedGatewayRestartMutationRunner = <T>(
  input: NormalFleetMutationInput<T>,
) => Promise<T>;

export interface ForcedGatewayRestartInput {
  store: PlatformStateStore;
  kubeContext: string;
  namespace: string;
  gatewayId: string;
  idempotencyKey?: string;
  now?: () => number;
  runKubectl?: FleetKubectlRunner;
  runMutation?: ForcedGatewayRestartMutationRunner;
}

function forceRestartKubectlFailure(
  action: string,
  result: FleetKubectlResult,
): Error {
  const detail = result.error?.message || result.stderr.trim() || result.stdout.trim();
  return new Error(`kubectl ${action} failed${detail ? `: ${detail}` : ""}`);
}

function parseForceRestartJson(raw: string): ForceRestartPodList {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as ForceRestartPodList;
  } catch {
    throw new Error("kubectl returned invalid pod JSON");
  }
}

export function parseForceRestartPodList(raw: string, gatewayId: string): ForceRestartPod {
  const parsed = parseForceRestartJson(raw);
  if (!Array.isArray(parsed.items) || parsed.items.length !== 1) {
    const count = Array.isArray(parsed.items) ? parsed.items.length : 0;
    throw new Error(`force restart expected exactly one pod for ${gatewayId}, found ${count}`);
  }
  const metadata = parsed.items[0]?.metadata;
  if (typeof metadata?.name !== "string" || metadata.name.length === 0) {
    throw new Error(`force restart pod for ${gatewayId} is missing metadata.name`);
  }
  if (typeof metadata.uid !== "string" || metadata.uid.length === 0) {
    throw new Error(`force restart pod for ${gatewayId} is missing metadata.uid`);
  }
  if (metadata.deletionTimestamp !== undefined && metadata.deletionTimestamp !== null) {
    throw new Error(`force restart pod ${metadata.name} is already terminating`);
  }
  const expectedPrefix = `octogee-gateway-${gatewayId}-`;
  if (!metadata.name.startsWith(expectedPrefix)) {
    throw new Error(`force restart pod ${metadata.name} does not belong to ${gatewayId}`);
  }
  return { name: metadata.name, uid: metadata.uid };
}

function assertForceRestartPodUnchanged(
  raw: string,
  expected: ForceRestartPod,
): void {
  const metadata = (parseForceRestartJson(raw) as ForceRestartPodDocument).metadata;
  if (metadata?.name !== expected.name) {
    throw new Error(`force restart pod name changed from ${expected.name}`);
  }
  if (metadata.uid !== expected.uid) {
    throw new Error(`force restart pod UID changed for ${expected.name}`);
  }
  if (metadata.deletionTimestamp !== undefined && metadata.deletionTimestamp !== null) {
    throw new Error(`force restart pod ${expected.name} is already terminating`);
  }
}

function localFleetKubectl(args: string[], input?: string, timeout?: number): FleetKubectlResult {
  const result = spawnSync(
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    "kubectl",
    args,
    {
      encoding: "utf-8",
      input,
      timeout,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    },
  );
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function runForceRestartKubectl(
  runKubectl: FleetKubectlRunner,
  action: string,
  args: string[],
  input?: string,
): string {
  const result = runKubectl(args, input);
  if (result.error || result.status !== 0) throw forceRestartKubectlFailure(action, result);
  return result.stdout;
}

function isPlainTarget(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function recordForcedGatewayRestartPod(
  store: PlatformStateStore,
  claim: { auditId: string; claimId: string },
  gatewayId: string,
  pod: ForceRestartPod,
): Promise<void> {
  await store.transaction({ label: "fleet.force-restart.record-pod" }, async (tx) => {
    const audit = await tx.journal.audits.get(claim.auditId);
    if (audit?.status !== "in-progress" || audit.actionClaimId !== claim.claimId || !isPlainTarget(audit.target)) {
      throw new Error(`force restart audit ${claim.auditId} is not owned by this action`);
    }
    await tx.journal.audits.patch(claim.auditId, {
      target: { ...audit.target, gatewayId, podName: pod.name, podUid: pod.uid },
    });
  });
}

async function assertForcedGatewayRestartDeleteFence(
  store: PlatformStateStore,
  claim: { auditId: string; claimId: string },
  gatewayId: string,
  pod: ForceRestartPod,
): Promise<void> {
  await store.transaction({ label: "fleet.force-restart.delete-fence", readOnly: true }, async (tx) => {
    const [gateway, audit] = await Promise.all([
      tx.gateways.roots.get(gatewayId),
      tx.journal.audits.get(claim.auditId),
    ]);
    assertUserForceRestart(gateway);
    const durableGateway = gateway === null ? null : projectGatewayDesiredRootForGateway(withoutRevision(gateway), gatewayId);
    if (!durableGateway) {
      throw new Error(`gateway ${gatewayId} has no valid durable root configuration`);
    }
    if (durableGateway.desiredStatus === "retired") {
      throw new Error(`cannot force restart a retired gateway: ${gatewayId}`);
    }
    const target = audit?.target;
    const targetKeys = isPlainTarget(target) ? Object.keys(target).sort() : [];
    if (
      audit?.status !== "in-progress" ||
      audit.actionClaimId !== claim.claimId ||
      !isPlainTarget(target) ||
      targetKeys.join(",") !== "gatewayId,podName,podUid" ||
      target.gatewayId !== gatewayId ||
      target.podName !== pod.name ||
      target.podUid !== pod.uid
    ) {
      throw new Error(`force restart audit ${claim.auditId} is not owned by this action`);
    }
  });
}

function withoutRevision<T extends { readonly revision: unknown }>(record: T): Omit<T, "revision"> {
  const { revision: _revision, ...rest } = record;
  return rest;
}

function assertUserForceRestart(root: { readonly gatewayClass?: unknown } | null): void {
  if (root?.gatewayClass !== "isolated") {
    throw new Error("Shared gateways cannot be force restarted; a dedicated isolated gateway is required");
  }
}

function forceRestartKubectlArgs(input: {
  kubeContext: string;
  namespace: string;
  gatewayId: string;
}): string[] {
  return [
    "--context", input.kubeContext,
    "-n", input.namespace,
  ];
}

export async function runForcedGatewayRestart(
  input: ForcedGatewayRestartInput,
): Promise<{ auditId: string; podName: string; podUid: string }> {
  assertUserForceRestart(await input.store.gateways.roots.get(input.gatewayId));
  const runKubectl = input.runKubectl ?? localFleetKubectl;
  const runMutation: ForcedGatewayRestartMutationRunner = input.runMutation ??
    ((mutation) => runNormalFleetMutation(input.store, mutation));
  return runMutation({
    actor: "operator",
    forced: true,
    what: "force restart gateway pod",
    why: "operator requested break-glass pod restart",
    target: { gatewayId: input.gatewayId },
    preActionStatus: {},
    mutation: {
      kind: "restart-gateway",
      gatewayId: input.gatewayId,
      mode: "force-pod-delete",
    },
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    action: async (claim) => {
      const base = forceRestartKubectlArgs(input);
      const pod = parseForceRestartPodList(
        runForceRestartKubectl(runKubectl, "list pods", [
          ...base,
          "get", "pods",
          "-l", `app=octogee-gateway,gateway-instance=${input.gatewayId}`,
          "-o", "json",
        ]),
        input.gatewayId,
      );
      await recordForcedGatewayRestartPod(input.store, claim, input.gatewayId, pod);
      assertForceRestartPodUnchanged(
        runForceRestartKubectl(runKubectl, "get pod", [
          ...base,
          "get", "pod", pod.name,
          "-o", "json",
        ]),
        pod,
      );
      await assertForcedGatewayRestartDeleteFence(
        input.store,
        claim,
        input.gatewayId,
        pod,
      );
      runForceRestartKubectl(
        runKubectl,
        "delete pod",
        [
          ...base,
          "delete",
          `--raw=/api/v1/namespaces/${encodeURIComponent(input.namespace)}/pods/${
            encodeURIComponent(pod.name)
          }`,
          "-f", "-",
        ],
        JSON.stringify({
          apiVersion: "v1",
          kind: "DeleteOptions",
          preconditions: { uid: pod.uid },
        }),
      );
      return { auditId: claim.auditId, podName: pod.name, podUid: pod.uid };
    },
  });
}

let args: ParsedFleetArgs = parseFleetArgs([]);
let db: ReturnType<typeof getFirestore>;
let platformState: PlatformStateStore;
let resolvedOperatorUid: Promise<string> | null = null;
let resolvedFirebaseWebApiKey: Promise<string> | null = null;

async function initializeFleetCli(argv: string[]): Promise<void> {
  args = parseFleetArgs(argv);

  if (args.flags.version === true) {
    console.log(VERSION);
    process.exit(0);
  }

  if (args.positional.length === 0 || args.flags.help === true) {
    const verb = resolveFleetVerb(args);
    console.log(verb ? renderVerbHelp(verb) : renderTopHelp());
    process.exit(args.positional.length === 0 ? 1 : 0);
  }

  if (args.positional[0] === "help") {
    const target = args.positional.slice(1).join(" ").trim();
    if (!target) {
      console.log(renderTopHelp());
      process.exit(0);
    }
    const verb = verbsByName.get(target);
    if (!verb) {
      console.error(red(`Unknown verb: '${target}'`));
      console.error(dim(`Run \`fleet --help\` for the verb list.`));
      process.exit(1);
    }
    console.log(renderVerbHelp(verb));
    process.exit(0);
  }

  if (!args.env) {
    console.error(red(`--env is required (test or prod).`));
    console.error(dim(`Example: fleet --env=prod ls gateways`));
    console.error(dim(`Run \`fleet --help\` for the verb list.`));
    process.exit(1);
  }
  if (args.env !== "test" && args.env !== "prod") {
    console.error(red(`--env must be 'test' or 'prod' (got: '${args.env}').`));
    process.exit(1);
  }

  if (args.positional[0] === "gw" && args.positional[1] === "restart") {
    resolveFleetGatewayRestart(args);
  }

  const target = resolveFleetDeploymentTarget(args.env);
  if (args.positional[0] === "logs") return;
  const projectId = target.projectId;
  const applicationDefaultServiceAccount = applicationDefaultServiceAccountCredential(
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    projectId,
  );
  const signerServiceAccountId = fleetFirebaseSignerServiceAccountId(projectId);
  initializeApp({
    credential: applicationDefaultServiceAccount
      ? cert(applicationDefaultServiceAccount)
      : applicationDefault(),
    projectId,
    ...(applicationDefaultServiceAccount ? {} : { serviceAccountId: signerServiceAccountId }),
  });
  console.error(dim(
    applicationDefaultServiceAccount
      ? `  fleet uses the service-account key supplied through GOOGLE_APPLICATION_CREDENTIALS for ${projectId}.`
      : `  fleet uses keyless ADC/WIF for ${projectId}; Firebase tokens are signed by ${signerServiceAccountId}.`,
  ));
  db = getFirestore();
  platformState = await operatorPlatformStateStore(target.targetId);
  KUBE_CONTEXT = target.kubeContext;
  KUBE_NS = target.namespace;
}

export function resolveExplicitFleetOperatorUid(input: {
  uid: string;
  role: unknown;
  disabled: boolean;
}): string {
  if (input.disabled) throw new Error("configured Fleet admin is disabled");
  if (input.role !== "admin") throw new Error("configured Fleet admin does not have the admin role");
  return input.uid;
}

interface FleetOperatorLookups {
  getUser(uid: string): Promise<{ uid: string; disabled: boolean }>;
  getUserByEmail(email: string): Promise<{ uid: string; disabled: boolean }>;
  readRole(uid: string): Promise<unknown>;
}

export async function resolveFleetOperatorUid(
  env: NodeJS.ProcessEnv,
  lookups: FleetOperatorLookups,
): Promise<string> {
  const authUser = env.OPERATOR_UID
    ? await lookups.getUser(env.OPERATOR_UID)
    : await lookups.getUserByEmail(requireOperatorEmail(env));
  return resolveExplicitFleetOperatorUid({
    uid: authUser.uid,
    role: await lookups.readRole(authUser.uid),
    disabled: authUser.disabled,
  });
}

function fleetOperatorUid(): Promise<string> {
  resolvedOperatorUid ??= resolveFleetOperatorUid(process.env, {
    getUser: (uid) => getAuth().getUser(uid),
    getUserByEmail: (email) => getAuth().getUserByEmail(email),
    readRole: async (uid) => (await platformState.users.records.get(uid))?.role ?? null,
  });
  return resolvedOperatorUid;
}

function fleetAdminClient(): AdminFleetClient {
  if (!args.env) throw new Error("fleet environment must be selected before creating an Admin API client");
  const settings = deploymentEnvironmentSettings(args.env);
  resolvedFirebaseWebApiKey ??= resolveFirebaseWebApiKey({
    appOrigin: settings.appOrigin,
    configuredKey: process.env.FIREBASE_WEB_API_KEY,
  });
  const webApiKey = resolvedFirebaseWebApiKey;
  return createAdminFleetClient({
    apiOrigin: settings.apiOrigin,
    getIdToken: async () => exchangeAdminFleetCustomToken({
      operatorUid: await fleetOperatorUid(),
      webApiKey: await webApiKey,
      createCustomToken: (uid) => getAuth().createCustomToken(uid),
    }),
  });
}

let KUBE_CONTEXT = resolveFleetDeploymentTarget("test").kubeContext;
let KUBE_NS = resolveFleetDeploymentTarget("test").namespace;

type FirestoreTs = { toMillis(): number };

function normalizeGatewayProfile(profile: unknown): GatewayProfile {
  return profile === "isolated" ? "isolated" : "standard";
}

export interface GatewayHeartbeatView {
  status?: string;
  version?: string;
  openclawVersion?: string;
  internalUrl?: string;
  mountedCustomers?: string[];
  lastHeartbeatAt?: number;
  lastError?: { message?: string; slug?: string; at?: unknown } | null;
}

function heartbeatView(heartbeat: Record<string, unknown> | undefined): GatewayHeartbeatView {
  return heartbeat ? (heartbeat as GatewayHeartbeatView) : {};
}

export interface FleetGatewayRuntime {
  gatewayId: string;
  desiredStatus: GatewayDesiredStatus;
  profile: GatewayProfile;
  heartbeat: GatewayHeartbeatView;
}

export interface FleetGatewayRuntimeEntry {
  gatewayId: string;
  runtime: FleetGatewayRuntime | null;
}

export async function readFleetGatewayRuntime(
  state: GatewayStateReader,
  gatewayId: string,
): Promise<FleetGatewayRuntime | null> {
  const authorization = await readGatewayAuthorizationInStore(state, gatewayId);
  if (!authorization) return null;
  const heartbeat = await readGatewayRuntimeHeartbeat(state, authorization.gateway);
  return {
    gatewayId,
    desiredStatus: authorization.gateway.desiredStatus,
    profile: normalizeGatewayProfile(authorization.config.profile),
    heartbeat: heartbeatView(heartbeat ?? undefined),
  };
}

export async function listFleetGatewayRuntimes(
  state: GatewayStateReader,
): Promise<FleetGatewayRuntimeEntry[]> {
  const roots = await state.gateways.roots.list();
  return Promise.all(roots.map(async (root) => ({
    gatewayId: root.gatewayId,
    runtime: await readFleetGatewayRuntime(state, root.gatewayId),
  })));
}

interface PodInfo {
  name: string;
  phase: string;
  ready: string; 
  ageS: number;
}

let podsCache: PodInfo[] | null = null;
function allGatewayPods(): PodInfo[] {
  if (podsCache !== null) return podsCache;
  const result = spawnSync(
    "kubectl", // eslint-disable-line sonarjs/no-os-command-from-path -- operator CLI, PATH is the operator's shell
    [
      "--context", KUBE_CONTEXT,
      "-n", KUBE_NS,
      "get", "pods",
      "-l", "app=octogee-gateway",
      "-o", "json",
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0 || result.error) {
    
    podsCache = [];
    return podsCache;
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      items: Array<{
        metadata: { name: string; creationTimestamp: string; labels?: Record<string, string> };
        status: { phase: string; containerStatuses?: Array<{ ready: boolean }> };
      }>;
    };
    podsCache = parsed.items.map((p) => ({
      name: p.metadata.name,
      phase: p.status.phase,
      ready: (() => {
        const cs = p.status.containerStatuses ?? [];
        return `${cs.filter((c) => c.ready).length}/${cs.length}`;
      })(),
      ageS: Math.round((Date.now() - new Date(p.metadata.creationTimestamp).getTime()) / 1000),
    }));
  } catch {
    podsCache = [];
  }
  return podsCache;
}

function ts(t: { toMillis(): number } | number | undefined): string {
  if (t === undefined) return "-";
  const ms = typeof t === "number" ? t : t.toMillis();
  const ageS = Math.round((Date.now() - ms) / 1000);
  if (ageS < 60) return `${ageS}s ago`;
  if (ageS < 3600) return `${Math.round(ageS / 60)}m ago`;
  return `${Math.round(ageS / 3600)}h ago`;
}

function ageHuman(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function table(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) return "(none)";
  const cols = Object.keys(rows[0]);
  const widths: Record<string, number> = {};
  for (const c of cols) {
    widths[c] = Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length));
  }
  const header = cols.map((c) => c.toUpperCase().padEnd(widths[c])).join("  ");
  const sep = cols.map((c) => "─".repeat(widths[c])).join("  ");
  const body = rows.map((r) => cols.map((c) => String(r[c] ?? "").padEnd(widths[c])).join("  "));
  return [header, sep, ...body].join("\n");
}

async function findUserBySlug(slug: string): Promise<Stored<PlatformUserRecord> | null> {
  return platformState.users.records.findBySlug(slug);
}

export function retirementFinished(entry: FleetGatewayRuntimeEntry, podNames: readonly string[]): boolean {
  const runtime = entry.runtime;
  if (runtime?.desiredStatus !== "retired") return false;
  const heartbeat = runtime.heartbeat ?? {};
  if (heartbeat.status || heartbeat.lastHeartbeatAt) return false;
  return !podNames.some((name) => name.startsWith(`octogee-gateway-${entry.gatewayId}-`));
}

export function visibleFleetGateways(
  gateways: FleetGatewayRuntimeEntry[],
  includeRetired: boolean,
  podNames: readonly string[],
): { shown: FleetGatewayRuntimeEntry[]; hiddenRetired: number } {
  if (includeRetired) return { shown: gateways, hiddenRetired: 0 };
  const shown = gateways.filter((entry) => !retirementFinished(entry, podNames));
  return { shown, hiddenRetired: gateways.length - shown.length };
}

async function lsGateways(): Promise<void> {
  const pods = allGatewayPods();
  const { shown: gateways, hiddenRetired } = visibleFleetGateways(
    await listFleetGatewayRuntimes(platformState),
    args.flags.all === true,
    pods.map((pod) => pod.name),
  );
  const podSummary = pods.length === 0
    ? "?"
    : pods.length === 1
      ? `${pods[0].ready} ${pods[0].phase} (${ageHuman(pods[0].ageS)})`
      : `${pods.length} pods (${pods.filter((p) => p.phase === "Running").length} running)`;
  const rows = gateways.map(({ gatewayId, runtime }) => {
    const hb = runtime?.heartbeat ?? {};
    return {
      gatewayId,
      status: runtime ? hb.status ?? "?" : "invalid-root",
      version: (hb.version ?? "-").slice(0, 12),
      mounted: (hb.mountedCustomers ?? []).length,
      heartbeat: ts(hb.lastHeartbeatAt),
      pods: podSummary,
    };
  });
  console.log(table(rows));
  if (hiddenRetired > 0) {
    console.log(`${hiddenRetired} retired gateway${hiddenRetired === 1 ? "" : "s"} with no heartbeat or pods hidden; pass --all to include them.`);
  }
}

async function lsUsers(): Promise<void> {
  const filter = typeof args.flags.gateway === "string" ? args.flags.gateway : null;
  const gateways = await listFleetGatewayRuntimes(platformState);
  const gwMounted: Record<string, Set<string>> = {};
  for (const { gatewayId, runtime } of gateways) {
    if (runtime) {
      gwMounted[gatewayId] = new Set(runtime.heartbeat.mountedCustomers ?? []);
    }
  }

  const userRecords = filter
    ? await platformState.users.records.listByGateway(filter)
    : await platformState.users.records.listAll();
  const accounts = await firestoreUserAccountReader(db).getMany(userRecords.map((userRecord) => userRecord.uid));

  const rows = userRecords
    .map((userRecord) => {
      const slug = userRecord.slug ?? "?";
      const gw = userRecord.gateway?.gatewayId ?? "-";
      const status = userRecord.openclaw.status ?? "-";
      const onGateway = gw !== "-" && gwMounted[gw]?.has(slug);
      const drift =
        gw !== "-" && status === "complete"
          ? onGateway
            ? "ok"
            : "MISSING"
          : "-";
      return {
        slug,
        username: accounts.get(userRecord.uid)?.username ?? "-",
        gatewayId: gw,
        status,
        drift,
      };
    })
    .filter((r) => r.slug !== "?")
    .sort((a, b) => a.slug.localeCompare(b.slug));

  console.log(table(rows));

  const orphans: Array<{ gatewayId: string; slug: string }> = [];
  for (const [gwId, mountedSet] of Object.entries(gwMounted)) {
    if (filter && gwId !== filter) continue;
    if (mountedSet.size === 0) continue;
    const assigned = await platformState.users.records.listByGateway(gwId);
    const assignedSlugs = new Set(
      assigned.map((userRecord) => userRecord.slug).filter((s): s is string => s !== null),
    );
    for (const slug of mountedSet) {
      if (!assignedSlugs.has(slug)) {
        orphans.push({ gatewayId: gwId, slug });
      }
    }
  }
  if (orphans.length > 0) {
    console.log("\n" + yellow(bold("ORPHANS")) + dim("  in gateway.mountedCustomers but not assigned to that gateway"));
    console.log(table(orphans));
  }
}

async function inspectUser(slug: string): Promise<void> {
  const user = await findUserBySlug(slug);
  if (!user) {
    console.error(red(`${CROSS} No user found with slug '${slug}'.`));
    process.exit(1);
  }
  const account = await firestoreUserAccountReader(db).get(user.uid);
  const gatewayId = user.gateway?.gatewayId;
  const openclawStatus = user.openclaw.status;
  console.log(bold(`USER ${slug}`) + dim(`  uid=${user.uid}`));
  console.log(table([
    {
      field: "username",
      value: account?.username ?? "-",
    },
    {
      field: "email",
      value: account?.email ?? "-",
    },
    {
      field: "openclaw.status",
      value: openclawStatus ?? "-",
    },
    {
      field: "openclaw.gatewayId",
      value: gatewayId ?? "-",
    },
  ]));

  if (!gatewayId) {
    console.log("\n" + yellow(`No gateway assigned — placement hasn't run; check config/orchestrator.`));
    return;
  }

  const runtime = await readFleetGatewayRuntime(platformState, gatewayId);
  if (!runtime) {
    console.log("\n" + red(`${CROSS} gateways/${gatewayId} has no valid durable root configuration.`));
    return;
  }
  const gw = runtime.heartbeat;
  const mounted = (gw.mountedCustomers ?? []).includes(slug);
  const lastErrorForSlug =
    gw.lastError && gw.lastError.slug === slug ? gw.lastError : null;
  console.log("\n" + bold(`GATEWAY ${gatewayId}`));
  console.log(table([
    { field: "status", value: gw.status ?? "-" },
    { field: "heartbeat", value: ts(gw.lastHeartbeatAt) },
    { field: `mountedCustomers.includes('${slug}')`, value: mounted ? "true" : "false" },
    {
      field: `lastError (this slug)`,
      value: lastErrorForSlug
        ? `${lastErrorForSlug.message} (${ts(lastErrorForSlug.at as FirestoreTs)})`
        : "-",
    },
  ]));

console.log("\n" + bold("DRIFT"));
  if (openclawStatus === "complete" && !mounted) {
    console.log(red(`${CROSS} NOT MOUNTED`) + " — assigned + complete but absent from mountedCustomers.");
    console.log(dim(`  The gateway reconcile re-checks desired−observed every ~15s and self-heals — no kick needed.`));
    console.log(dim(`  If it persists, check the gateway pod's [reconcile] logs${lastErrorForSlug ? " + the lastError above" : ""}.`));
  } else if (openclawStatus !== "complete") {
    console.log(yellow("·") + " upstream provisioning incomplete; not a fleet issue.");
  } else {
    console.log(green(`${CHECK} healthy`) + " — mounted on the assigned gateway.");
  }
}

async function inspectGateway(gatewayId: string): Promise<void> {
  const runtime = await readFleetGatewayRuntime(platformState, gatewayId);
  if (!runtime) {
    console.error(red(`${CROSS} Gateway '${gatewayId}' has no valid durable root configuration.`));
    process.exit(1);
  }
  const gw = runtime.heartbeat;
  console.log(bold(`GATEWAY ${gatewayId}`));
  console.log(table([
    { field: "status", value: gw.status ?? "-" },
    { field: "version", value: gw.version ?? "-" },
    { field: "openclawVersion", value: gw.openclawVersion ?? "-" },
    { field: "internalUrl", value: gw.internalUrl ?? "-" },
    { field: "heartbeat", value: ts(gw.lastHeartbeatAt) },
    { field: "mountedCustomers", value: String((gw.mountedCustomers ?? []).length) },
  ]));

  const mounted = (gw.mountedCustomers ?? []).slice().sort();
  console.log("\n" + bold(`MOUNTED`) + dim(`  ${mounted.length}`));
  console.log(mounted.length === 0 ? dim("  (none)") : "  " + mounted.join(", "));

  console.log("\n" + bold(`LAST ERROR`) + dim(`  most recent reconcile ensure failure`));
  if (gw.lastError) {
    console.log(table([{
      slug: gw.lastError.slug ?? "-",
      message: (gw.lastError.message ?? "-").slice(0, 80),
      at: ts(gw.lastError.at as FirestoreTs),
    }]));
  } else {
    console.log("(none)");
  }

const pods = allGatewayPods();
  console.log(`\n=== PODS (${pods.length}) ===`);
  console.log(pods.length === 0 ? "(none / kubectl unavailable)" : table(pods.map((p) => ({
    name: p.name,
    phase: p.phase,
    ready: p.ready,
    age: ageHuman(p.ageS),
  }))));
}

async function runFleetGatewayMutation(apply: boolean): Promise<void> {
  const request = resolveFleetGatewayMutation(args);
  console.log(bold(`GW ${args.positional[1]?.toUpperCase() ?? ""}`));
  console.log(dim(`  ${request.method} ${request.path}`));
  if (request.body?.force === true) console.log("  BREAK GLASS: boot disk data, including unpublished project work, may be lost; the verified home disk is retained.");
  if (!apply) {
    console.log(dim("--- DRY RUN (re-run with --apply to send the Admin API request) ---"));
    return;
  }
  const result = await executeFleetGatewayMutation(fleetAdminClient(), request, true);
  console.log(green(`${CHECK} Admin API request accepted`));
  console.log(JSON.stringify(result.response, null, 2));
}

async function runFleetGatewayRestart(): Promise<void> {
  const restart = resolveFleetGatewayRestart(args);
  if (restart.resolveForceAuditId) {
    const result = await resolveForcedGatewayRestart({
      store: platformState, gatewayId: restart.gatewayId, forceAuditId: restart.resolveForceAuditId,
      kubeContext: KUBE_CONTEXT, namespace: KUBE_NS, runKubectl: localFleetKubectl,
      apply: restart.apply,
      ...(restart.idempotencyKey ? { idempotencyKey: restart.idempotencyKey } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!restart.force) return runFleetGatewayMutation(restart.apply);
  assertUserForceRestart(await platformState.gateways.roots.get(restart.gatewayId));
  console.log(bold(`GW FORCE RESTART ${restart.gatewayId.toUpperCase()}`));
  console.log(dim(`  delete exactly one pod selected by gateway-instance=${restart.gatewayId}`));
  if (!restart.apply) {
    console.log(dim("--- DRY RUN (re-run with --force --apply to journal and delete the exact pod) ---"));
    return;
  }
  const result = await runForcedGatewayRestart({
    store: platformState,
    kubeContext: KUBE_CONTEXT,
    namespace: KUBE_NS,
    gatewayId: restart.gatewayId,
    ...(restart.idempotencyKey
      ? { idempotencyKey: restart.idempotencyKey }
      : {}),
  });
  console.log(green(`${CHECK} Force restart requested`));
  console.log(JSON.stringify(result, null, 2));
}

export function releaseStatusRows(status: ReleaseStatusSnapshot): Array<Record<string, string | number>> {
  return status.gateways.map((gateway) => ({
    gatewayId: gateway.gatewayId,
    default: gateway.isDefault ? "*" : "",
    desired: gateway.desiredRelease ?? "-",
    live: gateway.liveRelease ?? "-",
    runtime: gateway.runtimeRelease ?? "-",
    lifecycle: gateway.runtimeLifecycle ?? "-",
    heartbeat: gateway.heartbeatStatus ?? "-",
    heartbeatAt: gateway.lastHeartbeatAt === null
      ? "-"
      : new Date(gateway.lastHeartbeatAt).toISOString(),
    tag: gateway.desiredImageTag ?? "-",
    version: gateway.heartbeatVersion ?? "-",
    status: gateway.observation,
  }));
}

async function releaseStatus(): Promise<void> {
  const status = await readReleaseStatus(platformState);
  const summary = summarizeReleaseStatus(status);
  const defaultLabel = status.defaultGatewayId || (
    status.defaultSelection === "invalid" ? "(invalid)" : "(unconfigured)"
  );
  console.log(
    bold("RELEASE STATUS") + dim(
      `  default=${defaultLabel} (${status.defaultSelection})`,
    ),
  );
  console.log(`Gateway release convergence: ${summary.status} — ${summary.converged}/${summary.serving} serving gateways at their own desired release; ${summary.excluded} paused/retired excluded.`);
  console.log(dim("Platform workflow success is separate. This snapshot does not verify user migration completion or a fleet-wide SHA."));
  if (summary.blockers.length > 0) console.log(`Outstanding: ${summary.blockers.join("; ")}`);
  console.log(table(releaseStatusRows(status)));
}

async function addUser(slug: string, gatewayId: string, apply: boolean): Promise<void> {
  const user = await findUserBySlug(slug);
  if (!user) {
    console.error(red(`${CROSS} No user found with slug '${slug}'.`));
    process.exit(1);
  }
  const plan = await planOperatorPlacement(platformState, { uid: user.uid, gatewayId });
  if (plan.kind === "refused") {
    console.error(red(`${CROSS} Refusing to assign '${slug}' (${plan.reason}): ${plan.message}.`));
    process.exit(1);
  }
  if (plan.assignmentPresent && plan.mirrorCurrent) {
    console.log(yellow(`'${slug}' is already assigned to '${gatewayId}'. Nothing to do.`));
    return;
  }

  console.log(bold(`ADD-CUSTOMER ${slug}`) + dim(`  ${ARROW} ${gatewayId}`));
  console.log(`  uid                 ${user.uid}`);
  console.log(`  current gatewayId   ${plan.currentGatewayId ?? dim("(none)")}`);
  console.log(`  new gatewayId       ${cyan(gatewayId)}`);
  console.log(`  assignment          ${plan.assignmentPresent ? "present" : "created"}`);

  if (!apply) {
    console.log("\n" + dim(`--- DRY RUN (re-run with --apply to commit) ---`));
    return;
  }

  const outcome = await commitAddUserPlacement(platformState, { uid: user.uid, gatewayId, now: Date.now() });
  if (outcome === "unchanged") {
    console.log(yellow(`'${slug}' is already assigned to '${gatewayId}'. Nothing to do.`));
    return;
  }
  console.log("\n" + green(`${CHECK} ${user.uid} placed on ${gatewayId}`));
  if (outcome === "placed") console.log(green(`${CHECK} serving assignment on ${gatewayId} created in the same transaction`));
  console.log(dim(`  ${gatewayId} mounts ${slug} once it is serving; watch gateways/${gatewayId}.mountedCustomers.`));
}

async function migrateUserPlan(
  slug: string,
  toGatewayId: string,
  apply: boolean,
  sourceTransferMode?: "retained-pod",
  forceOperationId?: string,
): Promise<void> {
  const user = await findUserBySlug(slug);
  if (!user) {
    console.error(red(`${CROSS} No user found with slug '${slug}'.`));
    process.exit(1);
  }
  slug = user.slug ?? slug;
  const fromGatewayId = user.gateway?.gatewayId;
  if (!fromGatewayId) {
    console.error(red(`${CROSS} User '${slug}' is not currently assigned to any gateway.`));
    console.error(dim(`  Use \`fleet --env=${args.env} add-customer ${slug} --to=<gw-id> --apply\` to place them first.`));
    process.exit(1);
  }
  if (forceOperationId) await readForceMigrationSource(platformState, {
    operationId: forceOperationId, uid: user.uid, slug, fromGatewayId, toGatewayId,
  });
  if (fromGatewayId === toGatewayId) {
    console.log(yellow(`'${slug}' is already on '${toGatewayId}'. Nothing to migrate.`));
    return;
  }
  const targetRuntime = await readFleetGatewayRuntime(platformState, toGatewayId);
  if (!targetRuntime) {
    console.error(red(`${CROSS} Target gateway '${toGatewayId}' has no valid durable root configuration.`));
    process.exit(1);
  }
  const target = targetRuntime.heartbeat;
  if (targetRuntime.desiredStatus !== "running" || target.status !== "ready") {
    const status = targetRuntime.desiredStatus === "running"
      ? target.status ?? "unknown"
      : targetRuntime.desiredStatus;
    console.error(red(`${CROSS} Target gateway '${toGatewayId}' is in status '${status}'.`));
    console.error(dim(`  Refusing to migrate to a non-ready gateway.`));
    process.exit(1);
  }

  console.log(bold(`MIGRATE-CUSTOMER ${slug}`) + dim(`  ${fromGatewayId} ${ARROW} ${toGatewayId}`));
  console.log(`  uid  ${user.uid}`);
  if (sourceTransferMode) console.log(`  source transfer  ${sourceTransferMode}`);
  if (forceOperationId) {
    const target = {
      operationId: forceOperationId, uid: user.uid, slug, fromGatewayId, toGatewayId,
    };
    const recovery = await readForcedMigrationRecovery(platformState, target);
    const plan = recovery.completed ?? await readForceMigrationPlan(platformState, target, recovery.owned);
    console.log(`  existing operation  ${plan.operationId}  source epoch ${plan.sourceEpoch}`);
    if (recovery.completed) console.log(dim("  Native restart already completed; observing the existing migration."));
    else if (recovery.owned) console.log(dim("  Native restart already reserved; observing its outcome without dispatching again."));
    console.log(yellow("  Force recovery interrupts this dedicated isolated gateway. Disk, migration history, and native acknowledgement are preserved. Shared gateways are excluded; only Kubernetes isolated gateways are supported."));
  }

  console.log("\n" + bold("FORWARD PLAN"));
  console.log(dim("  Prepare target → quiesce source → transfer and verify → commit placement → release source."));
  console.log("\n" + bold("RECOVERY"));
  console.log(dim("  Before cutover: abort only when in-flight work is proven stopped; then resume source."));
  console.log(dim("  After cutover: recover forward using the same durable handoff."));
  console.log(dim("  Ambiguous target preparation or helper execution remains fenced."));

  if (!apply) {
    console.log("\n" + dim(`--- PLAN ONLY (re-run with --apply to execute) ---`));
    return;
  }

  await executeMigration(slug, user.uid, fromGatewayId, toGatewayId, { sourceTransferMode, forceOperationId });
}

const MIGRATION_OP_TIMEOUT_MS = 30 * 60_000;

export function resolveFleetMigrationForce(args: ParsedFleetArgs): string | undefined {
  if (args.flags.force === undefined && args.flags.operation === undefined) return undefined;
  if (args.flags.force !== true) throw new Error("migrate-customer --operation requires the bare --force flag");
  const operation = args.flags.operation;
  if (typeof operation !== "string" || !operation || operation.includes("/")) {
    throw new Error("migrate-customer --force requires --operation=<existing-operation-id>");
  }
  if (args.flags["source-transfer"] !== undefined) throw new Error("force migration cannot change source transfer mode");
  if (args.flags.apply !== undefined && args.flags.apply !== true) throw new Error("migrate-customer --apply must be a bare flag");
  if (args.positional.length !== 2) throw new Error("migrate-customer requires exactly one user slug");
  for (const flag of Object.keys(args.flags)) {
    if (!["to", "force", "operation", "apply"].includes(flag)) throw new Error(`force migration does not accept --${flag}`);
  }
  return operation;
}

export function resolveFleetSourceTransferMode(value: unknown): "retained-pod" | undefined {
  if (value === undefined) return undefined;
  if (value !== "retained-pod") throw new Error("migration transfer requires --source-transfer=retained-pod");
  return value;
}

export function buildFleetMigrateOperationInput(
  uid: string,
  fromGatewayId: string,
  toGatewayId: string,
  sourceTransferMode?: unknown,
): { uid: string; fromGatewayId: string; toGatewayId: string; sourceTransferMode?: "retained-pod" } {
  const mode = resolveFleetSourceTransferMode(sourceTransferMode);
  return { uid, fromGatewayId, toGatewayId, ...(mode ? { sourceTransferMode: mode } : {}) };
}

async function executeMigration(
  slug: string,
  uid: string,
  fromGatewayId: string,
  toGatewayId: string,
  options: { sourceTransferMode?: "retained-pod"; forceOperationId?: string },
): Promise<void> {
  const { sourceTransferMode, forceOperationId } = options;
  const actor = `fleet-cli:${process.env.USER ?? "operator"}`;
  const opId = forceOperationId ? (await runForcedMigration({
    store: platformState, actor, target: { operationId: forceOperationId, uid, slug, fromGatewayId, toGatewayId },
    transport: createForceMigrationTransport({
      namespace: KUBE_NS,
      runKubectl: async (argv, opts) => {
        const result = localFleetKubectl(["--context", KUBE_CONTEXT, ...argv], opts?.stdin, opts?.timeoutMs);
        if (result.error) throw result.error;
        return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      },
    }),
  })).operationId : await enqueueOperation(platformState, {
    kind: "migrate-user",
    input: buildFleetMigrateOperationInput(uid, fromGatewayId, toGatewayId, sourceTransferMode),
    createdBy: actor,
  });

  console.log(
    "\n" +
      bold(`EXECUTING`) +
      dim(`  operationId=${opId}  (glm-controller runs the migration in-cluster)`),
  );

  const rendered = new Set<string>();
  const finalOp = await awaitOperation(platformState, opId, {
    pollMs: 2_000,
    timeoutMs: MIGRATION_OP_TIMEOUT_MS,
    onUpdate: (op) => {
      for (const step of op.steps ?? []) {
        const key = `${step.name}:${step.status}`;
        if (rendered.has(key)) continue;
        rendered.add(key);
        const icon =
          step.status === "done"
            ? green(CHECK)
            : step.status === "failed"
              ? red(CROSS)
              : dim("·");
        console.log(
          `  ${icon} ${step.name}${step.error ? dim(` — ${step.error}`) : ""}`,
        );
      }
    },
  });

  if (finalOp.status === "succeeded") {
    console.log(
      "\n" +
        green(`${CHECK} migration complete: ${slug} ${fromGatewayId} ${ARROW} ${toGatewayId}`),
    );
    return;
  }
  console.error(
    "\n" + red(`${CROSS} migration ${finalOp.status}: ${finalOp.error ?? "unknown error"}`),
  );
  console.error(
    dim(
      finalOp.rolledBack
        ? `  Rollback was attempted. Source should still own the user; verify with \`fleet --env=${args.env} inspect customer ${slug}\`.`
        : `  No rollback attempted (or post-unmount). Operator must intervene.`,
    ),
  );
  process.exit(1);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await initializeFleetCli(argv);
  const verb = args.positional[0] ?? "";
  const sub = args.positional[1] ?? "";
  const apply = args.flags.apply === true;

  switch (`${verb} ${sub}`.trim()) {
    case "ls gateways":
    case "gw ls":
      return lsGateways();
    case "ls customers":
      return lsUsers();
    case "inspect customer":
      if (!args.positional[2]) {
        return missingArg("inspect customer");
      }
      return inspectUser(args.positional[2]);
    case "inspect gateway":
      if (!args.positional[2]) {
        return missingArg("inspect gateway");
      }
      return inspectGateway(args.positional[2]);
    case "gw inspect":
      if (!args.positional[2]) {
        return missingArg("gw inspect");
      }
      return inspectGateway(args.positional[2]);
    case "desktop-image publish": {
      if (args.positional.length !== 2 || Object.keys(args.flags).some(flag => !["sha", "apply"].includes(flag)) || (args.flags.apply !== undefined && args.flags.apply !== true)) throw new Error("desktop-image publish accepts only --sha and --apply");
      return runDesktopImagePublication({ environment: args.env as "test" | "prod", sourceSha: requiredFlag(args, "sha", "desktop-image publish", "full-main-sha"), apply, actor: await fleetOperatorUid(), why: "Operator selected a tested immutable desktop image manifest", store: platformState });
    }
    case "release status":
      return releaseStatus();
    case "logs":
      return runFleetLogsCommand(process.argv.slice(2));
    case "gw restart":
      return runFleetGatewayRestart();
  }

  switch (verb) {
    case "gw":
      return runFleetGatewayMutation(apply);
    case "add-customer": {

const to = typeof args.flags.to === "string" ? args.flags.to : undefined;
      if (!args.positional[1] || !to) {
        return missingArg("add-customer");
      }
      return addUser(args.positional[1], to, apply);
    }
    case "migrate-customer": {
const forceOperationId = resolveFleetMigrationForce(args);
const to = typeof args.flags.to === "string" ? args.flags.to : undefined;
      if (!args.positional[1] || !to) {
        return missingArg("migrate-customer");
      }
      return migrateUserPlan(args.positional[1], to, apply, resolveFleetSourceTransferMode(args.flags["source-transfer"]), forceOperationId);
    }
  }

  const triedVerb = `${verb}${sub ? " " + sub : ""}`;
  console.error(red(`${CROSS} Unknown verb: '${triedVerb}'`));
  console.error(dim(`  Run \`fleet --help\` for the verb list,`));
  console.error(dim(`  or \`fleet help <verb>\` for per-verb usage.`));
  process.exit(1);
}

function missingArg(verbName: string): never {
  const verb = verbsByName.get(verbName);
  if (!verb) {
    console.error(red(`${CROSS} Internal: unknown verb '${verbName}' in router.`));
    process.exit(1);
  }
  console.error(red(`${CROSS} '${verb.verb}' is missing required arguments.`));
  console.error(dim(`  Usage: fleet --env=<env> ${verb.verb}${verb.args ? " " + verb.args : ""}`));
  console.error(dim(`  Example: ${verb.examples[0]}`));
  console.error(dim(`  Full help: fleet help ${verb.verb}`));
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
