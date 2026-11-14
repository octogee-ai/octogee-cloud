import { brokerRequestLimit } from "../middleware/broker-request-limit.js";
import { Router, type Request, type Response } from "express";

import {
  getConnector,
  isConnectorAgentRuntimeTokenMaterializable,
  isConnectorTokenBrokerable,
} from "../../../gateway-edge/src/lib/connectors/index.js";
import { getFreshAccessTokenFromStore } from "../../../gateway-edge/src/lib/connector-tokens.js";
import { isSafeCanvasPath } from "../../../gateway-edge/src/lib/canvas-file.js";
import { decryptSecret } from "../../../gateway-edge/src/lib/kms.js";
import type { OpaqueMap, PlatformStateRepositories, PlatformStateStore } from "@octogee/core/platform-state";
import {
  podBelongsToGateway,
  readServingGatewayAuthorization,
} from "@octogee/core/gateway-live-release";
import { gatewayVmPodName, resolveGatewayRuntime } from "@octogee/shared/types/glm";
import { logger } from "../../../gateway-edge/src/middleware/logging.js";
import { configuredUserPreparationAllowed } from "../lib/user-preparation.js";
import { readVmRuntimeObservation } from "../lib/vm-runtime-observation.js";
import { projectMemberExists } from "../lib/project-members.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

export type PublicCanvasFileReader = (workspaceSlug: string, projectSlug: string) => Promise<string | null>;

export const NO_PUBLIC_CANVAS: PublicCanvasFileReader = async () => null;

const FORBIDDEN = { error: "forbidden" } as const;
const WORKSPACE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PROJECT_ID_RE = /^[a-z0-9]{1,16}$/;
const OWNER_RUNTIME_ACCESS_KIND = "owner-runtime";
const PUBLIC_CANVAS_ACCESS_KIND = "public-canvas";
const PROJECT_CLONE_ACCESS_KIND = "project-clone";

interface ProjectAccessContext {
  kind: "project";
  requestingUid: string;
  workspaceSlug: string;
  projectSlug: string;
}

interface OwnerRuntimeAccessContext {
  kind: typeof OWNER_RUNTIME_ACCESS_KIND;
  builderSlug: string;
}

interface PublicCanvasAccessContext {
  kind: typeof PUBLIC_CANVAS_ACCESS_KIND;
  workspaceSlug: string;
  projectSlug: string;
  canvasPath: string;
}

interface ProjectCloneAccessContext {
  kind: typeof PROJECT_CLONE_ACCESS_KIND;
  builderSlug: string;
  projectSlug: string;
}

type ConnectorAccessContext =
  | ProjectAccessContext
  | OwnerRuntimeAccessContext
  | PublicCanvasAccessContext
  | ProjectCloneAccessContext;
type ParsedAccess =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; value: ConnectorAccessContext };
type FreshTokenFailureReason = "not_connected" | "reauth_required";
type OwnerRuntimeTokenRead =
  | { status: "connected"; accessToken: string }
  | { status: "disconnected"; reason: FreshTokenFailureReason };

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const claimed = (req.body as { gatewayId?: unknown } | undefined)?.gatewayId;
  if (typeof claimed === "string" && claimed.length > 0 && claimed !== bound.gatewayId) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return bound;
}

function stringBody(req: Request, key: string): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
}

function requestAccess(req: Request): ParsedAccess {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || !("access" in body)) return { status: "absent" };
  const access = body.access;
  if (!access || typeof access !== "object") return { status: "invalid" };
  const data = access as Record<string, unknown>;
  if (data.kind === OWNER_RUNTIME_ACCESS_KIND) return parseOwnerRuntimeAccess(data);
  if (data.kind === PROJECT_CLONE_ACCESS_KIND) return parseProjectCloneAccess(data);
  if (data.kind === PUBLIC_CANVAS_ACCESS_KIND) return parsePublicCanvasAccess(data);
  if (data.kind === "project") return parseProjectAccess(data);
  return { status: "invalid" };
}

function parseProjectCloneAccess(data: Record<string, unknown>): ParsedAccess {
  const builderSlug = typeof data.builderSlug === "string" ? data.builderSlug : "";
  const projectSlug = typeof data.projectSlug === "string" ? data.projectSlug : "";
  return WORKSPACE_SLUG_RE.test(builderSlug) && PROJECT_ID_RE.test(projectSlug)
    ? { status: "valid", value: { kind: PROJECT_CLONE_ACCESS_KIND, builderSlug, projectSlug } }
    : { status: "invalid" };
}

function parseOwnerRuntimeAccess(data: Record<string, unknown>): ParsedAccess {
  const builderSlug = typeof data.builderSlug === "string" ? data.builderSlug : "";
  return WORKSPACE_SLUG_RE.test(builderSlug)
    ? { status: "valid", value: { kind: OWNER_RUNTIME_ACCESS_KIND, builderSlug } }
    : { status: "invalid" };
}

function parseProjectAccess(data: Record<string, unknown>): ParsedAccess {
  const requestingUid = typeof data.requestingUid === "string" ? data.requestingUid : "";
  const workspaceSlug = typeof data.workspaceSlug === "string" ? data.workspaceSlug : "";
  const projectSlug = typeof data.projectSlug === "string" ? data.projectSlug : "";
  if (
    !safeDocId(requestingUid) ||
    !WORKSPACE_SLUG_RE.test(workspaceSlug) ||
    !PROJECT_ID_RE.test(projectSlug)
  ) {
    return { status: "invalid" };
  }
  return { status: "valid", value: { kind: "project", requestingUid, workspaceSlug, projectSlug } };
}

function parsePublicCanvasAccess(data: Record<string, unknown>): ParsedAccess {
  const workspaceSlug = typeof data.workspaceSlug === "string" ? data.workspaceSlug : "";
  const projectSlug = typeof data.projectSlug === "string" ? data.projectSlug : "";
  const canvasPath = data.canvasPath;
  if (
    !WORKSPACE_SLUG_RE.test(workspaceSlug) ||
    !PROJECT_ID_RE.test(projectSlug) ||
    !isSafeCanvasPath(canvasPath)
  ) {
    return { status: "invalid" };
  }
  return {
    status: "valid",
    value: { kind: PUBLIC_CANVAS_ACCESS_KIND, workspaceSlug, projectSlug, canvasPath },
  };
}

function safeDocId(value: string): boolean {
  return value.length > 0 && !value.includes("/");
}

function projectRepoSourceProvider(repoSource: OpaqueMap | null): string | null {
  const provider = repoSource?.provider;
  return typeof provider === "string" ? provider : null;
}

async function projectAccessAuthorized(
  input: { store: PlatformStateRepositories; uid: string; connectorId: string; access: ProjectAccessContext },
): Promise<boolean> {
  const { store, uid, connectorId, access } = input;
  const project = await store.workspaces.projects.get(access.workspaceSlug, access.projectSlug);
  if (!project) return false;
  if (projectRepoSourceProvider(project.repoSource) !== connectorId) return false;
  if (access.requestingUid !== uid) return false;
  if (project.ownerUid === uid) return true;
  return projectMemberExists(store, access.workspaceSlug, access.projectSlug, uid);
}

async function publicCanvasAccessAuthorized(
  input: {
    readPublicCanvasFile: PublicCanvasFileReader;
    store: PlatformStateRepositories;
    uid: string;
    runtimeOwnerUid: string;
    connectorId: string;
    access: PublicCanvasAccessContext;
  },
): Promise<boolean> {
  const { readPublicCanvasFile, store, uid, runtimeOwnerUid, connectorId, access } = input;
  if (uid !== runtimeOwnerUid) return false;
  const project = await store.workspaces.projects.get(access.workspaceSlug, access.projectSlug);
  if (!project) return false;
  if (project.ownerUid !== uid) return false;
  if (projectRepoSourceProvider(project.repoSource) !== connectorId) return false;
  if (project.visibility !== "public" && project.visibility !== "unlisted") return false;
  return access.canvasPath === await readPublicCanvasFile(access.workspaceSlug, access.projectSlug);
}

function refused(bound: GatewayBinding, reason: string): null {
  logger.warn("[connector-broker] gateway access refused", {
    gatewayId: bound.gatewayId,
    podName: bound.podName,
    reason,
  });
  return null;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

interface RuntimeOwnerIdentity {
  ownerUid: string;
  builderSlug: string;
}

function vmOwnerIdentity(
  runtime: Record<string, unknown> | undefined,
  bound: GatewayBinding,
): RuntimeOwnerIdentity | null {
  const instanceId = recordOf(runtime?.vm).instanceId;
  if (typeof instanceId !== "string" || !/^\d+$/.test(instanceId)) return null;
  if (bound.podUid !== instanceId || bound.podName !== gatewayVmPodName(bound.gatewayId, instanceId)) {
    return null;
  }
  const { ownerUid, builderSlug } = recordOf(runtime?.vmInstance);
  return typeof ownerUid === "string" && ownerUid && typeof builderSlug === "string" && builderSlug
    ? { ownerUid, builderSlug }
    : null;
}

function clusterOwnerIdentity(
  config: { ownerUid: string | null; builderSlug: string | null },
  bound: GatewayBinding,
): RuntimeOwnerIdentity | null {
  if (!podBelongsToGateway(bound.gatewayId, bound.podName)) return null;
  return config.ownerUid && config.builderSlug
    ? { ownerUid: config.ownerUid, builderSlug: config.builderSlug }
    : null;
}

async function verifiedGatewayAuthorization(
  store: PlatformStateRepositories,
  bound: GatewayBinding,
): Promise<{ builderSlug: string; gatewayClass: string } | null> {
  const authorization = await readServingGatewayAuthorization(store, bound.gatewayId);
  if (!authorization) return refused(bound, "gateway is not serving");
  if (authorization.config.ownerUid !== bound.ownerUid) return refused(bound, "bound owner differs from gateway owner");
  const runtime = await readVmRuntimeObservation(store, bound.gatewayId);
  const vmRuntime = resolveGatewayRuntime(runtime?.runtime) === "gce-vm";
  const ownerIdentity = vmRuntime
    ? vmOwnerIdentity(runtime && { ...runtime }, bound)
    : clusterOwnerIdentity(authorization.config, bound);
  if (!ownerIdentity) return refused(bound, vmRuntime ? "caller is not the gateway's VM instance" : "caller is not an owned pod of the gateway");
  if (
    ownerIdentity.ownerUid !== authorization.config.ownerUid
    || ownerIdentity.builderSlug !== authorization.config.builderSlug
  ) {
    return refused(bound, "runtime owner identity differs from gateway authorization");
  }
  return {
    builderSlug: ownerIdentity.builderSlug,
    gatewayClass: authorization.config.gatewayClass,
  };
}

async function accessAuthorized(
  input: {
    readPublicCanvasFile: PublicCanvasFileReader;
    store: PlatformStateRepositories;
    bound: GatewayBinding;
    uid: string;
    connectorId: string;
    access: ConnectorAccessContext | null;
  },
): Promise<boolean> {
  const { readPublicCanvasFile, store, bound, uid, connectorId, access } = input;
  if (!safeDocId(uid) || !bound.ownerUid || !bound.podName || !bound.podUid) return false;
  const authorization = await verifiedGatewayAuthorization(store, bound);
  if (!authorization) return false;
  if (access?.kind === OWNER_RUNTIME_ACCESS_KIND) return ownerRuntimeAccessAuthorized({
    store,
    access,
    uid,
    ownerUid: bound.ownerUid,
    builderSlug: authorization.builderSlug,
    gatewayClass: authorization.gatewayClass,
  });
  if (access?.kind === PUBLIC_CANVAS_ACCESS_KIND) {
    return publicCanvasAccessAuthorized({ readPublicCanvasFile, store, uid, runtimeOwnerUid: bound.ownerUid, connectorId, access });
  }
  if (access?.kind === "project") {
    if (uid !== bound.ownerUid || access.requestingUid !== bound.ownerUid) return false;
    return projectAccessAuthorized({ store, uid, connectorId, access });
  }
  if (uid === bound.ownerUid) return true;
  return false;
}

async function ownerRuntimeAccessAuthorized(input: {
  store: PlatformStateRepositories;
  access: OwnerRuntimeAccessContext;
  uid: string;
  ownerUid: string;
  builderSlug: string;
  gatewayClass: string;
}): Promise<boolean> {
  if (
    input.uid !== input.ownerUid
    || input.builderSlug !== input.access.builderSlug
    || input.gatewayClass !== "isolated"
  ) {
    return false;
  }
  const workspace = await input.store.workspaces.records.get(input.access.builderSlug);
  return workspace?.ownerUid === input.ownerUid;
}

type ProjectCloneAuthorizationInput = {
  store: PlatformStateRepositories;
  bound: GatewayBinding;
  uid: string;
  access: ProjectCloneAccessContext;
};

async function projectCloneGatewayMode(input: ProjectCloneAuthorizationInput): Promise<"preparing" | "serving" | null> {
  const { store, bound, uid, access } = input;
  if (!safeDocId(uid) || !bound.ownerUid || uid !== bound.ownerUid) return refused(bound, "clone request is not from the owner runtime");
  if (await configuredUserPreparationAllowed(store, bound, access.builderSlug, uid)) return "preparing";
  const [user, assignment] = await Promise.all([
    store.users.records.get(uid),
    store.gateways.assignments.get(bound.gatewayId, uid),
  ]);
  if (user?.gateway?.gatewayId !== bound.gatewayId || assignment?.gatewayId !== bound.gatewayId ||
    assignment.slug !== access.builderSlug || assignment.state !== "serving") return refused(bound, "clone gateway does not own the serving assignment");
  const authorization = await verifiedGatewayAuthorization(store, bound);
  if (!authorization) return null;
  if (authorization.gatewayClass !== "isolated" || authorization.builderSlug !== access.builderSlug) {
    return refused(bound, `clone requested for ${access.builderSlug} on a ${authorization.gatewayClass} gateway of ${authorization.builderSlug}`);
  }
  return "serving";
}

async function projectCloneSourceAuthorized(input: ProjectCloneAuthorizationInput): Promise<{ owner: string; repo: string } | null> {
  const { store, bound, access } = input;
  if (!await projectCloneGatewayMode(input)) return null;
  const project = await store.workspaces.projects.get(access.builderSlug, access.projectSlug);
  if (!project || project.ownerUid !== bound.ownerUid || !project.repoSource) {
    return refused(bound, `project ${access.builderSlug}/${access.projectSlug} is missing, foreign, or has no repo source`);
  }
  const { provider, owner, repo } = project.repoSource;
  if (provider !== "github" || typeof owner !== "string" || typeof repo !== "string") {
    return refused(bound, `project ${access.builderSlug}/${access.projectSlug} is not GitHub-backed`);
  }
  return { owner, repo };
}

function connectorAllowedForAccess(
  connectorId: string,
  access: ConnectorAccessContext | null,
): boolean {
  if (access?.kind === OWNER_RUNTIME_ACCESS_KIND) {
    return isConnectorAgentRuntimeTokenMaterializable(connectorId);
  }
  if (access?.kind === PROJECT_CLONE_ACCESS_KIND) return connectorId === "github";
  return isConnectorTokenBrokerable(connectorId);
}

async function readEncryptedAccessToken(
  store: PlatformStateRepositories,
  uid: string,
  connectorId: string,
): Promise<string | null> {
  const secret = await store.secrets.get(uid, connectorId);
  const enc = secret?.kind === "connector" ? secret.encryptedAccessToken : null;
  return enc ? enc : null;
}

async function readOwnerRuntimeAccessToken(
  store: PlatformStateStore,
  uid: string,
  connectorId: string,
): Promise<OwnerRuntimeTokenRead> {
  const def = getConnector(connectorId);
  if (!def) return { status: "disconnected", reason: "not_connected" };
  const fresh = await getFreshAccessTokenFromStore(store, uid, def);
  if (!fresh.ok) return { status: "disconnected", reason: fresh.reason };
  return { status: "connected", accessToken: fresh.accessToken };
}

async function respondProjectCloneAccess(input: {
  store: PlatformStateStore;
  bound: GatewayBinding;
  uid: string;
  access: ProjectCloneAccessContext;
  connectorId: string;
  res: Response;
}): Promise<void> {
  const { store, bound, uid, access, connectorId, res } = input;
  const repository = await projectCloneSourceAuthorized({
    store,
    bound,
    uid,
    access,
  });
  if (!repository) {
    res.status(403).json(FORBIDDEN);
    return;
  }
  const token = await readOwnerRuntimeAccessToken(store, uid, connectorId);
  if (token.status === "disconnected") {
    res.status(token.reason === "reauth_required" ? 409 : 404).json({ error: token.reason });
    return;
  }
  const currentRepository = await projectCloneSourceAuthorized({ store, bound, uid, access });
  if (!currentRepository || currentRepository.owner !== repository.owner || currentRepository.repo !== repository.repo) {
    res.status(403).json(FORBIDDEN);
    return;
  }
  res.set("Cache-Control", "no-store");
  res.json({ accessToken: token.accessToken, repository: { owner: repository.owner, repo: repository.repo } });
}

async function respondAuthorizedAccess(input: {
  readPublicCanvasFile: PublicCanvasFileReader;
  store: PlatformStateStore;
  bound: GatewayBinding;
  uid: string;
  connectorId: string;
  access: Exclude<ConnectorAccessContext, ProjectCloneAccessContext> | null;
  res: Response;
}): Promise<void> {
  const { readPublicCanvasFile, store, bound, uid, connectorId, access, res } = input;
  if (!(await accessAuthorized({
    readPublicCanvasFile,
    store,
    bound,
    uid,
    connectorId,
    access,
  }))) {
    res.status(403).json(FORBIDDEN);
    return;
  }
  if (access?.kind === OWNER_RUNTIME_ACCESS_KIND) {
    const token = await readOwnerRuntimeAccessToken(store, uid, connectorId);
    if (token.status === "disconnected") {
      res.status(token.reason === "reauth_required" ? 409 : 404).json({ error: token.reason });
      return;
    }
    res.json({ accessToken: token.accessToken });
    return;
  }
  const enc = await readEncryptedAccessToken(store, uid, connectorId);
  if (!enc) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ accessToken: await decryptSecret(enc) });
}

export function createConnectorTokenBrokerRoutes(opts: {
  store: PlatformStateStore;
  readPublicCanvasFile?: PublicCanvasFileReader;
}): Router {
  const router = Router();
  const { store } = opts;
  const readPublicCanvasFile = opts.readPublicCanvasFile ?? NO_PUBLIC_CANVAS;

  router.post(["/access-token", "/github-project-clone-access"], brokerRequestLimit(1800), async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;

    const connectorId = stringBody(req, "connectorId");
    if (!connectorId) {
      res.status(400).json({ error: "connectorId required" });
      return;
    }
    const parsedAccess = requestAccess(req);
    if (parsedAccess.status === "invalid") {
      res.status(400).json({ error: "invalid_access" });
      return;
    }
    const access = parsedAccess.status === "valid" ? parsedAccess.value : null;
    const projectCloneBrokerRequest = req.path === "/github-project-clone-access";
    if (projectCloneBrokerRequest !== (access?.kind === PROJECT_CLONE_ACCESS_KIND)) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const uid = access?.kind === OWNER_RUNTIME_ACCESS_KIND || access?.kind === PROJECT_CLONE_ACCESS_KIND
      ? bound.ownerUid
      : stringBody(req, "uid");
    if (!uid) {
      res.status(400).json({ error: "uid required" });
      return;
    }
    if (!connectorAllowedForAccess(connectorId, access)) {
      res.status(403).json(FORBIDDEN);
      return;
    }

    if (access?.kind === PROJECT_CLONE_ACCESS_KIND) {
      await respondProjectCloneAccess({
        store,
        bound,
        uid,
        access,
        connectorId,
        res,
      });
      return;
    }

    await respondAuthorizedAccess({
      readPublicCanvasFile,
      store,
      bound,
      uid,
      connectorId,
      access,
      res,
    });
  });

  return router;
}
